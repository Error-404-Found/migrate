'use strict';

/**
 * dynamicZoneHandler.js
 * Processes dynamic zones and nested components recursively.
 *
 * KEY FIX: Components are NO LONGER misidentified as relations.
 * A v3 component object always has an 'id' field, which previously caused
 * looksLikeRelation() to return true, silently dropping the entire component.
 *
 * Fix: distinguish component objects from relation objects by checking whether
 * the value has fields BEYOND just 'id' that are non-scalar (which relations
 * don't have when populate=deep returns them as { id, slug, title... }).
 * Better fix: use the schema. When schema is available, type is definitive.
 * When schema is missing, we check for __component or treat any plain object
 * as a component (process it) rather than skipping it.
 *
 * KEY FIX: snake_case field names inside components are written to v5 using
 * their camelCase equivalents (from schema v5FieldName). Without schema,
 * toCamel() is applied to all field names.
 */

const { processMediaField }   = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { getComponentSchema }   = require('./schemaInspector');
const { toCamel }              = require('./schemaInspector');
const logger = require('./logger');

// v3 internal fields to strip — never send these to v5
const STRIP = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by', '__v', '__component',
]);

// ── Heuristics ─────────────────────────────────────────────────────────────────

function looksLikeMedia(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return typeof v.url === 'string' && (v.mime != null || v.ext != null || v.name != null);
}

const RELATION_IDENTIFIER_FIELDS = new Set([
  'id', 'slug', 'title', 'name', 'email', 'code', 'handle', 'key',
  'uid', 'username', 'identifier', 'locale', 'localizations',
  'created_at', 'updated_at', 'created_by', 'updated_by', 'published_at', '__v',
]);

function looksLikeRelationArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0];
  if (!first || typeof first !== 'object') return false;
  if (typeof first.id !== 'number') return false;
  if (looksLikeMedia(first)) return false;
  const nonRelationField = Object.keys(first).find(k => !RELATION_IDENTIFIER_FIELDS.has(k));
  return !nonRelationField;
}

/**
 * A value is a RELATION object if it has only an id (or id + a few scalar fields)
 * and does NOT have any object-valued fields (which would make it a component).
 *
 * KEY FIX: We check whether the object has any non-scalar fields. Relations
 * returned by populate=deep have id + scalar fields only (slug, title, etc.).
 * Components have id + potentially nested objects (media, subcomponents).
 *
 * However the safest rule is: if schema is unavailable, NEVER skip an object
 * as "unknown relation" — instead treat it as a component and process its fields.
 * This ensures meta, breadcrumbs, etc. always get processed.
 */
function looksLikeRelation(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (looksLikeMedia(v)) return false;
  if (typeof v.id !== 'number') return false;
  // If ANY field value is a non-null object (nested media, component, etc.),
  // this is a component not a relation
  const hasNestedObject = Object.entries(v).some(([k, val]) =>
    !STRIP.has(k) && val !== null && typeof val === 'object'
  );
  if (hasNestedObject) return false; // it's a component
  return true;
}

function looksLikeDynamicZone(arr) {
  return Array.isArray(arr) && arr.length > 0 &&
    typeof arr[0] === 'object' && arr[0] !== null &&
    typeof arr[0].__component === 'string';
}

// ── Component processor ───────────────────────────────────────────────────────

/**
 * Process all fields of a single component object.
 *
 * @param {object} data         - raw v3 component data
 * @param {string} componentUid - UID used to fetch schema (e.g. "sections.hero")
 * @param {string} contentType  - parent slug (logging)
 * @param {any}    v3Id         - parent entry ID (logging)
 * @returns {object}            - processed component ready for v5
 */
