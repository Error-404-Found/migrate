'use strict';

/**
 * Plugin register lifecycle.
 *
 * Runs BEFORE Strapi finishes loading. Used to:
 *  1. Register plugin-specific RBAC permission actions.
 *  2. Extend the admin user model if needed (none required here).
 *
 * @module env-sync/server/register
 */

const PLUGIN_ID = 'env-sync';

/**
 * RBAC actions exposed by this plugin.
 * Super Admins get all actions automatically.
 * The "Reviewer" role gets trigger + view-logs by default (set in bootstrap).
 */
const PLUGIN_ACTIONS = [
  {
    section:     'plugins',
    displayName: 'Trigger Sync',
    uid:         'trigger',
    pluginName:  PLUGIN_ID,
    subCategory: 'sync',
  },
  {
    section:     'plugins',
    displayName: 'View Sync Logs',
    uid:         'view-logs',
    pluginName:  PLUGIN_ID,
    subCategory: 'logs',
  },
  {
    section:     'plugins',
    displayName: 'Rollback Sync',
    uid:         'rollback',
    pluginName:  PLUGIN_ID,
    subCategory: 'sync',
  },
  {
    section:     'plugins',
    displayName: 'Dry Run Sync',
    uid:         'dry-run',
    pluginName:  PLUGIN_ID,
    subCategory: 'sync',
  },
];

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = async ({ strapi }) => {
  // ── Register RBAC actions ──────────────────────────────────────────────────
  if (strapi.admin?.services?.permission?.actionProvider) {
    await strapi.admin.services.permission.actionProvider.registerMany(PLUGIN_ACTIONS);
    strapi.log.info(`[env-sync] Registered ${PLUGIN_ACTIONS.length} RBAC actions.`);
  } else {
    strapi.log.warn(
      '[env-sync] Could not register RBAC actions — ' +
      'strapi.admin.services.permission.actionProvider not available. ' +
      'Ensure you are running Strapi v5.'
    );
  }
};
