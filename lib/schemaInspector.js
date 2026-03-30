'use strict';

/**
 * schemaInspector.js
 * Fetches and caches content type and component schemas from Strapi APIs.
 *
 * KEY FIX: parseAttributes now tracks ALL known component UIDs so the heuristic
 * layer can distinguish a component object (has id + non-relation fields) from
 * a true relation object (has id + only Strapi-internal fields).
 */

const axios  = require('axios');
const logger = require('./logger');

const cfg = {
  get v3Url()   { return (process.env.STRAPI_V3_URL  || '').replace(/\/$/, ''); },
  get v5Url()   { return (process.env.STRAPI_V5_URL  || '').replace(/\/$/, ''); }
};

const schemaCache = new Map();
const uidCache    = new Map();

// ── UID candidates ─────────────────────────────────────────────────────────────

function v3UidCandidates(slug) {
  const c = new Set();
  c.add(`application::${slug}.${slug}`);
  if (slug.endsWith('s'))   c.add(`application::${slug.slice(0,-1)}.${slug.slice(0,-1)}`);
  if (slug.endsWith('ies')) { const b = slug.slice(0,-3)+'y'; c.add(`application::${b}.${b}`); }
  if (slug.endsWith('es'))  { const b = slug.slice(0,-2);     c.add(`application::${b}.${b}`); }
  return [...c];
}

function v5UidCandidates(slug) {
  const c = new Set();
  c.add(`api::${slug}.${slug}`);
  if (slug.endsWith('s'))   c.add(`api::${slug.slice(0,-1)}.${slug.slice(0,-1)}`);
  if (slug.endsWith('ies')) { const b = slug.slice(0,-3)+'y'; c.add(`api::${b}.${b}`); }
  if (slug.endsWith('es'))  { const b = slug.slice(0,-2);     c.add(`api::${b}.${b}`); }
  return [...c];
}

async function discoverV3Uid(slug) {
  if (uidCache.has(slug)) return uidCache.get(slug);

  for (const uid of v3UidCandidates(slug)) {
    try {
      const r = await axios.get(`${cfg.v3Url}/content-manager/content-types/${uid}`, {
         timeout: 10000
      });
      if (r.data?.data?.schema?.attributes || r.data?.schema?.attributes) {
        uidCache.set(slug, uid); return uid;
      }
    } catch { /* try next */ }
  }

  // Fallback: list all CTs
  try {
    const r = await axios.get(`${cfg.v3Url}/content-manager/content-types`, {
       timeout: 10000
    });
    const types = r.data?.data || r.data || [];
    if (Array.isArray(types)) {
      const match = types.find(t => {
        const info = t.info || t.schema?.info || {};
        return t.uid?.includes(slug) || info.pluralName === slug ||
               info.singularName === slug || t.collectionName === slug || t.apiID === slug;
      });
      if (match?.uid) { uidCache.set(slug, match.uid); return match.uid; }
    }
  } catch (err) {
    logger.warn(`Could not list v3 content types for UID discovery of "${slug}": ${err.message}`);
  }

  logger.warn(`Could not resolve v3 UID for slug "${slug}".`);
  uidCache.set(slug, null);
  return null;
}

// ── Slug helpers ──────────────────────────────────────────────────────────────

function uidToSlug(uid) {
  if (!uid || typeof uid !== 'string') return null;
  const modelName = uid.split('.').pop();
  if (modelName.endsWith('y') && !modelName.endsWith('ey')) return modelName.slice(0,-1) + 'ies';
  if (modelName.endsWith('s')) return modelName;
  return modelName + 's';
}

// ── snake_case → camelCase ────────────────────────────────────────────────────
// v3 field names use snake_case; v5 REST API uses camelCase for the same fields.
function toCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// ── Attribute parser ──────────────────────────────────────────────────────────

/**
 * Parse raw Strapi attributes into a normalised descriptor map.
 * Keyed by the ORIGINAL v3 field name (snake_case).
 * Includes v5FieldName (camelCase) so callers can write the correct output key.
 */
function parseAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') return {};
  const schema = {};

  for (const [fieldName, attr] of Object.entries(attributes)) {
    if (!attr || typeof attr !== 'object') continue;
    const t = attr.type;
    // The v5 field name is camelCase; v3 field name is the key
    const v5FieldName = toCamel(fieldName);

    if (t === 'media') {
      schema[fieldName] = { type: 'media', v5FieldName };
    } else if (t === 'relation') {
      schema[fieldName] = {
        type: 'relation',
        v5FieldName,
        relatedSlug: uidToSlug(attr.target || attr.relatedModel || null),
        relationType: attr.relation || null
      };
    } else if (t === 'dynamiczone') {
      schema[fieldName] = {
        type: 'dynamiczone',
        v5FieldName,
        componentUids: Array.isArray(attr.components) ? attr.components : []
      };
    } else if (t === 'component') {
      schema[fieldName] = {
        type: 'component',
        v5FieldName,
        isRepeatable: attr.repeatable === true,
        componentUid: attr.component || null
      };
    } else {
      // All scalar types: string, text, richtext, integer, decimal, boolean,
      // date, datetime, time, json, uid, email, password, enumeration, blocks
      schema[fieldName] = { type: 'primitive', v5FieldName };
    }
  }

  return schema;
}

// ── Public: get content type schema ───────────────────────────────────────────

async function getSchema(slug) {
  if (schemaCache.has(slug)) return schemaCache.get(slug);

  logger.info(`Fetching schema for "${slug}"...`);
  const uid = await discoverV3Uid(slug);
  let rawAttributes = null;

  if (uid) {
    try {
      const r = await axios.get(`${cfg.v3Url}/content-manager/content-types/${uid}`, {
         timeout: 15000
      });
      rawAttributes = r.data?.data?.schema?.attributes || r.data?.schema?.attributes || r.data?.attributes || null;
    } catch (err) {
      logger.warn(`v3 schema fetch failed for "${slug}" (${uid}): ${err.message}`);
    }
  }

  // Fallback: v5 CM API
  if (!rawAttributes) {
    logger.warn(`Falling back to v5 schema for "${slug}"...`);
    for (const v5uid of v5UidCandidates(slug)) {
      try {
        const r = await axios.get(`${cfg.v5Url}/content-manager/content-types/${v5uid}`, {
           timeout: 15000
        });
        rawAttributes = r.data?.data?.schema?.attributes || r.data?.schema?.attributes || r.data?.attributes || null;
        if (rawAttributes) break;
      } catch { /* try next */ }
    }
  }

  if (!rawAttributes) {
    logger.warn(`Schema unavailable for "${slug}". Using runtime heuristics only.`);
    schemaCache.set(slug, {});
    return {};
  }

  const parsed = parseAttributes(rawAttributes);
  const summary = Object.entries(parsed).map(([k,v]) =>
    `${k}→${v.v5FieldName}(${v.type}${v.relatedSlug ? ':'+v.relatedSlug : ''}${v.componentUid ? ':'+v.componentUid : ''})`
  ).join(', ');
  logger.info(`Schema for "${slug}": ${summary || '(empty)'}`);

  schemaCache.set(slug, parsed);
  return parsed;
}

// ── Public: get component schema ──────────────────────────────────────────────

async function getComponentSchema(componentUid) {
  if (!componentUid) return {};
  const cacheKey = `__cmp__${componentUid}`;
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey);

  let rawAttributes = null;

  // Try v3 first
  try {
    const r = await axios.get(`${cfg.v3Url}/content-manager/components/${componentUid}`, {
       timeout: 15000
    });
    rawAttributes = r.data?.data?.schema?.attributes || r.data?.schema?.attributes || r.data?.attributes || null;
  } catch (err) {
    logger.warn(`v3 component schema failed for "${componentUid}": ${err.message}`);
  }

  // Fallback: v5
  if (!rawAttributes) {
    try {
      const r = await axios.get(`${cfg.v5Url}/content-manager/components/${componentUid}`, {
         timeout: 15000
      });
      rawAttributes = r.data?.data?.schema?.attributes || r.data?.schema?.attributes || r.data?.attributes || null;
    } catch { /* ignore */ }
  }

  const parsed = rawAttributes ? parseAttributes(rawAttributes) : {};

  if (Object.keys(parsed).length > 0) {
    logger.info(`Component schema "${componentUid}": ${Object.keys(parsed).join(', ')}`);
  } else {
    logger.warn(`Component schema unavailable for "${componentUid}". Using heuristics.`);
  }

  schemaCache.set(cacheKey, parsed);
  return parsed;
}

function clearCache() { schemaCache.clear(); uidCache.clear(); }

module.exports = { getSchema, getComponentSchema, uidToSlug, toCamel, clearCache };