async function processComponent(data, componentUid, contentType, v3Id) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

  // Fetch this component's schema — tells us exact field types and v5 field names
  const schema = componentUid ? await getComponentSchema(componentUid) : {};

  const result = {};

  for (const [key, value] of Object.entries(data)) {
    if (STRIP.has(key)) continue;

    const def = schema[key];

    // Determine the output key:
    // - If schema available: use schema's v5FieldName (correct camelCase)
    // - If no schema: apply toCamel() to convert snake_case → camelCase
    const outKey = def ? def.v5FieldName : toCamel(key);

    if (value === null || value === undefined) {
      result[outKey] = null;
      continue;
    }

    // ── Schema-driven (definitive) ───────────────────────────────────────────
    if (def) {
      switch (def.type) {
        case 'media':
          result[outKey] = await processMediaField(value, contentType, v3Id);
          continue;
        case 'relation':
          if (def.relatedSlug) {
            result[outKey] = await resolveRelationField(value, def.relatedSlug, contentType, v3Id);
          } else {
            logger.warn(`Component "${componentUid}" field "${key}": relation has no target slug.`, contentType, v3Id);
            result[outKey] = null;
          }
          continue;
        case 'dynamiczone':
          result[outKey] = Array.isArray(value) ? await processDynamicZone(value, contentType, v3Id) : null;
          continue;
        case 'component': {
          const nestedUid = def.componentUid;
          if (def.isRepeatable) {
            result[outKey] = Array.isArray(value)
              ? await Promise.all(value.map(item => processComponent(item, nestedUid, contentType, v3Id)))
              : [];
          } else {
            result[outKey] = (value && typeof value === 'object' && !Array.isArray(value))
              ? await processComponent(value, nestedUid, contentType, v3Id)
              : null;
          }
          continue;
        }
        default:
          result[outKey] = value;
          continue;
      }
    }

    // ── Heuristic fallback (no schema for this field) ─────────────────────────

    if (Array.isArray(value)) {
      if (looksLikeDynamicZone(value)) {
        result[outKey] = await processDynamicZone(value, contentType, v3Id);
      } else if (value.length > 0 && looksLikeMedia(value[0])) {
        result[outKey] = await processMediaField(value, contentType, v3Id);
      } else if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        if (looksLikeRelation(value[0])) {
          // True relation array — can't resolve without schema
          logger.warn(
            `Component "${componentUid || 'unknown'}" field "${key}": relation array, schema missing. Skipping.`,
            contentType, v3Id
          );
          result[outKey] = null;
        } else {
          // KEY FIX: Repeatable component array (e.g. breadcrumbs items)
          // Process each item as a component instead of skipping
          result[outKey] = await Promise.all(
            value.map(item => processComponent(item, null, contentType, v3Id))
          );
        }
      } else {
        result[outKey] = value; // primitive array
      }
      continue;
    }

    if (looksLikeMedia(value)) {
      result[outKey] = await processMediaField(value, contentType, v3Id);
      continue;
    }

    if (looksLikeRelation(value)) {
      // True relation object — can't resolve without knowing the target slug
      logger.warn(
        `Component "${componentUid || 'unknown'}" field "${key}": relation, schema missing. Skipping.`,
        contentType, v3Id
      );
      result[outKey] = null;
      continue;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      // KEY FIX: Treat as nested component — process recursively instead of skipping
      // This catches: meta.shareImage nested objects, breadcrumb items, any sub-component
      result[outKey] = await processComponent(value, null, contentType, v3Id);
      continue;
    }

    result[outKey] = value;
  }

  return result;
}

// ── Dynamic zone processor ────────────────────────────────────────────────────

/**
 * Process a v3 dynamic zone array (dynamic_sections, additional_sections, etc.)
 * Each item MUST have a __component field.
 *
 * @param {Array}  items       - v3 dynamic zone array
 * @param {string} contentType - parent slug (logging)
 * @param {any}    v3Id        - parent entry ID (logging)
 * @returns {Array}            - processed array ready for v5
 */
async function processDynamicZone(items, contentType, v3Id) {
  if (!Array.isArray(items)) return [];

  const result = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const componentUid = item.__component || null;

    if (!componentUid) {
      logger.warn(
        `Dynamic zone item missing __component field. Data: ${JSON.stringify(item).substring(0,100)}`,
        contentType, v3Id
      );
      continue;
    }

    try {
      const processed = await processComponent(item, componentUid, contentType, v3Id);
      // v5 REQUIRES __component on each dynamic zone item
      processed.__component = componentUid;
      result.push(processed);
    } catch (err) {
      logger.error(
        `Failed to process dynamic zone item "${componentUid}": ${err.message}`,
        contentType, v3Id
      );
      // Skip bad item — rest of dynamic zone continues
    }
  }

  return result;
}

module.exports = { processDynamicZone, processComponent };
