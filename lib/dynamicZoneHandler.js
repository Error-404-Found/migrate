'use strict';

/**
 * dynamicZoneHandler.js
 * Processes dynamic zones and nested components recursively.
 *
 * Each component's field types (media, relation, component) are resolved
 * by fetching the component schema via schemaInspector automatically.
 *
 * v3 dynamic zone item:
 *   { __component: "sections.hero", title: "Hero", image: { id:1, url:"...", ... } }
 *
 * v5 dynamic zone item:
 *   { __component: "sections.hero", title: "Hero", image: 42 }
 */

const { processMediaField } = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { getComponentSchema } = require('./schemaInspector');
const logger = require('./logger');

// Fields that must be stripped from component payloads before sending to v5
const STRIP_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by', '__v', '__component',
]);

// ── Heuristics (fallback when component schema is unavailable) ────────────────

function looksLikeMedia(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.url === 'string' && (value.mime != null || value.ext != null || value.name != null);
}

function looksLikeRelation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (looksLikeMedia(value)) return false;
  return typeof value.id === 'number' && Object.keys(value).length >= 1;
}

function looksLikeDynamicZone(arr) {
  return Array.isArray(arr) && arr.length > 0 &&
    typeof arr[0] === 'object' && arr[0] !== null &&
    typeof arr[0].__component === 'string';
}

// ── Component processor ───────────────────────────────────────────────────────

/**
 * Process all fields in a single component object.
 *
 * @param {object} data          - raw v3 component data
 * @param {string} componentUid  - e.g. "sections.hero" (used to fetch schema)
 * @param {string} contentType   - parent content type slug (for logging)
 * @param {any}    v3Id          - parent entry ID (for logging)
 * @returns {object}             - processed component ready for v5
 */
async function processComponent(data, componentUid, contentType, v3Id) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

  // Fetch this component's own field schema
  const schema = componentUid ? await getComponentSchema(componentUid) : {};

  const result = {};

  for (const [key, value] of Object.entries(data)) {
    if (STRIP_FIELDS.has(key)) continue; // strip internal and __component

    if (value === null || value === undefined) {
      result[key] = null;
      continue;
    }

    const fieldDef = schema[key];

    // ── Schema-driven (most accurate) ────────────────────────────────────────
    if (fieldDef) {
      switch (fieldDef.type) {

        case 'media':
          result[key] = await processMediaField(value, contentType, v3Id);
          continue;

        case 'relation':
          if (fieldDef.relatedSlug) {
            result[key] = await resolveRelationField(value, fieldDef.relatedSlug, contentType, v3Id);
          } else {
            logger.warn(`Component "${componentUid}" field "${key}": relation has no target slug. Skipping.`, contentType, v3Id);
            result[key] = null;
          }
          continue;

        case 'dynamiczone':
          result[key] = Array.isArray(value)
            ? await processDynamicZone(value, contentType, v3Id)
            : null;
          continue;

        case 'component': {
          const nestedUid = fieldDef.componentUid;
          if (fieldDef.isRepeatable) {
            result[key] = Array.isArray(value)
              ? await Promise.all(value.map(item => processComponent(item, nestedUid, contentType, v3Id)))
              : [];
          } else {
            result[key] = (value && typeof value === 'object')
              ? await processComponent(value, nestedUid, contentType, v3Id)
              : null;
          }
          continue;
        }

        default:
          result[key] = value;
          continue;
      }
    }

    // ── Heuristic fallback ────────────────────────────────────────────────────
    if (Array.isArray(value)) {
      if (looksLikeDynamicZone(value)) {
        result[key] = await processDynamicZone(value, contentType, v3Id);
      } else if (value.length > 0 && looksLikeMedia(value[0])) {
        result[key] = await processMediaField(value, contentType, v3Id);
      } else if (value.length > 0 && looksLikeRelation(value[0])) {
        logger.warn(
          `Component "${componentUid}" field "${key}" looks like a relation array but schema is missing. Skipping.`,
          contentType, v3Id
        );
        result[key] = null;
      } else if (value.length > 0 && typeof value[0] === 'object') {
        // Repeatable nested component — recurse without a UID (heuristic mode)
        result[key] = await Promise.all(
          value.map(item => processComponent(item, null, contentType, v3Id))
        );
      } else {
        result[key] = value; // plain primitive array
      }
      continue;
    }

    if (looksLikeMedia(value)) {
      result[key] = await processMediaField(value, contentType, v3Id);
      continue;
    }

    if (looksLikeRelation(value)) {
      logger.warn(
        `Component "${componentUid}" field "${key}" looks like a relation but schema missing. Skipping.`,
        contentType, v3Id
      );
      result[key] = null;
      continue;
    }

    if (typeof value === 'object') {
      result[key] = await processComponent(value, null, contentType, v3Id);
      continue;
    }

    result[key] = value;
  }

  return result;
}

// ── Dynamic zone processor ────────────────────────────────────────────────────

/**
 * Process an array of dynamic zone items.
 * Each item has a __component field identifying its type.
 *
 * @param {Array}  items       - v3 dynamic zone array
 * @param {string} contentType - parent content type (for logging)
 * @param {any}    v3Id        - parent entry ID (for logging)
 * @returns {Array}            - processed array for v5
 */
async function processDynamicZone(items, contentType, v3Id) {
  if (!Array.isArray(items)) return [];

  const result = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const componentUid = item.__component || null;

    try {
      const processed = await processComponent(item, componentUid, contentType, v3Id);

      // __component must be included in v5 dynamic zone items
      if (componentUid) processed.__component = componentUid;

      result.push(processed);
    } catch (err) {
      logger.error(
        `Failed to process dynamic zone item "${componentUid || 'unknown'}": ${err.message}`,
        contentType, v3Id
      );
      // Skip broken component — don't let one bad item kill the whole dynamic zone
    }
  }

  return result;
}

module.exports = { processDynamicZone, processComponent };
