'use strict';

/**
 * relationResolver.js
 * Resolves v3 relation IDs to v5 IDs.
 *
 * Strategy:
 * 1. Check the in-memory stateManager ID map first (fastest)
 * 2. If not found, query v5 API to find the entry by a unique field
 *    (slug → title → name → id as fallback order)
 * 3. Cache result to avoid repeated lookups
 */

const { v5 } = require('./apiClient');
const stateManager = require('./stateManager');
const logger = require('./logger');

// In-memory cache: "slug:field:value" → v5 ID
// Avoids repeated v5 API calls for the same relation within a run
const relationCache = new Map();

// Priority order of unique identifier fields to try when matching entries
const UNIQUE_FIELDS = ['slug', 'title', 'name', 'email', 'code'];

/**
 * Try to find a v5 entry ID by matching unique fields from the v3 entry object.
 *
 * @param {string} relatedSlug - the collection slug of the related type, e.g. "authors"
 * @param {object} v3RelatedEntry - the v3 entry object (may include id, slug, title, etc.)
 * @param {string} parentSlug - parent content type (for logging)
 * @param {any} parentV3Id - parent entry ID (for logging)
 * @returns {number|null} v5 ID or null
 */
async function resolveRelationId(relatedSlug, v3RelatedEntry, parentSlug, parentV3Id) {
  if (!v3RelatedEntry || typeof v3RelatedEntry !== 'object') return null;

  const v3Id = v3RelatedEntry.id;

  // ── Step 1: Check stateManager idMap (fastest) ────────────────────────────
  if (v3Id != null) {
    const mappedId = stateManager.getV5Id(relatedSlug, v3Id);
    if (mappedId != null) {
      return mappedId;
    }
  }

  // ── Step 2: Try unique fields in priority order ───────────────────────────
  for (const field of UNIQUE_FIELDS) {
    const value = v3RelatedEntry[field];
    if (!value) continue;

    const cacheKey = `${relatedSlug}:${field}:${value}`;
    if (relationCache.has(cacheKey)) {
      return relationCache.get(cacheKey);
    }

    try {
      const result = await v5.findByField(relatedSlug, field, value);
      if (result.error || !result.data?.data?.length) continue;

      const v5Id = result.data.data[0]?.id ?? null;
      if (v5Id != null) {
        relationCache.set(cacheKey, v5Id);
        // Also store in stateManager if we have the v3 ID
        if (v3Id != null) {
          stateManager.setIdMapping(relatedSlug, v3Id, v5Id);
        }
        return v5Id;
      }
    } catch (err) {
      logger.warn(
        `Exception resolving relation ${relatedSlug} by ${field}=${value}: ${err.message}`,
        parentSlug,
        parentV3Id
      );
    }
  }

  // ── Step 3: Log that we couldn't resolve ──────────────────────────────────
  if (v3Id != null) {
    logger.warn(
      `Could not resolve relation: ${relatedSlug} v3_id=${v3Id}. Entry may not be migrated yet.`,
      parentSlug,
      parentV3Id
    );
  }

  return null;
}

/**
 * Resolve a v3 relation field value to v5-compatible ID(s).
 *
 * v3 relation field can be:
 * - A single object: { id: 5, slug: "my-author", ... }
 * - An array of objects: [{ id: 5 }, { id: 6 }]
 * - A plain ID number (less common in REST API)
 * - null / undefined
 *
 * Returns the v5 format: { connect: [{ id: X }] } for Strapi v5 relations
 *
 * @param {any} v3Value - the v3 relation field value
 * @param {string} relatedSlug - the collection slug for the related type
 * @param {string} parentSlug - for logging
 * @param {any} parentV3Id - for logging
 * @returns {{ connect: Array<{ id: number }> } | null}
 */
async function resolveRelationField(v3Value, relatedSlug, parentSlug, parentV3Id) {
  if (!v3Value) return null;

  // Normalize to array
  const entries = Array.isArray(v3Value) ? v3Value : [v3Value];

  const connectedIds = [];
  for (const entry of entries) {
    // Handle plain ID or object
    const v3RelatedEntry = typeof entry === 'object' ? entry : { id: entry };
    const v5Id = await resolveRelationId(relatedSlug, v3RelatedEntry, parentSlug, parentV3Id);
    if (v5Id != null) {
      connectedIds.push({ id: v5Id });
    }
  }

  if (connectedIds.length === 0) return null;

  // Strapi v5 relation format uses "connect" array
  return { connect: connectedIds };
}

/**
 * Clear the in-memory cache (useful between collection runs).
 */
function clearCache() {
  relationCache.clear();
}

module.exports = { resolveRelationId, resolveRelationField, clearCache };
