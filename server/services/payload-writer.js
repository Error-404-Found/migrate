'use strict';

/**
 * Payload Writer Service
 *
 * Called on the TARGET environment after the sync payload is received
 * and validated. Responsible for:
 *
 *  1. Taking a pre-write snapshot (for rollback).
 *  2. Ensuring all media files exist locally.
 *  3. Resolving and validating all relations.
 *  4. Writing each locale of the document atomically in a DB transaction.
 *  5. Restoring publish state.
 *
 * This is intentionally separated from sync-engine.js (outbound) so each
 * side of the sync is cleanly isolated.
 *
 * @module env-sync/server/services/payload-writer
 */

const PLUGIN_ID = 'env-sync';

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = ({ strapi }) => ({

  /**
   * Apply an incoming sync payload to the local database.
   *
   * @param {object} params
   * @param {string}  params.contentType
   * @param {string}  params.documentId
   * @param {object}  params.locales          - { locale: documentData }
   * @param {string[]} params.localesSynced
   * @param {object[]} params.mediaManifest
   * @param {string}  params.conflictStrategy
   * @param {string}  params.sourceEnv
   * @param {string}  params.logId
   * @param {number}  params.triggeredByAdminId
   * @returns {Promise<WriteResult>}
   */
  async applyPayload({
    contentType,
    documentId,
    locales,
    localesSynced,
    mediaManifest,
    conflictStrategy,
    sourceEnv,
    logId,
    triggeredByAdminId,
  }) {
    const config         = _getConfig(strapi);
    const currentEnv     = config.currentEnv;
    const rollbackSvc    = strapi.plugin(PLUGIN_ID).service('rollback');
    const mediaSvc       = strapi.plugin(PLUGIN_ID).service('mediaSync');
    const relationSvc    = strapi.plugin(PLUGIN_ID).service('relationResolver');

    // ── 1. Pre-write snapshot ──────────────────────────────────────────────
    let snapshot = null;
    if (config.enableRollback) {
      try {
        snapshot = await rollbackSvc.takeSnapshot({
          contentType,
          documentId,
          locale:            null, // all locales
          environment:       currentEnv,
          takenByAdminId:    triggeredByAdminId,
          logId,
        });
      } catch (snapshotErr) {
        strapi.log.warn(`[env-sync] writer: snapshot failed (non-fatal): ${snapshotErr.message}`);
      }
    }

    // ── 2. Ensure all media exists locally ─────────────────────────────────
    let mediaIdMap = new Map();
    try {
      mediaIdMap = await mediaSvc.ensureMediaExists({ mediaManifest });
    } catch (mediaErr) {
      strapi.log.warn(`[env-sync] writer: media sync had errors (non-fatal): ${mediaErr.message}`);
    }

    const brokenRelations = [];

    // ── 3. Write each locale atomically ───────────────────────────────────
    await strapi.db.transaction(async () => {
      for (const [locale, rawData] of Object.entries(locales)) {
        await _writeLocale({
          strapi,
          contentType,
          documentId,
          locale,
          rawData,
          mediaIdMap,
          relationSvc,
          mediaSvc,
          brokenRelations,
        });
      }
    });

    if (brokenRelations.length > 0) {
      strapi.log.warn(
        `[env-sync] writer: ${brokenRelations.length} broken relation(s) were skipped: ` +
        brokenRelations.map((r) => `${r.path} → ${r.documentId}`).join(', ')
      );
    }

    return {
      success:        true,
      snapshotId:     snapshot?.documentId ?? null,
      brokenRelations,
      localesWritten: localesSynced,
    };
  },
});

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Write a single locale of a document to the local database.
 * Handles create vs update, media remapping, relation resolution,
 * and publish/draft state restoration.
 *
 * @param {object} params
 */
async function _writeLocale({
  strapi,
  contentType,
  documentId,
  locale,
  rawData,
  mediaIdMap,
  relationSvc,
  mediaSvc,
  brokenRelations,
}) {
  const isDefaultLocale = locale === '__default__';

  // ── a. Strip Strapi meta fields from incoming data ─────────────────────
  const data = _stripMeta(rawData);

  // ── b. Remap media IDs (source → local IDs) ────────────────────────────
  const dataWithMedia = mediaSvc.remapMediaIds(data, mediaIdMap, contentType);

  // ── c. Resolve relations ───────────────────────────────────────────────
  const { payload: resolvedData, brokenRelations: broken } = await relationSvc.resolveRelations({
    payload:     dataWithMedia,
    contentType,
  });
  brokenRelations.push(...broken);

  // ── d. Check if document already exists on target ─────────────────────
  const findOptions = isDefaultLocale
    ? { documentId, populate: ['id'] }
    : { documentId, locale,   populate: ['id'] };

  let existing = null;
  try {
    existing = await strapi.documents(contentType).findOne(findOptions);
  } catch { /* may not exist */ }

  // ── e. Upsert ─────────────────────────────────────────────────────────
  const wasPublished = Boolean(rawData.publishedAt);

  if (existing) {
    // Update existing document
    const updateOptions = isDefaultLocale
      ? { documentId, data: resolvedData }
      : { documentId, locale, data: resolvedData };

    await strapi.documents(contentType).update(updateOptions);
    strapi.log.debug(`[env-sync] writer: updated ${contentType}#${documentId}${isDefaultLocale ? '' : ` (${locale})`}`);
  } else {
    // Create new document — use the incoming documentId for idempotency
    const createData = isDefaultLocale
      ? { ...resolvedData, documentId }
      : { ...resolvedData, documentId, locale };

    await strapi.documents(contentType).create({ data: createData });
    strapi.log.debug(`[env-sync] writer: created ${contentType}#${documentId}${isDefaultLocale ? '' : ` (${locale})`}`);
  }

  // ── f. Restore publish state ──────────────────────────────────────────
  const publishOptions = isDefaultLocale ? { documentId } : { documentId, locale };

  if (wasPublished) {
    try {
      await strapi.documents(contentType).publish(publishOptions);
    } catch (publishErr) {
      strapi.log.warn(`[env-sync] writer: publish failed for ${documentId}: ${publishErr.message}`);
    }
  } else {
    try {
      await strapi.documents(contentType).unpublish(publishOptions);
    } catch { /* already draft — harmless */ }
  }
}

/**
 * Strip Strapi internal metadata fields.
 * We preserve documentId and locale deliberately — they are identity fields.
 *
 * @param {object} data
 * @returns {object}
 */
function _stripMeta(data) {
  if (!data) return {};
  const {
    id,
    createdAt,
    updatedAt,
    publishedAt,   // managed via publish() / unpublish()
    createdBy,
    updatedBy,
    localizations,
    documentId,    // do not pass as data field — used in findOne/update/create options
    locale,        // same
    ...rest
  } = data;
  return rest;
}

/**
 * Get plugin config.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @returns {object}
 */
function _getConfig(strapi) {
  return strapi.config.get(`plugin::${PLUGIN_ID}`) || {};
}

/**
 * @typedef {object} WriteResult
 * @property {boolean}  success
 * @property {string|null} snapshotId
 * @property {object[]} brokenRelations
 * @property {string[]} localesWritten
 */
