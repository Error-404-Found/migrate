'use strict';

/**
 * index.js
 * Entry point for the Strapi v3 → v5 migration middleware.
 *
 * Responsibilities:
 * 1. Load .env
 * 2. Parse CLI arguments
 * 3. Validate slugs against v3 API
 * 4. Load migration state (for resumption)
 * 5. Run migration loop for each collection and single type
 * 6. Print grand summary
 */

// ── Load environment variables FIRST before any other module reads them ──────
require('dotenv').config();

const { parseArgs, expandAllFlag, printHelp } = require('./lib/cliParser');
const { validateCollections, validateSingleTypes } = require('./lib/slugValidator');
const stateManager = require('./lib/stateManager');
const logger = require('./lib/logger');
const { v3, v5, sleep } = require('./lib/apiClient');
const { mapFields } = require('./lib/fieldMapper');
const { migrateLocales, migrateSingleTypeLocales, extractLocales } = require('./lib/i18nHandler');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '30000', 10);
const MAX_RETRIES_PER_ENTRY = 3;

// ─── Utility: print startup banner ───────────────────────────────────────────
function printBanner() {
  console.log('\n' + '═'.repeat(70));
  console.log('  Strapi v3.6.8 → v5  Migration Middleware');
  console.log('═'.repeat(70));
  console.log(`  V3 URL   : ${process.env.STRAPI_V3_URL || '(not set)'}`);
  console.log(`  V5 URL   : ${process.env.STRAPI_V5_URL || '(not set)'}`);
  console.log(`  Batch    : ${BATCH_SIZE} entries/call`);
  console.log(`  Delay    : ${DELAY_MS}ms between calls`);
  console.log(`  Log file : ${logger.getLogFilePath()}`);
  console.log('═'.repeat(70) + '\n');
}

// ─── Validate required env vars ───────────────────────────────────────────────
function checkEnv() {
  const required = ['STRAPI_V3_URL', 'STRAPI_V5_URL', 'STRAPI_V3_TOKEN', 'STRAPI_V5_TOKEN'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    logger.error('Please check your .env file. See .env.example for reference.');
    process.exit(1);
  }
}

// ─── Migrate a single entry (with retry logic) ───────────────────────────────
/**
 * Attempt to migrate a single v3 entry to v5.
 * Retries up to MAX_RETRIES_PER_ENTRY times on failure.
 *
 * @param {object} v3Entry - raw v3 entry
 * @param {string} slug - collection slug
 * @returns {{ success: boolean, v5Id: number|null }}
 */
async function migrateEntry(v3Entry, slug) {
  const v3Id = v3Entry?.id;
  if (v3Id == null) {
    logger.warn('Entry has no ID, skipping.', slug);
    return { success: false, v5Id: null };
  }

  // Skip permanently failed entries
  if (stateManager.isFailed(slug, v3Id)) {
    logger.skip(`Entry permanently failed in previous run. Skipping.`, slug, v3Id);
    return { success: false, v5Id: null, skipped: true };
  }

  // Skip already migrated entries
  if (stateManager.isAlreadyMigrated(slug, v3Id)) {
    const existing = stateManager.getV5Id(slug, v3Id);
    logger.skip(`Already migrated (v5_id: ${existing}). Skipping.`, slug, v3Id);
    return { success: true, v5Id: existing, skipped: true };
  }

  const defaultLocale = v3Entry.locale || (process.env.SUPPORTED_LOCALES || 'en').split(',')[0].trim();

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_ENTRY; attempt++) {
    try {
      logger.fetch(
        `Attempt ${attempt}/${MAX_RETRIES_PER_ENTRY} for entry v3_id=${v3Id}`,
        slug,
        v3Id,
        defaultLocale
      );

      // ── Map v3 fields to v5 format ─────────────────────────────────────────
      const v5Data = await mapFields(v3Entry, slug, v3Id, defaultLocale);

      // Remove localizations array — v5 manages this
      delete v5Data.localizations;

      // Set locale explicitly
      v5Data.locale = defaultLocale;

      // ── Create entry in v5 ─────────────────────────────────────────────────
      const createResult = await v5.create(slug, { data: v5Data });

      if (createResult.error) {
        throw new Error(`v5 create failed: ${createResult.error} (HTTP ${createResult.statusCode})`);
      }

      // Extract the v5 ID from the response
      const v5Id = createResult.data?.data?.id ?? createResult.data?.id ?? null;
      if (v5Id == null) {
        throw new Error('v5 create returned no ID in response');
      }

      // Store ID mapping
      stateManager.setIdMapping(slug, v3Id, v5Id);
      logger.create(`Created in v5 with id ${v5Id}`, slug, v3Id, defaultLocale);

      // ── Migrate other locales ──────────────────────────────────────────────
      const localeResults = await migrateLocales(v3Entry, slug, v5Id, defaultLocale);
      const failedLocales = localeResults.filter(r => !r.success).map(r => r.locale);
      if (failedLocales.length > 0) {
        logger.warn(`Locale failures for v3_id=${v3Id}: ${failedLocales.join(', ')}`, slug, v3Id);
      }

      return { success: true, v5Id };

    } catch (err) {
      lastError = err.message;
      const retries = stateManager.incrementRetry(slug, v3Id);
      logger.error(
        `Attempt ${attempt} failed: ${err.message}`,
        slug,
        v3Id,
        defaultLocale
      );

      if (attempt < MAX_RETRIES_PER_ENTRY) {
        const backoff = 5000 * attempt;
        logger.warn(`Retrying in ${backoff}ms...`, slug, v3Id);
        await sleep(backoff);
      }
    }
  }

  // All retries exhausted
  stateManager.markFailed(slug, v3Id);
  logger.error(
    `Entry permanently failed after ${MAX_RETRIES_PER_ENTRY} attempts. Last error: ${lastError}`,
    slug,
    v3Id
  );
  return { success: false, v5Id: null };
}

