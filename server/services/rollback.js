'use strict';

/**
 * Rollback Service
 *
 * Before every sync overwrites a document on the target, this service:
 *  1. Captures a full snapshot of the current document (all locales).
 *  2. Stores it in the `env-sync-snapshot` collection.
 *  3. Prunes old snapshots to respect `maxSnapshotsPerDocument`.
 *
 * A snapshot can later be restored via the rollback action, which:
 *  1. Reads the snapshot data.
 *  2. Writes it back to the document using the Document Service.
 *  3. Marks the snapshot as restored and updates the audit log.
 *
 * @module env-sync/server/services/rollback
 */

const crypto = require('crypto');

const PLUGIN_ID    = 'env-sync';
const SNAPSHOT_UID = `plugin::${PLUGIN_ID}.env-sync-snapshot`;

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = ({ strapi }) => ({

  /**
   * Take a snapshot of the current document on this environment
   * before it is overwritten by an incoming sync.
   *
   * @param {object} params
   * @param {string} params.contentType
   * @param {string} params.documentId
   * @param {string|null} params.locale         - null = snapshot all locales
   * @param {string} params.environment         - current env name
   * @param {number} params.takenByAdminId
   * @param {string} params.logId               - audit log documentId
   * @returns {Promise<object|null>} snapshot document, or null if document not found
   */
  async takeSnapshot({ contentType, documentId, locale, environment, takenByAdminId, logId }) {
    const pluginConfig = strapi.config.get(`plugin::${PLUGIN_ID}`);
    if (!pluginConfig?.enableRollback) return null;

    // ── 1. Fetch the current document (all locales) ────────────────────────
    const snapshotData = await _fetchAllLocales(strapi, contentType, documentId);
    if (!snapshotData || Object.keys(snapshotData).length === 0) {
      strapi.log.debug(`[env-sync] rollback: document ${contentType}#${documentId} not found — no snapshot taken`);
      return null;
    }

    // ── 2. Build media manifest ────────────────────────────────────────────
    const mediaSyncService = strapi.plugin(PLUGIN_ID).service('mediaSync');
    const mediaManifest    = mediaSyncService.buildMediaManifest(
      Object.values(snapshotData)[0] || {},
      contentType
    );

    // ── 3. Serialise and compute checksum ─────────────────────────────────
    const json      = JSON.stringify(snapshotData);
    const checksum  = crypto.createHash('sha256').update(json).digest('hex');
    const sizeBytes = Buffer.byteLength(json, 'utf8');

    // ── 4. Persist snapshot ───────────────────────────────────────────────
    const snapshot = await strapi.documents(SNAPSHOT_UID).create({
      data: {
        contentType,
        documentId,
        locale:       locale ?? null,
        environment,
        snapshotData,
        mediaManifest,
        takenAt:     new Date().toISOString(),
        takenBy:     takenByAdminId ? { connect: [{ id: takenByAdminId }] } : undefined,
        logId,
        isRestored:  false,
        sizeBytes,
        checksum,
      },
    });

    strapi.log.debug(`[env-sync] rollback: snapshot ${snapshot.documentId} taken for ${contentType}#${documentId}`);

    // ── 5. Prune old snapshots ─────────────────────────────────────────────
    await this._pruneOldSnapshots(contentType, documentId, environment, pluginConfig.maxSnapshotsPerDocument);

    return snapshot;
  },

  /**
   * Restore a document from a snapshot.
   *
   * @param {object} params
   * @param {string} params.snapshotDocumentId  - documentId of the snapshot entry
   * @param {number} params.restoredByAdminId
   * @returns {Promise<{ success: boolean, message: string, contentType?: string, documentId?: string }>}
   */
  async restoreSnapshot({ snapshotDocumentId, restoredByAdminId }) {
    // ── 1. Fetch snapshot ──────────────────────────────────────────────────
    const snapshot = await strapi.documents(SNAPSHOT_UID).findOne({
      documentId: snapshotDocumentId,
      populate:   ['takenBy'],
    });

    if (!snapshot) {
      return { success: false, message: `Snapshot "${snapshotDocumentId}" not found.` };
    }

    if (snapshot.isRestored) {
      return { success: false, message: 'This snapshot has already been restored. Create a new sync first.' };
    }

    // ── 2. Verify checksum ────────────────────────────────────────────────
    const json             = JSON.stringify(snapshot.snapshotData);
    const actualChecksum   = crypto.createHash('sha256').update(json).digest('hex');
    if (actualChecksum !== snapshot.checksum) {
      return {
        success: false,
        message: 'Snapshot integrity check failed (checksum mismatch). The snapshot data may be corrupted.',
      };
    }

    // ── 3. Restore each locale ────────────────────────────────────────────
    await strapi.db.transaction(async () => {
      const { contentType, documentId, snapshotData } = snapshot;

      for (const [locale, data] of Object.entries(snapshotData)) {
        const isDefault = locale === '__default__';

        // Strip internal Strapi metadata fields before restore
        const cleanData = _stripMetaFields(data);

        const existing = isDefault
          ? await strapi.documents(contentType).findOne({ documentId })
          : await strapi.documents(contentType).findOne({ documentId, locale });

        if (existing) {
          await (isDefault
            ? strapi.documents(contentType).update({ documentId, data: cleanData })
            : strapi.documents(contentType).update({ documentId, locale, data: cleanData })
          );
        } else {
          await (isDefault
            ? strapi.documents(contentType).create({ data: { ...cleanData, documentId } })
            : strapi.documents(contentType).create({ data: { ...cleanData, documentId, locale } })
          );
        }

        // Re-publish if the snapshot had a publishedAt
        if (data.publishedAt) {
          await (isDefault
            ? strapi.documents(contentType).publish({ documentId })
            : strapi.documents(contentType).publish({ documentId, locale })
          );
        } else {
          // Ensure it's back in draft if it was draft in snapshot
          try {
            await (isDefault
              ? strapi.documents(contentType).unpublish({ documentId })
              : strapi.documents(contentType).unpublish({ documentId, locale })
            );
          } catch { /* already draft — ignore */ }
        }
      }
    });

    // ── 4. Mark snapshot as restored ──────────────────────────────────────
    await strapi.documents(SNAPSHOT_UID).update({
      documentId: snapshotDocumentId,
      data: {
        isRestored:  true,
        restoredAt:  new Date().toISOString(),
        restoredBy:  restoredByAdminId ? { connect: [{ id: restoredByAdminId }] } : undefined,
      },
    });

    strapi.log.info(
      `[env-sync] rollback: restored ${snapshot.contentType}#${snapshot.documentId} ` +
      `from snapshot ${snapshotDocumentId}`
    );

    return {
      success:     true,
      message:     'Document restored successfully.',
      contentType: snapshot.contentType,
      documentId:  snapshot.documentId,
    };
  },

  /**
   * Prune snapshots for a document beyond the max count.
   * Keeps the most recent N snapshots, deletes the rest.
   *
   * @param {string} contentType
   * @param {string} documentId
   * @param {string} environment
   * @param {number} maxCount
   */
  async _pruneOldSnapshots(contentType, documentId, environment, maxCount = 5) {
    try {
      const allSnapshots = await strapi.documents(SNAPSHOT_UID).findMany({
        filters:    { contentType, documentId, environment },
        sort:       { takenAt: 'desc' },
        pagination: { page: 1, pageSize: 100 },
        fields:     ['id', 'documentId', 'takenAt'],
      });

      if (allSnapshots.length <= maxCount) return;

      const toDelete = allSnapshots.slice(maxCount);
      for (const snap of toDelete) {
        await strapi.documents(SNAPSHOT_UID).delete({ documentId: snap.documentId });
        strapi.log.debug(`[env-sync] rollback: pruned old snapshot ${snap.documentId}`);
      }
    } catch (err) {
      strapi.log.warn(`[env-sync] rollback: snapshot pruning failed: ${err.message}`);
    }
  },
});

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Fetch all locale versions of a document and return them
 * as { locale: data } — uses '__default__' for non-i18n types.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} contentType
 * @param {string} documentId
 * @returns {Promise<object>}
 */
