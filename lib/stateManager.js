'use strict';

/**
 * stateManager.js
 * Reads and writes migration-state.json to track progress across runs.
 * Enables resuming from the last successful checkpoint.
 *
 * State file structure:
 * {
 *   "articles": {
 *     "type": "collection",         // "collection" | "singleType"
 *     "status": "in_progress",      // "pending" | "in_progress" | "done"
 *     "lastPage": 2,                // last fully processed page (0-indexed)
 *     "idMap": { "42": 87, ... },   // v3 entry ID → v5 entry ID
 *     "failedIds": [43, 55],        // v3 IDs that exceeded retry limit
 *     "retryCount": { "43": 3 }     // per-ID retry counter
 *   },
 *   ...
 * }
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const STATE_FILE = path.resolve(process.cwd(), 'migration-state.json');

let state = {};

/**
 * Load the state file from disk. If it doesn't exist, start with empty state.
 */
function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      state = JSON.parse(raw);
      logger.info(`Loaded existing state from ${STATE_FILE}`);
    } else {
      state = {};
      logger.info('No existing state file found — starting fresh.');
    }
  } catch (err) {
    // If state file is corrupted, log a warning and reset — don't crash
    logger.warn(`Failed to parse state file, resetting. Reason: ${err.message}`);
    state = {};
  }
}

/**
 * Persist current state to disk.
 * Safe write: write to a temp file first then rename to avoid corruption.
 */
function save() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    // Failing to save state is non-fatal — log it and carry on
    logger.warn(`Failed to save state file: ${err.message}`);
  }
}

/**
 * Initialize state for a slug if it hasn't been seen before.
 */
function initSlug(slug, type) {
  if (!state[slug]) {
    state[slug] = {
      type,           // "collection" | "singleType"
      status: 'pending',
      lastPage: -1,   // -1 means no pages processed yet
      idMap: {},      // v3Id (string) → v5Id
      failedIds: [],  // v3 IDs permanently skipped
      retryCount: {}, // v3Id (string) → number of attempts
    };
    save();
  }
}

/**
 * Check if a slug has already been fully migrated.
 */
function isDone(slug) {
  return state[slug]?.status === 'done';
}

/**
 * Get the last successfully completed page index for a slug.
 * Returns -1 if no pages have been processed.
 */
function getLastPage(slug) {
  return state[slug]?.lastPage ?? -1;
}

/**
 * Mark a page as successfully completed for a slug.
 */
function setLastPage(slug, page) {
  if (state[slug]) {
    state[slug].lastPage = page;
    state[slug].status = 'in_progress';
    save();
  }
}

/**
 * Mark a slug as fully done.
 */
function markDone(slug) {
  if (state[slug]) {
    state[slug].status = 'done';
    save();
  }
}

/**
 * Store the v3 → v5 ID mapping for an entry.
 */
function setIdMapping(slug, v3Id, v5Id) {
  if (state[slug]) {
    state[slug].idMap[String(v3Id)] = v5Id;
    // Save periodically — don't save on every single entry to reduce I/O
    // We save on page completion in the main loop, so this is just an in-memory update
  }
}

/**
 * Get the v5 ID for a given v3 ID within a slug.
 * Returns null if not mapped yet.
 */
function getV5Id(slug, v3Id) {
  return state[slug]?.idMap?.[String(v3Id)] ?? null;
}

/**
 * Get the full idMap for a slug (used by relationResolver to cross-reference).
 */
function getIdMap(slug) {
  return state[slug]?.idMap ?? {};
}

/**
 * Increment and return the retry count for an entry.
 */
function incrementRetry(slug, v3Id) {
  if (!state[slug]) return 0;
  const key = String(v3Id);
  state[slug].retryCount[key] = (state[slug].retryCount[key] || 0) + 1;
  save();
  return state[slug].retryCount[key];
}

/**
 * Get current retry count for an entry.
 */
function getRetryCount(slug, v3Id) {
  return state[slug]?.retryCount?.[String(v3Id)] ?? 0;
}

/**
 * Mark an entry as permanently failed (exceeded max retries).
 */
function markFailed(slug, v3Id) {
  if (state[slug]) {
    const id = String(v3Id);
    if (!state[slug].failedIds.includes(id)) {
      state[slug].failedIds.push(id);
    }
    save();
  }
}

/**
 * Check if an entry is permanently failed.
 */
function isFailed(slug, v3Id) {
  return state[slug]?.failedIds?.includes(String(v3Id)) ?? false;
}

/**
 * Check if an entry has already been successfully migrated (has a v5 ID).
 */
function isAlreadyMigrated(slug, v3Id) {
  return state[slug]?.idMap?.[String(v3Id)] != null;
}

/**
 * Flush in-memory state to disk (call after processing each page).
 */
function flush() {
  save();
}

module.exports = {
  load,
  save,
  flush,
  initSlug,
  isDone,
  getLastPage,
  setLastPage,
  markDone,
  setIdMapping,
  getV5Id,
  getIdMap,
  incrementRetry,
  getRetryCount,
  markFailed,
  isFailed,
  isAlreadyMigrated,
};
