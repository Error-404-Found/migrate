'use strict';

/**
 * Health Controller
 *
 * GET  /api/env-sync/health  — Inbound: proves this env is reachable (called by source)
 * GET  /api/env-sync/status  — Outbound: returns cached health of all configured targets
 *
 * @module env-sync/server/controllers/health
 */

const PLUGIN_ID = 'env-sync';

module.exports = {

  /**
   * GET /api/env-sync/health
   *
   * Called BY the source env TO this env to verify it is reachable and the token is valid.
   * Protected by verify-sync-token middleware.
   */
  async check(ctx) {
    const pluginConfig = strapi.config.get('plugin::' + PLUGIN_ID) || {};
    ctx.status = 200;
    ctx.body = {
      status:  'ok',
      env:     pluginConfig.currentEnv || 'unknown',
      version: require('../../package.json').version,
      ts:      new Date().toISOString(),
    };
  },

  /**
   * GET /api/env-sync/status
   *
   * Admin-only. Returns cached reachability status of all configured target envs.
   */
  async status(ctx) {
    const healthSvc = strapi.plugin(PLUGIN_ID).service('health');
    const cached    = healthSvc.getCachedStatus();

    ctx.status = 200;
    ctx.body   = {
      targets:   cached,
      checkedAt: new Date().toISOString(),
    };
  },

  /**
   * POST /api/env-sync/status/refresh
   *
   * Admin-only. Forces an immediate health re-check of all targets.
   */
  async refresh(ctx) {
    const healthSvc = strapi.plugin(PLUGIN_ID).service('health');
    const results   = await healthSvc.checkAll();

    ctx.status = 200;
    ctx.body   = { targets: results };
  },
};
