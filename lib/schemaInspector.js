'use strict';

/**
 * schemaInspector.js
 * Fetches the content type schema from both Strapi v3 and v5 APIs automatically.
 *
 * This eliminates the need to manually define RELATION_SLUG_MAP,
 * DYNAMIC_ZONE_FIELDS, or FIELD_TYPE_HINTS in .env.
 *
 * v3 schema endpoint: GET /content-manager/content-types/:uid
 *   Returns attributes with { type, relation, target, component, components }
 *
 * v5 schema endpoint: GET /content-manager/content-types/:uid
 *   Same structure but with v5 UID format
 *
 * Schema is cached in memory per slug so it is only fetched once per run.
 *
 * Field types we care about:
 *   - "media"        → media upload field
 *   - "relation"     → relation to another content type
 *   - "dynamiczone"  → array of components
 *   - "component"    → single or repeatable component
 *   - everything else → primitive / passthrough
 */

const axios = require('axios');
const logger = require('./logger');

const V3_URL = (process.env.STRAPI_V3_URL || '').replace(/\/$/, '');
const V5_URL = (process.env.STRAPI_V5_URL || '').replace(/\/$/, '');
const V3_TOKEN = process.env.STRAPI_V3_TOKEN || '';
const V5_TOKEN = process.env.STRAPI_V5_TOKEN || '';

// In-memory schema cache: slug → parsed schema descriptor
// { fields: { fieldName: { type, relatedSlug, isDynamicZone, isComponent, isRepeatable } } }
const schemaCache = new Map();

// ── v3 UID formats ────────────────────────────────────────────────────────────
// Strapi v3 uses UIDs like:  application::article.article
// We try both the content-manager API and a fallback approach
function buildV3Uid(slug) {
  // Singularise slug for the model name: articles → article
  const singular = slug.replace(/s$/, '');
  return `application::${singular}.${singular}`;
}

// ── v5 UID formats ────────────────────────────────────────────────────────────
// Strapi v5 uses UIDs like:  api::article.article
function buildV5Uid(slug) {
  const singular = slug.replace(/s$/, '');
  return `api::${singular}.${singular}`;
}

/**
 * Extract the collection slug from a v3/v5 relation target UID.
 * e.g. "application::author.author" → "authors"
 * e.g. "api::tag.tag"              → "tags"
 * e.g. "plugin::users-permissions.user" → "users"
 */
function uidToSlug(uid) {
  if (!uid || typeof uid !== 'string') return null;
  // Take the part after the last dot, then pluralise
  const parts = uid.split('.');
  const modelName = parts[parts.length - 1];
  // Simple pluralisation: append 's' if not already ending in 's'
  return modelName.endsWith('s') ? modelName : `${modelName}s`;
}

/**
 * Fetch the schema for a slug from the v3 Content Manager API.
 * Returns raw attributes object or null on failure.
 */
async function fetchV3Schema(slug) {
  const uid = buildV3Uid(slug);
  try {
    const response = await axios.get(
      `${V3_URL}/content-manager/content-types/${uid}`,
      {
        headers: { Authorization: `Bearer ${V3_TOKEN}` },
        timeout: 15000,
      }
    );
    // v3 returns { data: { schema: { attributes: { ... } } } }
    const attributes =
      response.data?.data?.schema?.attributes ||
      response.data?.schema?.attributes ||
      response.data?.attributes ||
      null;

    if (!attributes) {
      logger.warn(`v3 schema for "${slug}" (uid: ${uid}) returned no attributes.`);
    }
    return attributes;
  } catch (err) {
    const status = err?.response?.status;
    logger.warn(
      `Could not fetch v3 schema for "${slug}" (uid: ${uid}): HTTP ${status || 'N/A'} — ${err.message}`
    );
    return null;
  }
}

/**
 * Fetch the schema for a slug from the v5 Content Manager API.
 * Returns raw attributes object or null on failure.
 */
async function fetchV5Schema(slug) {
  const uid = buildV5Uid(slug);
  try {
    const response = await axios.get(
      `${V5_URL}/content-manager/content-types/${uid}`,
      {
        headers: { Authorization: `Bearer ${V5_TOKEN}` },
        timeout: 15000,
      }
    );
    // v5 returns { data: { schema: { attributes: { ... } } } } or { info: {}, attributes: {} }
    const attributes =
      response.data?.data?.schema?.attributes ||
      response.data?.schema?.attributes ||
      response.data?.attributes ||
      null;

    if (!attributes) {
      logger.warn(`v5 schema for "${slug}" (uid: ${uid}) returned no attributes.`);
    }
    return attributes;
  } catch (err) {
    const status = err?.response?.status;
    logger.warn(
      `Could not fetch v5 schema for "${slug}" (uid: ${uid}): HTTP ${status || 'N/A'} — ${err.message}`
    );
    return null;
  }
}

