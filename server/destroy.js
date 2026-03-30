'use strict';

/**
 * Plugin destroy lifecycle.
 *
 * Called when Strapi is shutting down or the plugin is unloaded.
 * Used to:
 *  - Drain any in-progress sync queue gracefully
 *  - Clear cached health-check intervals
 *
 * @module env-sync/server/destroy
 */

const PLUGIN_ID = 'env-sync';

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = async ({ strapi }) => {
  try {
    // Drain the sync queue so in-flight syncs can finish (up to 5s)
    const syncEngine = strapi.plugin(PLUGIN_ID).service('syncEngine');
    if (syncEngine?.drain) {
      await Promise.race([
        syncEngine.drain(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    // Stop any periodic health-check timers
    const healthService = strapi.plugin(PLUGIN_ID).service('health');
    if (healthService?.destroy) {
      healthService.destroy();
    }

    strapi.log.info('[env-sync] Plugin shut down cleanly.');
  } catch (err) {
    strapi.log.warn(`[env-sync] Error during plugin destroy: ${err.message}`);
  }
};
