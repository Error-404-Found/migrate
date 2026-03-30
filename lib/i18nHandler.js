'use strict';

/**
 * i18nHandler.js
 * Handles multilingual (i18n) migration — fetches all locale variants of a
 * v3 entry and creates/updates each in v5.
 *
 * FIX: createLocalization sends correct body: { data: { ...fields, locale } }
 * FIX: locale existence check uses v5 entry's documentId / locale correctly
 * FIX: uses v3.getEntry (with populate=deep) per locale instead of bare get
 */

const { v3, v5 } = require('./apiClient');
const { mapFields } = require('./fieldMapper');
const logger = require('./logger');

const FALLBACK_LOCALES = (process.env.SUPPORTED_LOCALES || 'en')
  .split(',').map(l => l.trim()).filter(Boolean);

// ── Locale extraction ─────────────────────────────────────────────────────────

/**
 * Extract all locale codes from a v3 entry.
 * v3 returns localizations as: [{ id: 10, locale: "fr" }, ...]
 */
function extractLocales(v3Entry) {
  const locales = new Set();

  if (v3Entry?.locale) locales.add(v3Entry.locale);

  const locs = v3Entry?.localizations;
  if (Array.isArray(locs)) {
    for (const l of locs) {
      if (l?.locale) locales.add(l.locale);
      if (typeof l === 'string') locales.add(l);
    }
  }

  if (locales.size === 0) FALLBACK_LOCALES.forEach(l => locales.add(l));

  return [...locales];
}

// ── Fetch v3 entry in a specific locale ───────────────────────────────────────

/**
 * Fetch a v3 collection entry in a specific locale (with populate=deep).
 */
async function fetchV3Locale(slug, v3Id, locale) {
  try {
    const result = await v3.getEntry(slug, v3Id, locale);
    if (result.error || !result.data) return null;
    // v3 may return 404 as an error or an empty object — guard both
    if (typeof result.data !== 'object') return null;
    return result.data;
  } catch (err) {
    logger.warn(`Failed to fetch ${slug}/${v3Id} locale=${locale}: ${err.message}`);
    return null;
  }
}

// ── Create locale variant in v5 ───────────────────────────────────────────────

/**
 * Create a locale variant of an existing v5 entry.
 *
 * v5 i18n endpoint: POST /api/:slug/:id/localizations
 * FIX: Body must be { data: { ...fields, locale } }
 *      NOT { ...fields, locale } (unwrapped)
 *
 * If the localization already exists, fall back to PUT to update it.
 *
 * @param {string} slug        - collection slug
 * @param {number} v5DefaultId - the v5 ID of the default-locale entry
 * @param {string} locale      - locale to create (e.g. "fr")
 * @param {object} v5Data      - mapped field data (no locale field yet)
 * @returns {{ success: boolean, v5Id: number|null, error?: string }}
 */
async function createLocaleVariant(slug, v5DefaultId, locale, v5Data) {

  // FIX: Correct body format for v5 localizations endpoint
  const body = { data: { ...v5Data, locale } };

  const result = await v5.createLocalization(slug, v5DefaultId, body);

  if (!result.error) {
    // v5 localization endpoint returns the new locale entry directly
    const createdId = result.data?.id ?? result.data?.data?.id ?? v5DefaultId;
    return { success: true, v5Id: createdId };
  }

  // If 400/409 — localization may already exist; try PUT to update
  if (result.statusCode === 400 || result.statusCode === 409 || result.statusCode === 422) {
    logger.warn(`Locale "${locale}" may already exist in v5 for ${slug}/${v5DefaultId}. Trying PUT update.`);
    const updateResult = await v5.update(slug, v5DefaultId, { data: { ...v5Data, locale } });
    if (!updateResult.error) {
      const updatedId = updateResult.data?.data?.id ?? updateResult.data?.id ?? v5DefaultId;
      return { success: true, v5Id: updatedId };
    }
    return { success: false, v5Id: null, error: updateResult.error };
  }

  return { success: false, v5Id: null, error: result.error };
}

