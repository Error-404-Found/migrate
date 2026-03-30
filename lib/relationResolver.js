'use strict';

/**
 * relationResolver.js
 * Resolves v3 relation references to their corresponding v5 IDs.
 *
 * FIX: With populate=deep on v3 fetches, relation fields now contain full
 *      objects (with slug, title, etc.) instead of bare IDs. The resolver
 *      uses those unique fields to find the matching v5 entry.
 *
 * FIX: v5 findByField response shape is { data: { data: [...], meta: {} } }
 *      — correctly extracts id from data.data[0].id.
 *
 * Resolution order:
 *  1. Check stateManager ID map (already-migrated entries — fastest)
 *  2. Try unique fields from the populated v3 object (slug, title, name, etc.)
 *  3. Log a warning if unresolvable (entry not migrated yet)
 */

const { v5 } = require('./apiClient');
const stateManager = require('./stateManager');
const logger = require('./logger');

// In-memory cache: "relatedSlug|field|value" → v5 ID
const cache = new Map();

// Priority order of unique fields to try when matching
const UNIQUE_FIELDS = ['slug', 'title', 'name', 'email', 'code', 'handle', 'key'];

/**
 * Resolve a single v3 relation entry to a v5 ID.
 *
 * @param {string} relatedSlug    - collection slug of the related type (e.g. "authors")
 * @param {object|number} v3Ref  - the v3 relation value: full object or bare id
 * @param {string} parentSlug    - parent content type (for logging)
 * @param {any}    parentV3Id    - parent entry ID (for logging)
 * @returns {number|null}        - v5 ID or null
 */
async function resolveOneRelation(relatedSlug, v3Ref, parentSlug, parentV3Id) {
  if (!v3Ref) return null;

  // Normalise: bare ID or full object
  const v3Obj = typeof v3Ref === 'object' ? v3Ref : { id: v3Ref };
  const v3Id  = v3Obj.id;

  // ── 1. Check ID map from already-migrated entries ─────────────────────────
  if (v3Id != null) {
    const mapped = stateManager.getV5Id(relatedSlug, v3Id);
    if (mapped != null) return mapped;
  }

  // ── 2. Try unique fields from the populated object ────────────────────────
  for (const field of UNIQUE_FIELDS) {
    const value = v3Obj[field];
    if (value == null || value === '') continue;

    const cacheKey = `${relatedSlug}|${field}|${value}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    try {
      const result = await v5.findByField(relatedSlug, field, value);

      // v5 response shape: { data: { data: [ {id, attributes} ], meta } }
      const entries = result.data?.data;
      if (!Array.isArray(entries) || entries.length === 0) continue;

      const v5Id = entries[0]?.id ?? null;
      if (v5Id != null) {
        cache.set(cacheKey, v5Id);
        if (v3Id != null) stateManager.setIdMapping(relatedSlug, v3Id, v5Id);
        return v5Id;
      }
    } catch (err) {
      logger.warn(
        `Exception resolving relation ${relatedSlug} by ${field}=${value}: ${err.message}`,
        parentSlug, parentV3Id
      );
    }
  }

  // ── 3. Nothing found ──────────────────────────────────────────────────────
  logger.warn(
    `Could not resolve relation: ${relatedSlug} v3_id=${v3Id ?? 'unknown'}. ` +
    `Migrate "${relatedSlug}" before "${parentSlug}" for correct relation linking.`,
    parentSlug, parentV3Id
  );
  return null;
}

/**
 * Resolve a v3 relation field value to v5-compatible connect format.
 *
 * v3 relation can be:
 *  - null / undefined           → null
 *  - bare number (id)           → { connect: [{ id: v5Id }] }  (if resolvable)
 *  - object with id + fields    → { connect: [{ id: v5Id }] }
 *  - array of objects/ids       → { connect: [{ id }, { id }, ...] }
 *
 * Strapi v5 relation format uses { connect: [{ id }] }
 *
 * @param {any}    v3Value      - raw v3 relation field value
 * @param {string} relatedSlug  - collection slug of the target type
 * @param {string} parentSlug   - for logging
 * @param {any}    parentV3Id   - for logging
 * @returns {{ connect: {id: number}[] } | null}
 */
async function resolveRelationField(v3Value, relatedSlug, parentSlug, parentV3Id) {
  if (!v3Value || !relatedSlug) return null;

  const refs = Array.isArray(v3Value) ? v3Value : [v3Value];
  const connected = [];

  for (const ref of refs) {
    if (!ref) continue;
    const v5Id = await resolveOneRelation(relatedSlug, ref, parentSlug, parentV3Id);
    if (v5Id != null) connected.push({ id: v5Id });
  }

  return connected.length > 0 ? { connect: connected } : null;
}

function clearCache() {
  cache.clear();
}

module.exports = { resolveRelationField, resolveOneRelation, clearCache };
