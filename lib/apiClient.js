'use strict';

/**
 * apiClient.js
 * Axios wrappers for Strapi v3 and v5 REST APIs.
 *
 * FIX: All process.env reads are lazy (inside functions) so dotenv.config()
 *      in index.js runs before any value is consumed.
 * FIX: v3 collection fetches include populate=deep to get full relation/media data.
 * FIX: ping() includes enforceDelay to avoid hammering the API during validation.
 */

const axios = require('axios');
const logger = require('./logger');

// ── Lazy config helpers (read env at call time, not module load time) ─────────
const cfg = {
  get v3Url()    { return (process.env.STRAPI_V3_URL  || '').replace(/\/$/, ''); },
  get v5Url()    { return (process.env.STRAPI_V5_URL  || '').replace(/\/$/, ''); },
  get v3Token()  { return process.env.STRAPI_V3_TOKEN || ''; },
  get v5Token()  { return process.env.STRAPI_V5_TOKEN || ''; },
  get delayMs()  { return parseInt(process.env.DELAY_MS   || '30000', 10); },
  get maxRetries(){ return parseInt(process.env.MAX_RETRIES || '5',   10); },
};

// ── sleep ─────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Enforced delay between every API call ─────────────────────────────────────
async function enforceDelay(customMs) {
  const ms = customMs != null ? customMs : cfg.delayMs;
  if (ms > 0) {
    logger.info(`Waiting ${ms}ms before next API call...`);
    await sleep(ms);
  }
}

