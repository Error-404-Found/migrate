'use strict';

/**
 * Unit tests — SyncEngine service
 *
 * All Strapi internals are mocked so tests run without a real Strapi instance.
 */

const PLUGIN_ID = 'env-sync';

// ── Mock Strapi ───────────────────────────────────────────────────────────────
const mockLogger       = { createLog: jest.fn(), markInProgress: jest.fn(), markSuccess: jest.fn(), markFailed: jest.fn(), markDryRun: jest.fn(), isAlreadyInProgress: jest.fn().mockResolvedValue(false) };
const mockDiffEngine   = { computeDiff: jest.fn(), summarise: jest.fn().mockReturnValue({ hasChanges: true, fieldsChanged: [] }), resolveConflict: jest.fn().mockReturnValue({ proceed: true, reason: 'source-wins' }) };
const mockMediaSync    = { buildMediaManifest: jest.fn().mockReturnValue([]) };
const mockDocuments    = jest.fn().mockReturnValue({ findOne: jest.fn().mockResolvedValue(null) });

const makeStrapiMock = (configOverrides = {}) => ({
  config: { get: jest.fn().mockImplementation((key) => {
    if (key === 'plugin::' + PLUGIN_ID) return {
      currentEnv:       'SIT',
      targets:          { QA: { url: 'https://qa.example.com', secret: 'secret123' } },
      conflictStrategy: 'source-wins',
      requestTimeoutMs: 5000,
      retryAttempts:    0,
      maxConcurrentSyncs: 10,
      enableDryRun:     true,
      enableRollback:   false,
      ...configOverrides,
    };
    return null;
  })},
  plugin: jest.fn().mockReturnValue({
    service: jest.fn().mockImplementation((name) => {
      if (name === 'logger')     return mockLogger;
      if (name === 'diffEngine') return mockDiffEngine;
      if (name === 'mediaSync')  return mockMediaSync;
      return {};
    }),
  }),
  documents: mockDocuments,
  getModel:  jest.fn().mockReturnValue({ attributes: {}, pluginOptions: {} }),
  log:       { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSyncEngine(strapiOverrides = {}) {
  const strapi = makeStrapiMock(strapiOverrides);
  return require('../server/services/sync-engine')({ strapi });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SyncEngine', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('triggerSync()', () => {

    it('returns error when targetEnv has no config', async () => {
      const engine = makeSyncEngine();
      const result = await engine.triggerSync({
        contentType: 'api::article.article',
        documentId:  'abc123',
        targetEnv:   'PROD',         // not in config.targets
        triggeredByAdminId: 1,
        isDryRun: false,
      });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not configured/i);
    });

    it('blocks sync between QA and UAT (same DB)', async () => {
      const strapi = makeStrapiMock();
      // Override currentEnv to QA
      strapi.config.get.mockImplementation((key) => {
        if (key === 'plugin::' + PLUGIN_ID) return {
          currentEnv: 'QA',
          targets: { UAT: { url: 'https://uat.example.com', secret: 'secret' } },
          conflictStrategy: 'source-wins',
          requestTimeoutMs: 5000,
          enableDryRun: false,
          enableRollback: false,
        };
      });
      const engine = require('../server/services/sync-engine')({ strapi });
      const result = await engine.triggerSync({
        contentType: 'api::article.article',
        documentId:  'abc123',
        targetEnv:   'UAT',
        triggeredByAdminId: 1,
      });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/same database/i);
    });

    it('returns queued result when sync already in progress', async () => {
      mockLogger.isAlreadyInProgress.mockResolvedValueOnce(true);
      const engine = makeSyncEngine();
      const result = await engine.triggerSync({
        contentType: 'api::article.article',
        documentId:  'abc123',
        targetEnv:   'QA',
        triggeredByAdminId: 1,
      });
      expect(result.success).toBe(false);
      expect(result.reason).toBe('queued');
    });

    it('creates a log entry and marks it in_progress', async () => {
      mockLogger.createLog.mockResolvedValueOnce({ documentId: 'log-doc-id-1' });
      mockLogger.markInProgress.mockResolvedValueOnce({});

      // Make the HTTP call fail so we don't need a real target
      const engine = makeSyncEngine();

      // Mock _serialiseDocument to return empty (triggers "not found" error path)
      mockDocuments.mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(null) });

      await engine.triggerSync({
        contentType: 'api::article.article',
        documentId:  'abc123',
        targetEnv:   'QA',
        triggeredByAdminId: 1,
      });

      expect(mockLogger.createLog).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'api::article.article', documentId: 'abc123', targetEnv: 'QA' })
      );
      expect(mockLogger.markInProgress).toHaveBeenCalledWith('log-doc-id-1');
    });

  });
});
