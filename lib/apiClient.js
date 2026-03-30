'use strict';

/**
 * apiClient.js
 * HTTP wrappers for Strapi v3 and v5.
 * - No API tokens (open access)
 * - No populate params on v3 calls
 * - Lazy env reads (after dotenv loads)
 * - Retry + exponential backoff on 5xx / 429
 */

const axios  = require('axios');
const logger = require('./logger');

// All env values read at call time so dotenv has already run
const cfg = {
  get v3Url()    { return (process.env.STRAPI_V3_URL || '').replace(/\/$/, ''); },
  get v5Url()    { return (process.env.STRAPI_V5_URL || '').replace(/\/$/, ''); },
  get delay()    { return parseInt(process.env.DELAY_MS    || '5000', 10); },
  get retries()  { return parseInt(process.env.MAX_RETRIES || '3',    10); },
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function wait() {
  if (cfg.delay > 0) {
    logger.info(`Waiting ${cfg.delay}ms...`);
    await sleep(cfg.delay);
  }
}

// ── Core HTTP request with retry ──────────────────────────────────────────────
async function req(config, retries, backoff = 2000) {
  if (retries === undefined) retries = cfg.retries;
  try {
    const res = await axios({ timeout: 60000, ...config });
    if (res.data == null) return { data: null, error: 'Empty response', status: res.status };
    return { data: res.data, error: null, status: res.status };
  } catch (err) {
    const status = err?.response?.status;
    const body   = err?.response?.data;

    if (status === 429) {
      const wait_ms = parseInt(err?.response?.headers?.['retry-after'] || '0', 10) * 1000 || backoff;
      logger.warn(`429 rate limit — waiting ${wait_ms}ms`);
      await sleep(wait_ms);
      return req(config, retries, Math.min(backoff * 2, 60000));
    }

    if (status >= 500 && retries > 0) {
      logger.warn(`HTTP ${status} — retrying in ${backoff}ms (${retries} left)`);
      await sleep(backoff);
      return req(config, retries - 1, Math.min(backoff * 2, 30000));
    }

    const msg = body?.error?.message || body?.message || err.message || `HTTP ${status || '?'}`;
    return { data: null, error: msg, status: status || 0 };
  }
}

// ── v3 client ─────────────────────────────────────────────────────────────────
const v3 = {

  // Fetch a page of collection entries
  // v3 pagination: _start + _limit
  async getCollection(slug, start, limit, locale) {
    const params = { _start: start, _limit: limit };
    if (locale) params._locale = locale;
    await wait();
    return req({ method: 'GET', url: `${cfg.v3Url}/${slug}`, params });
  },

  // Fetch a single entry by ID
  async getEntry(slug, id, locale) {
    const params = {};
    if (locale) params._locale = locale;
    await wait();
    return req({ method: 'GET', url: `${cfg.v3Url}/${slug}/${id}`, params });
  },

  // Total count for a collection
  async getCount(slug, locale) {
    const params = {};
    if (locale) params._locale = locale;
    await wait();
    const r = await req({ method: 'GET', url: `${cfg.v3Url}/${slug}/count`, params });
    if (r.error && locale) {
      // Retry without locale — collection may not be i18n-enabled
      await wait();
      const r2 = await req({ method: 'GET', url: `${cfg.v3Url}/${slug}/count` });
      return typeof r2.data === 'number' ? r2.data : 0;
    }
    return typeof r.data === 'number' ? r.data : 0;
  },

  // Fetch a single type
  async getSingleType(slug, locale) {
    const params = {};
    if (locale) params._locale = locale;
    await wait();
    return req({ method: 'GET', url: `${cfg.v3Url}/${slug}`, params });
  },

  // Ping a slug — used in validation
  async ping(slug) {
    await wait();
    return req({ method: 'GET', url: `${cfg.v3Url}/${slug}`, params: { _limit: 1 }, timeout: 10000 });
  },
};

// ── v5 client ─────────────────────────────────────────────────────────────────
const v5 = {

  // Fetch a collection page from v5
  async getCollection(slug, page, pageSize, locale) {
    const params = { 'pagination[page]': page, 'pagination[pageSize]': pageSize };
    if (locale) params.locale = locale;
    await wait();
    return req({ method: 'GET', url: `${cfg.v5Url}/api/${slug}`, params });
  },

  // Create a new entry
  // Body: { data: { ...fields, locale } }
  async create(slug, body) {
    await wait();
    return req({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Update an existing entry
  async update(slug, id, body) {
    await wait();
    return req({
      method: 'PUT',
      url: `${cfg.v5Url}/api/${slug}/${id}`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Update a single type
  async updateSingleType(slug, body, locale) {
    const params = {};
    if (locale) params.locale = locale;
    await wait();
    return req({
      method: 'PUT',
      url: `${cfg.v5Url}/api/${slug}`,
      data: body,
      params,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Create a localization variant: POST /api/:slug/:id/localizations
  async createLocalization(slug, id, body) {
    await wait();
    return req({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}/${id}/localizations`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Find an entry by a specific field value (for relation lookup)
  async findByField(slug, field, value) {
    await wait();
    return req({
      method: 'GET',
      url: `${cfg.v5Url}/api/${slug}`,
      params: { [`filters[${field}][$eq]`]: value, 'pagination[pageSize]': 1 },
    });
  },

  // Publish an entry (sets publishedAt)
  async publish(slug, id) {
    await wait();
    return req({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}/${id}/actions/publish`,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Upload a file — called from mediaHandler
  async uploadFile(formData) {
    // No wait() here — mediaHandler manages its own timing
    return req({
      method: 'POST',
      url: `${cfg.v5Url}/api/upload`,
      data: formData,
      headers: { ...formData.getHeaders() },
    });
  },
};

module.exports = { v3, v5, sleep, wait, cfg };