// ── Core request with retry + exponential backoff ─────────────────────────────
async function request(config, retries, backoffMs = 2000) {
  if (retries === undefined) retries = cfg.maxRetries;
  try {
    const response = await axios({ timeout: 60000, ...config });
    if (response.data === undefined || response.data === null) {
      return { data: null, error: 'Empty response body', statusCode: response.status };
    }
    return { data: response.data, error: null, statusCode: response.status };
  } catch (err) {
    const status = err?.response?.status;
    const body   = err?.response?.data;

    // 429 — always retry with backoff
    if (status === 429) {
      const retryAfter = err?.response?.headers?.['retry-after'];
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoffMs;
      logger.warn(`Rate limited (429). Waiting ${waitMs}ms before retry...`);
      await sleep(waitMs);
      return request(config, retries, Math.min(backoffMs * 2, 120000));
    }

    // 5xx — retry with exponential backoff
    if (status >= 500 && retries > 0) {
      logger.warn(`Server error ${status}. Retrying in ${backoffMs}ms... (${retries} retries left)`);
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

  /**
   * Generic GET from v3.
   */
  async get(path, params = {}) {
    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v3Url}${path}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v3Token}` },
    });
  },

  /**
   * Fetch a paginated batch of entries from a v3 collection.
   *
   * FIX: populate=deep ensures nested relations and media are fully returned,
   *      not just bare IDs. Without this, image/relation fields are empty.
   *
   * v3 pagination: _start (offset) + _limit
   */
  async getCollection(slug, start = 0, limit = 100, locale = null) {
    const params = {
      _start: start,
      _limit: limit,
      _publicationState: 'preview',  // fetch both published and draft entries
      'populate': 'deep',            // FIX: get full nested data (media, relations, components)
    };
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v3Url}/${slug}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v3Token}` },
    });
  },

  /**
   * Fetch a single entry by ID with full population.
   */
  async getEntry(slug, id, locale = null) {
    const params = { populate: 'deep' };
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v3Url}/${slug}/${id}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v3Token}` },
    });
  },

  /**
   * Get total count for a v3 collection.
   * FIX: if count returns 0 or errors due to missing i18n, fallback gracefully.
   */
  async getCount(slug, locale = null) {
    const params = {};
    if (locale) params._locale = locale;

    await enforceDelay();
    const result = await request({
      method: 'GET',
      url: `${cfg.v3Url}/${slug}/count`,
      params,
      headers: { Authorization: `Bearer ${cfg.v3Token}` },
    });

    if (result.error) {
      // If count fails (e.g. no i18n support on this type), try without locale
      if (locale) {
        const fallback = await request({
          method: 'GET',
          url: `${cfg.v3Url}/${slug}/count`,
          headers: { Authorization: `Bearer ${cfg.v3Token}` },
        });
        return typeof fallback.data === 'number' ? fallback.data : 0;
      }
      return 0;
    }
    return typeof result.data === 'number' ? result.data : 0;
  },

  /**
   * Fetch a v3 single type with full population.
   */
  async getSingleType(slug, locale = null) {
    const params = { populate: 'deep' };
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v3Url}/${slug}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v3Token}` },
    });
  },

  /**
   * Ping a slug to check it exists — used during slug validation.
   * FIX: includes enforceDelay to avoid hammering API during validation loop.
   */
  async ping(slug) {
    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v3Url}/${slug}`,
      params: { _limit: 1 },
      headers: { Authorization: `Bearer ${cfg.v3Token}` },
      timeout: 15000,
    });
  },
};

// ── Strapi v5 client ──────────────────────────────────────────────────────────
const v5 = {

  /**
   * Generic GET from v5.
   */
  async get(path, params = {}) {
    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v5Url}${path}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v5Token}` },
    });
  },

  /**
   * Fetch a paginated collection page from v5.
   * v5 pagination: pagination[page] + pagination[pageSize]
   */
  async getCollection(slug, page = 1, pageSize = 100, locale = null) {
    const params = {
      'pagination[page]': page,
      'pagination[pageSize]': pageSize,
      'populate': '*',
    };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v5Url}/api/${slug}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v5Token}` },
    });
  },

  /**
   * Fetch a v5 single type.
   */
  async getSingleType(slug, locale = null) {
    const params = { populate: '*' };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v5Url}/api/${slug}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v5Token}` },
    });
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
      headers: {
        Authorization: `Bearer ${cfg.v5Token}`,
        'Content-Type': 'application/json',
      },
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
      headers: {
        Authorization: `Bearer ${cfg.v5Token}`,
        'Content-Type': 'application/json',
      },
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
      headers: {
        Authorization: `Bearer ${cfg.v5Token}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * Create a locale variant of an existing entry.
   * v5 i18n endpoint: POST /api/:slug/:id/localizations
   * Body shape: { data: { ...fields, locale } }
   */
  async createLocalization(slug, id, body) {
    await enforceDelay();
    return request({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}/${id}/localizations`,
      data: body,
      headers: {
        Authorization: `Bearer ${cfg.v5Token}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * Find a v5 entry by a specific field value (for relation resolution).
   * Returns { data: { data: [ entry ], meta: {...} } }
   */
  async findByField(slug, field, value, locale = null) {
    const params = {
      [`filters[${field}][$eq]`]: value,
      'pagination[pageSize]': 1,
      'populate': '*',
    };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${cfg.v5Url}/api/${slug}`,
      params,
      headers: { Authorization: `Bearer ${cfg.v5Token}` },
    });
  },

  /**
   * Search v5 media library for a file by name.
   * Returns a plain array (not wrapped in data).
   * FIX: does NOT call enforceDelay — caller (mediaHandler) manages timing.
   */
  async findMediaByName(filename) {
    // No enforceDelay here — mediaHandler controls call timing to avoid double-delay
    return request({
      method: 'GET',
      url: `${cfg.v5Url}/api/upload/files`,
      params: {
        'filters[name][$eq]': filename,
        'pagination[pageSize]': 5,
      },
      headers: { Authorization: `Bearer ${cfg.v5Token}` },
    });
  },

  /**
   * Upload a file to v5 using multipart/form-data.
   * Used by mediaHandler to stream files from S3 URL into v5.
   * FIX: does NOT call enforceDelay — mediaHandler controls call timing.
   */
  async uploadFile(formData) {
    return request({
      method: 'POST',
      url: `${cfg.v5Url}/api/upload`,
      data: formData,
      headers: {
        Authorization: `Bearer ${cfg.v5Token}`,
        ...formData.getHeaders(),
      },
    });
  },

  /**
   * Publish an entry in v5 (set publishedAt to now).
   * Called after create when the source entry was published in v3.
   */
  async publish(slug, id) {
    await enforceDelay();
    return request({
      method: 'POST',
      url: `${cfg.v5Url}/api/${slug}/${id}/actions/publish`,
      headers: {
        Authorization: `Bearer ${cfg.v5Token}`,
        'Content-Type': 'application/json',
      },
    });
  },
};

module.exports = { v3, v5, enforceDelay, sleep, cfg };