// ── Migrate all locale variants for a collection entry ───────────────────────

/**
 * After the default-locale entry is created in v5, migrate all other locales.
 *
 * @param {object} v3Entry      - original v3 entry (default locale, with localizations)
 * @param {string} slug         - collection slug
 * @param {number} v5DefaultId  - v5 ID of the default locale entry
 * @param {string} defaultLocale
 * @returns {Array<{ locale, success, v5Id }>}
 */
async function migrateLocales(v3Entry, slug, v5DefaultId, defaultLocale) {
  const allLocales = extractLocales(v3Entry);
  const results = [];

  for (const locale of allLocales) {
    if (locale === defaultLocale) continue;

    try {
      logger.info(`Migrating locale "${locale}" for ${slug} v3_id=${v3Entry.id}`, slug, v3Entry.id, locale);

      // Fetch full locale entry from v3 (with populate=deep)
      const localeEntry = await fetchV3Locale(slug, v3Entry.id, locale);
      if (!localeEntry) {
        logger.warn(`No v3 data for ${slug}/${v3Entry.id} locale=${locale}. Skipping.`, slug, v3Entry.id, locale);
        results.push({ locale, success: false, v5Id: null });
        continue;
      }

      // Map fields
      const v5Data = await mapFields(localeEntry, slug, v3Entry.id, locale);
      // Strip fields managed by v5 internally
      delete v5Data.localizations;
      delete v5Data.locale;
      delete v5Data.publishedAt; // let the publish step handle this

      // Create locale variant in v5
      const { success, v5Id, error } = await createLocaleVariant(slug, v5DefaultId, locale, v5Data);

      if (success) {
        logger.create(
          `Locale "${locale}" created/updated in v5 (id:${v5Id ?? v5DefaultId})`,
          slug, v3Entry.id, locale
        );
        results.push({ locale, success: true, v5Id: v5Id ?? v5DefaultId });
      } else {
        logger.error(`Failed to migrate locale "${locale}": ${error}`, slug, v3Entry.id, locale);
        results.push({ locale, success: false, v5Id: null });
      }

    } catch (err) {
      logger.error(
        `Exception migrating locale "${locale}" for ${slug}/${v3Entry.id}: ${err.message}`,
        slug, v3Entry.id, locale
      );
      results.push({ locale, success: false, v5Id: null });
    }
  }

  return results;
}

// ── Migrate all locale variants for a single type ─────────────────────────────

/**
 * Migrate all locales for a single type.
 * Single types use PUT /api/:slug?locale=xx
 */
async function migrateSingleTypeLocales(slug, v3Entry, defaultLocale) {
  const allLocales = extractLocales(v3Entry);
  const results = [];

  for (const locale of allLocales) {
    if (locale === defaultLocale) continue;

    try {
      logger.info(`Migrating single type "${slug}" locale "${locale}"`, slug, null, locale);

      const localeResult = await v3.getSingleType(slug, locale);
      if (localeResult.error || !localeResult.data) {
        logger.warn(`No v3 data for single type ${slug} locale=${locale}. Skipping.`, slug, null, locale);
        continue;
      }

      const v5Data = await mapFields(localeResult.data, slug, null, locale);
      delete v5Data.localizations;
      delete v5Data.locale;

      // FIX: Correct body format for single type locale update
      const putResult = await v5.updateSingleType(slug, { data: { ...v5Data, locale } }, locale);
      if (putResult.error) {
        logger.error(`Failed to update single type ${slug} locale=${locale}: ${putResult.error}`, slug, null, locale);
        results.push({ locale, success: false });
      } else {
        logger.update(`Single type "${slug}" locale "${locale}" updated in v5.`, slug, null, locale);
        results.push({ locale, success: true });
      }

    } catch (err) {
      logger.error(`Exception on single type ${slug} locale=${locale}: ${err.message}`, slug, null, locale);
      results.push({ locale, success: false });
    }
  }

  return results;
}

module.exports = { migrateLocales, migrateSingleTypeLocales, extractLocales };
