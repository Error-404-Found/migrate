'use strict';

/**
 * dynamicZoneHandler.js
 * Handles dynamic zones and components, including nested media and relations.
 *
 * v3 dynamic zone items look like:
 *   { __component: "sections.hero", title: "...", image: { url: "..." } }
 *
 * v5 dynamic zone items look like:
 *   { __component: "sections.hero", title: "...", image: 42 }
 *
 * Component UIDs stay the same between v3 and v5 in most setups.
 * If renaming is needed, define COMPONENT_UID_MAP in .env as JSON.
 */

const { processMediaField } = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const logger = require('./logger');

// Optional component UID remapping (from env)
// Format: COMPONENT_UID_MAP={"sections.old-hero":"sections.hero"}
let componentUidMap = {};
try {
  if (process.env.COMPONENT_UID_MAP) {
    componentUidMap = JSON.parse(process.env.COMPONENT_UID_MAP);
  }
} catch {
  logger.warn('COMPONENT_UID_MAP in .env is not valid JSON — ignoring.');
}

/**
 * Map a v3 component UID to a v5 UID using the optional remap table.
 */
function mapComponentUid(uid) {
  return componentUidMap[uid] || uid;
}

/**
 * Detect if a field value looks like a Strapi media object.
 * Media objects have url, mime, and name fields.
 */
function isMediaObject(value) {
  if (!value || typeof value !== 'object') return false;
  return typeof value.url === 'string' && (value.mime || value.name || value.ext);
}

/**
 * Detect if a field value looks like a Strapi relation object.
 * Relation objects have an id and at least one other field (slug, title, etc.)
 * but NOT the url/mime fields of a media object.
 */
function isRelationObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isMediaObject(value)) return false;
  return typeof value.id === 'number';
}

/**
 * Recursively process a component's fields to:
 * - Re-upload media fields
 * - Remap relation fields
 * - Handle nested components
 *
 * @param {object} componentData - the component object from v3
 * @param {string} contentType - parent content type (for logging)
 * @param {any} v3Id - parent entry ID (for logging)
 * @param {object} relationFieldMap - optional map of field names to their related slug
 *                                    e.g. { "author": "authors", "tags": "tags" }
 * @returns {object} processed component data ready for v5
 */
async function processComponent(componentData, contentType, v3Id, relationFieldMap = {}) {
  if (!componentData || typeof componentData !== 'object') return componentData;

  const result = {};

  for (const [key, value] of Object.entries(componentData)) {
    // Skip internal fields that v5 doesn't accept in POST/PUT body
    if (['id', 'created_at', 'updated_at', 'created_by', 'updated_by', '__v'].includes(key)) {
      continue;
    }

    if (value === null || value === undefined) {
      result[key] = value;
      continue;
    }

    // ── Array field ──────────────────────────────────────────────────────────
    if (Array.isArray(value)) {
      // Array of media objects
      if (value.length > 0 && isMediaObject(value[0])) {
        const mediaIds = await processMediaField(value, contentType, v3Id);
        result[key] = mediaIds;
        continue;
      }

      // Array of relation objects
      if (value.length > 0 && isRelationObject(value[0])) {
        const relatedSlug = relationFieldMap[key];
        if (relatedSlug) {
          result[key] = await resolveRelationField(value, relatedSlug, contentType, v3Id);
        } else {
          // Unknown relation — keep IDs as-is with a warning
          logger.warn(
            `Unknown relation field "${key}" in component — no relatedSlug mapping. Skipping.`,
            contentType,
            v3Id
          );
          result[key] = null;
        }
        continue;
      }

      // Array of nested components (repeatable component)
      if (value.length > 0 && typeof value[0] === 'object' && value[0].__component) {
        result[key] = await processDynamicZone(value, contentType, v3Id, relationFieldMap);
        continue;
      }

      // Plain array (strings, numbers, etc.)
      result[key] = value;
      continue;
    }

    // ── Single media object ──────────────────────────────────────────────────
    if (isMediaObject(value)) {
      const mediaId = await processMediaField(value, contentType, v3Id);
      result[key] = mediaId;
      continue;
    }

    // ── Single relation object ───────────────────────────────────────────────
    if (isRelationObject(value)) {
      const relatedSlug = relationFieldMap[key];
      if (relatedSlug) {
        result[key] = await resolveRelationField(value, relatedSlug, contentType, v3Id);
      } else {
        logger.warn(
          `Unknown relation field "${key}" in component — no relatedSlug mapping. Skipping.`,
          contentType,
          v3Id
        );
        result[key] = null;
      }
      continue;
    }

    // ── Nested component (single, non-array) ─────────────────────────────────
    if (typeof value === 'object' && !Array.isArray(value)) {
      result[key] = await processComponent(value, contentType, v3Id, relationFieldMap);
      continue;
    }

    // ── Primitive (string, number, boolean) ──────────────────────────────────
    result[key] = value;
  }

  return result;
}

/**
 * Process a dynamic zone array from a v3 entry.
 *
 * @param {Array} dynamicZoneValue - array of v3 component objects
 * @param {string} contentType - parent content type (for logging)
 * @param {any} v3Id - parent entry ID (for logging)
 * @param {object} relationFieldMap - map of field names to related slugs
 * @returns {Array} processed dynamic zone array for v5
 */
async function processDynamicZone(dynamicZoneValue, contentType, v3Id, relationFieldMap = {}) {
  if (!Array.isArray(dynamicZoneValue)) return [];

  const processed = [];

  for (const item of dynamicZoneValue) {
    if (!item || typeof item !== 'object') {
      processed.push(item);
      continue;
    }

    try {
      // Remap __component UID if a mapping is defined
      const originalUid = item.__component;
      const mappedUid = mapComponentUid(originalUid);

      if (originalUid && originalUid !== mappedUid) {
        logger.info(
          `Remapped component UID: ${originalUid} → ${mappedUid}`,
          contentType,
          v3Id
        );
      }

      // Process all fields within the component recursively
      const processedItem = await processComponent(item, contentType, v3Id, relationFieldMap);

      // Set the (possibly remapped) __component
      if (mappedUid) {
        processedItem.__component = mappedUid;
      }

      processed.push(processedItem);
    } catch (err) {
      logger.error(
        `Failed to process dynamic zone component (${item?.__component || 'unknown'}): ${err.message}`,
        contentType,
        v3Id
      );
      // Don't push a broken component — skip it to keep the array valid
    }
  }

  return processed;
}

module.exports = { processDynamicZone, processComponent, mapComponentUid };
