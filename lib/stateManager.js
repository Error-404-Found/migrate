'use strict';

/**
 * stateManager.js
 * Persists migration progress to migration-state.json.
 * Saves immediately after each entry so restarts don't re-migrate completed work.
 */

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.resolve(process.cwd(), 'migration-state.json');

let state = {};

function load() {
  try {
    if (fs.existsSync(FILE)) {
      state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      logger.info(`Loaded state from ${FILE}`);
    } else {
      state = {};
      logger.info('No state file found — starting fresh.');
    }
  } catch (e) {
    logger.warn(`State file corrupt, resetting: ${e.message}`);
    state = {};
  }
}

function save() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    logger.warn(`Could not save state: ${e.message}`);
  }
}

function initSlug(slug, type) {
  if (!state[slug]) {
    state[slug] = { type, status: 'pending', lastPage: -1, idMap: {}, failed: [], retries: {} };
    save();
  }
}

const isDone          = (slug)        => state[slug]?.status === 'done';
const markDone        = (slug)        => { if (state[slug]) { state[slug].status = 'done'; save(); } };
const getLastPage     = (slug)        => state[slug]?.lastPage ?? -1;
const setLastPage     = (slug, p)     => { if (state[slug]) { state[slug].lastPage = p; state[slug].status = 'in_progress'; save(); } };
const isMigrated      = (slug, v3Id) => state[slug]?.idMap?.[String(v3Id)] != null;
const isFailed        = (slug, v3Id) => state[slug]?.failed?.includes(String(v3Id)) ?? false;
const getV5Id         = (slug, v3Id) => state[slug]?.idMap?.[String(v3Id)] ?? null;
const getIdMap        = (slug)        => state[slug]?.idMap ?? {};

function setIdMapping(slug, v3Id, v5Id) {
  if (state[slug]) {
    state[slug].idMap[String(v3Id)] = v5Id;
    save(); // save immediately — crash safety
  }
}

function markFailed(slug, v3Id) {
  if (state[slug]) {
    const k = String(v3Id);
    if (!state[slug].failed.includes(k)) state[slug].failed.push(k);
    save();
  }
}

function bumpRetry(slug, v3Id) {
  if (!state[slug]) return 0;
  const k = String(v3Id);
  state[slug].retries[k] = (state[slug].retries[k] || 0) + 1;
  save();
  return state[slug].retries[k];
}

module.exports = {
  load, save,
  initSlug, isDone, markDone,
  getLastPage, setLastPage,
  isMigrated, isFailed, getV5Id, getIdMap,
  setIdMapping, markFailed, bumpRetry,
};
