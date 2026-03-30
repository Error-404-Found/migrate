'use strict';

/**
 * index.js
 * Entry point for the Strapi v3 → v5 migration middleware.
 *
 * FIX: locale is included inside the data object (not at root) when creating v5 entries.
 * FIX: publishedAt is handled explicitly — published v3 entries are published in v5.
 * FIX: stateManager.setIdMapping now saves immediately after each entry.
 * FIX: migrateLocales receives updated signature (no stateManager import needed in i18nHandler).
 */

// Load .env FIRST — before any other module reads process.env
require('dotenv').config();

const { parseArgs, printHelp } = require('./lib/cliParser');
const { validateCollections, validateSingleTypes } = require('./lib/slugValidator');
const stateManager = require('./lib/stateManager');
const logger       = require('./lib/logger');
const { v3, v5, sleep } = require('./lib/apiClient');
const { mapFields }     = require('./lib/fieldMapper');
const { migrateLocales, migrateSingleTypeLocales, extractLocales } = require('./lib/i18nHandler');

const BATCH_SIZE         = () => parseInt(process.env.BATCH_SIZE  || '100',   10);
const DELAY_MS           = () => parseInt(process.env.DELAY_MS    || '30000', 10);
const MAX_ENTRY_RETRIES  = 3;

// ── Banner ────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('\n' + '═'.repeat(70));
  console.log('  Strapi v3.6.8 → v5  Migration Middleware');
  console.log('═'.repeat(70));
  console.log(`  V3 URL    : ${process.env.STRAPI_V3_URL || '(not set)'}`);
  console.log(`  V5 URL    : ${process.env.STRAPI_V5_URL || '(not set)'}`);
  console.log(`  Batch     : ${BATCH_SIZE()} entries / call`);
  console.log(`  Delay     : ${DELAY_MS()}ms between calls`);
  console.log(`  Log file  : ${logger.getLogFilePath()}`);
  console.log('═'.repeat(70) + '\n');
}

// ── Env check ─────────────────────────────────────────────────────────────────
function checkEnv() {
  const required = ['STRAPI_V3_URL', 'STRAPI_V5_URL'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`Missing required env vars: ${missing.join(', ')}`);
    logger.error('Check your .env file. See .env.example for reference.');
    process.exit(1);
  }
}

// ── Default locale helper ─────────────────────────────────────────────────────
function getDefaultLocale() {
  return (process.env.SUPPORTED_LOCALES || 'en').split(',')[0].trim();
}

// ── Publish a v5 entry if it was published in v3 ─────────────────────────────
/**
 * v3 published entries have published_at set (non-null).
 * In v5, entries are created as drafts by default.
 * We call the publish action to match the v3 state.
 */
async function publishIfNeeded(slug, v5Id, v3Entry, locale) {
  // v3 uses published_at (snake_case); it's non-null when published
  const wasPublished = v3Entry.published_at != null || v3Entry.publishedAt != null;
  if (!wasPublished) return; // draft — leave as-is in v5

  try {
    const result = await v5.publish(slug, v5Id);
    if (result.error) {
      logger.warn(`Could not publish ${slug}/${v5Id}: ${result.error}`, slug, v3Entry.id, locale);
    } else {
      logger.info(`Published ${slug}/${v5Id} in v5.`, slug, v3Entry.id, locale);
    }
  } catch (err) {
    logger.warn(`Exception publishing ${slug}/${v5Id}: ${err.message}`, slug, v3Entry.id, locale);
  }
}

