'use strict';

/**
 * Plugin bootstrap lifecycle.
 *
 * Runs AFTER Strapi has finished loading all plugins and content types.
 * Used to:
 *  1. Validate plugin configuration.
 *  2. Create the "Reviewer" admin role if it doesn't exist.
 *  3. Assign plugin RBAC permissions to the Reviewer role.
 *  4. Warm up target environment health checks.
 *  5. Log startup summary.
 *
 * @module env-sync/server/bootstrap
 */

const PLUGIN_ID      = 'env-sync';
const REVIEWER_ROLE  = 'Reviewer';

/**
 * RBAC action UIDs granted to the Reviewer role by default.
 * Super Admin automatically gets everything.
 */
const REVIEWER_DEFAULT_ACTIONS = [
  `plugin::${PLUGIN_ID}.trigger`,
  `plugin::${PLUGIN_ID}.view-logs`,
  `plugin::${PLUGIN_ID}.dry-run`,
];

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = async ({ strapi }) => {
  const pluginConfig = strapi.config.get(`plugin::${PLUGIN_ID}`);

  // ── 1. Validate config ─────────────────────────────────────────────────────
  _validateConfig(pluginConfig, strapi);

  // ── 2. Ensure "Reviewer" role exists ──────────────────────────────────────
  await _ensureReviewerRole(strapi);

  // ── 3. Assign RBAC permissions to Reviewer ────────────────────────────────
  await _assignReviewerPermissions(strapi);

  // ── 4. Warm-up: async health checks (non-blocking) ────────────────────────
  _scheduleHealthChecks(strapi, pluginConfig);

  // ── 5. Startup summary ────────────────────────────────────────────────────
  _logStartupSummary(strapi, pluginConfig);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate critical config values at bootstrap time (belt-and-suspenders
 * after the config validator runs at load time).
 *
 * @param {object} config
 * @param {import('@strapi/strapi').Strapi} strapi
 */
function _validateConfig(config, strapi) {
  if (!config) {
    strapi.log.warn(
      '[env-sync] No plugin configuration found. ' +
      'Add env-sync config to config/plugins.js'
    );
    return;
  }

  const { currentEnv, targets } = config;

  // Warn if QA/UAT share DB but someone accidentally added a QA→UAT target
  if (currentEnv === 'QA' && targets?.UAT) {
    strapi.log.warn(
      '[env-sync] QA → UAT target is configured, but QA and UAT share the same ' +
      'database. This target will be ignored to prevent data corruption.'
    );
  }
  if (currentEnv === 'UAT' && targets?.QA) {
    strapi.log.warn(
      '[env-sync] UAT → QA target is configured, but QA and UAT share the same ' +
      'database. This target will be ignored.'
    );
  }

  // Warn if currentEnv is PROD but targets are defined (PROD should not push)
  if (currentEnv === 'PROD' && targets && Object.keys(targets).length > 0) {
    strapi.log.warn(
      '[env-sync] PROD environment has outbound sync targets configured. ' +
      'PROD is typically the final destination and should not push to other envs.'
    );
  }
}

/**
 * Create the "Reviewer" admin role if it does not already exist.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 */
async function _ensureReviewerRole(strapi) {
  try {
    const roleService = strapi.admin?.services?.role;
    if (!roleService) {
      strapi.log.warn('[env-sync] Admin role service not available — skipping Reviewer role creation.');
      return;
    }

    const existing = await roleService.findOne({ name: REVIEWER_ROLE });
    if (existing) {
      strapi.log.debug(`[env-sync] "${REVIEWER_ROLE}" role already exists (id: ${existing.id}).`);
      return;
    }

    const created = await roleService.create({
      name:        REVIEWER_ROLE,
      description: 'Can trigger environment content syncs and view sync logs. Managed by strapi-plugin-env-sync.',
    });

    strapi.log.info(`[env-sync] Created admin role "${REVIEWER_ROLE}" (id: ${created.id}).`);
  } catch (err) {
    strapi.log.error(`[env-sync] Failed to create "${REVIEWER_ROLE}" role: ${err.message}`);
  }
}

/**
 * Assign default RBAC permissions to the Reviewer role.
 * Only adds permissions that are not yet assigned — idempotent.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 */
async function _assignReviewerPermissions(strapi) {
  try {
    const roleService       = strapi.admin?.services?.role;
    const permissionService = strapi.admin?.services?.permission;

    if (!roleService || !permissionService) {
      strapi.log.warn('[env-sync] Cannot assign Reviewer permissions — admin services unavailable.');
      return;
    }

    const reviewerRole = await roleService.findOne({ name: REVIEWER_ROLE });
    if (!reviewerRole) return;

    // Fetch actions already assigned to this role
    const existingPermissions = await permissionService.findMany({
      where: { role: reviewerRole.id },
    });
    const existingActions = new Set(existingPermissions.map((p) => p.action));

    // Build the list of permissions to add
    const toAdd = REVIEWER_DEFAULT_ACTIONS
      .filter((action) => !existingActions.has(action))
      .map((action) => ({
        action,
        subject:    null,
        properties: {},
        conditions: [],
        role:       reviewerRole.id,
      }));

    if (toAdd.length === 0) {
      strapi.log.debug('[env-sync] Reviewer role permissions are already up-to-date.');
      return;
    }

    await permissionService.createMany(toAdd);
    strapi.log.info(
      `[env-sync] Assigned ${toAdd.length} permission(s) to "${REVIEWER_ROLE}" role: ` +
      toAdd.map((p) => p.action).join(', ')
    );
  } catch (err) {
    strapi.log.error(`[env-sync] Failed to assign Reviewer permissions: ${err.message}`);
  }
}

/**
 * Fire async health checks against all configured target environments.
 * Results are cached in the health-check service and surfaced in the admin UI.
 * This is non-blocking — bootstrap does not wait for results.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {object} config
 */
function _scheduleHealthChecks(strapi, config) {
  if (!config?.targets || Object.keys(config.targets).length === 0) return;

  // Defer to next tick so bootstrap completes cleanly
  setImmediate(async () => {
    try {
      const healthService = strapi.plugin(PLUGIN_ID).service('health');
      if (healthService?.checkAll) {
        await healthService.checkAll();
      }
    } catch (err) {
      strapi.log.warn(`[env-sync] Startup health checks failed: ${err.message}`);
    }
  });
}

/**
 * Log a startup summary to help operators verify configuration.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {object} config
 */
function _logStartupSummary(strapi, config) {
  if (!config) return;

  const targetCount = config.targets ? Object.keys(config.targets).length : 0;
  const targetNames = targetCount > 0 ? Object.keys(config.targets).join(', ') : 'none';

  strapi.log.info(
    `[env-sync] ✓ Plugin ready | env: ${config.currentEnv} | ` +
    `targets: [${targetNames}] | strategy: ${config.conflictStrategy} | ` +
    `rollback: ${config.enableRollback ? 'on' : 'off'} | ` +
    `dryRun: ${config.enableDryRun ? 'on' : 'off'}`
  );
}
