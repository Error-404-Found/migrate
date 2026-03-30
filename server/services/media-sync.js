'use strict';

/**
 * Media Sync Service
 *
 * Handles file/media synchronisation between environments.
 *
 * Strategy:
 *  1. For every media file referenced in the source document, check if a file
 *     with the same `hash` already exists on the target.
 *  2. If it exists → reuse it (no re-upload needed).
 *  3. If it doesn't → download from source URL and re-upload via Strapi's
 *     upload API on the target environment.
 *
 * This service is called by the receive controller (inbound side) to ensure
 * all media assets are available before the document is written.
 *
 * @module env-sync/server/services/media-sync
 */

const path    = require('path');
const axios   = require('axios');
const FormData = require('form-data');

const PLUGIN_ID = 'env-sync';

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = ({ strapi }) => ({

  /**
   * Ensure all media files referenced in a payload exist locally.
   * Returns a map of { sourceFileId → localFileId } for relation remapping.
   *
   * @param {object} params
   * @param {object[]} params.mediaManifest  - Array of { id, hash, url, name, mime, size, folderPath }
   * @returns {Promise<Map<number, number>>} sourceId → localId
   */
  async ensureMediaExists({ mediaManifest }) {
    if (!mediaManifest || mediaManifest.length === 0) {
      return new Map();
    }

    const idMap = new Map();

    for (const file of mediaManifest) {
      try {
        const localId = await this._ensureSingleFile(file);
        if (localId) {
          idMap.set(file.id, localId);
        }
      } catch (err) {
        strapi.log.warn(
          `[env-sync] Media sync: failed to ensure file "${file.name}" (hash: ${file.hash}): ${err.message}`
        );
        // Non-fatal: continue syncing other files
      }
    }

    return idMap;
  },

  /**
   * Walk a document payload recursively and replace source media IDs
   * with local IDs using the idMap produced by ensureMediaExists().
   *
   * @param {object} payload
   * @param {Map<number, number>} idMap
   * @param {string} contentType
   * @returns {object} remapped payload
   */
  remapMediaIds(payload, idMap, contentType) {
    if (!idMap || idMap.size === 0) return payload;

    const schema = _getSchema(strapi, contentType);
    if (!schema) return _deepRemapIds(payload, idMap);

    return _remapBySchema(payload, schema, idMap, strapi);
  },

  /**
   * Build a media manifest from a document — lists all unique files
   * referenced anywhere in the document (including components and dynamic zones).
   *
   * Called by the outbound sync engine before serialising the payload.
   *
   * @param {object} document  - Populated Strapi document
   * @param {string} contentType
   * @returns {object[]} array of file descriptor objects
   */
  buildMediaManifest(document, contentType) {
    const files   = new Map(); // hash → descriptor
    const schema  = _getSchema(strapi, contentType);

    if (schema) {
      _collectFilesFromSchema(document, schema, files, strapi);
    } else {
      _collectFilesDeep(document, files);
    }

    return Array.from(files.values());
  },

  // ── Private method exposed for testing ──────────────────────────────────────

  /**
   * Ensure a single file exists locally by hash.
   * If already present → return its local ID.
   * If not → download and upload.
   *
   * @param {object} file - { id, hash, url, name, mime, size, folderPath }
   * @returns {Promise<number|null>} local file ID
   */
  async _ensureSingleFile(file) {
    // 1. Check if file with same hash already exists
    const existing = await _findByHash(strapi, file.hash);
    if (existing) {
      strapi.log.debug(`[env-sync] Media: reusing existing file "${file.name}" (hash: ${file.hash}, id: ${existing.id})`);
      return existing.id;
    }

    // 2. File not found locally — download from source URL
    strapi.log.debug(`[env-sync] Media: downloading "${file.name}" from ${file.url}`);
    const buffer = await _downloadFile(file.url);

    // 3. Upload to local Strapi upload service
    const uploaded = await _uploadFile(strapi, {
      buffer,
      name:       file.name,
      mime:       file.mime || 'application/octet-stream',
      size:       file.size || buffer.length,
      folderPath: file.folderPath || '/',
    });

    strapi.log.debug(`[env-sync] Media: uploaded "${file.name}" as id ${uploaded.id}`);
    return uploaded.id;
  },
});

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Find a local file by its hash.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} hash
 * @returns {Promise<object|null>}
 */
async function _findByHash(strapi, hash) {
  if (!hash) return null;
  try {
    const results = await strapi.db.query('plugin::upload.file').findMany({
      where:  { hash },
      limit:  1,
      select: ['id', 'hash', 'name', 'url'],
    });
    return results[0] || null;
  } catch (err) {
    strapi.log.warn(`[env-sync] Media: DB query for hash failed: ${err.message}`);
    return null;
  }
}

/**
 * Download a file from a remote URL and return its buffer.
 *
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function _downloadFile(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout:      30_000,
    maxContentLength: 100 * 1024 * 1024, // 100 MB limit
  });
  return Buffer.from(response.data);
}

/**
 * Upload a file buffer to the local Strapi upload service.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {object} params
 * @returns {Promise<object>} uploaded file record
 */
