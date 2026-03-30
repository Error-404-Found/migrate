'use strict';

/**
 * Content-type registrations for strapi-plugin-env-sync.
 * Both types are hidden from the Content Manager and Content-Type Builder UI.
 *
 * @module env-sync/server/content-types
 */

const envSyncLog      = require('./env-sync-log/schema.json');
const envSyncSnapshot = require('./env-sync-snapshot/schema.json');

module.exports = {
  'env-sync-log':      { schema: envSyncLog },
  'env-sync-snapshot': { schema: envSyncSnapshot },
};
