'use strict';

/**
 * dynamicZoneHandler.js
 * Processes dynamic zones and components recursively.
 *
 * Component field types (media, relation, nested component) are resolved
 * automatically by fetching the component schema from the Strapi v3
 * Content Manager API via schemaInspector.getComponentSchema().
 *
 * No environment variable configuration needed.
 *
 * v3 dynamic zone item:  { __component: "sections.hero", title: "...", image: { url: "..." } }
 * v5 dynamic zone item:  { __component: "sections.hero", title: "...", image: 42 }
 */

const { processMediaField } = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { getComponentSchema } = require('./schemaInspector');
const logger = require('./logger');

// v3 internal fields to strip from component payloads
const COMPONENT_INTERNAL_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by', '__v',
]);

// ── Runtime heuristics — used when component schema fetch fails ───────────────

function isMediaObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.url === 'string' && (value.mime != null || value.ext != null || value.name != null);
}

function isRelationObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isMediaObject(value)) return false;
  return typeof value.id === 'number';
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

// ── Component field processor ─────────────────────────────────────────────────

/**
 * Process a single component's fields using its schema.
 *
 * @param {object} componentData  - raw component object from v3
 * @param {string} componentUid   - e.g. "sections.hero" (used to fetch schema)
 * @param {string} contentType    - parent content type slug (for logging)
 * @param {any}    v3Id           - parent entry ID (for logging)
 * @returns {object} processed component ready for v5
 */
async function processComponent(componentData, contentType, v3Id, componentUid = null) {
  if (!componentData || typeof componentData !== 'object') return componentData;

  // Fetch the component's own schema so we know field types accurately
  const componentSchema = componentUid
    ? await getComponentSchema(componentUid)
    : {};

  const result = {};

  for (const [key, value] of Object.entries(componentData)) {

    // Strip v3 internal fields
    if (COMPONENT_INTERNAL_FIELDS.has(key) || key === '__component') continue;

    if (value === null || value === undefined) {
      result[key] = null;
      continue;
    }

    const fieldDef = componentSchema[key];

    // ── Schema-driven processing ─────────────────────────────────────────────
    if (fieldDef) {
      switch (fieldDef.type) {

        case 'media': {
          result[key] = await processMediaField(value, contentType, v3Id);
          continue;
        }

        case 'relation': {
          if (!fieldDef.relatedSlug) {
            logger.warn(
              `Component "${componentUid}" field "${key}" is a relation with unknown target. Skipping.`,
              contentType, v3Id
            );
            result[key] = null;
            continue;
          }
          result[key] = await resolveRelationField(
            value, fieldDef.relatedSlug, contentType, v3Id
          );
          continue;
        }

        case 'dynamiczone': {
          if (Array.isArray(value)) {
            result[key] = await processDynamicZone(value, contentType, v3Id);
          } else {
            result[key] = null;
          }
          continue;
        }

        case 'component': {
          const nestedUid = fieldDef.componentUid;
          if (fieldDef.isRepeatable && Array.isArray(value)) {
            const items = [];
            for (const item of value) {
              items.push(await processComponent(item, contentType, v3Id, nestedUid));
            }
            result[key] = items;
          } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = await processComponent(value, contentType, v3Id, nestedUid);
          } else {
            result[key] = null;
          }
          continue;
        }

        case 'primitive':
        default:
          result[key] = value;
          continue;
      }
    }

    // ── Fallback heuristics (schema unavailable for this field) ──────────────

    if (Array.isArray(value)) {
      if (isDynamicZoneArray(value)) {
        result[key] = await processDynamicZone(value, contentType, v3Id);
        continue;
      }

      if (value.length > 0 && isMediaObject(value[0])) {
        result[key] = await processMediaField(value, contentType, v3Id);
        continue;
      }

      if (value.length > 0 && isRelationObject(value[0])) {
        // Cannot safely resolve without knowing the target slug
        logger.warn(
          `Component "${componentUid || 'unknown'}" field "${key}" looks like a relation array ` +
          `but schema is unavailable. Skipping.`,
          contentType, v3Id
        );
        result[key] = null;
        continue;
      }

      // Nested repeatable component array (items are plain objects, not relations)
      if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        const items = [];
        for (const item of value) {
          items.push(await processComponent(item, contentType, v3Id, null));
        }
        result[key] = items;
        continue;
      }

      result[key] = value;
      continue;
    }

    if (isMediaObject(value)) {
      result[key] = await processMediaField(value, contentType, v3Id);
      continue;
    }

    if (isRelationObject(value)) {
      logger.warn(
        `Component "${componentUid || 'unknown'}" field "${key}" looks like a relation ` +
        `but schema is unavailable. Skipping.`,
        contentType, v3Id
      );
      result[key] = null;
      continue;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      // Nested component — no UID known, recurse with heuristics only
      result[key] = await processComponent(value, contentType, v3Id, null);
      continue;
    }

    result[key] = value;
  }

  return result;
}

// ── Dynamic zone processor ────────────────────────────────────────────────────

/**
 * Process a v3 dynamic zone array.
 * Each item has a __component UID — we fetch that component's schema
 * automatically and process its fields accordingly.
 *
 * @param {Array}  dynamicZoneValue - array of v3 component objects with __component
 * @param {string} contentType      - parent content type slug (for logging)
 * @param {any}    v3Id             - parent entry ID (for logging)
 * @returns {Array} processed dynamic zone array ready for v5
 */
async function processDynamicZone(dynamicZoneValue, contentType, v3Id) {
  if (!Array.isArray(dynamicZoneValue)) return [];

  const processed = [];

  for (const item of dynamicZoneValue) {
    if (!item || typeof item !== 'object') {
      processed.push(item);
      continue;
    }

    const componentUid = item.__component || null;

    try {
      // Process the component using its own schema (fetched automatically)
      const processedItem = await processComponent(item, contentType, v3Id, componentUid);

      // Preserve the __component identifier — v5 requires it in dynamic zones
      if (componentUid) {
        processedItem.__component = componentUid;
      }

      processed.push(processedItem);

    } catch (err) {
      logger.error(
        `Failed to process dynamic zone component "${componentUid || 'unknown'}": ${err.message}`,
        contentType, v3Id
      );
      // Skip the broken component — don't push it, keep the rest intact
    }
  }

  return processed;
}

module.exports = { processDynamicZone, processComponent };