async function _uploadFile(strapi, { buffer, name, mime, size, folderPath }) {
  const uploadService = strapi.plugin('upload').service('upload');

  // Strapi's upload service accepts a mocked file object
  const fileData = {
    name,
    type:     mime,
    size,
    buffer,
    // Strapi v5 upload accepts path or buffer
  };

  // Write buffer to a temp file for the upload provider
  const tmpPath = require('path').join(require('os').tmpdir(), `env-sync-${Date.now()}-${name}`);
  require('fs').writeFileSync(tmpPath, buffer);

  try {
    const [uploaded] = await uploadService.upload({
      data:  { fileInfo: { name, caption: '', alternativeText: '', folder: null } },
      files: { path: tmpPath, name, type: mime, size },
    });
    return uploaded;
  } finally {
    // Always clean up temp file
    try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Get Strapi schema for a content type.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} uid
 * @returns {object|null}
 */
function _getSchema(strapi, uid) {
  try { return strapi.getModel(uid); } catch { return null; }
}

/**
 * Recursively collect all media file descriptors from a document
 * following the content type's schema attribute definitions.
 *
 * @param {object} data
 * @param {object} schema
 * @param {Map} files
 * @param {import('@strapi/strapi').Strapi} strapi
 */
function _collectFilesFromSchema(data, schema, files, strapi) {
  if (!data || !schema?.attributes) return;

  for (const [attrName, attrDef] of Object.entries(schema.attributes)) {
    const val = data[attrName];
    if (val == null) continue;

    switch (attrDef.type) {
      case 'media': {
        const fileList = Array.isArray(val) ? val : [val];
        for (const f of fileList) {
          if (f?.hash && !files.has(f.hash)) {
            files.set(f.hash, {
              id:         f.id,
              hash:       f.hash,
              url:        f.url,
              name:       f.name,
              mime:       f.mime,
              size:       f.size,
              folderPath: f.folderPath || '/',
            });
          }
        }
        break;
      }
      case 'component': {
        const componentSchema = _getSchema(strapi, attrDef.component);
        if (!componentSchema) break;
        const items = attrDef.repeatable ? val : [val];
        for (const item of items) {
          if (item) _collectFilesFromSchema(item, componentSchema, files, strapi);
        }
        break;
      }
      case 'dynamiczone': {
        for (const zone of (val || [])) {
          if (!zone?.__component) continue;
          const zoneSchema = _getSchema(strapi, zone.__component);
          if (zoneSchema) _collectFilesFromSchema(zone, zoneSchema, files, strapi);
        }
        break;
      }
    }
  }
}

/**
 * Deep collect all file objects from an arbitrary payload (schema-less fallback).
 *
 * @param {any} val
 * @param {Map} files
 */
function _collectFilesDeep(val, files) {
  if (!val || typeof val !== 'object') return;
  if (Array.isArray(val)) { val.forEach((v) => _collectFilesDeep(v, files)); return; }

  // Detect file-like objects: must have hash + url + mime
  if (val.hash && val.url && val.mime) {
    if (!files.has(val.hash)) {
      files.set(val.hash, { id: val.id, hash: val.hash, url: val.url, name: val.name, mime: val.mime, size: val.size, folderPath: '/' });
    }
    return;
  }

  for (const v of Object.values(val)) {
    _collectFilesDeep(v, files);
  }
}

/**
 * Schema-aware ID remapping — replaces source file IDs with local IDs.
 *
 * @param {object} data
 * @param {object} schema
 * @param {Map} idMap
 * @param {import('@strapi/strapi').Strapi} strapi
 * @returns {object}
 */
function _remapBySchema(data, schema, idMap, strapi) {
  if (!data) return data;
  const result = { ...data };

  for (const [attrName, attrDef] of Object.entries(schema.attributes || {})) {
    const val = result[attrName];
    if (val == null) continue;

    switch (attrDef.type) {
      case 'media': {
        if (Array.isArray(val)) {
          result[attrName] = val.map((f) => _remapFileId(f, idMap));
        } else {
          result[attrName] = _remapFileId(val, idMap);
        }
        break;
      }
      case 'component': {
        const componentSchema = _getSchema(strapi, attrDef.component);
        if (!componentSchema) break;
        if (attrDef.repeatable) {
          result[attrName] = val.map((item) => _remapBySchema(item, componentSchema, idMap, strapi));
        } else {
          result[attrName] = _remapBySchema(val, componentSchema, idMap, strapi);
        }
        break;
      }
      case 'dynamiczone': {
        result[attrName] = (val || []).map((zone) => {
          const zoneSchema = _getSchema(strapi, zone?.__component);
          return zoneSchema ? _remapBySchema(zone, zoneSchema, idMap, strapi) : zone;
        });
        break;
      }
    }
  }
  return result;
}

/**
 * Remap a single file reference's ID.
 *
 * @param {object} file
 * @param {Map} idMap
 * @returns {object}
 */
function _remapFileId(file, idMap) {
  if (!file) return file;
  const newId = idMap.get(file.id);
  return newId ? { ...file, id: newId } : file;
}

/**
 * Deep ID remap for payloads without schema (fallback).
 *
 * @param {any} val
 * @param {Map} idMap
 * @returns {any}
 */
function _deepRemapIds(val, idMap) {
  if (!val || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map((v) => _deepRemapIds(v, idMap));

  // File-like: remap id
  if (val.hash && val.url && val.mime && val.id) {
    const newId = idMap.get(val.id);
    return newId ? { ...val, id: newId } : val;
  }

  const result = {};
  for (const [k, v] of Object.entries(val)) {
    result[k] = _deepRemapIds(v, idMap);
  }
  return result;
}
