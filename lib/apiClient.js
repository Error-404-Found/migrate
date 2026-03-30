'use strict';

/**
 * apiClient.js
 * Axios wrappers for Strapi v3 and v5 REST APIs.
 * No API tokens — both instances are accessed without authentication.
 * No populate params on v3 — data comes back as-is from the public API.
 */

const axios  = require('axios');
const logger = require('./logger');

// Lazy env readers — resolved at call time so dotenv has already run
const cfg = {
  get v3Url()     { return (process.env.STRAPI_V3_URL || '').replace(/\/$/, ''); },
  get v5Url()     { return (process.env.STRAPI_V5_URL || '').replace(/\/$/, ''); },
  get delayMs()   { return parseInt(process.env.DELAY_MS    || '30000', 10); },
  get maxRetries(){ return parseInt(process.env.MAX_RETRIES || '5',     10); },
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enforceDelay(customMs) {
  const ms = customMs != null ? customMs : cfg.delayMs;
  if (ms > 0) {
    logger.info(`Waiting ${ms}ms before next API call...`);
    await sleep(ms);
  }
}

// ── Core request — retry + exponential backoff ────────────────────────────────

async function request(config, retries, backoffMs = 2000) {
  if (retries === undefined) retries = cfg.maxRetries;
  try {
    const response = await axios({ timeout: 60000, ...config });
    if (response.data == null) {
      return { data: null, error: 'Empty response body', statusCode: response.status };
    }
    return { data: response.data, error: null, statusCode: response.status };
  } catch (err) {
    const status = err?.response?.status;
    const body   = err?.response?.data;

    if (status === 429) {
      const wait = err?.response?.headers?.['retry-after']
        ? parseInt(err.response.headers['retry-after'], 10) * 1000
        : backoffMs;
      logger.warn(`Rate limited (429). Waiting ${wait}ms...`);
      await sleep(wait);
      return request(config, retries, Math.min(backoffMs * 2, 120000));
    }

    if (status >= 500 && retries > 0) {
      logger.warn(`Server error ${status}. Retrying in ${backoffMs}ms... (${retries} left)`);
      await sleep(backoffMs);
      return request(config, retries - 1, Math.min(backoffMs * 2, 60000));
    }

    const errorMessage =
      body?.error?.message || body?.message || err.message || `HTTP ${status || 'unknown'}`;
    return { data: null, error: errorMessage, statusCode: status || 0 };
  }
}

// ── Strapi v3 client ──────────────────────────────────────────────────────────
const v3 = {

  /** Generic GET from v3 */
  async get(path, params = {}) {
    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v3Url}${path}`, params });
  },

  /**
   * Fetch a paginated batch of entries from a v3 collection.
   * v3 pagination: _start (offset) + _limit
   * No populate param — v3 public API returns data as configured.
   */
  async getCollection(slug, start = 0, limit = 100, locale = null) {
    const params = {
      _start: start,
      _limit: limit,
    };
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v3Url}/${slug}`, params });
  },

  /**
   * Fetch a single entry by ID from v3.
   */
  async getEntry(slug, id, locale = null) {
    const params = {};
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v3Url}/${slug}/${id}`, params });
  },

  /**
   * Get total count for a v3 collection.
   * Falls back to no-locale count if the locale-scoped count fails.
   */
  async getCount(slug, locale = null) {
    const params = {};
    if (locale) params._locale = locale;

    await enforceDelay();
    const result = await request({ method: 'GET', url: `${cfg.v3Url}/${slug}/count`, params });

    if (result.error && locale) {
      // Retry without locale — collection may not have i18n enabled
      const fallback = await request({ method: 'GET', url: `${cfg.v3Url}/${slug}/count` });
      return typeof fallback.data === 'number' ? fallback.data : 0;
    }
    return typeof result.data === 'number' ? result.data : 0;
  },

  /**
   * Fetch a v3 single type.
   */
  async getSingleType(slug, locale = null) {
    const params = {};
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v3Url}/${slug}`, params });
  },

  /**
   * Ping a slug to confirm it exists before starting migration.
   */
  async ping(slug) {
    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v3Url}/${slug}`,
      params: { _limit: 1 },
      timeout: 15000,
    });
  },
};

// ── Strapi v5 client ──────────────────────────────────────────────────────────
const v5 = {

  /** Generic GET from v5 */
  async get(path, params = {}) {
    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v5Url}${path}`, params });
  },

  /**
   * Fetch a paginated collection page from v5.
   * v5 pagination: pagination[page] + pagination[pageSize]
   */
  async getCollection(slug, page = 1, pageSize = 100, locale = null) {
    const params = {
      'pagination[page]': page,
      'pagination[pageSize]': pageSize,
    };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v5Url}/api/${slug}`, params });
  },

  /**
   * Fetch a v5 single type.
   */
  async getSingleType(slug, locale = null) {
    const params = {};
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v5Url}/api/${slug}`, params });
  },

  /**
   * Create a new collection entry in v5.
   * Body shape: { data: { ...fields, locale } }
   */
  async create(slug, body) {
    await enforceDelay();
    return request({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  /**
   * Update an existing v5 entry.
   * Body shape: { data: { ...fields } }
   */
  async update(slug, id, body) {
    await enforceDelay();
    return request({
      method: 'PUT',
      url: `${cfg.v5Url}/api/${slug}/${id}`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  /**
   * Update a v5 single type.
   * Body shape: { data: { ...fields } }
   */
  async updateSingleType(slug, body, locale = null) {
    const params = {};
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'PUT',
      url: `${cfg.v5Url}/api/${slug}`,
      data: body,
      params,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  /**
   * Create a locale variant of an existing entry.
   * v5 i18n: POST /api/:slug/:id/localizations
   * Body shape: { data: { ...fields, locale } }
   */
  async createLocalization(slug, id, body) {
    await enforceDelay();
    return request({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}/${id}/localizations`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  /**
   * Find a v5 entry by a specific field value — used for relation resolution.
   * v5 response shape: { data: { data: [{ id, attributes }], meta } }
   */
  async findByField(slug, field, value, locale = null) {
    const params = {
      [`filters[${field}][$eq]`]: value,
      'pagination[pageSize]': 1,
    };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({ method: 'GET', url: `${cfg.v5Url}/api/${slug}`, params });
  },

  /**
   * Search v5 media library for a file by name (dedup check).
   * No enforceDelay — mediaHandler controls timing.
   */
  async findMediaByName(filename) {
    return request({
      method: 'GET',
      url: `${cfg.v5Url}/api/upload/files`,
      params: {
        'filters[name][$containsi]': filename.replace(/\.[^.]+$/, ''),
        'pagination[pageSize]': 5,
      },
    });
  },

  /**
   * Upload a file to v5 media library via multipart/form-data.
   * No enforceDelay — mediaHandler controls timing.
   */
  async uploadFile(formData) {
    return request({
      method: 'POST',
      url: `${cfg.v5Url}/api/upload`,
      data: formData,
      headers: { ...formData.getHeaders() },
    });
  },

  /**
   * Publish a v5 entry (sets publishedAt to now).
   * Called after create when the v3 source entry was published.
   */
  async publish(slug, id) {
    await enforceDelay();
    return request({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}/${id}/actions/publish`,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

module.exports = { v3, v5, enforceDelay, sleep, cfg };
