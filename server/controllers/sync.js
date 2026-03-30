'use strict';

/**
 * Sync Controller — Outbound
 *
 * Handles admin-triggered sync requests from the source environment.
 * All routes here require admin authentication + RBAC policy check.
 *
 * @module env-sync/server/controllers/sync
 */

const PLUGIN_ID = 'env-sync';

module.exports = {

  /**
   * POST /api/env-sync/trigger
   * Body: { contentType, documentId, targetEnv, locale?, isDryRun?, conflictStrategyOverride? }
   */
  async trigger(ctx) {
    const adminUser = ctx.state.admin;

    const {
      contentType,
      documentId,
      targetEnv,
      locale                   = null,
      isDryRun                 = false,
      conflictStrategyOverride,
    } = ctx.request.body;

    const validationError = _validateTriggerInput({ contentType, documentId, targetEnv });
    if (validationError) return ctx.badRequest(validationError);

    const pluginConfig = strapi.config.get('plugin::' + PLUGIN_ID);
    const currentEnv   = pluginConfig?.currentEnv;

    if (!pluginConfig?.targets?.[targetEnv]) {
      return ctx.badRequest(
        'This environment ("' + currentEnv + '") is not configured to sync to "' + targetEnv + '". Check your plugin config.'
      );
    }

    if (isDryRun && !pluginConfig?.enableDryRun) {
      return ctx.badRequest('Dry-run mode is not enabled in plugin configuration.');
    }

    const validStrategies = ['source-wins', 'target-wins', 'manual'];
    if (conflictStrategyOverride && !validStrategies.includes(conflictStrategyOverride)) {
      return ctx.badRequest('Invalid conflictStrategyOverride "' + conflictStrategyOverride + '".');
    }

    strapi.log.info(
      '[env-sync] Sync triggered by admin ' + adminUser?.id + ' (' + adminUser?.email + '): ' +
      contentType + '#' + documentId + ' → ' + targetEnv + (isDryRun ? ' [DRY RUN]' : '')
    );

    const syncEngine = strapi.plugin(PLUGIN_ID).service('syncEngine');
    const result = await syncEngine.triggerSync({
      contentType, documentId, locale, targetEnv,
      triggeredByAdminId: adminUser?.id,
      isDryRun, conflictStrategyOverride,
    });

    if (!result.success && result.reason === 'error') {
      ctx.status = 500;
      return (ctx.body = { error: { message: result.message }, logId: result.logId });
    }

    ctx.status = result.success ? 200 : 409;
    ctx.body   = result;
  },

  /**
   * GET /api/env-sync/config
   * Returns sanitised plugin config (no secrets) for the admin UI.
   */
  async getConfig(ctx) {
    const pluginConfig = strapi.config.get('plugin::' + PLUGIN_ID) || {};
    ctx.body = {
      currentEnv:       pluginConfig.currentEnv,
      targets:          Object.keys(pluginConfig.targets || {}),
      conflictStrategy: pluginConfig.conflictStrategy,
      enableDryRun:     pluginConfig.enableDryRun,
      enableRollback:   pluginConfig.enableRollback,
      perContentType:   pluginConfig.perContentType || {},
    };
  },
};

function _validateTriggerInput({ contentType, documentId, targetEnv }) {
  if (!contentType || typeof contentType !== 'string') return 'contentType is required.';
  if (!documentId  || typeof documentId  !== 'string') return 'documentId is required.';
  if (!targetEnv   || typeof targetEnv   !== 'string') return 'targetEnv is required.';
  if (!['SIT','QA','UAT','PROD'].includes(targetEnv))  return 'targetEnv must be one of: SIT, QA, UAT, PROD';
  return null;
}
