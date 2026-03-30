'use strict';

/**
 * RBAC Policies for strapi-plugin-env-sync.
 *
 * These are used in admin routes to enforce that only:
 *  - Super Admins, or
 *  - Users with the "Reviewer" role
 * can trigger syncs or view logs.
 *
 * @module env-sync/server/policies
 */

const PLUGIN_ID = 'env-sync';

/**
 * canTriggerSync — checks plugin::env-sync.trigger permission.
 * Applied to POST /api/env-sync/trigger.
 */
const canTriggerSync = async (policyContext, config, { strapi }) => {
  const { state } = policyContext;
  const admin     = state?.admin;

  if (!admin) return false;

  // Super admins bypass all checks
  if (admin.roles?.some((r) => r.code === 'strapi-super-admin')) return true;

  return _hasPermission(strapi, admin.id, `plugin::${PLUGIN_ID}.trigger`);
};

/**
 * canViewLogs — checks plugin::env-sync.view-logs permission.
 * Applied to GET /api/env-sync/logs.
 */
const canViewLogs = async (policyContext, config, { strapi }) => {
  const { state } = policyContext;
  const admin     = state?.admin;

  if (!admin) return false;
  if (admin.roles?.some((r) => r.code === 'strapi-super-admin')) return true;

  return _hasPermission(strapi, admin.id, `plugin::${PLUGIN_ID}.view-logs`);
};

/**
 * canRollback — checks plugin::env-sync.rollback permission.
 * Applied to POST /api/env-sync/rollback.
 */
const canRollback = async (policyContext, config, { strapi }) => {
  const { state } = policyContext;
  const admin     = state?.admin;

  if (!admin) return false;
  if (admin.roles?.some((r) => r.code === 'strapi-super-admin')) return true;

  return _hasPermission(strapi, admin.id, `plugin::${PLUGIN_ID}.rollback`);
};

/**
 * canDryRun — checks plugin::env-sync.dry-run permission.
 */
const canDryRun = async (policyContext, config, { strapi }) => {
  const { state } = policyContext;
  const admin     = state?.admin;

  if (!admin) return false;
  if (admin.roles?.some((r) => r.code === 'strapi-super-admin')) return true;

  return _hasPermission(strapi, admin.id, `plugin::${PLUGIN_ID}.dry-run`);
};

module.exports = {
  canTriggerSync,
  canViewLogs,
  canRollback,
  canDryRun,
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Check if an admin user has a specific permission action.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {number} adminId
 * @param {string} action
 * @returns {Promise<boolean>}
 */
async function _hasPermission(strapi, adminId, action) {
  try {
    const permissionService = strapi.admin?.services?.permission;
    if (!permissionService) return false;

    const permissions = await permissionService.findMany({
      where: {
        action,
        role: {
          users: { id: adminId },
        },
      },
    });

    return permissions.length > 0;
  } catch (err) {
    strapi.log.warn(`[env-sync] Permission check failed for admin ${adminId}: ${err.message}`);
    return false;
  }
}
