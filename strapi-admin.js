/**
 * strapi-plugin-env-sync — Admin Entry Point
 *
 * Registers the plugin in the Strapi v5 admin panel:
 *  - Adds "Env Sync" menu item → Logs page
 *  - Injects SyncButton into every Content Manager edit view
 *
 * @module strapi-plugin-env-sync/strapi-admin
 */

import { PLUGIN_ID, PLUGIN_ICON, Initializer } from './admin/src/index';

export default {
  register(app) {
    // ── Menu item → Logs page ───────────────────────────────────────────
    app.addMenuLink({
      to:        '/plugins/' + PLUGIN_ID,
      icon:      PLUGIN_ICON,
      intlLabel: { id: PLUGIN_ID + '.menu.label', defaultMessage: 'Env Sync' },
      Component: async () => {
        const { LogsPage } = await import('./admin/src/pages/LogsPage');
        return { default: LogsPage };
      },
      permissions: [
        { action: 'plugin::' + PLUGIN_ID + '.view-logs', subject: null },
      ],
    });

    // ── Admin router entry ───────────────────────────────────────────────
    app.router.addRoute({
      path:      '/plugins/' + PLUGIN_ID,
      exact:     true,
      Component: async () => {
        const { LogsPage } = await import('./admin/src/pages/LogsPage');
        return { default: LogsPage };
      },
    });

    // ── Initializer ──────────────────────────────────────────────────────
    app.registerPlugin({
      id:          PLUGIN_ID,
      name:        PLUGIN_ID,
      initializer: Initializer,
    });
  },

  async bootstrap(app) {
    // ── Inject Sync Button into Content Manager edit view ────────────────
    app.injectContentManagerComponent('editView', 'right-links', {
      name:      PLUGIN_ID + '-sync-button',
      Component: async () => {
        const { SyncButton } = await import('./admin/src/components/SyncButton');
        return { default: SyncButton };
      },
    });
  },
};
