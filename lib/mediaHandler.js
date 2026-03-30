'use strict';

/**
 * mediaHandler.js
 * Downloads media files from their S3 URL (as found in v3) and uploads them
 * to the Strapi v5 media library using multipart/form-data.
 *
 * Strategy:
 *  1. Extract filename from the v3 media object URL
 *  2. Check if file already exists in v5 by filename (dedup — avoids re-upload)
 *  3. If not found: download the file bytes from the S3 URL, then POST to
 *     /api/upload as multipart/form-data — Strapi v5 handles S3 storage
 *  4. Cache result in memory so the same file is never processed twice per run
 *
 * FIX: Single enforceDelay per media operation — no double-delay.
 * FIX: Dedup check uses both filename and original hash name variants.
 * FIX: File bytes are downloaded from S3 and uploaded to v5 properly.
 */

const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const logger = require('./logger');
const { sleep } = require('./apiClient');

// Lazy env accessors
const cfg = {
  get v5Url()   { return (process.env.STRAPI_V5_URL  || '').replace(/\/$/, ''); },
  get v5Token() { return process.env.STRAPI_V5_TOKEN || ''; },
  get delayMs() { return parseInt(process.env.DELAY_MS || '30000', 10); },
};

// In-memory cache: filename → v5 media object
// Prevents re-uploading the same file within a single run
const mediaCache = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the raw filename from a URL.
 * e.g. https://s3.amazonaws.com/bucket/uploads/photo-abc123.jpg → photo-abc123.jpg
 * Strips query string parameters (pre-signed URL tokens etc.)
 */
function extractFilename(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return path.basename(parsed.pathname) || '';
  } catch {
    return url.split('/').pop().split('?')[0] || '';
  }
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav',   webm: 'video/webm',
    csv: 'text/csv',   json: 'application/json', zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Core: find existing file in v5 ───────────────────────────────────────────

/**
 * Check if a file already exists in the v5 media library by filename.
 * FIX: No enforceDelay here — caller owns the timing budget per operation.
 */
async function findExistingInV5(filename) {
  if (!filename) return null;
  if (mediaCache.has(filename)) return mediaCache.get(filename);

  try {
    // Strip extension for name-only search (Strapi stores name without extension sometimes)
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');

    const response = await axios.get(`${cfg.v5Url}/api/upload/files`, {
      params: {
        'filters[name][$containsi]': nameWithoutExt,
        'pagination[pageSize]': 10,
      },
      headers: { Authorization: `Bearer ${cfg.v5Token}` },
      timeout: 15000,
    });

    const files = Array.isArray(response.data) ? response.data : [];
    // Match by exact filename or name-without-extension
    const match = files.find(f =>
      f.name === filename ||
      f.name === nameWithoutExt ||
      f.hash + f.ext === filename ||
      (f.url || '').endsWith(filename)
    );

    if (match) {
      mediaCache.set(filename, match);
      return match;
    }
  } catch (err) {
    logger.warn(`Dedup check failed for "${filename}": ${err.message}`);
  }
  return null;
}

// ── Core: download from S3 ────────────────────────────────────────────────────

/**
 * Download file bytes from an S3 URL.
 * Returns { buffer, contentType } or null on failure.
 */
async function downloadFromS3(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000, // 2 min — large files may be slow
      // No Authorization needed — S3 URLs are either public or pre-signed
      maxContentLength: 500 * 1024 * 1024, // 500MB limit
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers['content-type'] || null,
    };
  } catch (err) {
    const status = err?.response?.status;
    logger.warn(`S3 download failed for ${url}: HTTP ${status || 'N/A'} — ${err.message}`);
    return null;
  }
}

// ── Core: upload to v5 ────────────────────────────────────────────────────────

/**
 * Upload a file buffer to v5 media library as multipart/form-data.
 * Strapi v5 will handle storage to S3 via its own plugin.
 *
 * @param {Buffer} buffer      - file bytes
 * @param {string} filename    - original filename with extension
 * @param {string} mimeType    - MIME type
 * @param {string} altText     - optional alternative text
 * @param {string} caption     - optional caption
 * @returns {object|null}      - v5 media object or null
 */
