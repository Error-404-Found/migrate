'use strict';

/**
 * fieldMapper.js
 * Maps a v3 entry's raw fields to a v5-compatible data payload.
 *
 * KEY FIX: Field names are written to v5 using the camelCase name from schema
 * (v5FieldName). Without schema, toCamel() converts snake_case → camelCase.
 * This fixes: dynamic_sections → dynamicSections, additional_sections → additionalSections etc.
 *
 * KEY FIX: Component objects (meta, breadcrumbs, etc.) are no longer
 * misidentified as relations. The improved looksLikeRelation() checks whether
 * the object has nested object values before declaring it a relation.
 */

const { processMediaField }    = require('./mediaHandler');
const { resolveRelationField }  = require('./relationResolver');
const { processDynamicZone, processComponent } = require('./dynamicZoneHandler');
const { getSchema, toCamel }   = require('./schemaInspector');
const logger = require('./logger');

// v3 system fields that must never be sent to v5
const V3_INTERNAL = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'updated_by', '__v', 'localizations',
]);

// Explicit renames (v3 key → v5 key) beyond camelCase conversion
// published_at would normally become publishedAt via toCamel — but we handle
// it separately (stripping and re-applying via publish action) so it stays here
// for documentation.
const EXPLICIT_RENAME = {
  // published_at is stripped and handled via publishIfNeeded in index.js
};

// ── Heuristics ─────────────────────────────────────────────────────────────────

function looksLikeMedia(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return typeof v.url === 'string' && (v.mime != null || v.ext != null || v.name != null);
}

/**
 * KEY FIX: A value is only treated as a relation if it has an id AND
 * all its non-internal fields are scalars (no nested objects).
 * If it has any nested object field, it's a component — process it.
 */
function looksLikeRelation(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (looksLikeMedia(v)) return false;
  if (typeof v.id !== 'number') return false;
  const INTERNAL = new Set(['id','created_at','updated_at','created_by','updated_by','__v','locale','localizations']);
  const hasNestedObject = Object.entries(v).some(([k, val]) =>
    !INTERNAL.has(k) && val !== null && typeof val === 'object'
  );
  return !hasNestedObject; // has nested objects → component, not relation
}

function looksLikeDynamicZone(arr) {
  return Array.isArray(arr) && arr.length > 0 &&
    typeof arr[0] === 'object' && arr[0] !== null &&
    typeof arr[0].__component === 'string';
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
  // If ANY key is outside the known relation identifier set, it is a component array
  const nonRelationField = Object.keys(first).find(k => !RELATION_IDENTIFIER_FIELDS.has(k));
  return !nonRelationField;
}

// ── Main mapper ───────────────────────────────────────────────────────────────

/**
 * Map a v3 entry to a v5-compatible data object.
 *
 * @param {object} v3Entry  - raw v3 entry from v3 REST API
 * @param {string} slug     - content type slug
 * @param {any}    v3Id     - entry ID (logging)
 * @param {string} locale   - locale being processed (logging)
 * @returns {object}        - v5 data payload — wrap in { data: ... } before POST/PUT
 */
async function mapFields(v3Entry, slug, v3Id, locale = null) {
  if (!v3Entry || typeof v3Entry !== 'object') return {};

  // Fetch schema once — cached after first call per slug
  const schema = await getSchema(slug);

  const out = {};

  for (const [key, value] of Object.entries(v3Entry)) {

    // ── Strip v3-only system fields ──────────────────────────────────────────
    if (V3_INTERNAL.has(key)) continue;

    // published_at → handled by publishIfNeeded in index.js, strip here
    if (key === 'published_at' || key === 'publishedAt') continue;

    const def = schema[key];

    // Determine the output key:
    // Schema available → use schema's v5FieldName (authoritative camelCase)
    // No schema → apply toCamel() to convert snake_case fields
    // Explicit rename takes priority over both
    const outKey = EXPLICIT_RENAME[key] || (def ? def.v5FieldName : toCamel(key));

    // ── Null passthrough ─────────────────────────────────────────────────────
    if (value === null || value === undefined) {
      out[outKey] = null;
      continue;
    }

    // ── Schema-driven (definitive) ────────────────────────────────────────────
    if (def) {
      switch (def.type) {

        case 'media':
          out[outKey] = await processMediaField(value, slug, v3Id);
          continue;

        case 'relation':
          if (def.relatedSlug) {
            out[outKey] = await resolveRelationField(value, def.relatedSlug, slug, v3Id);
          } else {
            logger.warn(
              `Field "${key}" is a relation with no target slug for "${slug}". Skipping.`,
              slug, v3Id, locale
            );
            out[outKey] = null;
          }
          continue;

        case 'dynamiczone':
          out[outKey] = Array.isArray(value)
            ? await processDynamicZone(value, slug, v3Id)
            : null;
          continue;

        case 'component':
          if (def.isRepeatable) {
            out[outKey] = Array.isArray(value)
              ? await Promise.all(value.map(item => processComponent(item, def.componentUid, slug, v3Id)))
              : [];
          } else {
            out[outKey] = (value && typeof value === 'object' && !Array.isArray(value))
              ? await processComponent(value, def.componentUid, slug, v3Id)
              : null;
          }
          continue;

        case 'primitive':
        default:
          out[outKey] = value;
          continue;
      }
    }

    // ── Heuristic fallback (schema missing for this field) ────────────────────

    // Dynamic zone: array where every item has __component
    if (looksLikeDynamicZone(value)) {
      out[outKey] = await processDynamicZone(value, slug, v3Id);
      continue;
    }

    // Single media object
    if (looksLikeMedia(value)) {
      out[outKey] = await processMediaField(value, slug, v3Id);
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        out[outKey] = [];
        continue;
      }

      const first = value[0];

      // Array of media objects
      if (looksLikeMedia(first)) {
        out[outKey] = await processMediaField(value, slug, v3Id);
        continue;
      }

      // Array of objects — could be relation array OR repeatable component array
      if (typeof first === 'object' && first !== null) {
        if (looksLikeRelationArray(value)) {
          // True relation array — can't resolve without schema knowing the target
          logger.warn(
            `Field "${key}" looks like a relation array but schema is unavailable for "${slug}". ` +
            `Skipping. Check v3 Content Manager API access.`,
            slug, v3Id, locale
          );
          out[outKey] = null;
        } else {
          // KEY FIX: Repeatable component array (breadcrumbs, etc.)
          // Don't skip — process each item as a component
          out[outKey] = await Promise.all(
            value.map(item => processComponent(item, null, slug, v3Id))
          );
        }
        continue;
      }

      // Primitive array (string[], number[], etc.)
      out[outKey] = value;
      continue;
    }

    // Relation object — only if looksLikeRelation is true (scalars only, no nested objects)
    if (looksLikeRelation(value)) {
      logger.warn(
        `Field "${key}" looks like a relation but schema is unavailable for "${slug}". ` +
        `Cannot resolve target slug — skipping. Check v3 Content Manager API access.`,
        slug, v3Id, locale
      );
      out[outKey] = null;
      continue;
    }

    // Plain nested object — component (meta, seo, breadcrumb item, etc.)
    // KEY FIX: process as component instead of skipping
    if (typeof value === 'object' && !Array.isArray(value)) {
      out[outKey] = await processComponent(value, null, slug, v3Id);
      continue;
    }

    // Primitive
    out[outKey] = value;
  }

  return out;
}

module.exports = { mapFields };
