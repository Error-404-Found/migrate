'use strict';

/**
 * dynamicZoneHandler.js
 * Processes dynamic zones and nested components.
 *
 * Uses component schemas from schemaInspector to correctly identify
 * media, relation, nested component, and primitive fields.
 *
 * KEY RULE: An object that has an `id` AND nested object-valued fields
 * is a COMPONENT — not a relation. Only objects whose non-system fields
 * are all scalars AND whose field names are known relation identifiers
 * are treated as relations.
 */

const { processMediaField }   = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { getComponentSchema, toCamel } = require('./schemaInspector');
const logger = require('./logger');

// System fields stripped from every component payload before sending to v5
const SYSTEM = new Set(['id','created_at','updated_at','created_by','updated_by','__v','__component']);

// Known relation identifier field names — objects whose non-system fields
// are ALL in this set are treated as relation objects, not components.
const REL_FIELDS = new Set([
  'id','slug','title','name','email','code','handle','key','uid','username',
  'locale','localizations','created_at','updated_at','created_by','updated_by','published_at','__v',
]);

// ── Heuristics ─────────────────────────────────────────────────────────────────

function isMedia(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return typeof v.url === 'string' && (v.mime != null || v.ext != null || v.name != null);
}

// An array is a true relation array when every non-system key in each item
// is a known relation identifier (e.g. {id, slug, title}).
// Arrays containing domain-specific keys (label, url, href, text, icon etc.)
// are repeatable component arrays and should be processed, not skipped.
function isRelationArray(arr) {
  if (!Array.isArray(arr) || !arr.length) return false;
  const first = arr[0];
  if (!first || typeof first !== 'object' || typeof first.id !== 'number') return false;
  if (isMedia(first)) return false;
  return Object.keys(first).every(k => REL_FIELDS.has(k));
}

// A single object is a true relation if it has an id and all non-system
// fields are scalars AND match known relation identifier names.
function isRelationObj(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (isMedia(v)) return false;
  if (typeof v.id !== 'number') return false;
  // If any value is a non-null object → it's a component (has nested data)
  const hasNested = Object.entries(v).some(([k, val]) =>
    !SYSTEM.has(k) && val !== null && typeof val === 'object'
  );
  if (hasNested) return false;
  // All non-system keys must be in REL_FIELDS
  return Object.keys(v).every(k => REL_FIELDS.has(k));
}

function isDynamicZone(arr) {
  return Array.isArray(arr) && arr.length > 0 &&
    typeof arr[0]?.__component === 'string';
}

// ── Component processor ───────────────────────────────────────────────────────

async function processComponent(data, componentUid, ct, id) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

  const schema = componentUid ? await getComponentSchema(componentUid) : {};
  const out = {};

  for (const [key, value] of Object.entries(data)) {
    if (SYSTEM.has(key)) continue;

    const def    = schema[key];
    const outKey = def ? def.v5Name : toCamel(key);

    if (value === null || value === undefined) { out[outKey] = null; continue; }

    if (def) {
      // Schema-driven — definitive
      if (def.type === 'media') {
        out[outKey] = await processMediaField(value, ct, id);
      } else if (def.type === 'relation') {
        out[outKey] = def.relatedSlug
          ? await resolveRelationField(value, def.relatedSlug, ct, id)
          : null;
      } else if (def.type === 'dynamiczone') {
        out[outKey] = Array.isArray(value) ? await processDynamicZone(value, ct, id) : null;
      } else if (def.type === 'component') {
        if (def.isRepeatable) {
          out[outKey] = Array.isArray(value)
            ? await Promise.all(value.map(item => processComponent(item, def.componentUid, ct, id)))
            : [];
        } else {
          out[outKey] = (value && typeof value === 'object' && !Array.isArray(value))
            ? await processComponent(value, def.componentUid, ct, id)
            : null;
        }
      } else {
        out[outKey] = value;
      }
      continue;
    }

    // ── Heuristic fallback ───────────────────────────────────────────────────
    if (Array.isArray(value)) {
      if (isDynamicZone(value)) {
        out[outKey] = await processDynamicZone(value, ct, id);
      } else if (value.length > 0 && isMedia(value[0])) {
        out[outKey] = await processMediaField(value, ct, id);
      } else if (isRelationArray(value)) {
        logger.warn(`Component "${componentUid}" field "${key}": relation array, schema missing. Skipping.`, ct, id);
        out[outKey] = null;
      } else if (value.length > 0 && typeof value[0] === 'object') {
        // Repeatable component (e.g. breadcrumbs, links — has domain-specific fields)
        out[outKey] = await Promise.all(value.map(item => processComponent(item, null, ct, id)));
      } else {
        out[outKey] = value;
      }
      continue;
    }

    if (isMedia(value))      { out[outKey] = await processMediaField(value, ct, id); continue; }
    if (isRelationObj(value)){ out[outKey] = null; logger.warn(`Component "${componentUid}" field "${key}": relation, schema missing.`, ct, id); continue; }

    if (typeof value === 'object') {
      // Nested component (e.g. meta, seo object)
      out[outKey] = await processComponent(value, null, ct, id);
      continue;
    }

    out[outKey] = value;
  }

  return out;
}

// ── Dynamic zone processor ────────────────────────────────────────────────────

async function processDynamicZone(items, ct, id) {
  if (!Array.isArray(items)) return [];
  const out = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const uid = item.__component;
    if (!uid) { logger.warn(`DZ item missing __component`, ct, id); continue; }

    try {
      const processed = await processComponent(item, uid, ct, id);
      processed.__component = uid;
      out.push(processed);
    } catch (e) {
      logger.error(`DZ component "${uid}" failed: ${e.message}`, ct, id);
    }
  }

  return out;
}

module.exports = { processDynamicZone, processComponent };
