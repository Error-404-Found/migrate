'use strict';

/**
 * relationResolver.js
 * Resolves v3 relation references → v5 entry IDs.
 *
 * Resolution order:
 *  1. stateManager ID map (fastest — already migrated entries)
 *  2. Query v5 by unique fields (slug, title, name, email, etc.)
 *  3. Log a warning if unresolvable
 *
 * Returns Strapi v5 relation format: { connect: [{ id }] }
 */

const { v5 }       = require('./apiClient');
const stateManager = require('./stateManager');
const logger       = require('./logger');

const UNIQUE_FIELDS = ['slug', 'title', 'name', 'email', 'code', 'handle', 'key', 'uid'];
const lookupCache   = new Map(); // "slug|field|value" → v5 id

async function resolveOne(relatedSlug, ref, parentSlug, parentId) {
  if (!ref) return null;
  const obj  = typeof ref === 'object' ? ref : { id: ref };
  const v3Id = obj.id;

  // 1. State map
  if (v3Id != null) {
    const hit = stateManager.getV5Id(relatedSlug, v3Id);
    if (hit != null) return hit;
  }

  // 2. Unique field lookup in v5
  for (const field of UNIQUE_FIELDS) {
    const val = obj[field];
    if (val == null || val === '') continue;

    const key = `${relatedSlug}|${field}|${val}`;
    if (lookupCache.has(key)) return lookupCache.get(key);

    try {
      const r = await v5.findByField(relatedSlug, field, val);
      // v5 response: { data: { data: [{id,...}], meta } }
      const entries = r.data?.data;
      if (!Array.isArray(entries) || !entries.length) continue;
      const v5Id = entries[0]?.id ?? null;
      if (v5Id != null) {
        lookupCache.set(key, v5Id);
        if (v3Id != null) stateManager.setIdMapping(relatedSlug, v3Id, v5Id);
        return v5Id;
      }
    } catch (e) {
      logger.warn(`Relation lookup error [${relatedSlug}.${field}=${val}]: ${e.message}`, parentSlug, parentId);
    }
  }

  logger.warn(
    `Cannot resolve relation: ${relatedSlug} v3_id=${v3Id ?? '?'}. Migrate "${relatedSlug}" first.`,
    parentSlug, parentId
  );
  return null;
}

async function resolveRelationField(v3Value, relatedSlug, parentSlug, parentId) {
  if (!v3Value || !relatedSlug) return null;

  const refs  = Array.isArray(v3Value) ? v3Value : [v3Value];
  const ids   = [];

  for (const ref of refs) {
    if (!ref) continue;
    const id = await resolveOne(relatedSlug, ref, parentSlug, parentId);
    if (id != null) ids.push({ id });
  }

  return ids.length ? { connect: ids } : null;
}

module.exports = { resolveRelationField };
