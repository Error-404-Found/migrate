'use strict';

/**
 * mediaHandler.js
 * Registers media from Strapi v3 into the Strapi v5 media library.
 *
 * Strategy (S3 handled by Strapi itself):
 * 1. Extract filename from the v3 media object
 * 2. Check if file already exists in v5 by filename (dedup check)
 * 3. If not found, use Strapi v5's POST /api/upload?url= endpoint to register
 *    the S3 file URL — Strapi v5 fetches it from S3 and registers it
 *    in its own media library. No manual S3 download or re-upload needed.
 * 4. Return the v5 media object with its new ID
 *
 * NOTE: Both v3 and v5 point to the same S3 bucket, so the S3 URL from
 * v3 is still valid and accessible by Strapi v5 directly.
 */

const axios = require('axios');
const path = require('path');
const { v5, enforceDelay } = require('./apiClient');
const logger = require('./logger');

const V5_URL = (process.env.STRAPI_V5_URL || '').replace(/\/$/, '');
const V5_TOKEN = process.env.STRAPI_V5_TOKEN || '';

// In-memory cache: filename → v5 media object
// Avoids repeated API calls for the same file within a single run
const mediaCache = new Map();

/**
 * Extract the filename from a URL.
 * e.g. https://s3.amazonaws.com/bucket/uploads/photo-123.jpg → photo-123.jpg
 */
function extractFilename(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return path.basename(parsed.pathname);
  } catch {
    return url.split('/').pop().split('?')[0] || '';
  }
}

/**
 * Check if a file already exists in the v5 media library by filename.
 * Returns the existing v5 media object or null.
 */
async function findExistingMedia(filename) {
  if (!filename) return null;

  // Check memory cache first — avoids an API call for files seen this run
  if (mediaCache.has(filename)) {
    return mediaCache.get(filename);
  }

  const result = await v5.findMediaByName(filename);
  if (result.error) {
    logger.warn(`Media dedup check failed for "${filename}": ${result.error}`);
    return null;
  }

  // v5 /api/upload/files returns a plain array (not wrapped in { data })
  const files = Array.isArray(result.data) ? result.data : [];
  if (files.length > 0) {
    const existing = files[0];
    mediaCache.set(filename, existing);
    return existing;
  }
  return null;
}

/**
 * Register a media file in Strapi v5 by passing its S3 URL.
 *
 * Strapi v5 supports importing media by URL:
 *   POST /api/upload?url=<fileUrl>
 *   Body: { fileInfo: { name, alternativeText, caption } }
 *
 * Strapi fetches the file from S3 itself and stores it in its media
 * library — no manual download or byte transfer needed on our side.
 *
 * @param {string} fileUrl       - The S3 file URL (taken from v3 media object)
 * @param {string|null} altText  - Optional alt text to preserve from v3
 * @param {string|null} caption  - Optional caption to preserve from v3
 * @param {string} contentType   - Parent content type slug (for logging)
 * @param {any} v3Id             - Parent v3 entry ID (for logging)
 * @returns {object|null}        - v5 media object ({ id, url, name, ... }) or null
 */
async function registerMediaUrl(fileUrl, altText = null, caption = null, contentType = null, v3Id = null) {
  if (!fileUrl || typeof fileUrl !== 'string') {
    logger.warn('registerMediaUrl called with invalid URL.', contentType, v3Id);
    return null;
  }

  const filename = extractFilename(fileUrl);
  if (!filename) {
    logger.warn(`Could not extract filename from URL: ${fileUrl}`, contentType, v3Id);
    return null;
  }

  // ── Step 1: Dedup check ──────────────────────────────────────────────────
  const existing = await findExistingMedia(filename);
  if (existing) {
    logger.skip(
      `Media "${filename}" already exists in v5 (id: ${existing.id}). Reusing.`,
      contentType,
      v3Id
    );
    return existing;
  }

  // ── Step 2: Register via Strapi v5 URL import ────────────────────────────
  logger.info(`Registering media "${filename}" in v5 via URL import...`, contentType, v3Id);

  // Enforce the configured delay before every API call
  await enforceDelay();

  try {
    // Build fileInfo metadata — only include fields that have values
    const fileInfo = { name: filename };
    if (altText) fileInfo.alternativeText = altText;
    if (caption) fileInfo.caption = caption;

    // Strapi v5 expects the URL as a query param and optional fileInfo in the body
    const response = await axios.post(
      `${V5_URL}/api/upload`,
      { fileInfo },
      {
        params: { url: fileUrl },
        headers: {
          Authorization: `Bearer ${V5_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    // v5 returns an array of registered files
    const uploaded = Array.isArray(response.data)
      ? response.data[0]
      : response.data;

    if (!uploaded?.id) {
      logger.error(
        `Media registration for "${filename}" returned no ID.`,
        contentType,
        v3Id
      );
      return null;
    }

    // Cache so we don't re-register the same file in this run
    mediaCache.set(filename, uploaded);
    logger.create(
      `Media "${filename}" registered in v5 (id: ${uploaded.id})`,
      contentType,
      v3Id
    );
    return uploaded;

  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const reason =
      body?.error?.message ||
      body?.message ||
      err.message ||
      'Unknown error';

    logger.error(
      `Failed to register media "${filename}" in v5 (HTTP ${status || 'N/A'}): ${reason}`,
      contentType,
      v3Id
    );
    return null;
  }
}

/**
 * Process a v3 media field value and return a v5 media ID (or array of IDs).
 * Handles both single media objects and arrays of media objects.
 *
 * v3 media objects look like:
 * {
 *   id: 12,
 *   url: "https://s3.amazonaws.com/bucket/uploads/photo.jpg",
 *   name: "photo.jpg",
 *   alternativeText: "A photo",
 *   caption: null,
 *   formats: { thumbnail: { url: "..." }, medium: { url: "..." } }
 * }
 *
 * We only use the top-level `url` (original file) — Strapi v5 will generate
 * its own format variants (thumbnail, small, medium, large) after import.
 *
 * @param {object|object[]|null} v3Media - v3 media object(s)
 * @param {string} contentType           - parent content type (for logging)
 * @param {any} v3Id                     - parent entry ID (for logging)
 * @returns {number|number[]|null}       - v5 media ID(s) or null
 */
async function processMediaField(v3Media, contentType, v3Id) {
  if (!v3Media) return null;

  // ── Single media object ──────────────────────────────────────────────────
  if (!Array.isArray(v3Media)) {
    const url = v3Media?.url ?? null;
    if (!url) return null;

    const registered = await registerMediaUrl(
      url,
      v3Media?.alternativeText ?? null,
      v3Media?.caption ?? null,
      contentType,
      v3Id
    );
    return registered?.id ?? null;
  }

  // ── Array of media objects ────────────────────────────────────────────────
  const ids = [];
  for (const item of v3Media) {
    const url = item?.url ?? null;
    if (!url) continue;

    const registered = await registerMediaUrl(
      url,
      item?.alternativeText ?? null,
      item?.caption ?? null,
      contentType,
      v3Id
    );
    if (registered?.id != null) {
      ids.push(registered.id);
    }
  }
  return ids.length > 0 ? ids : null;
}

module.exports = {
  registerMediaUrl,
  processMediaField,
  findExistingMedia,
  extractFilename,
};
