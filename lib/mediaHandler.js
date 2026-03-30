'use strict';

/**
 * mediaHandler.js
 * Handles fetching media from S3 and uploading to Strapi v5 media library.
 *
 * Strategy:
 * 1. Extract filename from S3 URL
 * 2. Check if file already exists in v5 by name (dedup check)
 * 3. If not found, download from S3 and upload to v5 via multipart/form-data
 * 4. Return the v5 media object
 */

const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const { v5 } = require('./apiClient');
const logger = require('./logger');

// In-memory cache: filename → v5 media object
// Avoids repeated API calls for the same file within a single run
const mediaCache = new Map();

/**
 * Extract the filename from a URL.
 * e.g. https://s3.amazonaws.com/bucket/uploads/photo-123.jpg → photo-123.jpg
 */
function extractFilename(url) {
  try {
    const parsed = new URL(url);
    return path.basename(parsed.pathname);
  } catch {
    // Fallback for malformed URLs — use the last segment after the last slash
    return (url || '').split('/').pop().split('?')[0] || '';
  }
}

/**
 * Extract MIME type from filename or Content-Type header.
 */
function guessMimeType(filename, contentType) {
  if (contentType && contentType.includes('/')) return contentType.split(';')[0].trim();

  const ext = (filename || '').split('.').pop().toLowerCase();
  const mimeMap = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Download a file from a URL and return a buffer + metadata.
 * Returns null on failure.
 */
async function downloadFromUrl(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      // Don't use Authorization here — S3 pre-signed URLs or public S3 don't need it
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers['content-type'] || null,
      contentLength: response.headers['content-length'] || null,
    };
  } catch (err) {
    const status = err?.response?.status;
    const reason = err?.message || 'Unknown error';
    logger.warn(`Failed to download ${url}: HTTP ${status || 'N/A'} — ${reason}`);
    return null;
  }
}

/**
 * Check if a file already exists in the v5 media library by filename.
 * Returns the existing v5 media object or null.
 */
async function findExistingMedia(filename) {
  // Check memory cache first
  if (mediaCache.has(filename)) {
    return mediaCache.get(filename);
  }

  const result = await v5.findMediaByName(filename);
  if (result.error) {
    logger.warn(`Media dedup check failed for "${filename}": ${result.error}`);
    return null;
  }

  // v5 upload/files returns a plain array (not wrapped in data)
  const files = Array.isArray(result.data) ? result.data : [];
  if (files.length > 0) {
    const existing = files[0];
    mediaCache.set(filename, existing);
    return existing;
  }
  return null;
}

/**
 * Upload a file to v5 from a URL (typically an S3 URL from v3).
 *
 * @param {string} url - The S3 URL of the file
 * @param {string|null} altText - Optional alt text for the media
 * @param {string} contentType - The parent content type (for logging)
 * @param {any} v3Id - The v3 entry ID (for logging)
 * @returns {object|null} v5 media object or null on failure
 */
async function uploadFromS3Url(url, altText = null, contentType = null, v3Id = null) {
  if (!url || typeof url !== 'string') {
    logger.warn('uploadFromS3Url called with invalid URL', contentType, v3Id);
    return null;
  }

  const filename = extractFilename(url);
  if (!filename) {
    logger.warn(`Could not extract filename from URL: ${url}`, contentType, v3Id);
    return null;
  }

  // ── Step 1: Dedup check ──────────────────────────────────────────────────
  const existing = await findExistingMedia(filename);
  if (existing) {
    logger.skip(`Media "${filename}" already exists in v5 (id: ${existing.id}). Reusing.`, contentType, v3Id);
    return existing;
  }

  // ── Step 2: Download from S3 ─────────────────────────────────────────────
  logger.fetch(`Downloading media from S3: ${filename}`, contentType, v3Id);
  const downloaded = await downloadFromUrl(url);
  if (!downloaded) {
    logger.error(`Failed to download media "${filename}" from URL: ${url}`, contentType, v3Id);
    return null;
  }

  // ── Step 3: Upload to v5 ─────────────────────────────────────────────────
  const mimeType = guessMimeType(filename, downloaded.contentType);
  const form = new FormData();
  form.append('files', downloaded.buffer, {
    filename,
    contentType: mimeType,
  });

  // Attach optional file info (alt text, caption)
  if (altText) {
    form.append('fileInfo', JSON.stringify({ alternativeText: altText }));
  }

  logger.info(`Uploading "${filename}" (${mimeType}) to v5 media library...`, contentType, v3Id);
  const uploadResult = await v5.uploadMedia(form);

  if (uploadResult.error) {
    logger.error(`Upload failed for "${filename}": ${uploadResult.error}`, contentType, v3Id);
    return null;
  }

  // v5 upload returns an array of uploaded files
  const uploaded = Array.isArray(uploadResult.data)
    ? uploadResult.data[0]
    : uploadResult.data;

  if (!uploaded?.id) {
    logger.error(`Upload for "${filename}" returned no ID.`, contentType, v3Id);
    return null;
  }

  // Cache the result to avoid re-uploading in the same run
  mediaCache.set(filename, uploaded);
  logger.create(`Media "${filename}" uploaded to v5 (id: ${uploaded.id})`, contentType, v3Id);
  return uploaded;
}

/**
 * Process a v3 media field value and return a v5 media reference.
 * Handles both single media objects and arrays.
 *
 * @param {object|object[]|null} v3Media - v3 media object(s)
 * @param {string} contentType - parent content type (for logging)
 * @param {any} v3Id - parent entry ID (for logging)
 * @returns {number|number[]|null} v5 media ID(s) or null
 */
async function processMediaField(v3Media, contentType, v3Id) {
  if (!v3Media) return null;

  // Single media object
  if (!Array.isArray(v3Media)) {
    const url = v3Media?.url || v3Media?.formats?.original?.url || null;
    if (!url) return null;
    const uploaded = await uploadFromS3Url(url, v3Media?.alternativeText, contentType, v3Id);
    return uploaded?.id ?? null;
  }

  // Array of media objects
  const ids = [];
  for (const item of v3Media) {
    const url = item?.url || item?.formats?.original?.url || null;
    if (!url) continue;
    const uploaded = await uploadFromS3Url(url, item?.alternativeText, contentType, v3Id);
    if (uploaded?.id != null) {
      ids.push(uploaded.id);
    }
  }
  return ids.length > 0 ? ids : null;
}

module.exports = { uploadFromS3Url, processMediaField, findExistingMedia, extractFilename };
