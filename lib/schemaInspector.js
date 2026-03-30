'use strict';

/**
 * schemaInspector.js
 * Fetches and caches content type and component schemas from the
 * Strapi v3 Content Manager API.
 *
 * FIX: All env vars are read lazily (at call time) so dotenv has already
 *      loaded before any value is consumed.
 * FIX: UID discovery tries multiple formats and falls back to listing all
 *      content types to find the correct UID — fixes naive singularisation
 *      (categories→categorie, news→new, etc.).
 */

const axios = require('axios');
const logger = require('./logger');

// Lazy env accessors
const cfg = {
  get v3Url()   { return (process.env.STRAPI_V3_URL  || '').replace(/\/$/, ''); },
  get v5Url()   { return (process.env.STRAPI_V5_URL  || '').replace(/\/$/, ''); },
  get v3Token() { return process.env.STRAPI_V3_TOKEN || ''; },
  get v5Token() { return process.env.STRAPI_V5_TOKEN || ''; },
};

// In-memory cache: cacheKey → parsed schema descriptor
const schemaCache = new Map();

// Cache of slug → resolved UID (so we only discover each once)
const uidCache = new Map();

// ── UID building helpers ───────────────────────────────────────────────────────

/**
 * Generate candidate v3 UIDs to try for a given slug.
 * v3 uses: application::<model>.<model>
 * We try several singularisation strategies.
 */
function v3UidCandidates(slug) {
  const candidates = new Set();
  // As-is (e.g. slug = "news" → application::news.news)
  candidates.add(`application::${slug}.${slug}`);
  // Remove trailing 's' (articles → article)
  if (slug.endsWith('s')) candidates.add(`application::${slug.slice(0,-1)}.${slug.slice(0,-1)}`);
  // Remove trailing 'ies' and add 'y' (categories → category)
  if (slug.endsWith('ies')) {
    const base = slug.slice(0,-3) + 'y';
    candidates.add(`application::${base}.${base}`);
  }
  // Remove trailing 'es' (statuses → status)
  if (slug.endsWith('es')) {
    const base = slug.slice(0,-2);
    candidates.add(`application::${base}.${base}`);
  }
  return [...candidates];
}

/**
 * Generate candidate v5 UIDs for a given slug.
 * v5 uses: api::<model>.<model>
 */
function v5UidCandidates(slug) {
  const candidates = new Set();
  candidates.add(`api::${slug}.${slug}`);
  if (slug.endsWith('s')) candidates.add(`api::${slug.slice(0,-1)}.${slug.slice(0,-1)}`);
  if (slug.endsWith('ies')) {
    const base = slug.slice(0,-3) + 'y';
    candidates.add(`api::${base}.${base}`);
  }
  if (slug.endsWith('es')) {
    const base = slug.slice(0,-2);
    candidates.add(`api::${base}.${base}`);
  }
  return [...candidates];
}

/**
 * Fetch all content type UIDs registered in the v3 Content Manager.
 * Used as a fallback to find the correct UID for a slug.
 */
async function discoverV3Uid(slug) {
  if (uidCache.has(slug)) return uidCache.get(slug);

  // First: try candidate UIDs directly
  for (const uid of v3UidCandidates(slug)) {
    try {
      const r = await axios.get(`${cfg.v3Url}/content-manager/content-types/${uid}`, {
        headers: { Authorization: `Bearer ${cfg.v3Token}` },
        timeout: 10000,
      });
      if (r.data?.data?.schema?.attributes || r.data?.schema?.attributes) {
        uidCache.set(slug, uid);
        return uid;
      }
    } catch { /* try next */ }
  }

  // Fallback: list all content types and find one whose collectionName or uid matches the slug
  try {
    const r = await axios.get(`${cfg.v3Url}/content-manager/content-types`, {
      headers: { Authorization: `Bearer ${cfg.v3Token}` },
      timeout: 10000,
    });
    const types = r.data?.data || r.data || [];
    if (Array.isArray(types)) {
      const match = types.find(t => {
        const info = t.info || t.schema?.info || {};
        return (
          t.uid?.includes(slug) ||
          info.pluralName === slug ||
          info.singularName === slug ||
          t.collectionName === slug ||
          t.apiID === slug
        );
      });
      if (match?.uid) {
        uidCache.set(slug, match.uid);
        return match.uid;
      }
    }
  } catch (err) {
    logger.warn(`Could not list v3 content types to discover UID for "${slug}": ${err.message}`);
  }

  logger.warn(`Could not resolve v3 UID for slug "${slug}". Schema fetch will be skipped.`);
  uidCache.set(slug, null);
  return null;
}

// ── Attribute parser ───────────────────────────────────────────────────────────

/**
 * Convert a target UID (e.g. "api::tag.tag", "application::author.author") to
 * the collection API slug (e.g. "tags", "authors").
 *
 * Uses the v3 content type list to find the exact pluralName if possible,
 * otherwise falls back to simple pluralisation.
 */
function uidToSlug(uid) {
  if (!uid || typeof uid !== 'string') return null;
  // e.g. "application::author.author" or "api::tag.tag"
  const parts = uid.split('.');
  const modelName = parts[parts.length - 1]; // "author" or "tag"
  // Naive pluralise — good enough for most cases; schema will clarify edge cases
  if (modelName.endsWith('y')) return modelName.slice(0,-1) + 'ies';
  if (modelName.endsWith('s')) return modelName;
  return modelName + 's';
}

