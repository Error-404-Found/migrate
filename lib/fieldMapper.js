'use strict';

/**
 * fieldMapper.js
 * Maps a v3 entry's raw fields to a v5-compatible data payload.
 *
 * FIX: processDynamicZone call signature corrected (3 args, no schema arg).
 * FIX: publishedAt correctly passed through — null means draft in v5.
 * FIX: All env reads are lazy (no module-load-time reads).
 *
 * Field type is determined by:
 *  1. Schema fetched from Strapi Content Manager API (most accurate)
 *  2. Runtime value heuristics as fallback
 */

const { processMediaField }  = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { processDynamicZone, processComponent } = require('./dynamicZoneHandler');
const { getSchema } = require('./schemaInspector');
const logger = require('./logger');

// v3 system fields — never send these to v5
const V3_INTERNAL = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  '__v', 'localizations',
  // published_at is handled separately → publishedAt
]);

// snake_case → camelCase renames needed between v3 and v5
const RENAME = {
  published_at: 'publishedAt',
};

// ── Runtime heuristics ────────────────────────────────────────────────────────

function looksLikeMedia(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return typeof v.url === 'string' && (v.mime != null || v.ext != null || v.name != null);
}

function looksLikeRelation(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (looksLikeMedia(v)) return false;
  return typeof v.id === 'number';
}

function looksLikeDynamicZone(arr) {
  return Array.isArray(arr) && arr.length > 0 &&
    typeof arr[0] === 'object' && typeof arr[0].__component === 'string';
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/**
 * Map a v3 entry to a v5-compatible data object.
 *
 * @param {object} v3Entry  - raw v3 entry (with populate=deep fields)
 * @param {string} slug     - content type slug (e.g. "articles")
 * @param {any}    v3Id     - entry ID (for logging)
 * @param {string} locale   - current locale (for logging)
 * @returns {object}        - v5 data payload (wrap in { data: ... } before POST)
 */
async function mapFields(v3Entry, slug, v3Id, locale = null) {
  if (!v3Entry || typeof v3Entry !== 'object') return {};

  // Fetch schema once — cached after first call for this slug
  const schema = await getSchema(slug);

  const out = {};

  for (const [key, value] of Object.entries(v3Entry)) {

    // ── Skip v3-only system fields ───────────────────────────────────────────
    if (V3_INTERNAL.has(key)) continue;

    // ── Rename (published_at → publishedAt) ──────────────────────────────────
    const outKey = RENAME[key] || key;

    // ── Null passthrough ─────────────────────────────────────────────────────
    if (value === null || value === undefined) {
      out[outKey] = null;
      continue;
    }

    const def = schema[key];

    // ── Schema-driven ─────────────────────────────────────────────────────────
    if (def) {
      switch (def.type) {

        case 'media':
          out[outKey] = await processMediaField(value, slug, v3Id);
          continue;

        case 'relation':
          if (def.relatedSlug) {
            out[outKey] = await resolveRelationField(value, def.relatedSlug, slug, v3Id);
          } else {
            logger.warn(`Field "${key}" is a relation with unknown target for "${slug}". Skipping.`, slug, v3Id, locale);
            out[outKey] = null;
          }
          continue;

        case 'dynamiczone':
          // FIX: correct 3-arg call — (items, contentType, v3Id)
          out[outKey] = Array.isArray(value)
            ? await processDynamicZone(value, slug, v3Id)
            : null;
          continue;

        case 'component':
          if (def.isRepeatable) {
            out[outKey] = Array.isArray(value)
              ? await Promise.all(value.map(item => processComponent(item, def.componentUid, slug, v3Id)))
              : [];
          } else {
            out[outKey] = (value && typeof value === 'object')
              ? await processComponent(value, def.componentUid, slug, v3Id)
              : null;
          }
          continue;

        case 'primitive':
        default:
          out[outKey] = value;
          continue;
      }
    }

    // ── Heuristic fallback (schema missing for this field) ────────────────────

    if (looksLikeDynamicZone(value)) {
      // FIX: correct 3-arg call
      out[outKey] = await processDynamicZone(value, slug, v3Id);
      continue;
    }

    if (looksLikeMedia(value)) {
      out[outKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    if (Array.isArray(value) && value.length > 0 && looksLikeMedia(value[0])) {
      out[outKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    if (looksLikeRelation(value)) {
      logger.warn(
        `Field "${key}" looks like a relation but schema unavailable for "${slug}". ` +
        `Cannot resolve target — skipping. Ensure v3 Content Manager API is accessible.`,
        slug, v3Id, locale
      );
      out[outKey] = null;
      continue;
    }

    if (Array.isArray(value) && value.length > 0 && looksLikeRelation(value[0])) {
      logger.warn(
        `Field "${key}" looks like a relation array but schema unavailable for "${slug}". Skipping.`,
        slug, v3Id, locale
      );
      out[outKey] = null;
      continue;
    }

    // Nested plain object — process as component (heuristic)
    if (typeof value === 'object' && !Array.isArray(value)) {
      out[outKey] = await processComponent(value, null, slug, v3Id);
      continue;
    }

    // Primitive passthrough
    out[outKey] = value;
  }

  return out;
}

module.exports = { mapFields };
