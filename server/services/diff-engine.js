'use strict';

/**
 * Diff Engine Service
 *
 * Computes a structured diff between a source document (from the outbound env)
 * and a target document (fetched from the inbound env before overwriting).
 *
 * The diff is used for:
 *  1. The confirmation modal in the admin UI (shows changed fields)
 *  2. The diffSummary stored in the audit log
 *  3. Conflict-strategy decisions (target-wins requires knowing if target changed)
 *
 * @module env-sync/server/services/diff-engine
 */

const isEqual  = require('lodash/isEqual');
const isObject = require('lodash/isPlainObject');
const get      = require('lodash/get');

/**
 * @param {{ strapi: import('@strapi/strapi').Strapi }} context
 */
module.exports = ({ strapi }) => ({

  /**
   * Compute a diff between the source payload and the current target document.
   *
   * @param {object} params
   * @param {object} params.sourceData    - Full serialised document from source env
   * @param {object|null} params.targetData - Current document on target env (null = new document)
   * @param {string} params.contentType   - Strapi UID
   * @returns {object} DiffResult
   */
  computeDiff({ sourceData, targetData, contentType }) {
    if (!targetData) {
      // Document does not exist on target — everything is "new"
      return {
        isNew:            true,
        fieldsChanged:    [],
        fieldsAdded:      _collectLeafKeys(sourceData),
        fieldsRemoved:    [],
        relationsUpdated: [],
        mediaChanged:     [],
        localesDiff:      [],
        componentDiff:    [],
        dynamicZoneDiff:  [],
        hasChanges:       true,
      };
    }

    const schema = _getSchema(strapi, contentType);
    if (!schema) {
      strapi.log.warn(`[env-sync] diff-engine: no schema found for ${contentType} — doing deep equality check`);
      return _deepDiff(sourceData, targetData);
    }

    return _diffBySchema(sourceData, targetData, schema, strapi);
  },

  /**
   * Summarise a diff into a concise object for storage in the audit log.
   *
   * @param {object} diff - result of computeDiff()
   * @returns {object}
   */
  summarise(diff) {
    return {
      isNew:            diff.isNew ?? false,
      hasChanges:       diff.hasChanges,
      fieldsChanged:    diff.fieldsChanged,
      fieldsAdded:      diff.fieldsAdded ?? [],
      fieldsRemoved:    diff.fieldsRemoved ?? [],
      relationsUpdated: diff.relationsUpdated,
      mediaReuploaded:  diff.mediaChanged,
      localesSynced:    diff.localesDiff?.map((l) => l.locale) ?? [],
      componentDiff:    diff.componentDiff?.length ?? 0,
      dynamicZoneDiff:  diff.dynamicZoneDiff?.length ?? 0,
    };
  },

  /**
   * Determine whether a sync should proceed based on conflict strategy.
   *
   * @param {object} params
   * @param {object} params.diff
   * @param {string} params.strategy       - 'source-wins' | 'target-wins' | 'manual'
   * @param {Date|null} params.sourceUpdatedAt
   * @param {Date|null} params.targetUpdatedAt
   * @returns {{ proceed: boolean, reason: string }}
   */
  resolveConflict({ diff, strategy, sourceUpdatedAt, targetUpdatedAt }) {
    if (!diff.hasChanges) {
      return { proceed: false, reason: 'no-changes', message: 'Source and target are identical.' };
    }

    switch (strategy) {
      case 'source-wins':
        return { proceed: true, reason: 'source-wins', message: 'Source overrides target.' };

      case 'target-wins': {
        if (!targetUpdatedAt || !sourceUpdatedAt) {
          return { proceed: true, reason: 'source-wins-fallback', message: 'No timestamps — defaulting to source-wins.' };
        }
        const sourceTs = new Date(sourceUpdatedAt).getTime();
        const targetTs = new Date(targetUpdatedAt).getTime();
        if (targetTs > sourceTs) {
          return {
            proceed: false,
            reason:  'target-newer',
            message: `Target was modified after source (target: ${targetUpdatedAt}, source: ${sourceUpdatedAt}). Skipping.`,
          };
        }
        return { proceed: true, reason: 'source-newer', message: 'Source is newer — proceeding.' };
      }

      case 'manual':
        return {
          proceed: false,
          reason:  'manual-review-required',
          message: 'Conflict strategy is "manual". An administrator must resolve this conflict before syncing.',
        };

      default:
        return { proceed: true, reason: 'unknown-strategy-fallback', message: `Unknown strategy "${strategy}" — defaulting to source-wins.` };
    }
  },
});

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Retrieve the Strapi schema for a content type.
 *
 * @param {import('@strapi/strapi').Strapi} strapi
 * @param {string} contentType
 * @returns {object|null}
 */
