'use strict';

/**
 * fieldMapper.js
 * Maps a v3 entry's fields to the v5-compatible data payload.
 *
 * Responsibilities:
 * - Strip v3-only internal fields (created_by, updated_by, etc.)
 * - Convert v3 publishedAt null → v5 publishedAt handling
 * - Handle media fields (delegate to mediaHandler)
 * - Handle relation fields (delegate to relationResolver)
 * - Handle dynamic zones (delegate to dynamicZoneHandler)
 * - Handle nested component fields
 * - Preserve all primitive fields (text, number, boolean, date, richtext)
 *
 * IMPORTANT: This module does NOT know the schema of each content type.
 * It uses heuristics to detect field types (media vs relation vs component vs primitive).
 * For custom field type mappings, extend the FIELD_TYPE_HINTS env var (JSON).
 */

const { processMediaField } = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { processDynamicZone, processComponent } = require('./dynamicZoneHandler');
const logger = require('./logger');

// Fields that exist in v3 but must never be sent to v5
const V3_INTERNAL_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'published_at', // we handle this separately as publishedAt
  '__v',
  'localizations', // handled separately in i18nHandler
]);

// v5 uses camelCase for these
const FIELD_RENAME_MAP = {
  published_at: 'publishedAt',
};

/**
 * Optional per-slug field type hints loaded from env.
 * Format: FIELD_TYPE_HINTS={"articles":{"tags":"relation:tags","cover":"media"}}
 * This helps the mapper correctly identify ambiguous fields.
 */
let fieldTypeHints = {};
try {
  if (process.env.FIELD_TYPE_HINTS) {
    fieldTypeHints = JSON.parse(process.env.FIELD_TYPE_HINTS);
  }
} catch {
  logger.warn('FIELD_TYPE_HINTS in .env is not valid JSON — ignoring.');
}

/**
 * Optional relation slug map per content type.
 * Format: RELATION_SLUG_MAP={"articles":{"author":"authors","tags":"tags"}}
 */
let relationSlugMap = {};
try {
  if (process.env.RELATION_SLUG_MAP) {
    relationSlugMap = JSON.parse(process.env.RELATION_SLUG_MAP);
  }
} catch {
  logger.warn('RELATION_SLUG_MAP in .env is not valid JSON — ignoring.');
}

/**
 * Optional dynamic zone field names per content type.
 * Format: DYNAMIC_ZONE_FIELDS={"articles":["content","sections"]}
 */
let dynamicZoneFields = {};
try {
  if (process.env.DYNAMIC_ZONE_FIELDS) {
    dynamicZoneFields = JSON.parse(process.env.DYNAMIC_ZONE_FIELDS);
  }
} catch {
  logger.warn('DYNAMIC_ZONE_FIELDS in .env is not valid JSON — ignoring.');
}

/**
 * Detect if a field value is a Strapi v3 media object.
 */
function isMediaObject(value) {
  if (!value || typeof value !== 'object') return false;
  return typeof value.url === 'string' && (value.mime != null || value.ext != null || value.name != null);
}

/**
 * Detect if an array contains media objects.
 */
function isMediaArray(arr) {
  return Array.isArray(arr) && arr.length > 0 && isMediaObject(arr[0]);
}

/**
 * Detect if a value looks like a relation object.
 */
function isRelationObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isMediaObject(value)) return false;
  return typeof value.id === 'number';
}

/**
 * Detect if an array contains relation objects.
 */
function isRelationArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    typeof arr[0] === 'object' &&
    arr[0] !== null &&
    typeof arr[0].id === 'number' &&
    !isMediaObject(arr[0])
  );
}

/**
 * Detect if an array is a dynamic zone (items have __component).
 */
function isDynamicZoneArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    typeof arr[0] === 'object' &&
    arr[0] !== null &&
    typeof arr[0].__component === 'string'
  );
}

/**
 * Map a v3 entry to v5-compatible data object.
 *
 * @param {object} v3Entry - raw entry from v3 REST API
 * @param {string} slug - content type slug (used for hints and logging)
 * @param {any} v3Id - entry ID (for logging)
 * @param {string|null} locale - current locale being processed
 * @returns {object} v5-compatible data payload (to wrap in { data: ... })
 */
async function mapFields(v3Entry, slug, v3Id, locale = null) {
  if (!v3Entry || typeof v3Entry !== 'object') return {};

  const slugRelationMap = relationSlugMap[slug] || {};
  const slugDynamicZoneFields = new Set(dynamicZoneFields[slug] || []);
  const v5Data = {};

  for (const [key, value] of Object.entries(v3Entry)) {
    // ── Skip v3 internal fields ──────────────────────────────────────────────
    if (V3_INTERNAL_FIELDS.has(key)) continue;

    // ── Rename fields (e.g. published_at → publishedAt) ──────────────────────
    const targetKey = FIELD_RENAME_MAP[key] || key;

    // ── Null / undefined passthrough ─────────────────────────────────────────
    if (value === null || value === undefined) {
      v5Data[targetKey] = null;
      continue;
    }

    // ── Explicit dynamic zone field (from env config) ─────────────────────────
    if (slugDynamicZoneFields.has(key)) {
      if (Array.isArray(value)) {
        v5Data[targetKey] = await processDynamicZone(value, slug, v3Id, slugRelationMap);
      } else {
        v5Data[targetKey] = null;
      }
      continue;
    }

    // ── Auto-detected dynamic zone (array with __component) ───────────────────
    if (isDynamicZoneArray(value)) {
      v5Data[targetKey] = await processDynamicZone(value, slug, v3Id, slugRelationMap);
      continue;
    }

    // ── Single media object ───────────────────────────────────────────────────
    if (isMediaObject(value)) {
      v5Data[targetKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    // ── Array of media objects ────────────────────────────────────────────────
    if (isMediaArray(value)) {
      v5Data[targetKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    // ── Single relation object ────────────────────────────────────────────────
    if (isRelationObject(value)) {
      const relatedSlug = slugRelationMap[key];
      if (relatedSlug) {
        v5Data[targetKey] = await resolveRelationField(value, relatedSlug, slug, v3Id);
      } else {
        // No mapping known — log a warning and skip this field
        logger.warn(
          `Relation field "${key}" has no entry in RELATION_SLUG_MAP for "${slug}". Skipping field.`,
          slug,
          v3Id,
          locale
        );
        // Still include null so v5 doesn't get stale data
        v5Data[targetKey] = null;
      }
      continue;
    }

    // ── Array of relation objects ─────────────────────────────────────────────
    if (isRelationArray(value)) {
      const relatedSlug = slugRelationMap[key];
      if (relatedSlug) {
        v5Data[targetKey] = await resolveRelationField(value, relatedSlug, slug, v3Id);
      } else {
        logger.warn(
          `Relation array field "${key}" has no entry in RELATION_SLUG_MAP for "${slug}". Skipping field.`,
          slug,
          v3Id,
          locale
        );
        v5Data[targetKey] = null;
      }
      continue;
    }

    // ── Nested plain object (single component or JSON field) ──────────────────
    if (typeof value === 'object' && !Array.isArray(value)) {
      // Process it as a component — will recursively handle media/relations inside
      v5Data[targetKey] = await processComponent(value, slug, v3Id, slugRelationMap);
      continue;
    }

    // ── Primitive (string, number, boolean, array of primitives) ─────────────
    v5Data[targetKey] = value;
  }

  return v5Data;
}

module.exports = { mapFields };