// ─── Migrate a collection ─────────────────────────────────────────────────────
async function migrateCollection(slug) {
  logger.separator();
  logger.info(`Starting collection migration: ${slug}`);
  stateManager.initSlug(slug, 'collection');

  if (stateManager.isDone(slug)) {
    logger.info(`Collection "${slug}" already fully migrated. Skipping.`);
    return { total: 0, success: 0, skipped: 0, failed: 0 };
  }

  const stats = { total: 0, success: 0, skipped: 0, failed: 0 };
  const defaultLocale = (process.env.SUPPORTED_LOCALES || 'en').split(',')[0].trim();

  // Get total count for progress tracking
  const total = await v3.getCount(slug, defaultLocale);
  logger.info(`Total entries in "${slug}" (locale: ${defaultLocale}): ${total}`);
  stats.total = total;

  const lastPage = stateManager.getLastPage(slug);
  const startPage = lastPage + 1; // resume from next unprocessed page
  const totalPages = Math.ceil(total / BATCH_SIZE);

  logger.info(`Resuming from page ${startPage + 1}/${totalPages || 1} (0-indexed: ${startPage})`);

  for (let page = startPage; page < totalPages || (total === 0 && page === 0); page++) {
    const start = page * BATCH_SIZE;
    logger.fetch(`Fetching page ${page + 1}/${totalPages} (start: ${start}, limit: ${BATCH_SIZE})`, slug);

    // Fetch this batch from v3
    const batchResult = await v3.getCollection(slug, start, BATCH_SIZE, defaultLocale);

    if (batchResult.error) {
      logger.error(`Failed to fetch page ${page + 1}: ${batchResult.error}`, slug);
      // Don't mark page as done — it will be retried on next run
      // But don't abort the whole migration either
      await sleep(DELAY_MS);
      continue;
    }

    const entries = Array.isArray(batchResult.data) ? batchResult.data : [];
    logger.info(`Got ${entries.length} entries on page ${page + 1}`, slug);

    // Migrate each entry in the batch
    for (const entry of entries) {
      const result = await migrateEntry(entry, slug);
      if (result.skipped) {
        stats.skipped++;
      } else if (result.success) {
        stats.success++;
      } else {
        stats.failed++;
      }
    }

    // Mark this page as done and flush state to disk
    stateManager.setLastPage(slug, page);
    stateManager.flush();
    logger.info(`Page ${page + 1} complete. Stats so far — success:${stats.success} skipped:${stats.skipped} failed:${stats.failed}`, slug);

    // If this was the last page with 0 entries and total was 0, break
    if (total === 0) break;
  }

  stateManager.markDone(slug);
  logger.summary(slug, stats);
  return stats;
}

