'use strict';

/**
 * fieldMapper.js
 * Maps a raw v3 entry to a v5-compatible data payload.
 *
 * Field type is determined from the schema (fetched from v3/v5 CM API).
 * When schema is unavailable for a field, heuristics are used as fallback.
 *
 * Output key names are camelCase (v5 convention).
 * v3 snake_case field names are converted via toCamel().
 */

const { processMediaField }   = require('./mediaHandler');
const { resolveRelationField } = require('./relationResolver');
const { processDynamicZone, processComponent } = require('./dynamicZoneHandler');
const { getSchema, toCamel }  = require('./schemaInspector');
const logger = require('./logger');

// v3 system fields — never send to v5
const SYSTEM = new Set([
  'id','created_at','updated_at','created_by','updated_by',
  '__v','localizations','published_at','publishedAt',
]);

// Same relation-identifier field set as in dynamicZoneHandler
const REL_FIELDS = new Set([
  'id','slug','title','name','email','code','handle','key','uid','username',
  'locale','localizations','created_at','updated_at','created_by','updated_by','published_at','__v',
]);

// ── Heuristics ─────────────────────────────────────────────────────────────────

function isMedia(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return typeof v.url === 'string' && (v.mime != null || v.ext != null || v.name != null);
}

function isDynamicZone(arr) {
  return Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.__component === 'string';
}

function isRelationObj(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (isMedia(v)) return false;
  if (typeof v.id !== 'number') return false;
  const INTERNAL = new Set(['id','created_at','updated_at','created_by','updated_by','__v','locale','localizations']);
  const hasNested = Object.entries(v).some(([k, val]) =>
    !INTERNAL.has(k) && val !== null && typeof val === 'object'
  );
  return !hasNested;
}

function isRelationArray(arr) {
  if (!Array.isArray(arr) || !arr.length) return false;
  const first = arr[0];
  if (!first || typeof first !== 'object' || typeof first.id !== 'number') return false;
  if (isMedia(first)) return false;
  return Object.keys(first).every(k => REL_FIELDS.has(k));
}

// ── Main mapper ───────────────────────────────────────────────────────────────

async function mapFields(v3Entry, slug, v3Id, locale) {
  if (!v3Entry || typeof v3Entry !== 'object') return {};

  const schema = await getSchema(slug);
  const out    = {};

  for (const [key, value] of Object.entries(v3Entry)) {
    if (SYSTEM.has(key)) continue;

    const def    = schema[key];
    const outKey = def ? def.v5Name : toCamel(key);

    if (value === null || value === undefined) { out[outKey] = null; continue; }

    if (def) {
      // Schema says exactly what this field is
      if (def.type === 'media') {
        out[outKey] = await processMediaField(value, slug, v3Id);

      } else if (def.type === 'relation') {
        out[outKey] = def.relatedSlug
          ? await resolveRelationField(value, def.relatedSlug, slug, v3Id)
          : null;
        if (!def.relatedSlug) logger.warn(`Field "${key}" has no target slug in schema.`, slug, v3Id, locale);

      } else if (def.type === 'dynamiczone') {
        out[outKey] = Array.isArray(value)
          ? await processDynamicZone(value, slug, v3Id)
          : null;

      } else if (def.type === 'component') {
        if (def.isRepeatable) {
          out[outKey] = Array.isArray(value)
            ? await Promise.all(value.map(item => processComponent(item, def.componentUid, slug, v3Id)))
            : [];
        } else {
          out[outKey] = (value && typeof value === 'object' && !Array.isArray(value))
            ? await processComponent(value, def.componentUid, slug, v3Id)
            : null;
        }

      } else {
        out[outKey] = value;
      }
      continue;
    }

    // ── Heuristic fallback ────────────────────────────────────────────────────

    if (isDynamicZone(value)) {
      out[outKey] = await processDynamicZone(value, slug, v3Id);
      continue;
    }

    if (isMedia(value)) {
      out[outKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    if (Array.isArray(value)) {
      if (!value.length) { out[outKey] = []; continue; }

      if (isMedia(value[0])) {
        out[outKey] = await processMediaField(value, slug, v3Id);
        continue;
      }

      if (isDynamicZone(value)) {
        out[outKey] = await processDynamicZone(value, slug, v3Id);
        continue;
      }

      if (isRelationArray(value)) {
        logger.warn(`Field "${key}" looks like a relation array but schema missing. Skipping.`, slug, v3Id, locale);
        out[outKey] = null;
        continue;
      }

      if (typeof value[0] === 'object') {
        // Repeatable component array (breadcrumbs, links, items, etc.)
        out[outKey] = await Promise.all(value.map(item => processComponent(item, null, slug, v3Id)));
        continue;
      }

      out[outKey] = value;
      continue;
    }

    if (isRelationObj(value)) {
      logger.warn(`Field "${key}" looks like a relation but schema missing. Skipping.`, slug, v3Id, locale);
      out[outKey] = null;
      continue;
    }

    if (typeof value === 'object') {
      // Nested component (meta, seo, address block, etc.)
      out[outKey] = await processComponent(value, null, slug, v3Id);
      continue;
    }

    out[outKey] = value;
  }

  return out;
}

module.exports = { mapFields };