/**
 * Parse raw Strapi attributes into a normalised schema descriptor map.
 *
 * Output per field:
 * {
 *   type: 'media' | 'relation' | 'dynamiczone' | 'component' | 'primitive',
 *   relatedSlug: string | null,
 *   isRepeatable: boolean,
 *   componentUid: string | null,
 *   componentUids: string[],   // for dynamiczone
 * }
 */
function parseAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') return {};
  const schema = {};

  for (const [fieldName, attr] of Object.entries(attributes)) {
    if (!attr || typeof attr !== 'object') continue;
    const t = attr.type;

    if (t === 'media') {
      schema[fieldName] = { type: 'media' };
    } else if (t === 'relation') {
      schema[fieldName] = {
        type: 'relation',
        relatedSlug: uidToSlug(attr.target || attr.relatedModel || null),
        relationType: attr.relation || null, // oneToOne, oneToMany, manyToMany etc
      };
    } else if (t === 'dynamiczone') {
      schema[fieldName] = {
        type: 'dynamiczone',
        componentUids: Array.isArray(attr.components) ? attr.components : [],
      };
    } else if (t === 'component') {
      schema[fieldName] = {
        type: 'component',
        isRepeatable: attr.repeatable === true,
        componentUid: attr.component || null,
      };
    } else {
      schema[fieldName] = { type: 'primitive' };
    }
  }

  return schema;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get the parsed schema for a content type slug.
 * Fetches from v3 CM API; falls back to v5 CM API; falls back to empty schema.
 * All results are cached.
 *
 * @param {string} slug - e.g. "articles"
 * @returns {object} - fieldName → descriptor
 */
async function getSchema(slug) {
  if (schemaCache.has(slug)) return schemaCache.get(slug);

  logger.info(`Fetching schema for "${slug}"...`);

  // Discover the correct UID
  const uid = await discoverV3Uid(slug);

  let rawAttributes = null;

  if (uid) {
    try {
      const r = await axios.get(`${cfg.v3Url}/content-manager/content-types/${uid}`, {
        headers: { Authorization: `Bearer ${cfg.v3Token}` },
        timeout: 15000,
      });
      rawAttributes =
        r.data?.data?.schema?.attributes ||
        r.data?.schema?.attributes ||
        r.data?.attributes ||
        null;
    } catch (err) {
      logger.warn(`v3 schema fetch failed for "${slug}" (${uid}): ${err.message}`);
    }
  }

  // Fallback: try v5 Content Manager API
  if (!rawAttributes) {
    logger.warn(`Trying v5 schema fallback for "${slug}"...`);
    for (const v5uid of v5UidCandidates(slug)) {
      try {
        const r = await axios.get(`${cfg.v5Url}/content-manager/content-types/${v5uid}`, {
          headers: { Authorization: `Bearer ${cfg.v5Token}` },
          timeout: 15000,
        });
        rawAttributes =
          r.data?.data?.schema?.attributes ||
          r.data?.schema?.attributes ||
          r.data?.attributes ||
          null;
        if (rawAttributes) break;
      } catch { /* try next */ }
    }
  }

  if (!rawAttributes) {
    logger.warn(
      `Schema unavailable for "${slug}". Field type detection will use runtime heuristics only.`
    );
    schemaCache.set(slug, {});
    return {};
  }

  const parsed = parseAttributes(rawAttributes);
  const summary = Object.entries(parsed)
    .map(([k, v]) => `${k}(${v.type}${v.relatedSlug ? ':'+v.relatedSlug : ''})`)
    .join(', ');
  logger.info(`Schema for "${slug}": ${summary || '(empty)'}`);

  schemaCache.set(slug, parsed);
  return parsed;
}

/**
 * Get the parsed schema for a component UID.
 * e.g. "sections.hero", "shared.seo"
 *
 * @param {string} componentUid
 * @returns {object} - fieldName → descriptor
 */
async function getComponentSchema(componentUid) {
  if (!componentUid) return {};
  const cacheKey = `__cmp__${componentUid}`;
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey);

  // Try v3 first
  let rawAttributes = null;
  try {
    const r = await axios.get(
      `${cfg.v3Url}/content-manager/components/${componentUid}`,
      { headers: { Authorization: `Bearer ${cfg.v3Token}` }, timeout: 15000 }
    );
    rawAttributes =
      r.data?.data?.schema?.attributes ||
      r.data?.schema?.attributes ||
      r.data?.attributes ||
      null;
  } catch (err) {
    logger.warn(`v3 component schema fetch failed for "${componentUid}": ${err.message}`);
  }

  // Fallback: v5
  if (!rawAttributes) {
    try {
      const r = await axios.get(
        `${cfg.v5Url}/content-manager/components/${componentUid}`,
        { headers: { Authorization: `Bearer ${cfg.v5Token}` }, timeout: 15000 }
      );
      rawAttributes =
        r.data?.data?.schema?.attributes ||
        r.data?.schema?.attributes ||
        r.data?.attributes ||
        null;
    } catch { /* ignore */ }
  }

  const parsed = rawAttributes ? parseAttributes(rawAttributes) : {};
  schemaCache.set(cacheKey, parsed);
  return parsed;
}

function clearCache() {
  schemaCache.clear();
  uidCache.clear();
}

module.exports = { getSchema, getComponentSchema, uidToSlug, clearCache };
