'use strict';

/**
 * Services index for strapi-plugin-env-sync.
 *
 * All services are registered here and accessible via:
 *   strapi.plugin('env-sync').service('serviceName')
 *
 * @module env-sync/server/services
 */

const syncEngine       = require('./sync-engine');
const payloadWriter    = require('./payload-writer');
const mediaSync        = require('./media-sync');
const relationResolver = require('./relation-resolver');
const diffEngine       = require('./diff-engine');
const rollback         = require('./rollback');
const logger           = require('./logger');
const health           = require('./health');

module.exports = {
  syncEngine,
  payloadWriter,
  mediaSync,
  relationResolver,
  diffEngine,
  rollback,
  logger,
  health,
};
