'use strict';

/**
 * apiClient.js
 * Axios wrappers for Strapi v3 and v5 REST APIs.
 *
 * Features:
 * - Automatic delay between every call (DELAY_MS, default 30s)
 * - Retry with exponential backoff on 429 and 5xx errors
 * - Response validation — always returns { data, error, statusCode }
 * - Never throws unhandled — always resolves with an error shape
 */

const axios = require('axios');
const logger = require('./logger');

// ─── Config from environment ────────────────────────────────────────────────
const V3_URL = (process.env.STRAPI_V3_URL || '').replace(/\/$/, '');
const V5_URL = (process.env.STRAPI_V5_URL || '').replace(/\/$/, '');
const V3_TOKEN = process.env.STRAPI_V3_TOKEN || '';
const V5_TOKEN = process.env.STRAPI_V5_TOKEN || '';
const DELAY_MS = parseInt(process.env.DELAY_MS || '30000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '5', 10);

if (!V3_URL) logger.warn('STRAPI_V3_URL is not set in environment');
if (!V5_URL) logger.warn('STRAPI_V5_URL is not set in environment');

// ─── Utility: sleep ─────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Enforce a minimum delay between API calls.
 * Called before every request to stay within rate limits.
 */
async function enforceDelay(customMs) {
  const ms = customMs != null ? customMs : DELAY_MS;
  if (ms > 0) {
    logger.info(`Waiting ${ms}ms before next API call...`);
    await sleep(ms);
  }
}

// ─── Core request wrapper ────────────────────────────────────────────────────
/**
 * Make an HTTP request with retry logic.
 *
 * @param {object} config - Axios config object
 * @param {number} retries - Remaining retry attempts
 * @param {number} backoffMs - Current backoff delay in ms
 * @returns {{ data: any, error: string|null, statusCode: number }}
 */
async function request(config, retries = MAX_RETRIES, backoffMs = 2000) {
  try {
    const response = await axios({
      timeout: 60000, // 60s timeout per request
      ...config,
    });

    // Successful response — validate body exists
    if (response.data === undefined || response.data === null) {
      return { data: null, error: 'Empty response body', statusCode: response.status };
    }

    return { data: response.data, error: null, statusCode: response.status };

  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;

    // 429 Too Many Requests — always retry with backoff regardless of retry count
    if (status === 429) {
      const retryAfter = err?.response?.headers?.['retry-after'];
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoffMs;
      logger.warn(`Rate limited (429). Waiting ${waitMs}ms before retry...`);
      await sleep(waitMs);
      return request(config, retries, Math.min(backoffMs * 2, 120000));
    }

    // 5xx server errors — retry with exponential backoff
    if (status >= 500 && retries > 0) {
      logger.warn(`Server error ${status}. Retrying in ${backoffMs}ms... (${retries} left)`);
      await sleep(backoffMs);
      return request(config, retries - 1, Math.min(backoffMs * 2, 60000));
    }

    // 4xx client errors (except 429) — do not retry
    const errorMessage =
      body?.error?.message ||
      body?.message ||
      err.message ||
      `HTTP ${status || 'unknown'}`;

    return {
      data: null,
      error: errorMessage,
      statusCode: status || 0,
    };
  }
}

// ─── Strapi v3 client ────────────────────────────────────────────────────────
const v3 = {
  /**
   * GET from Strapi v3.
   * @param {string} path - URL path (e.g. /articles)
   * @param {object} params - Query params
   */
  async get(path, params = {}) {
    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V3_URL}${path}`,
      params,
      headers: {
        Authorization: `Bearer ${V3_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * GET a collection page from v3 using public REST endpoint.
   * v3 pagination uses _start and _limit.
   *
   * @param {string} slug - e.g. "articles"
   * @param {number} start - offset
   * @param {number} limit - page size
   * @param {string|null} locale - e.g. "en", "fr"
   */
  async getCollection(slug, start = 0, limit = 100, locale = null) {
    const params = {
      _start: start,
      _limit: limit,
      _publicationState: 'preview', // fetch both published and draft
    };
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V3_URL}/${slug}`,
      params,
      headers: {
        Authorization: `Bearer ${V3_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * GET total count for a v3 collection.
   */
  async getCount(slug, locale = null) {
    const params = {};
    if (locale) params._locale = locale;

    await enforceDelay();
    const result = await request({
      method: 'GET',
      url: `${V3_URL}/${slug}/count`,
      params,
      headers: {
        Authorization: `Bearer ${V3_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    // v3 count endpoint returns a plain number
    return typeof result.data === 'number' ? result.data : 0;
  },

  /**
   * GET a single type from v3.
   */
  async getSingleType(slug, locale = null) {
    const params = {};
    if (locale) params._locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V3_URL}/${slug}`,
      params,
      headers: {
        Authorization: `Bearer ${V3_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * Ping a slug to validate it exists before starting migration.
   * Uses _limit=1 to minimize data transfer.
   */
  async ping(slug) {
    // Try public API first with minimal params
    const result = await request({
      method: 'GET',
      url: `${V3_URL}/${slug}`,
      params: { _limit: 1 },
      headers: {
        Authorization: `Bearer ${V3_TOKEN}`,
      },
      timeout: 15000,
    });
    return result;
  },
};

// ─── Strapi v5 client ────────────────────────────────────────────────────────
const v5 = {
  /**
   * GET from Strapi v5.
   * @param {string} path - URL path (e.g. /api/articles)
   * @param {object} params - Query params
   */
  async get(path, params = {}) {
    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V5_URL}${path}`,
      params,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * GET a collection page from v5.
   * v5 pagination uses pagination[page] and pagination[pageSize].
   *
   * @param {string} slug - e.g. "articles"
   * @param {number} page - 1-based page number
   * @param {number} pageSize - entries per page
   * @param {string|null} locale - e.g. "en", "fr"
   * @param {string} populate - populate query string
   */
  async getCollection(slug, page = 1, pageSize = 100, locale = null, populate = '*') {
    const params = {
      'pagination[page]': page,
      'pagination[pageSize]': pageSize,
      populate,
    };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V5_URL}/api/${slug}`,
      params,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * GET a single type from v5.
   */
  async getSingleType(slug, locale = null, populate = '*') {
    const params = { populate };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V5_URL}/api/${slug}`,
      params,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * POST a new entry in v5.
   * @param {string} slug - collection API slug
   * @param {object} body - { data: {...}, locale: 'en' }
   */
  async create(slug, body) {
    await enforceDelay();
    return request({
      method: 'POST',
      url: `${V5_URL}/api/${slug}`,
      data: body,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * PUT to update an existing v5 entry.
   */
  async update(slug, id, body) {
    await enforceDelay();
    return request({
      method: 'PUT',
      url: `${V5_URL}/api/${slug}/${id}`,
      data: body,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * PUT to update a single type in v5.
   */
  async updateSingleType(slug, body, locale = null) {
    const params = {};
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'PUT',
      url: `${V5_URL}/api/${slug}`,
      data: body,
      params,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * Search for an entry in v5 by a unique field to support relation resolution.
   * @param {string} slug - collection slug
   * @param {string} field - e.g. "slug" or "title"
   * @param {any} value - the value to match
   */
  async findByField(slug, field, value, locale = null) {
    const params = {
      [`filters[${field}][$eq]`]: value,
      'pagination[pageSize]': 1,
    };
    if (locale) params.locale = locale;

    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V5_URL}/api/${slug}`,
      params,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  },

  /**
   * Upload a file to v5 media library using multipart/form-data.
   * @param {FormData} formData - form-data instance with file appended
   */
  async uploadMedia(formData) {
    await enforceDelay();
    return request({
      method: 'POST',
      url: `${V5_URL}/api/upload`,
      data: formData,
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
        ...formData.getHeaders(), // sets Content-Type: multipart/form-data with boundary
      },
    });
  },

  /**
   * Search v5 media library for an existing file by name to avoid duplicate uploads.
   */
  async findMediaByName(filename) {
    await enforceDelay();
    return request({
      method: 'GET',
      url: `${V5_URL}/api/upload/files`,
      params: {
        'filters[name][$eq]': filename,
        'pagination[pageSize]': 1,
      },
      headers: {
        Authorization: `Bearer ${V5_TOKEN}`,
      },
    });
  },
};

module.exports = { v3, v5, enforceDelay, sleep };
