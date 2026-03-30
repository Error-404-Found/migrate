'use strict';

/**
 * Health Check Service
 *
 * Pings each configured target environment's /api/env-sync/health endpoint
 * and caches the results. The admin UI polls these results to show
 * live connectivity status badges next to the sync button.
 *
 * @module env-sync/server/services/health
 */

const axios = require('axios');

const PLUGIN_ID       = 'env-sync';
const CACHE_TTL_MS    = 60_000;   // 1 minute
const CHECK_TIMEOUT   = 8_000;    // 8 seconds per check

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = ({ strapi }) => {
  /** In-memory cache: envName → { status, latencyMs, checkedAt, error } */
  const _cache = new Map();

  /** Interval handle for periodic background checks */
  let _intervalHandle = null;

  return {

    /**
     * Run health checks against all configured target environments.
     * Results are stored in the in-memory cache.
     *
     * @returns {Promise<object>} map of envName → result
     */
    async checkAll() {
      const config  = strapi.config.get(`plugin::${PLUGIN_ID}`);
      const targets = config?.targets || {};
      const results = {};

      await Promise.allSettled(
        Object.entries(targets).map(async ([envName, target]) => {
          const result        = await this._checkOne(envName, target);
          _cache.set(envName, result);
          results[envName]    = result;
        })
      );

      return results;
    },

    /**
     * Get cached health status for all target environments.
     * If a result is stale (> TTL), triggers a background refresh.
     *
     * @returns {object} map of envName → { status, latencyMs, checkedAt, error }
     */
    getCachedStatus() {
      const config  = strapi.config.get(`plugin::${PLUGIN_ID}`);
      const targets = config?.targets || {};
      const status  = {};

      for (const envName of Object.keys(targets)) {
        const cached = _cache.get(envName);
        if (!cached) {
          status[envName] = { status: 'unknown', latencyMs: null, checkedAt: null, error: null };
          // Trigger async check without blocking
          this._checkOne(envName, targets[envName]).then((r) => _cache.set(envName, r)).catch(() => {});
        } else {
          status[envName] = cached;
          // Refresh if stale
          const age = Date.now() - new Date(cached.checkedAt).getTime();
          if (age > CACHE_TTL_MS) {
            this._checkOne(envName, targets[envName]).then((r) => _cache.set(envName, r)).catch(() => {});
          }
        }
      }

      return status;
    },

    /**
     * Start periodic background health checks (every 60s).
     * Called from bootstrap if targets are configured.
     */
    startPeriodicChecks() {
      if (_intervalHandle) return; // Already running
      _intervalHandle = setInterval(() => {
        this.checkAll().catch((err) => {
          strapi.log.warn(`[env-sync] health: periodic check failed: ${err.message}`);
        });
      }, CACHE_TTL_MS);

      // Prevent the interval from keeping the process alive
      if (_intervalHandle.unref) _intervalHandle.unref();
    },

    /**
     * Stop periodic background health checks.
     * Called from plugin destroy.
     */
    destroy() {
      if (_intervalHandle) {
        clearInterval(_intervalHandle);
        _intervalHandle = null;
      }
    },

    /**
     * Perform a single health check against one target environment.
     *
     * @param {string} envName
     * @param {{ url: string, secret: string }} target
     * @returns {Promise<object>} health result
     */
    async _checkOne(envName, target) {
      const start = Date.now();

      try {
        const response = await axios.get(`${target.url}/api/env-sync/health`, {
          timeout: CHECK_TIMEOUT,
          headers: {
            Authorization: `Bearer ${target.secret}`,
            'x-env-sync-source': strapi.config.get(`plugin::${PLUGIN_ID}.currentEnv`),
          },
          validateStatus: (s) => s === 200,
        });

        return {
          status:    'reachable',
          latencyMs: Date.now() - start,
          checkedAt: new Date().toISOString(),
          error:     null,
          version:   response.data?.version || null,
          env:       response.data?.env || envName,
        };
      } catch (err) {
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const isUnreachable = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';

        strapi.log.warn(`[env-sync] health: ${envName} unreachable — ${err.message}`);

        return {
          status:    isTimeout ? 'timeout' : isUnreachable ? 'unreachable' : 'error',
          latencyMs: Date.now() - start,
          checkedAt: new Date().toISOString(),
          error:     err.message,
        };
      }
    },
  };
};