async function _fetchAllLocales(strapi, contentType, documentId) {
  const schema  = _getSchema(strapi, contentType);
  const isI18n  = schema?.pluginOptions?.i18n?.localized === true;

  if (!isI18n) {
    // Non-i18n: single fetch
    const doc = await strapi.documents(contentType).findOne({
      documentId,
      populate: '*',
    });
    if (!doc) return null;
    return { __default__: doc };
  }

  // i18n: fetch each locale
  const localesService = strapi.plugin('i18n')?.service('locales');
  let locales = ['en'];
  if (localesService) {
    const all = await localesService.find();
    locales = all.map((l) => l.code);
  }

  const result = {};
  for (const locale of locales) {
    try {
      const doc = await strapi.documents(contentType).findOne({
        documentId,
        locale,
        populate: '*',
      });
      if (doc) result[locale] = doc;
    } catch { /* locale may not exist for this doc */ }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Get Strapi schema safely.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} uid
 * @returns {object|null}
 */
function _getSchema(strapi, uid) {
  try { return strapi.getModel(uid); } catch { return null; }
}

/**
 * Strip Strapi internal metadata fields from a document before restoring.
 *
 * @param {object} data
 * @returns {object}
 */
function _stripMetaFields(data) {
  if (!data) return {};
  const { id, documentId, createdAt, updatedAt, publishedAt, createdBy, updatedBy, localizations, locale, ...rest } = data;
  return rest;
}