// ─── Migrate a single type ────────────────────────────────────────────────────
async function migrateSingleType(slug) {
  logger.separator();
  logger.info(`Starting single type migration: ${slug}`);
  stateManager.initSlug(slug, 'singleType');

  if (stateManager.isDone(slug)) {
    logger.info(`Single type "${slug}" already fully migrated. Skipping.`);
    return { total: 1, success: 0, skipped: 1, failed: 0 };
  }

  const stats = { total: 1, success: 0, skipped: 0, failed: 0 };
  const defaultLocale = (process.env.SUPPORTED_LOCALES || 'en').split(',')[0].trim();

  // Fetch from v3
  const v3Result = await v3.getSingleType(slug, defaultLocale);
  if (v3Result.error || !v3Result.data) {
    logger.error(`Failed to fetch single type "${slug}" from v3: ${v3Result.error}`, slug);
    stats.failed = 1;
    logger.summary(slug, stats);
    return stats;
  }

  const v3Entry = v3Result.data;
  const allLocales = extractLocales(v3Entry);
  logger.info(`Single type "${slug}" locales: ${allLocales.join(', ')}`, slug);

  let lastError = null;
  let v5Id = null;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_ENTRY; attempt++) {
    try {
      // Map fields for default locale
      const v5Data = await mapFields(v3Entry, slug, null, defaultLocale);
      delete v5Data.localizations;
      v5Data.locale = defaultLocale;

      // Single types use PUT in v5
      const putResult = await v5.updateSingleType(slug, { data: v5Data }, defaultLocale);
      if (putResult.error) {
        throw new Error(`v5 PUT failed: ${putResult.error} (HTTP ${putResult.statusCode})`);
      }

      v5Id = putResult.data?.data?.id ?? putResult.data?.id ?? null;
      logger.update(`Single type "${slug}" updated in v5 (locale: ${defaultLocale})`, slug, null, defaultLocale);

      // Migrate other locales
      await migrateSingleTypeLocales(slug, v3Entry, v5Id, defaultLocale);

      stats.success = 1;
      stateManager.markDone(slug);
      break;

    } catch (err) {
      lastError = err.message;
      logger.error(`Attempt ${attempt} failed for single type "${slug}": ${err.message}`, slug);
      if (attempt < MAX_RETRIES_PER_ENTRY) {
        await sleep(5000 * attempt);
      }
    }
  }

  if (stats.success === 0) {
    stats.failed = 1;
    logger.error(`Single type "${slug}" permanently failed. Last error: ${lastError}`, slug);
  }

  logger.summary(slug, stats);
  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  checkEnv();

  // Parse CLI args
  const parsed = parseArgs(process.argv);

  if (parsed.showHelp) {
    printHelp();
    if (parsed.errors.length > 0) {
      console.error('\nErrors:\n  ' + parsed.errors.join('\n  '));
    }
    process.exit(parsed.valid ? 0 : 1);
  }

  if (!parsed.valid) {
    console.error('\nErrors:\n  ' + parsed.errors.join('\n  '));
    printHelp();
    process.exit(1);
  }

  // Expand --all flag with env vars
  const expanded = expandAllFlag(parsed);
  if (!expanded.valid) {
    console.error('\nErrors:\n  ' + expanded.errors.join('\n  '));
    process.exit(1);
  }

  // Log any non-fatal warnings (unknown flags, etc.)
  if (expanded.errors.length > 0) {
    expanded.errors.forEach(e => logger.warn(e));
  }

  logger.info(`Collections to migrate: ${expanded.collections.join(', ') || '(none)'}`);
  logger.info(`Single types to migrate: ${expanded.singleTypes.join(', ') || '(none)'}`);

  // ── Validate slugs against v3 API ──────────────────────────────────────────
  logger.info('Validating slugs against v3 API...');
  const validCollections = await validateCollections(expanded.collections);
  const validSingleTypes = await validateSingleTypes(expanded.singleTypes);

  if (validCollections.length === 0 && validSingleTypes.length === 0) {
    logger.error('No valid migration targets found after validation. Exiting.');
    process.exit(1);
  }

  logger.info(`Valid collections: ${validCollections.join(', ') || '(none)'}`);
  logger.info(`Valid single types: ${validSingleTypes.join(', ') || '(none)'}`);

  // ── Load state ─────────────────────────────────────────────────────────────
  stateManager.load();

  // ── Run migrations ─────────────────────────────────────────────────────────
  const grandResults = {};

  for (const slug of validCollections) {
    try {
      grandResults[slug] = await migrateCollection(slug);
    } catch (err) {
      // Top-level catch — this should never trigger due to internal fallbacks,
      // but this is the last line of defence to keep the process alive.
      logger.error(`Unhandled exception migrating collection "${slug}": ${err.message}`);
      logger.error(err.stack || '(no stack trace)');
      grandResults[slug] = { total: 0, success: 0, skipped: 0, failed: 1 };
    }
  }

  for (const slug of validSingleTypes) {
    try {
      grandResults[slug] = await migrateSingleType(slug);
    } catch (err) {
      logger.error(`Unhandled exception migrating single type "${slug}": ${err.message}`);
      logger.error(err.stack || '(no stack trace)');
      grandResults[slug] = { total: 1, success: 0, skipped: 0, failed: 1 };
    }
  }

  // ── Grand summary ──────────────────────────────────────────────────────────
  logger.grandSummary(grandResults);

  // Flush final state
  stateManager.flush();

  logger.info('Migration complete.');
  process.exit(0);
}

// ── Uncaught exception handlers — last resort to prevent silent crashes ───────
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  // Don't call process.exit here — let the main loop handle it gracefully
});

process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] Unhandled promise rejection: ${reason}`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(`[FATAL] main() threw: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
