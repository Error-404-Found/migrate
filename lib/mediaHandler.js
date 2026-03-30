'use strict';

/**
 * mediaHandler.js
 * Downloads media from their S3 URL and uploads to Strapi v5 media library.
 *
 * KEY FIX: Relative URLs from v3 (e.g. /uploads/photo.jpg) are converted to
 * absolute by prepending the v3 base URL before attempting S3 download.
 * This is the primary reason images were not being migrated.
 *
 * Upload path: S3 URL → download bytes → POST multipart to v5 /api/upload
 * Strapi v5 then stores the file to S3 via its own upload plugin.
 */

const axios    = require('axios');
const FormData = require('form-data');
const path     = require('path');
const logger   = require('./logger');
const { sleep } = require('./apiClient');

const cfg = {
  get v3Url()   { return (process.env.STRAPI_V3_URL  || '').replace(/\/$/, ''); },
  get v5Url()   { return (process.env.STRAPI_V5_URL  || '').replace(/\/$/, ''); },
  get delayMs() { return parseInt(process.env.DELAY_MS || '30000', 10); }
};

// In-memory dedup cache: filename → v5 media object
const mediaCache = new Map();

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve a v3 media URL to an absolute URL.
 *
 * KEY FIX: Strapi v3 stores media URLs as relative paths (/uploads/photo.jpg)
 * when using local storage, but as full S3 URLs when using the S3 plugin.
 * We need to handle both cases:
 *   - Relative: prepend v3 base URL → http://localhost:1337/uploads/photo.jpg
 *   - Absolute S3: use as-is → https://s3.amazonaws.com/bucket/photo.jpg
 */
function resolveMediaUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // Already absolute
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  // Relative — prepend v3 base URL
  return `${cfg.v3Url}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Extract filename from a URL, stripping query string params.
 * e.g. https://s3.amazonaws.com/bucket/uploads/photo-abc123.jpg?token=x → photo-abc123.jpg
 */
function extractFilename(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    return path.basename(new URL(url).pathname) || '';
  } catch {
    return url.split('/').pop().split('?')[0] || '';
  }
}

/**
 * Guess MIME type from filename extension.
 */
function guessMime(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
    webp:'image/webp', svg:'image/svg+xml', ico:'image/x-icon',
    pdf:'application/pdf',
    mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm', avi:'video/x-msvideo',
    mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg',
    csv:'text/csv', txt:'text/plain',
    json:'application/json', zip:'application/zip',
    doc:'application/msword',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:'application/vnd.ms-excel',
    xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return map[ext] || 'application/octet-stream';
}

// ── Dedup check ───────────────────────────────────────────────────────────────

/**
 * Check if a file already exists in v5 by filename.
 * No enforceDelay — caller owns timing.
 */
async function findExistingInV5(filename) {
  if (!filename) return null;
  if (mediaCache.has(filename)) return mediaCache.get(filename);

  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');

  try {
    const response = await axios.get(`${cfg.v5Url}/api/upload/files`, {
      params: { 'filters[name][$containsi]': nameWithoutExt, 'pagination[pageSize]': 10 },
      timeout: 15000
    });
    const files = Array.isArray(response.data) ? response.data : [];
    const match = files.find(f =>
      f.name === filename || f.name === nameWithoutExt ||
      (f.hash && f.ext && f.hash + f.ext === filename) ||
      (f.url || '').endsWith('/' + filename)
    );
    if (match) { mediaCache.set(filename, match); return match; }
  } catch (err) {
    logger.warn(`Dedup check failed for "${filename}": ${err.message}`);
  }
  return null;
}

// ── S3 download ───────────────────────────────────────────────────────────────

/**
 * Download file bytes from a URL (S3 or local v3 server).
 */
async function downloadFile(absoluteUrl) {
  try {
    const response = await axios.get(absoluteUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 500 * 1024 * 1024,
      // For local v3 URLs we may need the v3 token
      headers: absoluteUrl.includes(cfg.v3Url)
        ? { }
        : {}
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers['content-type'] || null
    };
  } catch (err) {
    const status = err?.response?.status;
    logger.warn(`Download failed for ${absoluteUrl}: HTTP ${status || 'N/A'} — ${err.message}`);
    return null;
  }
}

// ── v5 upload ─────────────────────────────────────────────────────────────────

/**
 * Upload file bytes to v5 media library via multipart/form-data.
 * Strapi v5 stores it to S3 via its own upload plugin.
 */
async function uploadToV5(buffer, filename, mimeType, altText, caption) {
  try {
    const form = new FormData();
    form.append('files', buffer, { filename, contentType: mimeType, knownLength: buffer.length });

    const fileInfo = { name: filename };
    if (altText) fileInfo.alternativeText = altText;
    if (caption) fileInfo.caption = caption;
    form.append('fileInfo', JSON.stringify(fileInfo));

    const response = await axios.post(`${cfg.v5Url}/api/upload`, form, {
      headers: { ...form.getHeaders() },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    const uploaded = Array.isArray(response.data) ? response.data[0] : response.data;
    return uploaded || null;
  } catch (err) {
    const status = err?.response?.status;
    const msg    = err?.response?.data?.error?.message || err.message;
    logger.warn(`v5 upload failed for "${filename}": HTTP ${status || 'N/A'} — ${msg}`);
    return null;
  }
}

// ── Public: process a single media URL ───────────────────────────────────────

/**
 * Ensure a v3 media file exists in v5 and return its v5 ID.
 *
 * @param {string} rawUrl       - URL from v3 (may be relative or absolute S3)
 * @param {string} altText      - alt text from v3
 * @param {string} caption      - caption from v3
 * @param {string} contentType  - parent CT slug (logging)
 * @param {any}    v3Id         - parent entry ID (logging)
 * @returns {number|null}       - v5 media ID
 */
async function processMediaUrl(rawUrl, altText = null, caption = null, contentType = null, v3Id = null) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  // KEY FIX: resolve relative URLs before attempting download
  const absoluteUrl = resolveMediaUrl(rawUrl);
  if (!absoluteUrl) return null;

  const filename = extractFilename(absoluteUrl);
  if (!filename) {
    logger.warn(`Cannot extract filename from URL: ${absoluteUrl}`, contentType, v3Id);
    return null;
  }

  // ── Step 1: Dedup check ───────────────────────────────────────────────────
  const existing = await findExistingInV5(filename);
  if (existing) {
    logger.skip(`Media "${filename}" already in v5 (id:${existing.id}). Reusing.`, contentType, v3Id);
    return existing.id;
  }

  // ── Step 2: Download ─────────────────────────────────────────────────────
  logger.info(`Downloading "${filename}" from: ${absoluteUrl}`, contentType, v3Id);
  await sleep(cfg.delayMs);

  const downloaded = await downloadFile(absoluteUrl);
  if (!downloaded) {
    logger.error(`Download failed for "${filename}". Skipping media.`, contentType, v3Id);
    return null;
  }

  const mimeType = guessMime(filename) || downloaded.contentType || 'application/octet-stream';
  logger.info(`Downloaded "${filename}" (${mimeType}, ${downloaded.buffer.length} bytes)`, contentType, v3Id);

  // ── Step 3: Upload to v5 ─────────────────────────────────────────────────
  await sleep(cfg.delayMs);

  const uploaded = await uploadToV5(downloaded.buffer, filename, mimeType, altText, caption);
  if (!uploaded?.id) {
    logger.error(`v5 upload returned no ID for "${filename}".`, contentType, v3Id);
    return null;
  }

  mediaCache.set(filename, uploaded);
  logger.create(`Media "${filename}" → v5 id:${uploaded.id}`, contentType, v3Id);
  return uploaded.id;
}

// ── Public: process a v3 media field value ───────────────────────────────────

/**
 * Process a v3 media field (single object or array) → v5 media ID(s).
 *
 * v3 media object:
 * { id:12, url:'/uploads/photo.jpg', name:'photo.jpg', alternativeText:'...', mime:'image/jpeg' }
 *
 * Returns: number (single) | number[] (multiple) | null
 */
async function processMediaField(v3Media, contentType, v3Id) {
  if (!v3Media) return null;

  if (!Array.isArray(v3Media)) {
    // Single media object
    const url = v3Media?.url || null;
    if (!url) return null;
    return processMediaUrl(url, v3Media?.alternativeText, v3Media?.caption, contentType, v3Id);
  }

  // Array of media objects
  const ids = [];
  for (const item of v3Media) {
    const url = item?.url || null;
    if (!url) continue;
    const id = await processMediaUrl(url, item?.alternativeText, item?.caption, contentType, v3Id);
    if (id != null) ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

module.exports = { processMediaField, processMediaUrl, extractFilename, resolveMediaUrl };
