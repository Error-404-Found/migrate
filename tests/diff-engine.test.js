'use strict';

/**
 * Unit tests — DiffEngine service
 */

const makeStrapiMock = (schemaAttributes = {}) => ({
  getModel: jest.fn().mockReturnValue({ attributes: schemaAttributes }),
  log: { warn: jest.fn(), debug: jest.fn() },
});

function makeDiffEngine(schema = {}) {
  const strapi = makeStrapiMock(schema);
  return require('../server/services/diff-engine')({ strapi });
}

describe('DiffEngine', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('computeDiff()', () => {

    it('flags isNew when targetData is null', () => {
      const engine = makeDiffEngine();
      const diff = engine.computeDiff({
        sourceData:  { title: 'Hello' },
        targetData:  null,
        contentType: 'api::article.article',
      });
      expect(diff.isNew).toBe(true);
      expect(diff.hasChanges).toBe(true);
    });

    it('returns hasChanges=false when source and target are identical', () => {
      const engine = makeDiffEngine({ title: { type: 'string' } });
      const diff = engine.computeDiff({
        sourceData:  { title: 'Hello' },
        targetData:  { title: 'Hello' },
        contentType: 'api::article.article',
      });
      expect(diff.hasChanges).toBe(false);
      expect(diff.fieldsChanged).toHaveLength(0);
    });

    it('detects changed string field', () => {
      const engine = makeDiffEngine({ title: { type: 'string' } });
      const diff = engine.computeDiff({
        sourceData:  { title: 'New title' },
        targetData:  { title: 'Old title' },
        contentType: 'api::article.article',
      });
      expect(diff.hasChanges).toBe(true);
      expect(diff.fieldsChanged).toHaveLength(1);
      expect(diff.fieldsChanged[0].field).toBe('title');
      expect(diff.fieldsChanged[0].newValue).toBe('New title');
      expect(diff.fieldsChanged[0].oldValue).toBe('Old title');
    });

    it('detects changed boolean field', () => {
      const engine = makeDiffEngine({ published: { type: 'boolean' } });
      const diff = engine.computeDiff({
        sourceData: { published: true },
        targetData: { published: false },
        contentType: 'api::article.article',
      });
      expect(diff.hasChanges).toBe(true);
      expect(diff.fieldsChanged[0].field).toBe('published');
    });

    it('detects changed relation (different documentIds)', () => {
      const engine = makeDiffEngine({
        author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
      });
      const diff = engine.computeDiff({
        sourceData: { author: { documentId: 'author-2' } },
        targetData: { author: { documentId: 'author-1' } },
        contentType: 'api::article.article',
      });
      expect(diff.relationsUpdated).toHaveLength(1);
      expect(diff.relationsUpdated[0].field).toBe('author');
    });

    it('ignores identical relations', () => {
      const engine = makeDiffEngine({
        author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
      });
      const diff = engine.computeDiff({
        sourceData: { author: { documentId: 'author-1' } },
        targetData: { author: { documentId: 'author-1' } },
        contentType: 'api::article.article',
      });
      expect(diff.relationsUpdated).toHaveLength(0);
    });

    it('detects changed media (different hashes)', () => {
      const engine = makeDiffEngine({
        cover: { type: 'media', multiple: false },
      });
      const diff = engine.computeDiff({
        sourceData: { cover: { hash: 'hash-new', url: '/new.jpg', mime: 'image/jpeg' } },
        targetData: { cover: { hash: 'hash-old', url: '/old.jpg', mime: 'image/jpeg' } },
        contentType: 'api::article.article',
      });
      expect(diff.mediaChanged).toHaveLength(1);
    });

  });

  describe('resolveConflict()', () => {

    it('source-wins always proceeds', () => {
      const engine = makeDiffEngine();
      const result = engine.resolveConflict({
        diff: { hasChanges: true },
        strategy: 'source-wins',
        sourceUpdatedAt: '2024-01-01',
        targetUpdatedAt: '2024-06-01',
      });
      expect(result.proceed).toBe(true);
    });

    it('target-wins skips when target is newer', () => {
      const engine = makeDiffEngine();
      const result = engine.resolveConflict({
        diff: { hasChanges: true },
        strategy: 'target-wins',
        sourceUpdatedAt: '2024-01-01T00:00:00Z',
        targetUpdatedAt: '2024-06-01T00:00:00Z',
      });
      expect(result.proceed).toBe(false);
      expect(result.reason).toBe('target-newer');
    });

    it('target-wins proceeds when source is newer', () => {
      const engine = makeDiffEngine();
      const result = engine.resolveConflict({
        diff: { hasChanges: true },
        strategy: 'target-wins',
        sourceUpdatedAt: '2024-12-01T00:00:00Z',
        targetUpdatedAt: '2024-06-01T00:00:00Z',
      });
      expect(result.proceed).toBe(true);
    });

    it('manual always blocks', () => {
      const engine = makeDiffEngine();
      const result = engine.resolveConflict({
        diff: { hasChanges: true },
        strategy: 'manual',
        sourceUpdatedAt: '2024-12-01',
        targetUpdatedAt: '2024-01-01',
      });
      expect(result.proceed).toBe(false);
      expect(result.reason).toBe('manual-review-required');
    });

    it('skips when no changes', () => {
      const engine = makeDiffEngine();
      const result = engine.resolveConflict({
        diff: { hasChanges: false },
        strategy: 'source-wins',
      });
      expect(result.proceed).toBe(false);
      expect(result.reason).toBe('no-changes');
    });

  });

  describe('summarise()', () => {

    it('returns a compact summary object', () => {
      const engine = makeDiffEngine();
      const diff = {
        isNew: false, hasChanges: true,
        fieldsChanged:    [{ field: 'title' }],
        relationsUpdated: [],
        mediaChanged:     [{ field: 'cover' }],
        localesDiff:      [{ locale: 'en' }],
        componentDiff:    [],
        dynamicZoneDiff:  [],
      };
      const summary = engine.summarise(diff);
      expect(summary.fieldsChanged).toEqual([{ field: 'title' }]);
      expect(summary.mediaReuploaded).toEqual([{ field: 'cover' }]);
      expect(summary.localesSynced).toEqual(['en']);
    });

  });

});
