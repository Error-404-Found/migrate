'use strict';

/**
 * mediaHandler.js
 * Migrates media files from v3 (S3 or local) into Strapi v5.
 *
 * Flow:
 *  1. Resolve URL (relative v3 path → absolute)
 *  2. Check if file already exists in v5 (dedup by filename)
 *  3. Download file bytes from the resolved URL
 *  4. POST to v5 /api/upload as multipart/form-data
 *  5. Strapi v5 stores it via its configured upload plugin (S3 etc.)
 */

const axios    = require('axios');
const FormData = require('form-data');
const path     = require('path');
const logger   = require('./logger');
const { sleep, cfg: apiCfg } = require('./apiClient');

const cfg = {
  get v3Url()  { return (process.env.STRAPI_V3_URL || '').replace(/\/$/, ''); },
  get v5Url()  { return (process.env.STRAPI_V5_URL || '').replace(/\/$/, ''); },
  get delay()  { return parseInt(process.env.DELAY_MS || '5000', 10); },
};

// In-memory dedup cache: filename → v5 media object
const uploaded = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${cfg.v3Url}${url.startsWith('/') ? '' : '/'}${url}`;
}

function getFilename(url) {
  if (!url) return '';
  try   { return path.basename(new URL(url).pathname) || ''; }
  catch { return url.split('/').pop().split('?')[0] || ''; }
}

function mime(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return ({
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
    webp:'image/webp', svg:'image/svg+xml', ico:'image/x-icon',
    pdf:'application/pdf',
    mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm',
    mp3:'audio/mpeg', wav:'audio/wav',
    csv:'text/csv', txt:'text/plain', json:'application/json', zip:'application/zip',
    doc:'application/msword',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })[ext] || 'application/octet-stream';
}

// ── Step 1: Check v5 media library ────────────────────────────────────────────
async function findInV5(filename) {
  if (!filename) return null;
  if (uploaded.has(filename)) return uploaded.get(filename);

  const nameOnly = filename.replace(/\.[^.]+$/, '');
  try {
    const r = await axios.get(`${cfg.v5Url}/api/upload/files`, {
      params: { 'filters[name][$containsi]': nameOnly, 'pagination[pageSize]': 10 },
      timeout: 10000,
    });
    const files = Array.isArray(r.data) ? r.data : [];
    const match = files.find(f =>
      f.name === filename || f.name === nameOnly ||
      (f.url || '').endsWith('/' + filename)
    );
    if (match) { uploaded.set(filename, match); return match; }
  } catch (e) {
    logger.warn(`Dedup check failed for "${filename}": ${e.message}`);
  }
  return null;
}

// ── Step 2: Download file bytes ───────────────────────────────────────────────
async function download(url) {
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 500 * 1024 * 1024,
    });
    return { buffer: Buffer.from(r.data), contentType: r.headers['content-type'] || null };
  } catch (e) {
    logger.warn(`Download failed [${url}]: ${e?.response?.status || 'N/A'} — ${e.message}`);
    return null;
  }
}

// ── Step 3: Upload to v5 ──────────────────────────────────────────────────────
async function uploadToV5(buffer, filename, mimeType, altText, caption) {
  try {
    const form = new FormData();
    form.append('files', buffer, { filename, contentType: mimeType, knownLength: buffer.length });
    const info = { name: filename };
    if (altText) info.alternativeText = altText;
    if (caption) info.caption = caption;
    form.append('fileInfo', JSON.stringify(info));

    const r = await axios.post(`${cfg.v5Url}/api/upload`, form, {
      headers: { ...form.getHeaders() },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return Array.isArray(r.data) ? r.data[0] : r.data;
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e.message;
    logger.warn(`Upload failed for "${filename}": ${e?.response?.status || 'N/A'} — ${msg}`);
    return null;
  }
}

// ── Public: process one media URL ─────────────────────────────────────────────
async function processUrl(rawUrl, altText, caption, ct, id) {
  const absUrl  = resolveUrl(rawUrl);
  if (!absUrl) return null;

  const filename = getFilename(absUrl);
  if (!filename) { logger.warn(`No filename from URL: ${absUrl}`, ct, id); return null; }

  // Dedup
  const existing = await findInV5(filename);
  if (existing) {
    logger.skip(`"${filename}" already in v5 (id:${existing.id})`, ct, id);
    return existing.id;
  }

  // Download
  logger.info(`Downloading "${filename}"`, ct, id);
  await sleep(cfg.delay);
  const dl = await download(absUrl);
  if (!dl) { logger.error(`Download failed: "${filename}"`, ct, id); return null; }

  // Upload
  const mimeType = mime(filename) || dl.contentType || 'application/octet-stream';
  await sleep(cfg.delay);
  const result = await uploadToV5(dl.buffer, filename, mimeType, altText || null, caption || null);
  if (!result?.id) { logger.error(`Upload returned no ID for "${filename}"`, ct, id); return null; }

  uploaded.set(filename, result);
  logger.create(`Media "${filename}" → v5 id:${result.id}`, ct, id);
  return result.id;
}

// ── Public: process a v3 media field ─────────────────────────────────────────
async function processMediaField(v3Media, ct, id) {
  if (!v3Media) return null;

  if (!Array.isArray(v3Media)) {
    if (!v3Media.url) return null;
    return processUrl(v3Media.url, v3Media.alternativeText, v3Media.caption, ct, id);
  }

  const ids = [];
  for (const item of v3Media) {
    if (!item?.url) continue;
    const mid = await processUrl(item.url, item.alternativeText, item.caption, ct, id);
    if (mid != null) ids.push(mid);
  }
  return ids.length ? ids : null;
}

module.exports = { processMediaField, processUrl, resolveUrl, getFilename };