/**
 * Parse raw Strapi attributes into a normalised schema descriptor.
 *
 * Returns a map of fieldName → descriptor:
 * {
 *   type: 'media' | 'relation' | 'dynamiczone' | 'component' | 'primitive',
 *   relatedSlug: string | null,   // for relations — the target collection slug
 *   isRepeatable: boolean,        // for components
 *   componentUids: string[],      // for dynamiczones — list of allowed component UIDs
 * }
 */
function parseAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') return {};

  const schema = {};

  for (const [fieldName, attr] of Object.entries(attributes)) {
    if (!attr || typeof attr !== 'object') continue;

    const fieldType = attr.type;

    if (fieldType === 'media') {
      schema[fieldName] = { type: 'media', relatedSlug: null };
      continue;
    }

    if (fieldType === 'relation') {
      // attr.target is the UID of the related content type
      const relatedSlug = uidToSlug(attr.target || attr.relatedModel || null);
      schema[fieldName] = { type: 'relation', relatedSlug };
      continue;
    }

    if (fieldType === 'dynamiczone') {
      // attr.components is an array of allowed component UIDs
      schema[fieldName] = {
        type: 'dynamiczone',
        componentUids: Array.isArray(attr.components) ? attr.components : [],
      };
      continue;
    }

    if (fieldType === 'component') {
      schema[fieldName] = {
        type: 'component',
        isRepeatable: attr.repeatable === true,
        componentUid: attr.component || null,
      };
      continue;
    }

    // Everything else: string, text, richtext, number, boolean, date, json, uid, email, etc.
    schema[fieldName] = { type: 'primitive' };
  }

  return schema;
}

/**
 * Get the full parsed schema for a slug.
 * Tries v3 first, falls back to v5, falls back to empty schema with a warning.
 * Result is cached so subsequent calls for the same slug are free.
 *
 * @param {string} slug - e.g. "articles"
 * @returns {object} - fieldName → descriptor map
 */
async function getSchema(slug) {
  if (schemaCache.has(slug)) {
    return schemaCache.get(slug);
  }

  logger.info(`Fetching schema for "${slug}" from v3 Content Manager API...`);

  // Try v3 first — it has the source-of-truth schema
  let rawAttributes = await fetchV3Schema(slug);

  // Fallback to v5 if v3 schema fetch fails
  if (!rawAttributes) {
    logger.warn(`Falling back to v5 schema for "${slug}"...`);
    rawAttributes = await fetchV5Schema(slug);
  }

  if (!rawAttributes) {
    logger.warn(
      `Could not fetch schema for "${slug}" from either v3 or v5. ` +
      `Field type detection will rely on runtime value heuristics only.`
    );
    schemaCache.set(slug, {});
    return {};
  }

  const parsed = parseAttributes(rawAttributes);

  const fieldSummary = Object.entries(parsed)
    .map(([k, v]) => `${k}:${v.type}${v.relatedSlug ? `→${v.relatedSlug}` : ''}`)
    .join(', ');
  logger.info(`Schema for "${slug}": ${fieldSummary || '(no fields)'}`);

  schemaCache.set(slug, parsed);
  return parsed;
}

/**
 * Get the schema for a component UID from v3.
 * Component UIDs look like: "sections.hero", "shared.seo"
 * v3 endpoint: GET /content-manager/components/:uid
 */
async function getComponentSchema(componentUid) {
  const cacheKey = `__component__${componentUid}`;
  if (schemaCache.has(cacheKey)) {
    return schemaCache.get(cacheKey);
  }

  try {
    const response = await axios.get(
      `${V3_URL}/content-manager/components/${componentUid}`,
      {
        headers: { Authorization: `Bearer ${V3_TOKEN}` },
        timeout: 15000,
      }
    );

    const attributes =
      response.data?.data?.schema?.attributes ||
      response.data?.schema?.attributes ||
      response.data?.attributes ||
      null;

    if (!attributes) {
      schemaCache.set(cacheKey, {});
      return {};
    }

    const parsed = parseAttributes(attributes);
    schemaCache.set(cacheKey, parsed);
    return parsed;
  } catch (err) {
    logger.warn(`Could not fetch component schema for "${componentUid}": ${err.message}`);
    schemaCache.set(cacheKey, {});
    return {};
  }
}

/**
 * Clear the schema cache (useful in tests or if schemas change mid-run).
 */
function clearCache() {
  schemaCache.clear();
}

module.exports = { getSchema, getComponentSchema, parseAttributes, uidToSlug, clearCache };
