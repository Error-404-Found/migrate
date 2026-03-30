/**
 * Admin panel index — exports constants used by strapi-admin.js
 *
 * @module env-sync/admin/src/index
 */

export const PLUGIN_ID   = 'env-sync';
export const PLUGIN_ICON = 'refresh';

/**
 * Initializer — headless React component that signals plugin readiness.
 */
export const Initializer = ({ setPlugin }) => {
  setPlugin(PLUGIN_ID);
  return null;
};

export { SyncButton }  from './components/SyncButton';
export { LogsPage }    from './pages/LogsPage';
