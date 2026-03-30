'use strict';

// MUST be first — loads .env before any module reads process.env
require('dotenv').config();

const { parseArgs, printHelp }  = require('./lib/cliParser');
const { validateCollections, validateSingleTypes } = require('./lib/slugValidator');
const state   = require('./lib/stateManager');
const logger  = require('./lib/logger');
const { v3, v5, sleep } = require('./lib/apiClient');
const { mapFields }     = require('./lib/fieldMapper');
const { migrateLocales, migrateSingleTypeLocales, getLocales } = require('./lib/i18nHandler');

const BATCH       = () => parseInt(process.env.BATCH_SIZE  || '100',   10);
const DELAY       = () => parseInt(process.env.DELAY_MS    || '5000',  10);
const MAX_TRIES   = 3;

// ── Startup checks ────────────────────────────────────────────────────────────
function checkEnv() {
  const missing = ['STRAPI_V3_URL', 'STRAPI_V5_URL'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function banner() {
  console.log('\n' + '═'.repeat(68));
  console.log('  Strapi v3 → v5  Migration');
  console.log('═'.repeat(68));
  console.log(`  V3  : ${process.env.STRAPI_V3_URL}`);
  console.log(`  V5  : ${process.env.STRAPI_V5_URL}`);
  console.log(`  Log : ${logger.getLogFilePath()}`);
  console.log('═'.repeat(68) + '\n');
}

// ── Publish helper ────────────────────────────────────────────────────────────
// v3 published entries have published_at set. v5 creates drafts by default.
async function publishIfNeeded(slug, v5Id, v3Entry) {
  const wasPublished = v3Entry.published_at != null;
  if (!wasPublished) return;
  const r = await v5.publish(slug, v5Id);
  if (r.error) logger.warn(`Publish failed ${slug}/${v5Id}: ${r.error}`, slug, v3Entry.id);
  else         logger.info(`Published ${slug} v5:${v5Id}`, slug, v3Entry.id);
}

// ── Migrate one collection entry ──────────────────────────────────────────────
async function migrateEntry(entry, slug) {
  const v3Id = entry?.id;
  if (v3Id == null) { logger.warn('Entry missing id', slug); return { ok: false, skip: false }; }

  if (state.isFailed(slug, v3Id))   { logger.skip('Permanently failed. Skipping.', slug, v3Id); return { ok: false, skip: true }; }
  if (state.isMigrated(slug, v3Id)) { logger.skip(`Already done → v5:${state.getV5Id(slug, v3Id)}`, slug, v3Id); return { ok: true, skip: true }; }

  const locale = entry.locale || (process.env.SUPPORTED_LOCALES || 'en').split(',')[0].trim();
  let lastErr  = null;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      logger.fetch(`Attempt ${attempt}/${MAX_TRIES}`, slug, v3Id, locale);

      // Map all fields
      const data = await mapFields(entry, slug, v3Id, locale);
      delete data.localizations;
      delete data.publishedAt;
      data.locale = locale;

      // Create in v5
      const r = await v5.create(slug, { data });
      if (r.error) throw new Error(`v5 create failed (${r.status}): ${r.error}`);

      const v5Id = r.data?.data?.id ?? r.data?.id;
      if (!v5Id) throw new Error('v5 create returned no id');

      state.setIdMapping(slug, v3Id, v5Id);
      logger.create(`v3:${v3Id} → v5:${v5Id}`, slug, v3Id, locale);

      // Publish if the v3 entry was published
      await publishIfNeeded(slug, v5Id, entry);

      // Migrate all other locales
      const locRes = await migrateLocales(entry, slug, v5Id, locale);
      const failed = locRes.filter(l => !l.ok).map(l => l.locale);
      if (failed.length) logger.warn(`Locale failures: ${failed.join(', ')}`, slug, v3Id);

      return { ok: true, skip: false };

    } catch (e) {
      lastErr = e.message;
      state.bumpRetry(slug, v3Id);
      logger.error(`Attempt ${attempt} failed: ${e.message}`, slug, v3Id, locale);
      if (attempt < MAX_TRIES) await sleep(4000 * attempt);
    }
  }

  state.markFailed(slug, v3Id);
  logger.error(`Permanently failed: ${lastErr}`, slug, v3Id);
  return { ok: false, skip: false };
}