// ── Migrate a single collection entry ─────────────────────────────────────────
async function migrateEntry(v3Entry, slug) {
  const v3Id = v3Entry?.id;
  if (v3Id == null) {
    logger.warn('Entry has no ID — skipping.', slug);
    return { success: false, skipped: false };
  }

  // Already permanently failed in a previous run
  if (stateManager.isFailed(slug, v3Id)) {
    logger.skip('Permanently failed in previous run. Skipping.', slug, v3Id);
    return { success: false, skipped: true };
  }

  // Already successfully migrated
  if (stateManager.isAlreadyMigrated(slug, v3Id)) {
    const v5Id = stateManager.getV5Id(slug, v3Id);
    logger.skip(`Already migrated → v5_id:${v5Id}. Skipping.`, slug, v3Id);
    return { success: true, skipped: true };
  }

  const defaultLocale = v3Entry.locale || getDefaultLocale();
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ENTRY_RETRIES; attempt++) {
    try {
      logger.fetch(`Attempt ${attempt}/${MAX_ENTRY_RETRIES}`, slug, v3Id, defaultLocale);

      // ── Map all fields ─────────────────────────────────────────────────────
      const v5Data = await mapFields(v3Entry, slug, v3Id, defaultLocale);

      // Strip v5-managed fields
      delete v5Data.localizations;
      delete v5Data.publishedAt;  // handled separately via publish action

      // FIX: locale goes inside data object
      v5Data.locale = defaultLocale;

      // ── Create entry in v5 ─────────────────────────────────────────────────
      const createResult = await v5.create(slug, { data: v5Data });
      if (createResult.error) {
        throw new Error(`v5 create failed (HTTP ${createResult.statusCode}): ${createResult.error}`);
      }

      // v5 response: { data: { id, attributes } }
      const v5Id = createResult.data?.data?.id ?? createResult.data?.id ?? null;
      if (v5Id == null) throw new Error('v5 create returned no ID');

      // FIX: save ID mapping immediately (not deferred to page end)
      stateManager.setIdMapping(slug, v3Id, v5Id);
      logger.create(`Created in v5 id:${v5Id}`, slug, v3Id, defaultLocale);

      // ── Publish if needed ──────────────────────────────────────────────────
      await publishIfNeeded(slug, v5Id, v3Entry, defaultLocale);

      // ── Migrate other locale variants ──────────────────────────────────────
      const localeResults = await migrateLocales(v3Entry, slug, v5Id, defaultLocale);
      const failedLocales = localeResults.filter(r => !r.success).map(r => r.locale);
      if (failedLocales.length) {
        logger.warn(`Failed locales for v3_id=${v3Id}: ${failedLocales.join(', ')}`, slug, v3Id);
      }

      return { success: true, skipped: false };

    } catch (err) {
      lastError = err.message;
      stateManager.incrementRetry(slug, v3Id);
      logger.error(`Attempt ${attempt} failed: ${err.message}`, slug, v3Id, defaultLocale);

      if (attempt < MAX_ENTRY_RETRIES) {
        const backoffMs = 5000 * attempt;
        logger.warn(`Retrying in ${backoffMs}ms...`, slug, v3Id);
        await sleep(backoffMs);
      }
    }
  }

  stateManager.markFailed(slug, v3Id);
  logger.error(`Permanently failed after ${MAX_ENTRY_RETRIES} attempts: ${lastError}`, slug, v3Id);
  return { success: false, skipped: false };
}

// ── Migrate a collection ──────────────────────────────────────────────────────
async function migrateCollection(slug) {
  logger.separator();
  logger.info(`Starting collection: "${slug}"`);
  stateManager.initSlug(slug, 'collection');

  if (stateManager.isDone(slug)) {
    logger.info(`"${slug}" already fully migrated. Skipping.`);
    return { total: 0, success: 0, skipped: 1, failed: 0 };
  }

  const stats         = { total: 0, success: 0, skipped: 0, failed: 0 };
  const defaultLocale = getDefaultLocale();
  const batchSize     = BATCH_SIZE();

  // Get total entry count (with locale fallback)
  const total = await v3.getCount(slug, defaultLocale);
  stats.total = total;
  logger.info(`Total entries in "${slug}" (locale:${defaultLocale}): ${total}`);

  const lastPage  = stateManager.getLastPage(slug);
  const startPage = lastPage + 1; // resume from next unprocessed page
  const totalPages = total > 0 ? Math.ceil(total / batchSize) : 1;

  logger.info(`Pages: ${totalPages} | Resuming from page ${startPage + 1}`);

  for (let page = startPage; page < totalPages; page++) {
    const start = page * batchSize;
    logger.fetch(`Page ${page + 1}/${totalPages} — fetching ${batchSize} entries from offset ${start}`, slug);

    const batchResult = await v3.getCollection(slug, start, batchSize, defaultLocale);

    if (batchResult.error) {
      logger.error(`Failed to fetch page ${page + 1}: ${batchResult.error}`, slug);
      // Don't mark as done — will retry on next run
      await sleep(DELAY_MS());
      continue;
    }

    const entries = Array.isArray(batchResult.data) ? batchResult.data : [];
    logger.info(`Got ${entries.length} entries on page ${page + 1}`, slug);

    for (const entry of entries) {
      const result = await migrateEntry(entry, slug);
      if (result.skipped)        stats.skipped++;
      else if (result.success)   stats.success++;
      else                       stats.failed++;
    }

    // Mark page complete and checkpoint
    stateManager.setLastPage(slug, page);
    logger.info(
      `Page ${page + 1} done — success:${stats.success} skipped:${stats.skipped} failed:${stats.failed}`,
      slug
    );

    // If we got fewer entries than the batch size, we've reached the last page
    if (entries.length < batchSize) break;
  }

  stateManager.markDone(slug);
  logger.summary(slug, stats);
  return stats;
}

