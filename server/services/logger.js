'use strict';

/**
 * Logger Service
 *
 * Handles all audit log creation, updates, and retrieval for env-sync operations.
 * Every sync attempt — success, failure, dry-run, rollback — is persisted here.
 *
 * @module env-sync/server/services/logger
 */

const { v4: uuidv4 } = require('crypto').webcrypto
  ? (() => { try { return require('crypto'); } catch { return { randomUUID: () => uuidv4Fallback() }; } })()
  : require('crypto');

const PLUGIN_ID  = 'env-sync';
const LOG_UID    = `plugin::${PLUGIN_ID}.env-sync-log`;

// Fallback UUID generator if crypto.randomUUID unavailable
function generateId() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 * @returns {object} logger service
 */
module.exports = ({ strapi }) => ({

  /**
   * Create a new log entry with status "pending".
   *
   * @param {object} params
   * @param {string} params.contentType  - Strapi UID
   * @param {string} params.documentId   - Document's documentId
   * @param {string|null} params.locale  - Locale or null
   * @param {string} params.sourceEnv
   * @param {string} params.targetEnv
   * @param {string} params.targetUrl
   * @param {number} params.triggeredByAdminId
   * @param {string} params.conflictStrategy
   * @param {boolean} params.isDryRun
   * @param {object|null} params.payload  - Serialised document (stored for debugging)
   * @returns {Promise<object>} created log entry
   */
  async createLog({
    contentType,
    documentId,
    locale,
    sourceEnv,
    targetEnv,
    targetUrl,
    triggeredByAdminId,
    conflictStrategy,
    isDryRun = false,
    payload  = null,
  }) {
    const idempotencyKey = `${documentId}:${targetEnv}:${Date.now()}`;

    const log = await strapi.documents(LOG_UID).create({
      data: {
        contentType,
        documentId,
        locale:          locale ?? null,
        sourceEnv,
        targetEnv,
        targetUrl,
        status:          'pending',
        conflictStrategy,
        isDryRun,
        payload:         payload ? _truncatePayload(payload) : null,
        triggeredBy:     triggeredByAdminId ? { connect: [{ id: triggeredByAdminId }] } : undefined,
        triggeredAt:     new Date().toISOString(),
        idempotencyKey,
        retryCount:      0,
      },
    });

    strapi.log.debug(`[env-sync] Log created: ${log.documentId} for ${contentType}#${documentId} → ${targetEnv}`);
    return log;
  },

  /**
   * Mark a log entry as in_progress.
   *
   * @param {string} logDocumentId
   * @returns {Promise<object>}
   */
  async markInProgress(logDocumentId) {
    return strapi.documents(LOG_UID).update({
      documentId: logDocumentId,
      data: { status: 'in_progress' },
    });
  },

  /**
   * Mark a log entry as successful.
   *
   * @param {string} logDocumentId
   * @param {object} params
   * @param {object}  params.diffSummary
   * @param {string|null} params.snapshotId
   * @param {number}  params.duration      - milliseconds
   * @param {number}  params.retryCount
   * @returns {Promise<object>}
   */
  async markSuccess(logDocumentId, { diffSummary, snapshotId, duration, retryCount }) {
    return strapi.documents(LOG_UID).update({
      documentId: logDocumentId,
      data: {
        status:       'success',
        diffSummary,
        snapshotId:   snapshotId ?? null,
        duration,
        retryCount:   retryCount ?? 0,
        completedAt:  new Date().toISOString(),
        errorMessage: null,
        errorStack:   null,
      },
    });
  },

  /**
   * Mark a log entry as failed.
   *
   * @param {string} logDocumentId
   * @param {object} params
   * @param {Error|string} params.error
   * @param {number} params.duration
   * @param {number} params.retryCount
   * @returns {Promise<object>}
   */
  async markFailed(logDocumentId, { error, duration, retryCount }) {
    const isError   = error instanceof Error;
    const message   = isError ? error.message : String(error);
    const stack     = isError ? error.stack   : null;
    const isProd    = process.env.NODE_ENV === 'production';

    return strapi.documents(LOG_UID).update({
      documentId: logDocumentId,
      data: {
        status:       'failed',
        errorMessage: message,
        errorStack:   isProd ? null : stack,   // Never expose stacks in production
        duration,
        retryCount:   retryCount ?? 0,
        completedAt:  new Date().toISOString(),
      },
    });
  },

  /**
   * Mark a log entry as dry_run completed.
   *
   * @param {string} logDocumentId
   * @param {object} params
   * @param {object} params.diffSummary
   * @param {number} params.duration
   * @returns {Promise<object>}
   */
  async markDryRun(logDocumentId, { diffSummary, duration }) {
    return strapi.documents(LOG_UID).update({
      documentId: logDocumentId,
      data: {
        status:      'dry_run',
        diffSummary,
        duration,
        completedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * Mark a log entry as rolled_back.
   *
   * @param {string} logDocumentId
   * @returns {Promise<object>}
   */
  async markRolledBack(logDocumentId) {
    return strapi.documents(LOG_UID).update({
      documentId: logDocumentId,
      data: {
        status:      'rolled_back',
        completedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * Increment the retry counter on a log entry.
   *
   * @param {string} logDocumentId
   * @param {number} retryCount
   * @returns {Promise<object>}
   */
  async updateRetryCount(logDocumentId, retryCount) {
    return strapi.documents(LOG_UID).update({
      documentId: logDocumentId,
      data: { retryCount },
    });
  },

  /**
   * Retrieve paginated log entries with optional filters.
   *
   * @param {object} params
   * @param {object} params.filters     - Strapi filters object
   * @param {object} params.sort        - e.g. { triggeredAt: 'desc' }
   * @param {number} params.page
   * @param {number} params.pageSize
   * @returns {Promise<{ results: object[], pagination: object }>}
   */
  async findLogs({ filters = {}, sort = { triggeredAt: 'desc' }, page = 1, pageSize = 25 } = {}) {
    return strapi.documents(LOG_UID).findMany({
      filters,
      sort,
      populate:   ['triggeredBy'],
      pagination: { page, pageSize },
    });
  },

  /**
   * Retrieve a single log entry by its documentId.
   *
   * @param {string} logDocumentId
   * @returns {Promise<object|null>}
   */
  async findLog(logDocumentId) {
    return strapi.documents(LOG_UID).findOne({
      documentId: logDocumentId,
      populate:   ['triggeredBy'],
    });
  },

  /**
   * Count log entries matching given filters — used for pagination metadata.
   *
   * @param {object} filters
   * @returns {Promise<number>}
   */
  async countLogs(filters = {}) {
    return strapi.documents(LOG_UID).count({ filters });
  },

  /**
   * Check whether there is already an in-progress sync for a given document
   * to the same target — used to detect concurrent sync attempts.
   *
   * @param {string} documentId
   * @param {string} targetEnv
   * @returns {Promise<boolean>}
   */
  async isAlreadyInProgress(documentId, targetEnv) {
    const count = await strapi.documents(LOG_UID).count({
      filters: {
        documentId,
        targetEnv,
        status: { $in: ['pending', 'in_progress'] },
      },
    });
    return count > 0;
  },

  /**
   * Export logs to a flat array suitable for CSV serialisation.
   *
   * @param {object} filters
   * @returns {Promise<object[]>}
   */
  async exportLogs(filters = {}) {
    const logs = await strapi.documents(LOG_UID).findMany({
      filters,
      sort:     { triggeredAt: 'desc' },
      populate: ['triggeredBy'],
      pagination: { page: 1, pageSize: 10_000 },
    });

    return logs.map((log) => ({
      id:               log.id,
      documentId:       log.documentId,
      contentType:      log.contentType,
      sourceEnv:        log.sourceEnv,
      targetEnv:        log.targetEnv,
      status:           log.status,
      isDryRun:         log.isDryRun,
      conflictStrategy: log.conflictStrategy,
      locale:           log.locale ?? '',
      triggeredBy:      log.triggeredBy
        ? `${log.triggeredBy.firstname} ${log.triggeredBy.lastname} <${log.triggeredBy.email}>`
        : 'unknown',
      triggeredAt:      log.triggeredAt,
      completedAt:      log.completedAt ?? '',
      duration:         log.duration != null ? `${log.duration}ms` : '',
      retryCount:       log.retryCount,
      errorMessage:     log.errorMessage ?? '',
      fieldsChanged:    log.diffSummary?.fieldsChanged?.join(', ') ?? '',
      mediaReuploaded:  log.diffSummary?.mediaReuploaded?.length ?? 0,
      localesSynced:    log.diffSummary?.localesSynced?.join(', ') ?? '',
    }));
  },
});

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Truncate large payload objects to avoid bloating the DB.
 * Keeps the payload for debugging, but limits it to ~512 KB.
 *
 * @param {object} payload
 * @returns {object}
 */
function _truncatePayload(payload) {
  try {
    const json = JSON.stringify(payload);
    if (json.length <= 524_288) return payload;  // 512 KB
    return { _truncated: true, _originalSize: json.length, preview: json.slice(0, 1000) };
  } catch {
    return { _truncationError: true };
  }
}
