'use strict';

/**
 * schemaInspector.js
 * Fetches content-type and component schemas from the Strapi Content Manager API.
 * Results are cached in memory — each schema is fetched only once per run.
 *
 * Schema tells us per-field: type (media/relation/dynamiczone/component/primitive)
 * and the correct camelCase v5 field name so we write the right key in the payload.
 */

const axios  = require('axios');
const logger = require('./logger');

const cfg = {
  get v3Url() { return (process.env.STRAPI_V3_URL || '').replace(/\/$/, ''); },
  get v5Url() { return (process.env.STRAPI_V5_URL || '').replace(/\/$/, ''); },
};

const cache    = new Map(); // slug / cmpUid → parsed schema
const uidCache = new Map(); // slug → v3 UID string

// ── snake_case → camelCase ────────────────────────────────────────────────────
function toCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// ── UID discovery ─────────────────────────────────────────────────────────────

function v3Candidates(slug) {
  const s = new Set();
  s.add(`application::${slug}.${slug}`);
  if (slug.endsWith('s'))   s.add(`application::${slug.slice(0,-1)}.${slug.slice(0,-1)}`);
  if (slug.endsWith('ies')) { const b = slug.slice(0,-3)+'y'; s.add(`application::${b}.${b}`); }
  if (slug.endsWith('es') && !slug.endsWith('ies')) { const b = slug.slice(0,-2); s.add(`application::${b}.${b}`); }
  return [...s];
}

function v5Candidates(slug) {
  const s = new Set();
  s.add(`api::${slug}.${slug}`);
  if (slug.endsWith('s'))   s.add(`api::${slug.slice(0,-1)}.${slug.slice(0,-1)}`);
  if (slug.endsWith('ies')) { const b = slug.slice(0,-3)+'y'; s.add(`api::${b}.${b}`); }
  if (slug.endsWith('es') && !slug.endsWith('ies')) { const b = slug.slice(0,-2); s.add(`api::${b}.${b}`); }
  return [...s];
}

async function discoverUid(slug) {
  if (uidCache.has(slug)) return uidCache.get(slug);

  // Try direct UID candidates first
  for (const uid of v3Candidates(slug)) {
    try {
      const r = await axios.get(`${cfg.v3Url}/content-manager/content-types/${uid}`, { timeout: 8000 });
      if (r.data?.data?.schema?.attributes || r.data?.schema?.attributes) {
        uidCache.set(slug, uid);
        return uid;
      }
    } catch { /* try next */ }
  }

  // Fallback: list all registered content types
  try {
    const r = await axios.get(`${cfg.v3Url}/content-manager/content-types`, { timeout: 8000 });
    const list = r.data?.data || r.data || [];
    if (Array.isArray(list)) {
      const match = list.find(t => {
        const info = t.info || t.schema?.info || {};
        return (
          t.uid?.split('::')[1]?.split('.')[0] === slug ||
          info.pluralName === slug ||
          info.singularName === slug ||
          t.collectionName === slug ||
          t.apiID === slug ||
          t.uid?.includes(slug)
        );
      });
      if (match?.uid) { uidCache.set(slug, match.uid); return match.uid; }
    }
  } catch (e) {
    logger.warn(`UID discovery failed for "${slug}": ${e.message}`);
  }

  uidCache.set(slug, null);
  return null;
}

// ── Relation UID → API slug ───────────────────────────────────────────────────
function uidToSlug(uid) {
  if (!uid) return null;
  // e.g. "application::author.author" → "authors"
  // e.g. "api::tag.tag" → "tags"
  const model = uid.split('.').pop();
  if (model.endsWith('y') && !['day','way','key','boy','toy'].includes(model))
    return model.slice(0,-1) + 'ies';
  if (model.endsWith('s')) return model;
  return model + 's';
}

// ── Attribute parser ──────────────────────────────────────────────────────────
function parseAttrs(attributes) {
  if (!attributes) return {};
  const out = {};
  for (const [name, attr] of Object.entries(attributes)) {
    if (!attr || typeof attr !== 'object') continue;
    const v5Name = toCamel(name);
    const t = attr.type;
    if      (t === 'media')       out[name] = { type: 'media',       v5Name };
    else if (t === 'relation')    out[name] = { type: 'relation',    v5Name, relatedSlug: uidToSlug(attr.target || attr.relatedModel), relationType: attr.relation };
    else if (t === 'dynamiczone') out[name] = { type: 'dynamiczone', v5Name, componentUids: attr.components || [] };
    else if (t === 'component')   out[name] = { type: 'component',   v5Name, isRepeatable: !!attr.repeatable, componentUid: attr.component };
    else                          out[name] = { type: 'primitive',   v5Name };
  }
  return out;
}

function extractAttrs(data) {
  return (
    data?.data?.schema?.attributes ||
    data?.schema?.attributes ||
    data?.attributes ||
    null
  );
}

// ── Public: content type schema ───────────────────────────────────────────────
async function getSchema(slug) {
  if (cache.has(slug)) return cache.get(slug);

  const uid = await discoverUid(slug);
  let raw = null;

  if (uid) {
    try {
      const r = await axios.get(`${cfg.v3Url}/content-manager/content-types/${uid}`, { timeout: 10000 });
      raw = extractAttrs(r.data);
    } catch (e) {
      logger.warn(`v3 schema fetch failed for "${slug}": ${e.message}`);
    }
  }

  // v5 fallback
  if (!raw) {
    for (const v5uid of v5Candidates(slug)) {
      try {
        const r = await axios.get(`${cfg.v5Url}/content-manager/content-types/${v5uid}`, { timeout: 10000 });
        raw = extractAttrs(r.data);
        if (raw) break;
      } catch { /* try next */ }
    }
  }

  const parsed = raw ? parseAttrs(raw) : {};

  if (Object.keys(parsed).length > 0) {
    const fields = Object.entries(parsed).map(([k, v]) =>
      `${k}→${v.v5Name}(${v.type}${v.relatedSlug ? ':'+v.relatedSlug : ''})`
    ).join(', ');
    logger.info(`Schema [${slug}]: ${fields}`);
  } else {
    logger.warn(`No schema for "${slug}" — using heuristics`);
  }

  cache.set(slug, parsed);
  return parsed;
}

// ── Public: component schema ──────────────────────────────────────────────────
async function getComponentSchema(uid) {
  if (!uid) return {};
  const key = `__cmp__${uid}`;
  if (cache.has(key)) return cache.get(key);

  let raw = null;

  try {
    const r = await axios.get(`${cfg.v3Url}/content-manager/components/${uid}`, { timeout: 10000 });
    raw = extractAttrs(r.data);
  } catch (e) {
    logger.warn(`v3 component schema failed for "${uid}": ${e.message}`);
  }

  if (!raw) {
    try {
      const r = await axios.get(`${cfg.v5Url}/content-manager/components/${uid}`, { timeout: 10000 });
      raw = extractAttrs(r.data);
    } catch { /* ignore */ }
  }

  const parsed = raw ? parseAttrs(raw) : {};
  logger.info(`Component schema [${uid}]: ${Object.keys(parsed).join(', ') || '(none — using heuristics)'}`);
  cache.set(key, parsed);
  return parsed;
}

module.exports = { getSchema, getComponentSchema, toCamel, uidToSlug };
