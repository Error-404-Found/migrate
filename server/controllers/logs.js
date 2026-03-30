'use strict';

/**
 * Logs Controller
 *
 * CRUD and export endpoints for the sync audit log.
 * Rollback is also triggered from here.
 *
 * @module env-sync/server/controllers/logs
 */

const PLUGIN_ID = 'env-sync';

module.exports = {

  /**
   * GET /api/env-sync/logs
   * Query params: page, pageSize, status, sourceEnv, targetEnv, contentType, dateFrom, dateTo
   */
  async find(ctx) {
    const {
      page        = 1,
      pageSize    = 25,
      status,
      sourceEnv,
      targetEnv,
      contentType,
      dateFrom,
      dateTo,
    } = ctx.query;

    const filters = {};
    if (status)      filters.status      = status;
    if (sourceEnv)   filters.sourceEnv   = sourceEnv;
    if (targetEnv)   filters.targetEnv   = targetEnv;
    if (contentType) filters.contentType = { $containsi: contentType };
    if (dateFrom || dateTo) {
      filters.triggeredAt = {};
      if (dateFrom) filters.triggeredAt.$gte = new Date(dateFrom).toISOString();
      if (dateTo)   filters.triggeredAt.$lte = new Date(dateTo).toISOString();
    }

    const loggerSvc = strapi.plugin(PLUGIN_ID).service('logger');

    const [results, total] = await Promise.all([
      loggerSvc.findLogs({
        filters,
        sort:     { triggeredAt: 'desc' },
        page:     Number(page),
        pageSize: Math.min(Number(pageSize), 100),
      }),
      loggerSvc.countLogs(filters),
    ]);

    ctx.body = {
      data:       results,
      pagination: {
        page:      Number(page),
        pageSize:  Number(pageSize),
        total,
        pageCount: Math.ceil(total / Number(pageSize)),
      },
    };
  },

  /**
   * GET /api/env-sync/logs/:documentId
   */
  async findOne(ctx) {
    const { documentId } = ctx.params;
    const loggerSvc = strapi.plugin(PLUGIN_ID).service('logger');
    const log = await loggerSvc.findLog(documentId);

    if (!log) return ctx.notFound('Log entry not found.');
    ctx.body = { data: log };
  },

  /**
   * POST /api/env-sync/rollback
   * Body: { snapshotDocumentId }
   */
  async rollback(ctx) {
    const { snapshotDocumentId } = ctx.request.body;
    const adminUser = ctx.state.admin;

    if (!snapshotDocumentId) {
      return ctx.badRequest('snapshotDocumentId is required.');
    }

    const rollbackSvc = strapi.plugin(PLUGIN_ID).service('rollback');
    const loggerSvc   = strapi.plugin(PLUGIN_ID).service('logger');

    strapi.log.info(
      '[env-sync] Rollback triggered by admin ' + adminUser?.id +
      ' for snapshot: ' + snapshotDocumentId
    );

    const result = await rollbackSvc.restoreSnapshot({
      snapshotDocumentId,
      restoredByAdminId: adminUser?.id,
    });

    if (!result.success) {
      ctx.status = 400;
      ctx.body   = { error: { message: result.message } };
      return;
    }

    // Update the audit log entry that created this snapshot
    try {
      const SNAPSHOT_UID = 'plugin::' + PLUGIN_ID + '.env-sync-snapshot';
      const snapshot = await strapi.documents(SNAPSHOT_UID).findOne({ documentId: snapshotDocumentId });
      if (snapshot?.logId) {
        await loggerSvc.markRolledBack(snapshot.logId);
      }
    } catch (err) {
      strapi.log.warn('[env-sync] Could not update log status after rollback: ' + err.message);
    }

    ctx.status = 200;
    ctx.body   = result;
  },

  /**
   * GET /api/env-sync/logs/export
   * Returns logs as CSV text.
   */
  async exportCsv(ctx) {
    const { status, sourceEnv, targetEnv, contentType, dateFrom, dateTo } = ctx.query;

    const filters = {};
    if (status)      filters.status      = status;
    if (sourceEnv)   filters.sourceEnv   = sourceEnv;
    if (targetEnv)   filters.targetEnv   = targetEnv;
    if (contentType) filters.contentType = { $containsi: contentType };
    if (dateFrom || dateTo) {
      filters.triggeredAt = {};
      if (dateFrom) filters.triggeredAt.$gte = new Date(dateFrom).toISOString();
      if (dateTo)   filters.triggeredAt.$lte = new Date(dateTo).toISOString();
    }

    const loggerSvc = strapi.plugin(PLUGIN_ID).service('logger');
    const rows = await loggerSvc.exportLogs(filters);

    if (rows.length === 0) {
      ctx.set('Content-Type', 'text/csv');
      ctx.set('Content-Disposition', 'attachment; filename="env-sync-logs.csv"');
      ctx.body = 'No log entries found for the specified filters.\n';
      return;
    }

    const headers = Object.keys(rows[0]).join(',');
    const csvRows = rows.map((row) =>
      Object.values(row)
        .map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"')
        .join(',')
    );
    const csv = [headers, ...csvRows].join('\n');

    ctx.set('Content-Type', 'text/csv; charset=utf-8');
    ctx.set('Content-Disposition', 'attachment; filename="env-sync-logs-' + Date.now() + '.csv"');
    ctx.body = csv;
  },
};
