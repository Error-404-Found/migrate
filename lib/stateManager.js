'use strict';

/**
 * stateManager.js
 * Reads and writes migration-state.json to track progress across runs.
 *
 * FIX: State is flushed to disk after every successfully migrated entry,
 *      not just at page boundaries — prevents losing progress on mid-page crash.
 *
 * State file structure:
 * {
 *   "articles": {
 *     "type": "collection" | "singleType",
 *     "status": "pending" | "in_progress" | "done",
 *     "lastPage": 2,          // last fully completed page (0-indexed)
 *     "idMap": { "42": 87 },  // v3 ID (string) → v5 ID
 *     "failedIds": ["43"],    // permanently failed v3 IDs
 *     "retryCount": { "43": 3 }
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const STATE_FILE = path.resolve(process.cwd(), 'migration-state.json');

let state = {};
let _dirty = false; // track whether state needs writing

// ── Load / Save ───────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      logger.info(`Loaded migration state from ${STATE_FILE}`);
    } else {
      state = {};
      logger.info('No existing state file — starting fresh.');
    }
  } catch (err) {
    logger.warn(`State file corrupt, resetting. Reason: ${err.message}`);
    state = {};
  }
  _dirty = false;
}

/**
 * Persist state to disk using atomic write (tmp + rename) to avoid corruption.
 */
function save() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    _dirty = false;
  } catch (err) {
    logger.warn(`Failed to save state file: ${err.message}`);
  }
}

/**
 * Flush if dirty — call this after each significant operation.
 * FIX: Called after every entry (not just page end) to minimise data loss.
 */
function flush() {
  if (_dirty) save();
}

function markDirty() {
  _dirty = true;
}

// ── Slug management ───────────────────────────────────────────────────────────

function initSlug(slug, type) {
  if (!state[slug]) {
    state[slug] = {
      type,
      status: 'pending',
      lastPage: -1,
      idMap: {},
      failedIds: [],
      retryCount: {},
    };
    save();
  }
}

function isDone(slug) {
  return state[slug]?.status === 'done';
}

function markDone(slug) {
  if (state[slug]) {
    state[slug].status = 'done';
    save();
  }
}

// ── Page tracking ─────────────────────────────────────────────────────────────

function getLastPage(slug) {
  return state[slug]?.lastPage ?? -1;
}

function setLastPage(slug, page) {
  if (state[slug]) {
    state[slug].lastPage = page;
    state[slug].status = 'in_progress';
    save(); // always save page boundary
  }
}

// ── ID mapping ────────────────────────────────────────────────────────────────

/**
 * FIX: Save immediately after setting each ID mapping so that on a crash
 *      mid-page, already-migrated entries in that page are not re-migrated.
 */
function setIdMapping(slug, v3Id, v5Id) {
  if (state[slug]) {
    state[slug].idMap[String(v3Id)] = v5Id;
    save(); // immediate save — prevents duplicate entries on restart
  }
}

function getV5Id(slug, v3Id) {
  return state[slug]?.idMap?.[String(v3Id)] ?? null;
}

function getIdMap(slug) {
  return state[slug]?.idMap ?? {};
}

function isAlreadyMigrated(slug, v3Id) {
  return state[slug]?.idMap?.[String(v3Id)] != null;
}

// ── Retry / failure tracking ──────────────────────────────────────────────────

function incrementRetry(slug, v3Id) {
  if (!state[slug]) return 0;
  const key = String(v3Id);
  state[slug].retryCount[key] = (state[slug].retryCount[key] || 0) + 1;
  markDirty();
  flush();
  return state[slug].retryCount[key];
}

function getRetryCount(slug, v3Id) {
  return state[slug]?.retryCount?.[String(v3Id)] ?? 0;
}

function markFailed(slug, v3Id) {
  if (state[slug]) {
    const id = String(v3Id);
    if (!state[slug].failedIds.includes(id)) {
      state[slug].failedIds.push(id);
    }
    save();
  }
}

function isFailed(slug, v3Id) {
  return state[slug]?.failedIds?.includes(String(v3Id)) ?? false;
}

module.exports = {
  load, save, flush,
  initSlug, isDone, markDone,
  getLastPage, setLastPage,
  setIdMapping, getV5Id, getIdMap, isAlreadyMigrated,
  incrementRetry, getRetryCount, markFailed, isFailed,
};
