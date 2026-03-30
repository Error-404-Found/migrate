'use strict';

/**
 * Unit tests — MediaSync service
 */

const makeStrapiMock = () => ({
  getModel: jest.fn().mockReturnValue({ attributes: {} }),
  db: { query: jest.fn().mockReturnValue({ findMany: jest.fn().mockResolvedValue([]) }) },
  plugin: jest.fn().mockReturnValue({ service: jest.fn() }),
  log: { warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
});

function makeMediaSync() {
  const strapi = makeStrapiMock();
  return require('../server/services/media-sync')({ strapi });
}

describe('MediaSync', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('buildMediaManifest()', () => {

    it('returns empty array for document with no media', () => {
      const svc = makeMediaSync();
      const manifest = svc.buildMediaManifest({ title: 'Hello' }, 'api::article.article');
      expect(manifest).toEqual([]);
    });

    it('collects file descriptors from top-level media field (schema-less fallback)', () => {
      const svc = makeMediaSync();
      const doc = {
        cover: { id: 1, hash: 'abc123', url: '/uploads/img.jpg', name: 'img.jpg', mime: 'image/jpeg', size: 1024 },
      };
      const manifest = svc.buildMediaManifest(doc, 'api::article.article');
      expect(manifest).toHaveLength(1);
      expect(manifest[0].hash).toBe('abc123');
      expect(manifest[0].name).toBe('img.jpg');
    });

    it('deduplicates files with the same hash', () => {
      const svc = makeMediaSync();
      const sharedFile = { id: 1, hash: 'same-hash', url: '/img.jpg', name: 'img.jpg', mime: 'image/jpeg', size: 512 };
      const doc = { cover: sharedFile, thumbnail: sharedFile };
      const manifest = svc.buildMediaManifest(doc, 'api::article.article');
      expect(manifest).toHaveLength(1);
    });

  });

  describe('remapMediaIds()', () => {

    it('returns payload unchanged when idMap is empty', () => {
      const svc  = makeMediaSync();
      const data = { cover: { id: 5, hash: 'abc', url: '/img.jpg', mime: 'image/jpeg' } };
      const result = svc.remapMediaIds(data, new Map(), 'api::article.article');
      expect(result.cover.id).toBe(5);
    });

    it('remaps file id using idMap (deep fallback)', () => {
      const svc  = makeMediaSync();
      const data = { cover: { id: 5, hash: 'abc', url: '/img.jpg', mime: 'image/jpeg', name: 'img.jpg' } };
      const idMap = new Map([[5, 99]]);
      const result = svc.remapMediaIds(data, idMap, 'api::article.article');
      expect(result.cover.id).toBe(99);
    });

  });

  describe('ensureMediaExists()', () => {

    it('returns empty map when no manifest', async () => {
      const svc = makeMediaSync();
      const map = await svc.ensureMediaExists({ mediaManifest: [] });
      expect(map.size).toBe(0);
    });

  });

});
