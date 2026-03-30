'use strict';

/**
 * Content API routes — public-ish but protected by verify-sync-token middleware.
 * These are called machine-to-machine between Strapi environments.
 *
 * @module env-sync/server/routes/content-api
 */

module.exports = {
  type: 'content-api',
  routes: [

    // ── Inbound Sync Receiver ─────────────────────────────────────────────
    {
      method:  'POST',
      path:    '/env-sync/receive',
      handler: 'receive.receive',
      config: {
        auth:        false, // Auth handled by verify-sync-token middleware
        middlewares: ['plugin::env-sync.verify-sync-token'],
        description: 'Receive and apply an incoming sync payload from a source environment',
      },
    },

    // ── Peek (pre-sync diff data) ─────────────────────────────────────────
    {
      method:  'POST',
      path:    '/env-sync/peek',
      handler: 'receive.peek',
      config: {
        auth:        false,
        middlewares: ['plugin::env-sync.verify-sync-token'],
        description: 'Fetch current document state for pre-sync diffing',
      },
    },

    // ── Health check (called by source env) ───────────────────────────────
    {
      method:  'GET',
      path:    '/env-sync/health',
      handler: 'health.check',
      config: {
        auth:        false,
        middlewares: ['plugin::env-sync.verify-sync-token'],
        description: 'Prove this environment is reachable and the sync token is valid',
      },
    },
  ],
};
