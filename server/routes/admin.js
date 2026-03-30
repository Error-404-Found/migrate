'use strict';

/**
 * Admin routes — require Strapi admin JWT authentication.
 * RBAC policies applied per-route to enforce Super Admin / Reviewer access.
 *
 * @module env-sync/server/routes/admin
 */

module.exports = {
  type: 'admin',
  routes: [

    // ── Sync Trigger ──────────────────────────────────────────────────────
    {
      method:  'POST',
      path:    '/env-sync/trigger',
      handler: 'sync.trigger',
      config: {
        policies: ['plugin::env-sync.canTriggerSync'],
        description: 'Trigger an on-demand content sync to a target environment',
      },
    },

    // ── Plugin Config (read-only, any authenticated admin) ────────────────
    {
      method:  'GET',
      path:    '/env-sync/config',
      handler: 'sync.getConfig',
      config: {
        policies: [],
        description: 'Get sanitised plugin configuration for the admin UI',
      },
    },

    // ── Audit Logs ────────────────────────────────────────────────────────
    {
      method:  'GET',
      path:    '/env-sync/logs',
      handler: 'logs.find',
      config: {
        policies: ['plugin::env-sync.canViewLogs'],
        description: 'Retrieve paginated sync audit logs',
      },
    },
    {
      method:  'GET',
      path:    '/env-sync/logs/export',
      handler: 'logs.exportCsv',
      config: {
        policies: ['plugin::env-sync.canViewLogs'],
        description: 'Export sync audit logs as CSV',
      },
    },
    {
      method:  'GET',
      path:    '/env-sync/logs/:documentId',
      handler: 'logs.findOne',
      config: {
        policies: ['plugin::env-sync.canViewLogs'],
        description: 'Retrieve a single sync audit log entry',
      },
    },

    // ── Rollback ──────────────────────────────────────────────────────────
    {
      method:  'POST',
      path:    '/env-sync/rollback',
      handler: 'logs.rollback',
      config: {
        policies: ['plugin::env-sync.canRollback'],
        description: 'Restore a document from a pre-sync snapshot',
      },
    },

    // ── Health / Status ───────────────────────────────────────────────────
    {
      method:  'GET',
      path:    '/env-sync/status',
      handler: 'health.status',
      config: {
        policies: [],
        description: 'Get cached reachability status of all target environments',
      },
    },
    {
      method:  'POST',
      path:    '/env-sync/status/refresh',
      handler: 'health.refresh',
      config: {
        policies: [],
        description: 'Force a health re-check of all configured target environments',
      },
    },
  ],
};