function _getSchema(strapi, contentType) {
  try {
    return strapi.getModel(contentType);
  } catch {
    return null;
  }
}

/**
 * Schema-aware diff: iterates over attribute definitions to produce
 * a typed, structured diff result.
 *
 * @param {object} source
 * @param {object} target
 * @param {object} schema
 * @param {import('@strapi/strapi').Strapi} strapi
 * @returns {object}
 */
function _diffBySchema(source, target, schema, strapi) {
  const fieldsChanged    = [];
  const relationsUpdated = [];
  const mediaChanged     = [];
  const componentDiff    = [];
  const dynamicZoneDiff  = [];

  const attributes = schema.attributes || {};

  for (const [attrName, attrDef] of Object.entries(attributes)) {
    const srcVal = source[attrName];
    const tgtVal = target[attrName];

    switch (attrDef.type) {
      // ── Scalar fields ──────────────────────────────────────────────────────
      case 'string':
      case 'text':
      case 'richtext':
      case 'email':
      case 'password':
      case 'uid':
      case 'enumeration':
      case 'boolean':
      case 'integer':
      case 'biginteger':
      case 'float':
      case 'decimal':
      case 'date':
      case 'datetime':
      case 'time':
      case 'json':
      case 'blocks': {
        if (!isEqual(srcVal, tgtVal)) {
          fieldsChanged.push({
            field:    attrName,
            type:     attrDef.type,
            oldValue: _summariseValue(tgtVal),
            newValue: _summariseValue(srcVal),
          });
        }
        break;
      }

      // ── Relations ─────────────────────────────────────────────────────────
      case 'relation': {
        const srcIds = _extractRelationIds(srcVal);
        const tgtIds = _extractRelationIds(tgtVal);
        if (!isEqual(srcIds.sort(), tgtIds.sort())) {
          relationsUpdated.push({
            field:       attrName,
            relation:    attrDef.relation,
            target:      attrDef.target,
            addedIds:    srcIds.filter((id) => !tgtIds.includes(id)),
            removedIds:  tgtIds.filter((id) => !srcIds.includes(id)),
          });
        }
        break;
      }

      // ── Media ─────────────────────────────────────────────────────────────
      case 'media': {
        const srcHashes = _extractMediaHashes(srcVal);
        const tgtHashes = _extractMediaHashes(tgtVal);
        if (!isEqual(srcHashes.sort(), tgtHashes.sort())) {
          mediaChanged.push({
            field:        attrName,
            multiple:     attrDef.multiple ?? false,
            addedFiles:   srcHashes.filter((h) => !tgtHashes.includes(h)),
            removedFiles: tgtHashes.filter((h) => !srcHashes.includes(h)),
          });
        }
        break;
      }

      // ── Components ────────────────────────────────────────────────────────
      case 'component': {
        if (!isEqual(srcVal, tgtVal)) {
          componentDiff.push({
            field:      attrName,
            repeatable: attrDef.repeatable ?? false,
            changed:    true,
          });
        }
        break;
      }

      // ── Dynamic Zones ─────────────────────────────────────────────────────
      case 'dynamiczone': {
        if (!isEqual(srcVal, tgtVal)) {
          const srcComponents = (srcVal || []).map((c) => c.__component);
          const tgtComponents = (tgtVal || []).map((c) => c.__component);
          dynamicZoneDiff.push({
            field:          attrName,
            sourceLength:   (srcVal || []).length,
            targetLength:   (tgtVal || []).length,
            componentsUsed: [...new Set(srcComponents)],
            changed:        true,
          });
        }
        break;
      }

      default:
        // Unknown attribute type — fall back to deep equality
        if (!isEqual(srcVal, tgtVal)) {
          fieldsChanged.push({
            field:    attrName,
            type:     attrDef.type || 'unknown',
            oldValue: _summariseValue(tgtVal),
            newValue: _summariseValue(srcVal),
          });
        }
    }
  }

  const hasChanges =
    fieldsChanged.length > 0 ||
    relationsUpdated.length > 0 ||
    mediaChanged.length > 0 ||
    componentDiff.length > 0 ||
    dynamicZoneDiff.length > 0;

  return {
    isNew:           false,
    fieldsChanged,
    fieldsAdded:     [],
    fieldsRemoved:   [],
    relationsUpdated,
    mediaChanged,
    localesDiff:     [],
    componentDiff,
    dynamicZoneDiff,
    hasChanges,
  };
}

