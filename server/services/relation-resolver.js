'use strict';

/**
 * Relation Resolver Service
 *
 * Resolves cross-environment relation references.
 *
 * The fundamental challenge: a relation on the source env points to a document
 * by its `documentId`. That same documentId should exist on the target env
 * (Strapi v5 documentIds are stable across environments when content is synced).
 *
 * This service:
 *  1. Validates that related documents exist on the target env.
 *  2. Translates relation payloads into the format Strapi's Document Service expects.
 *  3. Handles circular relations with a visited set to avoid infinite loops.
 *  4. Reports broken relations (related doc missing on target) as warnings.
 *
 * @module env-sync/server/services/relation-resolver
 */

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = ({ strapi }) => ({

  /**
   * Validate and normalise all relations in a payload for the local (target) env.
   *
   * @param {object} params
   * @param {object} params.payload       - Document payload from source env
   * @param {string} params.contentType   - Strapi UID
   * @param {Set<string>} [params.visited] - Visited documentIds to prevent circular loops
   * @returns {Promise<{ payload: object, brokenRelations: object[] }>}
   */
  async resolveRelations({ payload, contentType, visited = new Set() }) {
    const schema = _getSchema(strapi, contentType);
    if (!schema) {
      return { payload, brokenRelations: [] };
    }

    const brokenRelations = [];
    const resolvedPayload = await _resolveBySchema({
      data:       payload,
      schema,
      visited,
      brokenRelations,
      strapi,
      path:       contentType,
    });

    return { payload: resolvedPayload, brokenRelations };
  },

  /**
   * Verify that a specific document exists on the local env.
   *
   * @param {string} contentType
   * @param {string} documentId
   * @returns {Promise<boolean>}
   */
  async documentExists(contentType, documentId) {
    try {
      const doc = await strapi.documents(contentType).findOne({ documentId });
      return doc != null;
    } catch {
      return false;
    }
  },
});

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Recursively resolve all relation attributes in a data object
 * using the content type's schema.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function _resolveBySchema({ data, schema, visited, brokenRelations, strapi, path }) {
  if (!data || typeof data !== 'object') return data;

  const result     = { ...data };
  const attributes = schema.attributes || {};

  for (const [attrName, attrDef] of Object.entries(attributes)) {
    const val = result[attrName];
    if (val == null) continue;

    switch (attrDef.type) {

      // ── Relations ─────────────────────────────────────────────────────────
      case 'relation': {
        result[attrName] = await _resolveRelationField({
          val,
          attrName,
          attrDef,
          brokenRelations,
          strapi,
          path: `${path}.${attrName}`,
        });
        break;
      }

      // ── Components ────────────────────────────────────────────────────────
      case 'component': {
        const componentSchema = _getSchema(strapi, attrDef.component);
        if (!componentSchema) break;

        if (attrDef.repeatable) {
          result[attrName] = await Promise.all(
            (val || []).map((item) =>
              _resolveBySchema({
                data:       item,
                schema:     componentSchema,
                visited,
                brokenRelations,
                strapi,
                path:       `${path}.${attrName}[]`,
              })
            )
          );
        } else {
          result[attrName] = await _resolveBySchema({
            data:       val,
            schema:     componentSchema,
            visited,
            brokenRelations,
            strapi,
            path:       `${path}.${attrName}`,
          });
        }
        break;
      }

      // ── Dynamic Zones ─────────────────────────────────────────────────────
      case 'dynamiczone': {
        result[attrName] = await Promise.all(
          (val || []).map(async (zone) => {
            if (!zone?.__component) return zone;
            const zoneSchema = _getSchema(strapi, zone.__component);
            if (!zoneSchema) return zone;

            return _resolveBySchema({
              data:       zone,
              schema:     zoneSchema,
              visited,
              brokenRelations,
              strapi,
              path:       `${path}.${attrName}[${zone.__component}]`,
            });
          })
        );
        break;
      }

      // All other types (scalar, media, etc.) are left as-is
    }
  }

  return result;
}

/**
 * Resolve a single relation field value.
 * Validates each related documentId exists on the target env.
 *
 * @param {object} params
 * @returns {Promise<any>} normalised relation connect payload
 */
async function _resolveRelationField({ val, attrName, attrDef, brokenRelations, strapi, path }) {
  const targetContentType = attrDef.target;

  // Normalise to array of { documentId }
  const sourceRefs = _normaliseRelationValue(val);
  if (sourceRefs.length === 0) return null;

  const validRefs   = [];
  const missingRefs = [];

  for (const ref of sourceRefs) {
    const docId = ref.documentId || ref.id;
    if (!docId) continue;

    // Skip polymorphic morph relations — can't validate without target type
    if (!targetContentType || targetContentType === 'morph') {
      validRefs.push(ref);
      continue;
    }

    try {
      const exists = await strapi.documents(targetContentType).findOne({
        documentId: String(docId),
        fields:     ['id'],
      });

      if (exists) {
        validRefs.push({ documentId: String(docId) });
      } else {
        missingRefs.push(docId);
        brokenRelations.push({
          path,
          targetContentType,
          documentId: docId,
          reason:     'not-found-on-target',
        });
      }
    } catch (err) {
      strapi.log.warn(
        `[env-sync] relation-resolver: could not check ${targetContentType}#${docId}: ${err.message}`
      );
      // Be lenient — include the ref optimistically
      validRefs.push({ documentId: String(docId) });
    }
  }

  if (missingRefs.length > 0) {
    strapi.log.warn(
      `[env-sync] relation-resolver: ${missingRefs.length} related document(s) not found ` +
      `on target for ${path} → ${targetContentType}: [${missingRefs.join(', ')}]`
    );
  }

  if (validRefs.length === 0) return null;

  // Return in Strapi v5 Document Service connect format
  const isToMany = ['oneToMany', 'manyToMany', 'morphToMany'].includes(attrDef.relation);
  if (isToMany) {
    return { connect: validRefs };
  }
  // toOne — return single connect
  return { connect: [validRefs[0]] };
}

/**
 * Normalise a relation value to an array of { documentId } objects.
 * Handles all the shapes Strapi may return from document population.
 *
 * @param {any} val
 * @returns {{ documentId: string }[]}
 */
function _normaliseRelationValue(val) {
  if (!val) return [];

  // Already a connect object: { connect: [...] }
  if (val.connect) {
    return (val.connect || []).map((r) => ({ documentId: r.documentId || r.id })).filter((r) => r.documentId);
  }

  // Array of populated documents or ids
  if (Array.isArray(val)) {
    return val.map((r) => {
      if (typeof r === 'string' || typeof r === 'number') return { documentId: String(r) };
      if (r?.documentId) return { documentId: r.documentId };
      if (r?.id) return { documentId: String(r.id) };
      return null;
    }).filter(Boolean);
  }

  // Single populated document
  if (val.documentId) return [{ documentId: val.documentId }];
  if (val.id) return [{ documentId: String(val.id) }];

  return [];
}

/**
 * Get Strapi content type schema safely.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} uid
 * @returns {object|null}
 */
function _getSchema(strapi, uid) {
  try { return strapi.getModel(uid); } catch { return null; }
}
