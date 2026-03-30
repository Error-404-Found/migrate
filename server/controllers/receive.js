'use strict';

/**
 * Receive Controller — Inbound
 *
 * Exposed on the TARGET environment. Accepts payloads from source environments
 * and writes them to the local database via payload-writer service.
 *
 * Protected by `verify-sync-token` middleware (Bearer token).
 *
 * @module env-sync/server/controllers/receive
 */

const PLUGIN_ID = 'env-sync';

const REQUIRED_PAYLOAD_FIELDS = ['contentType', 'documentId', 'locales'];
const VALID_ENVS               = ['SIT', 'QA', 'UAT', 'PROD'];
const VALID_STRATEGIES         = ['source-wins', 'target-wins', 'manual'];

module.exports = {

  /**
   * POST /api/env-sync/receive
   *
   * Receives a full document payload from the source environment and applies it.
   *
   * Body: {
   *   contentType, documentId, locales, localesSynced,
   *   mediaManifest, conflictStrategy, sourceEnv, triggeredAt, logId
   * }
   */
  async receive(ctx) {
    const body = ctx.request.body;

    // ── 1. Validate presence of required fields ──────────────────────────
    for (const field of REQUIRED_PAYLOAD_FIELDS) {
      if (!body[field]) {
        return ctx.badRequest('Missing required field: ' + field);
      }
    }

    const {
      contentType,
      documentId,
      locales,
      localesSynced    = [],
      mediaManifest    = [],
      conflictStrategy = 'source-wins',
      sourceEnv,
      logId,
    } = body;

    // ── 2. Validate field values ──────────────────────────────────────────
    if (typeof contentType !== 'string' || !contentType.includes('::')) {
      return ctx.badRequest('Invalid contentType format. Expected "api::name.name".');
    }
    if (typeof documentId !== 'string' || documentId.length < 1) {
      return ctx.badRequest('Invalid documentId.');
    }
    if (typeof locales !== 'object' || Array.isArray(locales)) {
      return ctx.badRequest('locales must be an object keyed by locale code.');
    }
    if (sourceEnv && !VALID_ENVS.includes(sourceEnv)) {
      return ctx.badRequest('Invalid sourceEnv: ' + sourceEnv);
    }
    if (!VALID_STRATEGIES.includes(conflictStrategy)) {
      return ctx.badRequest('Invalid conflictStrategy: ' + conflictStrategy);
    }

    // ── 3. Validate contentType exists on this Strapi instance ───────────
    try {
      strapi.getModel(contentType);
    } catch {
      return ctx.badRequest('Content type "' + contentType + '" does not exist on this environment.');
    }

    // ── 4. Guard: QA/UAT same-DB protection ──────────────────────────────
    const localEnv = strapi.config.get('plugin::' + PLUGIN_ID + '.currentEnv');
    if (_isSameDatabase(sourceEnv, localEnv)) {
      return ctx.badRequest(
        'QA and UAT share the same database. Sync between these environments is not permitted.'
      );
    }

    strapi.log.info(
      '[env-sync] Receiving sync: ' + contentType + '#' + documentId +
      ' from ' + (sourceEnv || 'unknown') + ' (locales: ' + Object.keys(locales).join(', ') + ')'
    );

    // ── 5. Apply payload ──────────────────────────────────────────────────
    const payloadWriter = strapi.plugin(PLUGIN_ID).service('payloadWriter');

    const writeResult = await payloadWriter.applyPayload({
      contentType,
      documentId,
      locales,
      localesSynced,
      mediaManifest,
      conflictStrategy,
      sourceEnv,
      logId,
      triggeredByAdminId: null, // inbound — no local admin context
    });

    strapi.log.info(
      '[env-sync] ✓ Write complete: ' + contentType + '#' + documentId +
      ' | snapshot: ' + (writeResult.snapshotId || 'none') +
      ' | brokenRelations: ' + writeResult.brokenRelations.length
    );

    ctx.status = 200;
    ctx.body = {
      success:         writeResult.success,
      snapshotId:      writeResult.snapshotId,
      localesWritten:  writeResult.localesWritten,
      brokenRelations: writeResult.brokenRelations,
      warnings:        writeResult.brokenRelations.length > 0
        ? writeResult.brokenRelations.map((r) => 'Relation not found: ' + r.path + ' → ' + r.documentId)
        : [],
    };
  },

  /**
   * POST /api/env-sync/peek
   *
   * Returns the current state of a document on this env (used for pre-sync diff).
   * Protected by the same Bearer token middleware.
   *
   * Body: { contentType, documentId }
   */
  async peek(ctx) {
    const { contentType, documentId } = ctx.request.body;

    if (!contentType || !documentId) {
      return ctx.badRequest('contentType and documentId are required.');
    }

    try {
      strapi.getModel(contentType);
    } catch {
      return ctx.notFound('Content type not found: ' + contentType);
    }

    try {
      const doc = await strapi.documents(contentType).findOne({
        documentId,
        populate: '*',
      });

      if (!doc) {
        ctx.status = 404;
        ctx.body   = { document: null };
        return;
      }

      ctx.status = 200;
      ctx.body   = { document: doc };
    } catch (err) {
      strapi.log.error('[env-sync] peek error: ' + err.message);
      ctx.status = 500;
      ctx.body   = { error: { message: 'Failed to retrieve document: ' + err.message } };
    }
  },
};

function _isSameDatabase(envA, envB) {
  const SHARED = new Set(['QA', 'UAT']);
  return SHARED.has(envA) && SHARED.has(envB);
}