// ── Migrate a single type ─────────────────────────────────────────────────────
async function migrateSingleType(slug) {
  logger.separator();
  logger.info(`Starting single type: "${slug}"`);
  stateManager.initSlug(slug, 'singleType');

  if (stateManager.isDone(slug)) {
    logger.info(`"${slug}" already migrated. Skipping.`);
    return { total: 1, success: 0, skipped: 1, failed: 0 };
  }

  const stats         = { total: 1, success: 0, skipped: 0, failed: 0 };
  const defaultLocale = getDefaultLocale();

  const v3Result = await v3.getSingleType(slug, defaultLocale);
  if (v3Result.error || !v3Result.data) {
    logger.error(`Failed to fetch single type "${slug}" from v3: ${v3Result.error}`, slug);
    stats.failed = 1;
    logger.summary(slug, stats);
    return stats;
  }

  const v3Entry   = v3Result.data;
  const allLocales = extractLocales(v3Entry);
  logger.info(`Single type "${slug}" locales: ${allLocales.join(', ')}`, slug);

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ENTRY_RETRIES; attempt++) {
    try {
      const v5Data = await mapFields(v3Entry, slug, null, defaultLocale);
      delete v5Data.localizations;
      delete v5Data.publishedAt;
      v5Data.locale = defaultLocale;

      // Single types use PUT in v5
      const putResult = await v5.updateSingleType(slug, { data: v5Data }, defaultLocale);
      if (putResult.error) {
        throw new Error(`v5 PUT failed (HTTP ${putResult.statusCode}): ${putResult.error}`);
      }

      const v5Id = putResult.data?.data?.id ?? putResult.data?.id ?? null;
      logger.update(`Single type "${slug}" updated in v5 (locale:${defaultLocale})`, slug, null, defaultLocale);

      // Publish if needed
      if (v5Id) await publishIfNeeded(slug, v5Id, v3Entry, defaultLocale);

      // Migrate other locales
      await migrateSingleTypeLocales(slug, v3Entry, defaultLocale);

      stats.success = 1;
      stateManager.markDone(slug);
      break;

    } catch (err) {
      lastError = err.message;
      logger.error(`Attempt ${attempt} failed for single type "${slug}": ${err.message}`, slug);
      if (attempt < MAX_ENTRY_RETRIES) await sleep(5000 * attempt);
    }
  }

  if (stats.success === 0) {
    stats.failed = 1;
    logger.error(`Single type "${slug}" permanently failed: ${lastError}`, slug);
  }

  logger.summary(slug, stats);
  return stats;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  checkEnv();

  const parsed = parseArgs(process.argv);

  if (parsed.showHelp) {
    printHelp();
    if (parsed.errors.length) console.error('\nErrors:\n  ' + parsed.errors.join('\n  '));
    process.exit(parsed.valid ? 0 : 1);
  }

  if (!parsed.valid) {
    console.error('\nErrors:\n  ' + parsed.errors.join('\n  '));
    printHelp();
    process.exit(1);
  }

  const expanded = expandAllFlag(parsed);
  if (!parsed.valid) {
    console.error('\nErrors:\n  ' + parsed.errors.join('\n  '));
    process.exit(1);
  }
  parsed.errors.forEach(e => logger.warn(e));

  logger.info(`Collections : ${parsed.collections.join(', ')  || '(none)'}`);
  logger.info(`Single types: ${parsed.singleTypes.join(', ') || '(none)'}`);

  // Validate slugs against v3
  logger.info('Validating slugs against v3 API...');
  const validCollections = await validateCollections(parsed.collections);
  const validSingleTypes = await validateSingleTypes(parsed.singleTypes);

  if (!validCollections.length && !validSingleTypes.length) {
    logger.error('No valid migration targets found after slug validation. Exiting.');
    process.exit(1);
  }

  logger.info(`Valid collections : ${validCollections.join(', ')  || '(none)'}`);
  logger.info(`Valid single types: ${validSingleTypes.join(', ') || '(none)'}`);

  stateManager.load();

  const grandResults = {};

  for (const slug of validCollections) {
    try {
      grandResults[slug] = await migrateCollection(slug);
    } catch (err) {
      logger.error(`Unhandled exception on collection "${slug}": ${err.message}`);
      logger.error(err.stack || '(no stack)');
      grandResults[slug] = { total: 0, success: 0, skipped: 0, failed: 1 };
    }
  }

  for (const slug of validSingleTypes) {
    try {
      grandResults[slug] = await migrateSingleType(slug);
    } catch (err) {
      logger.error(`Unhandled exception on single type "${slug}": ${err.message}`);
      logger.error(err.stack || '(no stack)');
      grandResults[slug] = { total: 1, success: 0, skipped: 0, failed: 1 };
    }
  }

  logger.grandSummary(grandResults);
  stateManager.flush();
  logger.info('Migration complete.');
  process.exit(0);
}

// Last-resort safety nets
process.on('uncaughtException',  err => { console.error('[FATAL] UncaughtException:', err.message, err.stack); });
process.on('unhandledRejection', err => { console.error('[FATAL] UnhandledRejection:', err); });

main().catch(err => {
  console.error('[FATAL] main() threw:', err.message, err.stack);
  process.exit(1);
});