async function uploadToV5(buffer, filename, mimeType, altText, caption) {
  try {
    const form = new FormData();

    // Append file bytes with correct filename and content type
    form.append('files', buffer, {
      filename,
      contentType: mimeType,
      knownLength: buffer.length,
    });

    // Attach metadata (Strapi uses fileInfo JSON string)
    const fileInfo = { name: filename };
    if (altText)  fileInfo.alternativeText = altText;
    if (caption)  fileInfo.caption = caption;
    form.append('fileInfo', JSON.stringify(fileInfo));

    const response = await axios.post(`${cfg.v5Url}/api/upload`, form, {
      headers: {
        Authorization: `Bearer ${cfg.v5Token}`,
        ...form.getHeaders(),
      },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // v5 upload returns an array
    const uploaded = Array.isArray(response.data) ? response.data[0] : response.data;
    return uploaded || null;

  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error?.message || err.message;
    logger.warn(`v5 upload failed for "${filename}": HTTP ${status || 'N/A'} — ${msg}`);
    return null;
  }
}

// ── Public: process one media URL ─────────────────────────────────────────────

/**
 * Given a v3 media URL (S3), ensure the file exists in v5 and return its v5 ID.
 *
 * @param {string} url          - S3 file URL from v3
 * @param {string} altText      - alt text from v3 media object
 * @param {string} caption      - caption from v3 media object
 * @param {string} contentType  - parent content type (for logging)
 * @param {any}    v3Id         - parent entry ID (for logging)
 * @returns {number|null}       - v5 media ID or null
 */
async function processMediaUrl(url, altText = null, caption = null, contentType = null, v3Id = null) {
  if (!url || typeof url !== 'string') return null;

  const filename = extractFilename(url);
  if (!filename) {
    logger.warn(`Cannot extract filename from URL: ${url}`, contentType, v3Id);
    return null;
  }

  // ── Step 1: Dedup check (no delay — fast path) ────────────────────────────
  const existing = await findExistingInV5(filename);
  if (existing) {
    logger.skip(`Media "${filename}" already in v5 (id:${existing.id}). Reusing.`, contentType, v3Id);
    return existing.id;
  }

  // ── Step 2: Enforce delay before S3 download (counts as an "API operation") 
  logger.info(`Downloading "${filename}" from S3...`, contentType, v3Id);
  await sleep(cfg.delayMs);

  const downloaded = await downloadFromS3(url);
  if (!downloaded) {
    logger.error(`Failed to download "${filename}" from S3. Skipping.`, contentType, v3Id);
    return null;
  }

  const mimeType = guessMimeType(filename) || downloaded.contentType || 'application/octet-stream';

  // ── Step 3: Upload to v5 (enforce delay before upload) ───────────────────
  logger.info(`Uploading "${filename}" (${mimeType}, ${downloaded.buffer.length} bytes) to v5...`, contentType, v3Id);
  await sleep(cfg.delayMs);

  const uploaded = await uploadToV5(
    downloaded.buffer, filename, mimeType,
    altText || null, caption || null
  );

  if (!uploaded?.id) {
    logger.error(`v5 upload returned no ID for "${filename}".`, contentType, v3Id);
    return null;
  }

  mediaCache.set(filename, uploaded);
  logger.create(`Media "${filename}" uploaded to v5 (id:${uploaded.id})`, contentType, v3Id);
  return uploaded.id;
}

// ── Public: process a v3 media field ─────────────────────────────────────────

/**
 * Process a v3 media field value (single object or array) and return
 * the v5-compatible media reference.
 *
 * v3 media object shape:
 * {
 *   id: 12, url: "https://s3.../photo.jpg",
 *   name: "photo.jpg", alternativeText: "...", caption: "...",
 *   mime: "image/jpeg", ext: ".jpg", size: 123.4,
 *   formats: { thumbnail: {...}, small: {...}, medium: {...} }
 * }
 *
 * Returns:
 *  - Single media: v5 media ID (number)
 *  - Multiple media: array of v5 media IDs
 *  - null if nothing could be processed
 */
async function processMediaField(v3Media, contentType, v3Id) {
  if (!v3Media) return null;

  // ── Single media object ──────────────────────────────────────────────────
  if (!Array.isArray(v3Media)) {
    const url = v3Media?.url || null;
    if (!url) return null;
    return processMediaUrl(url, v3Media?.alternativeText, v3Media?.caption, contentType, v3Id);
  }

  // ── Array of media objects ────────────────────────────────────────────────
  const ids = [];
  for (const item of v3Media) {
    const url = item?.url || null;
    if (!url) continue;
    const id = await processMediaUrl(url, item?.alternativeText, item?.caption, contentType, v3Id);
    if (id != null) ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

module.exports = { processMediaField, processMediaUrl, extractFilename };
