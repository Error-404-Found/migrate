'use strict';

/**
 * Verify Sync Token Middleware
 *
 * Protects the inbound `/api/env-sync/receive` and `/api/env-sync/peek` endpoints.
 *
 * The source environment sends `Authorization: Bearer <secret>` where the secret
 * is the shared token configured in the RECEIVING environment's `config/plugins.js`
 * under `targets[sourceEnv].secret`.
 *
 * Security notes:
 *  - Uses `timingSafeEqual` to prevent timing attacks on the token comparison.
 *  - Logs all unauthorised attempts with source IP for audit purposes.
 *  - Never reveals why a request was rejected (always "Unauthorized").
 *
 * @module env-sync/server/middlewares/verify-sync-token
 */

const crypto = require('crypto');

const PLUGIN_ID = 'env-sync';

/**
 * Koa middleware factory.
 *
 * @param {object} config - plugin config (unused here, read from strapi.config)
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 * @returns {Function} Koa middleware
 */
module.exports = (config, { strapi }) => {
  return async function verifySyncToken(ctx, next) {
    const authHeader = ctx.request.headers['authorization'] || '';
    const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (!token) {
      _reject(ctx, strapi, 'Missing Authorization header');
      return;
    }

    // Identify the source environment from the custom header
    const sourceEnv = ctx.request.headers['x-env-sync-source'];
    const pluginConfig = strapi.config.get(`plugin::${PLUGIN_ID}`);

    // Find which target entry matches the claimed source env
    // (The *receiving* env stores its own secret — the source sends it)
    const validSecret = _resolveSecret(pluginConfig, sourceEnv);

    if (!validSecret) {
      _reject(ctx, strapi, `No secret configured for source env "${sourceEnv}"`);
      return;
    }

    // Timing-safe comparison to prevent timing attacks
    if (!_timingSafeEquals(token, validSecret)) {
      _reject(ctx, strapi, `Invalid token from source env "${sourceEnv}"`);
      return;
    }

    // Attach source env to context for use in controllers
    ctx.state.syncSourceEnv = sourceEnv;

    await next();
  };
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the expected secret for an incoming request.
 *
 * The receiving env's config defines its OWN secret under each source env key.
 * Example: on QA env, `targets.SIT.secret` is the token SIT must send.
 *
 * @param {object} config
 * @param {string} sourceEnv
 * @returns {string|null}
 */
function _resolveSecret(config, sourceEnv) {
  if (!config?.targets) return null;

  // Look for the source env key in our targets config
  // (The receiving env lists what source envs are allowed to push to it)
  const targetEntry = config.targets[sourceEnv];
  return targetEntry?.secret || null;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _timingSafeEquals(a, b) {
  try {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      // Still do a comparison to avoid length-based timing leak
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Reject the request with a generic 401 and log the attempt.
 *
 * @param {import('koa').Context} ctx
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} reason - internal reason (NOT sent to client)
 */
function _reject(ctx, strapi, reason) {
  const ip = ctx.request.ip || ctx.request.headers['x-forwarded-for'] || 'unknown';
  strapi.log.warn(`[env-sync] Unauthorized sync attempt from ${ip}: ${reason}`);

  ctx.status = 401;
  ctx.body   = { error: { status: 401, name: 'UnauthorizedError', message: 'Unauthorized' } };
}