// ── Migrate a collection ──────────────────────────────────────────────────────
async function migrateCollection(slug) {
  logger.separator();
  logger.info(`Collection: "${slug}"`);
  state.initSlug(slug, 'collection');

  if (state.isDone(slug)) {
    logger.info(`"${slug}" already complete.`);
    return { total: 0, success: 0, skipped: 1, failed: 0 };
  }

  const stats         = { total: 0, success: 0, skipped: 0, failed: 0 };
  const defaultLocale = (process.env.SUPPORTED_LOCALES || 'en').split(',')[0].trim();
  const batchSize     = BATCH();

  const total = await v3.getCount(slug, defaultLocale);
  stats.total = total;
  logger.info(`Total: ${total} entries (locale: ${defaultLocale})`, slug);

  const lastPage   = state.getLastPage(slug);
  const startPage  = lastPage + 1;
  const totalPages = total > 0 ? Math.ceil(total / batchSize) : 1;

  logger.info(`Pages: ${totalPages}, resuming from page ${startPage + 1}`, slug);

  for (let page = startPage; page < totalPages; page++) {
    const start = page * batchSize;
    logger.fetch(`Page ${page + 1}/${totalPages} (offset ${start})`, slug);

    const r = await v3.getCollection(slug, start, batchSize, defaultLocale);
    if (r.error) {
      logger.error(`Fetch failed page ${page + 1}: ${r.error}`, slug);
      await sleep(DELAY());
      continue;
    }

    const entries = Array.isArray(r.data) ? r.data : [];
    logger.info(`Got ${entries.length} entries`, slug);

    for (const entry of entries) {
      const res = await migrateEntry(entry, slug);
      if (res.skip)       stats.skipped++;
      else if (res.ok)    stats.success++;
      else                stats.failed++;
    }

    state.setLastPage(slug, page);
    logger.info(`Page ${page + 1} done — ok:${stats.success} skip:${stats.skipped} fail:${stats.failed}`, slug);

    if (entries.length < batchSize) break;
  }

  state.markDone(slug);
  logger.summary(slug, stats);
  return stats;
}

// ── Migrate a single type ─────────────────────────────────────────────────────
async function migrateSingleType(slug) {
  logger.separator();
  logger.info(`Single type: "${slug}"`);
  state.initSlug(slug, 'singleType');

  if (state.isDone(slug)) {
    logger.info(`"${slug}" already complete.`);
    return { total: 1, success: 0, skipped: 1, failed: 0 };
  }

  const stats         = { total: 1, success: 0, skipped: 0, failed: 0 };
  const defaultLocale = (process.env.SUPPORTED_LOCALES || 'en').split(',')[0].trim();
  let   lastErr       = null;

  const r = await v3.getSingleType(slug, defaultLocale);
  if (r.error || !r.data) {
    logger.error(`Failed to fetch "${slug}" from v3: ${r.error}`, slug);
    stats.failed = 1;
    logger.summary(slug, stats);
    return stats;
  }

  const entry = r.data;
  logger.info(`Locales: ${getLocales(entry).join(', ')}`, slug);

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const data = await mapFields(entry, slug, null, defaultLocale);
      delete data.localizations; delete data.publishedAt;
      data.locale = defaultLocale;

      const upd = await v5.updateSingleType(slug, { data }, defaultLocale);
      if (upd.error) throw new Error(`v5 PUT failed (${upd.status}): ${upd.error}`);

      const v5Id = upd.data?.data?.id ?? upd.data?.id ?? null;
      logger.update(`"${slug}" updated in v5 (locale: ${defaultLocale})`, slug, null, defaultLocale);

      if (v5Id) await publishIfNeeded(slug, v5Id, entry);
      await migrateSingleTypeLocales(slug, entry, defaultLocale);

      stats.success = 1;
      state.markDone(slug);
      break;
    } catch (e) {
      lastErr = e.message;
      logger.error(`Attempt ${attempt} failed: ${e.message}`, slug);
      if (attempt < MAX_TRIES) await sleep(4000 * attempt);
    }
  }

  if (!stats.success) {
    stats.failed = 1;
    logger.error(`"${slug}" permanently failed: ${lastErr}`, slug);
  }

  logger.summary(slug, stats);
  return stats;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  banner();
  checkEnv();

  const args = parseArgs(process.argv);

  if (args.showHelp) {
    printHelp();
    if (args.errors.length) console.error('\n' + args.errors.join('\n'));
    process.exit(args.valid ? 0 : 1);
  }

  if (!args.valid) {
    console.error(args.errors.join('\n'));
    printHelp();
    process.exit(1);
  }

  if (args.errors.length) args.errors.forEach(e => logger.warn(e));

  logger.info(`Collections : ${args.collections.join(', ')  || '(none)'}`);
  logger.info(`Single types: ${args.singleTypes.join(', ') || '(none)'}`);

  logger.info('Validating slugs...');
  const validCols    = await validateCollections(args.collections);
  const validSingles = await validateSingleTypes(args.singleTypes);

  if (!validCols.length && !validSingles.length) {
    logger.error('No valid migration targets. Exiting.');
    process.exit(1);
  }

  state.load();

  const results = {};

  for (const slug of validCols) {
    try {
      results[slug] = await migrateCollection(slug);
    } catch (e) {
      logger.error(`Unhandled: ${e.message}\n${e.stack}`);
      results[slug] = { total: 0, success: 0, skipped: 0, failed: 1 };
    }
  }

  for (const slug of validSingles) {
    try {
      results[slug] = await migrateSingleType(slug);
    } catch (e) {
      logger.error(`Unhandled: ${e.message}\n${e.stack}`);
      results[slug] = { total: 1, success: 0, skipped: 0, failed: 1 };
    }
  }

  logger.grandSummary(results);
  state.save();
  logger.info('Done.');
  process.exit(0);
}

process.on('uncaughtException',  e => logger.error(`[FATAL] ${e.message}\n${e.stack}`));
process.on('unhandledRejection', e => logger.error(`[FATAL] ${e}`));

main().catch(e => { logger.error(`[FATAL] ${e.message}\n${e.stack}`); process.exit(1); });
