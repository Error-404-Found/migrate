'use strict';

/**
 * Plugin configuration schema with validation and defaults.
 *
 * Users define this in their Strapi project at:
 *   config/plugins.js  →  'env-sync': { enabled: true, config: { ... } }
 *
 * @module env-sync/server/config
 */

const ENV_VALUES = ['SIT', 'QA', 'UAT', 'PROD'];

const CONFLICT_STRATEGIES = ['source-wins', 'target-wins', 'manual'];

module.exports = {
  default: {
    /** Which environment this Strapi instance represents. */
    currentEnv: 'SIT',

    /**
     * Map of target environment names → { url, secret }.
     * Only define targets that this env is allowed to push TO.
     *
     * Example:
     *   targets: {
     *     QA:   { url: 'https://qa.api.example.com',   secret: process.env.ENV_SYNC_QA_SECRET   },
     *     PROD: { url: 'https://prod.api.example.com', secret: process.env.ENV_SYNC_PROD_SECRET },
     *   }
     */
    targets: {},

    /** Global conflict resolution strategy (can be overridden per content-type). */
    conflictStrategy: 'source-wins',

    /**
     * Per-content-type overrides.
     * Key: Strapi UID (e.g. 'api::article.article')
     * Value: { conflictStrategy: '...' }
     */
    perContentType: {},

    /** HTTP request timeout in milliseconds for outbound sync calls. */
    requestTimeoutMs: 30_000,

    /** Number of retry attempts on transient network failures. */
    retryAttempts: 3,

    /** Maximum concurrent outbound sync requests (rate limiting). */
    maxConcurrentSyncs: 10,

    /** Enable dry-run mode (preview diffs without applying). */
    enableDryRun: true,

    /** Store snapshots before overwriting, enabling rollback. */
    enableRollback: true,

    /** Max rollback snapshots kept per document. Oldest are pruned. */
    maxSnapshotsPerDocument: 5,

    /**
     * Optional webhook for Slack / Teams notifications.
     * Set to null to disable.
     *
     * webhook: {
     *   url: 'https://hooks.slack.com/services/...',
     *   onSuccess: true,
     *   onFailure: true,
     * }
     */
    webhook: null,

    /** Log level: 'error' | 'warn' | 'info' | 'debug' */
    logLevel: 'info',
  },

  /**
   * Joi-style validator called by Strapi at boot.
   * Throws if the user's config is invalid.
   *
   * @param {object} config - merged plugin config
   * @throws {Error} on invalid configuration
   */
  validator(config) {
    if (!ENV_VALUES.includes(config.currentEnv)) {
      throw new Error(
        `[env-sync] Invalid currentEnv "${config.currentEnv}". Must be one of: ${ENV_VALUES.join(', ')}`
      );
    }

    if (typeof config.targets !== 'object' || Array.isArray(config.targets)) {
      throw new Error('[env-sync] "targets" must be a plain object.');
    }

    for (const [envName, target] of Object.entries(config.targets)) {
      if (!ENV_VALUES.includes(envName)) {
        throw new Error(
          `[env-sync] Invalid target env key "${envName}". Must be one of: ${ENV_VALUES.join(', ')}`
        );
      }
      if (!target.url || typeof target.url !== 'string') {
        throw new Error(`[env-sync] Target "${envName}" must have a valid "url" string.`);
      }
      if (!target.secret || typeof target.secret !== 'string') {
        throw new Error(
          `[env-sync] Target "${envName}" must have a "secret" string. ` +
          `Use an environment variable, e.g. process.env.ENV_SYNC_${envName}_SECRET`
        );
      }
    }

    if (!CONFLICT_STRATEGIES.includes(config.conflictStrategy)) {
      throw new Error(
        `[env-sync] Invalid conflictStrategy "${config.conflictStrategy}". ` +
        `Must be one of: ${CONFLICT_STRATEGIES.join(', ')}`
      );
    }

    if (typeof config.perContentType === 'object') {
      for (const [uid, override] of Object.entries(config.perContentType)) {
        if (override.conflictStrategy && !CONFLICT_STRATEGIES.includes(override.conflictStrategy)) {
          throw new Error(
            `[env-sync] Invalid conflictStrategy for "${uid}": "${override.conflictStrategy}".`
          );
        }
      }
    }

    if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 300_000) {
      throw new Error('[env-sync] requestTimeoutMs must be between 1000 and 300000.');
    }

    if (config.retryAttempts < 0 || config.retryAttempts > 10) {
      throw new Error('[env-sync] retryAttempts must be between 0 and 10.');
    }

    if (config.maxConcurrentSyncs < 1 || config.maxConcurrentSyncs > 50) {
      throw new Error('[env-sync] maxConcurrentSyncs must be between 1 and 50.');
    }

    if (config.webhook !== null && config.webhook !== undefined) {
      if (!config.webhook.url || typeof config.webhook.url !== 'string') {
        throw new Error('[env-sync] webhook.url must be a valid URL string.');
      }
    }
  },
};
