'use strict';

/**
 * fieldMapper.js
 * Maps a v3 entry's fields to the v5-compatible data payload.
 *
 * Field types are determined by the schema fetched from the Strapi Content
 * Manager API via schemaInspector — NOT from environment variables.
 *
 * When schema is unavailable for a specific field, runtime value heuristics
 * are used as a safe fallback (same logic as before, but secondary).
 *
 * Processing order per field:
 *  1. Schema-defined type (most accurate)
 *  2. Runtime value heuristics (fallback when schema is missing/incomplete)
 *  3. Primitive passthrough
 */

const { processMediaField } = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { processDynamicZone, processComponent } = require('./dynamicZoneHandler');
const { getSchema } = require('./schemaInspector');
const logger = require('./logger');

// v3 internal fields that must never be sent to v5
const V3_INTERNAL_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'published_at',   // handled separately → publishedAt
  '__v',
  'localizations',  // handled by i18nHandler
]);

// v3 snake_case → v5 camelCase renames
const FIELD_RENAME_MAP = {
  published_at: 'publishedAt',
};

// ── Runtime heuristics (fallback when schema is unavailable) ─────────────────

function isMediaObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.url === 'string' && (value.mime != null || value.ext != null || value.name != null);
}

function isMediaArray(arr) {
  return Array.isArray(arr) && arr.length > 0 && isMediaObject(arr[0]);
}

function isRelationObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isMediaObject(value)) return false;
  // A relation object has a numeric id and at least one other string field
  return typeof value.id === 'number';
}

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

function isDynamicZoneArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    typeof arr[0] === 'object' &&
    arr[0] !== null &&
    typeof arr[0].__component === 'string'
  );
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/**
 * Map a v3 entry to a v5-compatible data object.
 *
 * @param {object} v3Entry  - raw entry from v3 REST API
 * @param {string} slug     - content type slug (e.g. "articles")
 * @param {any}    v3Id     - entry ID for logging
 * @param {string} locale   - current locale being processed (for logging)
 * @returns {object}        - v5-compatible data payload (wrap in { data: ... } before sending)
 */
async function mapFields(v3Entry, slug, v3Id, locale = null) {
  if (!v3Entry || typeof v3Entry !== 'object') return {};

  // Fetch schema once — cached after first call for this slug
  const schema = await getSchema(slug);

  const v5Data = {};

  for (const [key, value] of Object.entries(v3Entry)) {

    // ── 1. Skip v3 internal / system fields ───────────────────────────────────
    if (V3_INTERNAL_FIELDS.has(key)) continue;

    // ── 2. Rename snake_case → camelCase where needed ─────────────────────────
    const targetKey = FIELD_RENAME_MAP[key] || key;

    // ── 3. Null passthrough ───────────────────────────────────────────────────
    if (value === null || value === undefined) {
      v5Data[targetKey] = null;
      continue;
    }

    // ── 4. Schema-driven processing ───────────────────────────────────────────
    const fieldDef = schema[key]; // may be undefined if schema fetch failed

    if (fieldDef) {
      switch (fieldDef.type) {

        case 'media': {
          v5Data[targetKey] = await processMediaField(value, slug, v3Id);
          continue;
        }

        case 'relation': {
          if (!fieldDef.relatedSlug) {
            // Schema knows it's a relation but couldn't resolve the target slug
            logger.warn(
              `Relation field "${key}" schema has no target slug for "${slug}". Skipping.`,
              slug, v3Id, locale
            );
            v5Data[targetKey] = null;
            continue;
          }
          v5Data[targetKey] = await resolveRelationField(
            value, fieldDef.relatedSlug, slug, v3Id
          );
          continue;
        }

        case 'dynamiczone': {
          if (Array.isArray(value)) {
            v5Data[targetKey] = await processDynamicZone(value, slug, v3Id, schema);
          } else {
            v5Data[targetKey] = null;
          }
          continue;
        }

        case 'component': {
          if (fieldDef.isRepeatable && Array.isArray(value)) {
            // Repeatable component — process each item
            const processed = [];
            for (const item of value) {
              processed.push(await processComponent(item, slug, v3Id, schema));
            }
            v5Data[targetKey] = processed;
          } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            v5Data[targetKey] = await processComponent(value, slug, v3Id, schema);
          } else {
            v5Data[targetKey] = null;
          }
          continue;
        }

        case 'primitive':
        default: {
          v5Data[targetKey] = value;
          continue;
        }
      }
    }

    // ── 5. Fallback: runtime heuristics (schema unavailable for this field) ───
    // This path runs when the schema fetch failed or the field isn't in the schema.

    if (isDynamicZoneArray(value)) {
      v5Data[targetKey] = await processDynamicZone(value, slug, v3Id, schema);
      continue;
    }

    if (isMediaObject(value)) {
      v5Data[targetKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    if (isMediaArray(value)) {
      v5Data[targetKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    if (isRelationObject(value)) {
      // We don't know the related slug — log and skip rather than guess wrong
      logger.warn(
        `Relation field "${key}" detected by heuristic but schema is missing for "${slug}". ` +
        `Cannot resolve target slug — skipping field. ` +
        `Check if the v3 Content Manager API is accessible.`,
        slug, v3Id, locale
      );
      v5Data[targetKey] = null;
      continue;
    }

    if (isRelationArray(value)) {
      logger.warn(
        `Relation array field "${key}" detected by heuristic but schema is missing for "${slug}". ` +
        `Cannot resolve target slug — skipping field.`,
        slug, v3Id, locale
      );
      v5Data[targetKey] = null;
      continue;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      // Treat as a plain component/JSON field
      v5Data[targetKey] = await processComponent(value, slug, v3Id, schema);
      continue;
    }

    // Primitive passthrough
    v5Data[targetKey] = value;
  }

  return v5Data;
}

module.exports = { mapFields };
