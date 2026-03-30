'use strict';

/**
 * Sync Engine Service
 *
 * The central orchestrator for all outbound sync operations.
 *
 * Responsibilities:
 *  1. Serialise the full document (all locales, components, dynamic zones,
 *     relations, media) from the current (source) environment.
 *  2. Compute a diff and apply conflict strategy.
 *  3. Optionally run a dry-run (preview only, no write).
 *  4. Send the payload to the target environment via HTTP with retry logic.
 *  5. Maintain an in-process queue to prevent concurrent syncs on the same doc.
 *  6. Write a full audit log entry at every stage.
 *  7. Optionally send webhook notifications on completion.
 *
 * The INBOUND side (receiving and writing) lives in the receive controller
 * and the payload-writer helper below.
 *
 * @module env-sync/server/services/sync-engine
 */

const axios      = require('axios');
const axiosRetry = require('axios-retry').default ?? require('axios-retry');
const PQueue     = require('p-queue').default ?? require('p-queue');

const PLUGIN_ID = 'env-sync';

// ── Retry-enabled axios instance ────────────────────────────────────────────
const http = axios.create();
axiosRetry(http, {
  retries:           3,
  retryDelay:        axiosRetry.exponentialDelay,
  retryCondition:    (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    (err.response?.status >= 500 && err.response?.status <= 599),
  onRetry: (count, err) => {
    const strapi = global.strapi;
    if (strapi) strapi.log.warn(`[env-sync] HTTP retry #${count}: ${err.message}`);
  },
});

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = ({ strapi }) => {

  // Per-document concurrency queue: key = `${documentId}:${targetEnv}`
  const _queues  = new Map();

  // Global concurrency limiter (max N outbound requests at once)
  const _globalQueue = new PQueue({ concurrency: 10 });

  return {

    /**
     * Main entry point. Triggers an on-demand sync for a single document.
     *
     * @param {object} params
     * @param {string}  params.contentType         - Strapi UID
     * @param {string}  params.documentId          - Source document's documentId
     * @param {string|null} params.locale          - Specific locale, or null for all
     * @param {string}  params.targetEnv           - Target environment name
     * @param {number}  params.triggeredByAdminId  - Admin user ID
     * @param {boolean} [params.isDryRun=false]    - Preview only, no write
     * @param {string}  [params.conflictStrategyOverride]
     * @returns {Promise<SyncResult>}
     */
    async triggerSync({
      contentType,
      documentId,
      locale,
      targetEnv,
      triggeredByAdminId,
      isDryRun          = false,
      conflictStrategyOverride,
    }) {
      const config = _getConfig(strapi);

      // ── Guard: QA/UAT share DB ────────────────────────────────────────────
      const currentEnv = config.currentEnv;
      if (_isSameDatabase(currentEnv, targetEnv)) {
        return _errorResult('QA and UAT share the same database — sync is not required or safe.');
      }

      // ── Guard: valid target ────────────────────────────────────────────────
      const targetConfig = config.targets?.[targetEnv];
      if (!targetConfig) {
        return _errorResult(`No target configuration found for environment "${targetEnv}".`);
      }

      const conflictStrategy = conflictStrategyOverride
        || config.perContentType?.[contentType]?.conflictStrategy
        || config.conflictStrategy;

      const loggerService = strapi.plugin(PLUGIN_ID).service('logger');

      // ── Guard: duplicate in-progress sync ─────────────────────────────────
      const alreadyRunning = await loggerService.isAlreadyInProgress(documentId, targetEnv);
      if (alreadyRunning) {
        return _errorResult(
          `A sync is already in progress for document "${documentId}" → ${targetEnv}. ` +
          `Your request has been queued.`,
          'queued'
        );
      }

      // ── Create audit log entry ─────────────────────────────────────────────
      const logEntry = await loggerService.createLog({
        contentType,
        documentId,
        locale,
        sourceEnv:        currentEnv,
        targetEnv,
        targetUrl:        targetConfig.url,
        triggeredByAdminId,
        conflictStrategy,
        isDryRun,
      });

      // ── Enqueue with per-document queue ───────────────────────────────────
      const queueKey = `${documentId}:${targetEnv}`;
      if (!_queues.has(queueKey)) {
        _queues.set(queueKey, new PQueue({ concurrency: 1 }));
      }
      const docQueue = _queues.get(queueKey);

      // Execute in both per-doc and global queues
      const result = await _globalQueue.add(() =>
        docQueue.add(() =>
          this._executeSync({
            contentType,
            documentId,
            locale,
            targetEnv,
            targetConfig,
            currentEnv,
            triggeredByAdminId,
            isDryRun,
            conflictStrategy,
            logEntry,
          })
        )
      );

      return result;
    },

    /**
     * Drain the global queue gracefully.
     * Called during plugin destroy to allow in-flight syncs to complete.
     *
     * @returns {Promise<void>}
     */
    async drain() {
      await Promise.race([
        _globalQueue.onIdle(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    },

    // ── Internal execution (not directly exposed) ───────────────────────────

    /**
     * Execute the full sync pipeline for a single document.
     *
     * @param {object} params
     * @returns {Promise<SyncResult>}
     */
    async _executeSync({
      contentType,
      documentId,
      locale,
      targetEnv,
      targetConfig,
      currentEnv,
      triggeredByAdminId,
      isDryRun,
      conflictStrategy,
      logEntry,
    }) {
      const startTime     = Date.now();
      const loggerService = strapi.plugin(PLUGIN_ID).service('logger');
      const diffService   = strapi.plugin(PLUGIN_ID).service('diffEngine');
      const mediaSvc      = strapi.plugin(PLUGIN_ID).service('mediaSync');

      await loggerService.markInProgress(logEntry.documentId);

      let retryCount = 0;

      try {

        // ── 1. Serialise source document ──────────────────────────────────
        strapi.log.debug(`[env-sync] Serialising ${contentType}#${documentId}`);
        const { serialised, localesSynced } = await _serialiseDocument(
          strapi, contentType, documentId, locale
        );

        if (!serialised || Object.keys(serialised).length === 0) {
          throw new Error(`Document "${documentId}" not found in content type "${contentType}".`);
        }

        // ── 2. Build media manifest ────────────────────────────────────────
        const mediaManifest = mediaSvc.buildMediaManifest(
          Object.values(serialised)[0] || {}, contentType
        );

        // ── 3. Fetch current target document for diff ──────────────────────
        let targetDocument = null;
        try {
          targetDocument = await _fetchTargetDocument(http, targetConfig, contentType, documentId);
        } catch (err) {
          strapi.log.debug(`[env-sync] Could not fetch target doc for diff: ${err.message}`);
          // Non-fatal — proceed without diff (treated as new document)
        }

        // ── 4. Compute diff ────────────────────────────────────────────────
        const sourceData = Object.values(serialised)[0] || {};
        const diff = diffService.computeDiff({
          sourceData,
          targetData:  targetDocument,
          contentType,
        });

        // ── 5. Apply conflict strategy ────────────────────────────────────
        const conflictResolution = diffService.resolveConflict({
          diff,
          strategy:         conflictStrategy,
          sourceUpdatedAt:  sourceData.updatedAt,
          targetUpdatedAt:  targetDocument?.updatedAt,
        });

        if (!conflictResolution.proceed) {
          const duration = Date.now() - startTime;
          await loggerService.markFailed(logEntry.documentId, {
            error:      new Error(conflictResolution.message),
            duration,
            retryCount: 0,
          });
          return {
            success:    false,
            reason:     conflictResolution.reason,
            message:    conflictResolution.message,
            diff:       diffService.summarise(diff),
            logId:      logEntry.documentId,
          };
        }

        // ── 6. Dry-run: return diff without writing ────────────────────────
        if (isDryRun) {
          const duration     = Date.now() - startTime;
          const diffSummary  = diffService.summarise(diff);
          await loggerService.markDryRun(logEntry.documentId, { diffSummary, duration });

          return {
            success:   true,
            isDryRun:  true,
            diff:      diffSummary,
            logId:     logEntry.documentId,
            message:   'Dry run complete. No changes were written.',
          };
        }

        // ── 7. Build HTTP payload ──────────────────────────────────────────
        const payload = {
          contentType,
          documentId,
          locales:        serialised,
          localesSynced,
          mediaManifest,
          conflictStrategy,
          sourceEnv:      currentEnv,
          triggeredAt:    new Date().toISOString(),
          logId:          logEntry.documentId,
        };

        // ── 8. POST to target env ──────────────────────────────────────────
        strapi.log.info(
          `[env-sync] Sending ${contentType}#${documentId} → ${targetEnv} (${targetConfig.url})`
        );

        const config = _getConfig(strapi);

        let httpResponse;
        try {
          httpResponse = await http.post(
            `${targetConfig.url}/api/env-sync/receive`,
            payload,
            {
              timeout: config.requestTimeoutMs,
              headers: {
                'Content-Type':      'application/json',
                Authorization:       `Bearer ${targetConfig.secret}`,
                'x-env-sync-source': currentEnv,
                'x-env-sync-log-id': logEntry.documentId,
              },
            }
          );
          retryCount = httpResponse.config?.['axios-retry']?.retryCount ?? 0;
        } catch (httpErr) {
          retryCount = httpErr.config?.['axios-retry']?.retryCount ?? config.retryAttempts;
          throw new Error(
            `HTTP request to ${targetEnv} failed: ${httpErr.response?.data?.error?.message || httpErr.message}`
          );
        }

        // ── 9. Finalise log ────────────────────────────────────────────────
        const duration    = Date.now() - startTime;
        const diffSummary = diffService.summarise(diff);
        diffSummary.localesSynced = localesSynced;

        await loggerService.markSuccess(logEntry.documentId, {
          diffSummary,
          snapshotId: httpResponse.data?.snapshotId ?? null,
          duration,
          retryCount,
        });

        // ── 10. Webhook notification ───────────────────────────────────────
        await _sendWebhook(strapi, {
          event:       'sync.success',
          contentType,
          documentId,
          targetEnv,
          duration,
          diffSummary,
        });

        strapi.log.info(
          `[env-sync] ✓ Sync complete: ${contentType}#${documentId} → ${targetEnv} (${duration}ms)`
        );

        return {
          success:     true,
          isDryRun:    false,
          diff:        diffSummary,
          logId:       logEntry.documentId,
          snapshotId:  httpResponse.data?.snapshotId ?? null,
          duration,
          message:     `Successfully synced to ${targetEnv}.`,
        };

      } catch (err) {
        const duration = Date.now() - startTime;

        strapi.log.error(`[env-sync] Sync failed: ${contentType}#${documentId} → ${targetEnv}: ${err.message}`);

        await loggerService.markFailed(logEntry.documentId, { error: err, duration, retryCount });

        await _sendWebhook(strapi, {
          event:       'sync.failure',
          contentType,
          documentId,
          targetEnv,
          duration,
          error:       err.message,
        });

        return {
          success:  false,
          reason:   'error',
          message:  err.message,
          logId:    logEntry.documentId,
          duration,
        };
      }
    },
  };
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Serialise a document for all its locales into a { locale: data } map.
 * Also returns the list of locale codes that were synced.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} contentType
 * @param {string} documentId
 * @param {string|null} locale - specific locale, or null for all
 * @returns {Promise<{ serialised: object, localesSynced: string[] }>}
 */
async function _serialiseDocument(strapi, contentType, documentId, locale) {
  const schema = _getSchema(strapi, contentType);
  const isI18n = schema?.pluginOptions?.i18n?.localized === true;

  if (!isI18n || locale) {
    // Single locale (or non-i18n)
    const doc = await strapi.documents(contentType).findOne({
      documentId,
      locale:   locale || undefined,
      populate: _buildPopulate(strapi, contentType),
    });

    if (!doc) return { serialised: {}, localesSynced: [] };

    const key = locale || '__default__';
    return {
      serialised:    { [key]: _stripMeta(doc) },
      localesSynced: [key],
    };
  }

  // i18n: all locales
  const allLocales = await _getAllLocales(strapi);
  const serialised = {};
  const synced     = [];

  for (const loc of allLocales) {
    try {
      const doc = await strapi.documents(contentType).findOne({
        documentId,
        locale: loc,
        populate: _buildPopulate(strapi, contentType),
      });
      if (doc) {
        serialised[loc] = _stripMeta(doc);
        synced.push(loc);
      }
    } catch { /* locale may not exist for this document */ }
  }

  return { serialised, localesSynced: synced };
}

/**
 * Build a deep populate descriptor for a content type, handling
 * nested components and dynamic zones up to 5 levels deep.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} contentType
 * @param {number} [depth=5]
 * @returns {object}
 */
function _buildPopulate(strapi, contentType, depth = 5) {
  if (depth === 0) return '*';

  const schema = _getSchema(strapi, contentType);
  if (!schema?.attributes) return '*';

  const populate = {};

  for (const [attrName, attrDef] of Object.entries(schema.attributes)) {
    switch (attrDef.type) {
      case 'relation':
        // Populate relations but only 1 level deep to avoid huge payloads
        populate[attrName] = { fields: ['id', 'documentId'] };
        break;
      case 'media':
        populate[attrName] = {
          fields: ['id', 'documentId', 'hash', 'url', 'name', 'mime', 'size', 'folderPath', 'alternativeText', 'caption'],
        };
        break;
      case 'component': {
        const sub = depth > 1 ? _buildPopulate(strapi, attrDef.component, depth - 1) : '*';
        populate[attrName] = { populate: sub };
        break;
      }
      case 'dynamiczone':
        populate[attrName] = { populate: depth > 1 ? '*' : false };
        break;
    }
  }

  return Object.keys(populate).length > 0 ? populate : '*';
}

/**
 * Strip Strapi internal metadata from a document before sending.
 *
 * @param {object} doc
 * @returns {object}
 */
function _stripMeta(doc) {
  const { id, createdBy, updatedBy, localizations, ...rest } = doc || {};
  return rest;
}

/**
 * Fetch the current version of a document from the target environment
 * using its public API — used for pre-sync diffing.
 *
 * @param {object} http   - axios instance
 * @param {{ url: string, secret: string }} targetConfig
 * @param {string} contentType
 * @param {string} documentId
 * @returns {Promise<object|null>}
 */
async function _fetchTargetDocument(http, targetConfig, contentType, documentId) {
  const response = await http.post(
    `${targetConfig.url}/api/env-sync/peek`,
    { contentType, documentId },
    {
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${targetConfig.secret}`,
      },
      validateStatus: (s) => s === 200 || s === 404,
    }
  );

  if (response.status === 404) return null;
  return response.data?.document || null;
}

/**
 * Get all configured locale codes from the i18n plugin.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @returns {Promise<string[]>}
 */
async function _getAllLocales(strapi) {
  try {
    const localesService = strapi.plugin('i18n')?.service('locales');
    if (!localesService) return ['en'];
    const all = await localesService.find();
    return all.map((l) => l.code);
  } catch {
    return ['en'];
  }
}

/**
 * Send an optional webhook notification.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {object} event
 */
async function _sendWebhook(strapi, event) {
  try {
    const config = _getConfig(strapi);
    if (!config?.webhook?.url) return;

    const { url, onSuccess, onFailure } = config.webhook;
    if (event.event === 'sync.success' && !onSuccess) return;
    if (event.event === 'sync.failure' && !onFailure) return;

    await axios.post(url, {
      plugin:    'strapi-plugin-env-sync',
      ...event,
      timestamp: new Date().toISOString(),
    }, { timeout: 5000 });
  } catch (err) {
    strapi.log.warn(`[env-sync] Webhook notification failed: ${err.message}`);
    // Non-fatal
  }
}

/**
 * Get plugin config safely.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @returns {object}
 */
function _getConfig(strapi) {
  return strapi.config.get(`plugin::${PLUGIN_ID}`) || {};
}

/**
 * Check if two environments share the same database
 * (QA and UAT are the same DB by design).
 *
 * @param {string} envA
 * @param {string} envB
 * @returns {boolean}
 */
function _isSameDatabase(envA, envB) {
  const SHARED_DB_ENVS = new Set(['QA', 'UAT']);
  return SHARED_DB_ENVS.has(envA) && SHARED_DB_ENVS.has(envB);
}

/**
 * Get Strapi content type schema safely.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} uid
 * @returns {object|null}
 */
function _getSchema(strapi, uid) {
  try { return strapi.getModel(uid); } catch { return null; }
}

/**
 * @typedef {object} SyncResult
 * @property {boolean}  success
 * @property {boolean}  [isDryRun]
 * @property {string}   [reason]
 * @property {string}   message
 * @property {object}   [diff]
 * @property {string}   logId
 * @property {string}   [snapshotId]
 * @property {number}   [duration]
 */

/**
 * Build a generic error result without a log entry.
 *
 * @param {string} message
 * @param {string} [reason='error']
 * @returns {SyncResult}
 */
function _errorResult(message, reason = 'error') {
  return { success: false, reason, message, logId: null };
}