/**
 * Deep equality diff for when we don't have a schema.
 * Returns a simplified diff.
 *
 * @param {object} source
 * @param {object} target
 * @returns {object}
 */
function _deepDiff(source, target) {
  const fieldsChanged = [];
  const allKeys = new Set([...Object.keys(source || {}), ...Object.keys(target || {})]);

  for (const key of allKeys) {
    if (!isEqual(source?.[key], target?.[key])) {
      fieldsChanged.push({ field: key, type: 'unknown', oldValue: _summariseValue(target?.[key]), newValue: _summariseValue(source?.[key]) });
    }
  }

  return {
    isNew:           false,
    fieldsChanged,
    fieldsAdded:     [],
    fieldsRemoved:   [],
    relationsUpdated: [],
    mediaChanged:    [],
    localesDiff:     [],
    componentDiff:   [],
    dynamicZoneDiff: [],
    hasChanges:      fieldsChanged.length > 0,
  };
}

/**
 * Collect all leaf-level keys from an object (for "new document" diffs).
 *
 * @param {object} obj
 * @param {string} [prefix]
 * @returns {string[]}
 */
function _collectLeafKeys(obj, prefix = '') {
  if (!isObject(obj)) return prefix ? [prefix] : [];
  return Object.entries(obj).flatMap(([k, v]) =>
    isObject(v) ? _collectLeafKeys(v, prefix ? `${prefix}.${k}` : k) : [prefix ? `${prefix}.${k}` : k]
  );
}

/**
 * Extract documentIds from a relation value (handles both array and single).
 *
 * @param {any} val
 * @returns {string[]}
 */
function _extractRelationIds(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((r) => r?.documentId ?? r?.id).filter(Boolean).map(String);
  if (val.documentId) return [String(val.documentId)];
  if (val.id) return [String(val.id)];
  return [];
}

/**
 * Extract file hashes from a media value (handles single and multiple).
 *
 * @param {any} val
 * @returns {string[]}
 */
function _extractMediaHashes(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map((f) => f?.hash).filter(Boolean);
  return val?.hash ? [val.hash] : [];
}

/**
 * Create a concise human-readable summary of a value for display in diffs.
 * Avoids exposing large JSON blobs in the log UI.
 *
 * @param {any} val
 * @returns {string}
 */
function _summariseValue(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') return val.length > 80 ? `${val.slice(0, 80)}…` : val;
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (Array.isArray(val)) return `[Array(${val.length})]`;
  if (isObject(val)) return `{Object(${Object.keys(val).length} keys)}`;
  return String(val);
}
