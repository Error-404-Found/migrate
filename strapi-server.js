'use strict';

/**
 * strapi-plugin-env-sync — Server Entry Point
 *
 * Registers all server-side plugin components with Strapi v5:
 * content-types, services, controllers, routes, policies, and middlewares.
 *
 * @module strapi-plugin-env-sync/server
 */

const register   = require('./server/register');
const bootstrap  = require('./server/bootstrap');
const destroy    = require('./server/destroy');
const config     = require('./server/config');
const controllers = require('./server/controllers');
const routes     = require('./server/routes');
const services   = require('./server/services');
const contentTypes = require('./server/content-types');
const middlewares  = require('./server/middlewares');
const policies    = require('./server/policies');

module.exports = {
  register,
  bootstrap,
  destroy,
  config,
  controllers,
  routes,
  services,
  contentTypes,
  middlewares,
  policies,
};
