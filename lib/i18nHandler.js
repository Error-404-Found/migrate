'use strict';

/**
 * i18nHandler.js
 * Handles fetching all locale variants of a v3 entry and migrating each to v5.
 *
 * In Strapi v3 with i18n plugin:
 * - Entries have a `locale` field (e.g. "en") and a `localizations` array
 *   containing the other locale variants with their IDs.
 * - To get a specific locale, use ?_locale=fr when fetching.
 *
 * In Strapi v5:
 * - Create the default locale entry first (POST /api/articles)
 * - For other locales, use POST /api/articles/:id/localizations
 *   with the locale in the body: { locale: "fr", ...fields }
 */

const { v3, v5 } = require('./apiClient');
const { mapFields } = require('./fieldMapper');
const stateManager = require('./stateManager');
const logger = require('./logger');

// Locales to always attempt if v3 doesn't report them explicitly
const FALLBACK_LOCALES = (process.env.SUPPORTED_LOCALES || 'en')
  .split(',')
  .map(l => l.trim())
  .filter(Boolean);

/**
 * Get all locale codes for a v3 entry.
 *
 * v3 returns localizations as:
 * [{ id: 10, locale: "fr" }, { id: 11, locale: "de" }]
 *
 * We combine the entry's own locale with its localizations locales.
 *
 * @param {object} v3Entry - the fetched v3 entry object
 * @returns {string[]} - e.g. ["en", "fr", "de"]
 */
function extractLocales(v3Entry) {
  const locales = new Set();

  // The entry's own locale
  if (v3Entry?.locale) {
    locales.add(v3Entry.locale);
  }

  // Other locales from the localizations relation
  const localizations = v3Entry?.localizations;
  if (Array.isArray(localizations)) {
    for (const loc of localizations) {
      if (loc?.locale) locales.add(loc.locale);
      // Some v3 responses embed locale as a string in the localizations array
      if (typeof loc === 'string') locales.add(loc);
    }
  }

  // If no locale info was found, fall back to env-configured locales
  if (locales.size === 0) {
    FALLBACK_LOCALES.forEach(l => locales.add(l));
  }

  return Array.from(locales);
}

/**
 * Fetch a v3 entry in a specific locale.
 * Returns null if not available.
 *
 * @param {string} slug - collection slug
 * @param {number} v3Id - the entry ID
 * @param {string} locale - e.g. "fr"
 * @returns {object|null} - v3 entry for that locale
 */
async function fetchV3EntryLocale(slug, v3Id, locale) {
  try {
    const result = await v3.get(`/${slug}/${v3Id}`, { _locale: locale });
    if (result.error || !result.data) return null;
    return result.data;
  } catch (err) {
    logger.warn(`Failed to fetch ${slug}/${v3Id} in locale ${locale}: ${err.message}`);
    return null;
  }
}

/**
 * Create or update a v5 localization variant for an entry.
 *
 * For the default locale: POST /api/:slug (handled in main migrator)
 * For other locales: PUT /api/:slug/:id with ?locale=xx
 *   OR POST /api/:slug/:id/localizations (v5 i18n specific endpoint)
 *
 * We use the PUT + locale query param approach which is simpler and supported.
 *
 * @param {string} slug - collection slug
 * @param {number} v5DefaultId - the v5 ID of the default locale entry
 * @param {string} locale - the locale to create/update
 * @param {object} v5Data - the mapped field data for this locale
 * @returns {{ success: boolean, v5Id: number|null }}
 */
async function createOrUpdateLocaleVariant(slug, v5DefaultId, locale, v5Data) {
  // First check if the localization already exists in v5
  try {
    const existing = await v5.getCollection(slug, 1, 1, locale);
    // If we can find this entry by v5DefaultId, it's already there
    if (!existing.error && Array.isArray(existing.data?.data)) {
      const found = existing.data.data.find(e => e.id === v5DefaultId);
      if (found) {
        // Update it
        const updateResult = await v5.update(slug, v5DefaultId, {
          data: { ...v5Data, locale },
        });
        if (updateResult.error) {
          return { success: false, v5Id: null, error: updateResult.error };
        }
        return { success: true, v5Id: v5DefaultId };
      }
    }
  } catch {
    // Non-fatal — proceed to create
  }

  // Use the v5 localizations endpoint
  try {
    const result = await v5.create(`${slug}/${v5DefaultId}/localizations`, {
      ...v5Data,
      locale,
    });

    if (result.error) {
      // Fallback: try PUT with locale param
      const fallback = await v5.update(slug, v5DefaultId, {
        data: { ...v5Data, locale },
      });
      if (fallback.error) {
        return { success: false, v5Id: null, error: fallback.error };
      }
      const fbId = fallback.data?.data?.id ?? fallback.data?.id ?? null;
      return { success: true, v5Id: fbId };
    }

    const createdId = result.data?.id ?? result.data?.data?.id ?? null;
    return { success: true, v5Id: createdId };
  } catch (err) {
    return { success: false, v5Id: null, error: err.message };
  }
}

/**
 * Migrate all locale variants of a v3 entry.
 *
 * Called from the main migrator after the default locale entry has been created in v5.
 *
 * @param {object} v3Entry - original v3 entry (default locale)
 * @param {string} slug - collection slug
 * @param {number} v5DefaultId - the v5 ID created for the default locale
 * @param {string} defaultLocale - the locale of the original entry (e.g. "en")
 * @returns {{ locale: string, success: boolean, v5Id: number|null }[]}
 */
async function migrateLocales(v3Entry, slug, v5DefaultId, defaultLocale) {
  const allLocales = extractLocales(v3Entry);
  const results = [];

  for (const locale of allLocales) {
    // Skip the default locale — it's already migrated
    if (locale === defaultLocale) continue;

    try {
      logger.info(`Fetching ${slug} v3_id=${v3Entry.id} in locale: ${locale}`, slug, v3Entry.id, locale);

      // Fetch the v3 entry in this locale
      const localeEntry = await fetchV3EntryLocale(slug, v3Entry.id, locale);
      if (!localeEntry) {
        logger.warn(`No v3 data for ${slug}/${v3Entry.id} in locale ${locale}. Skipping.`, slug, v3Entry.id, locale);
        results.push({ locale, success: false, v5Id: null });
        continue;
      }

      // Map fields for this locale
      const v5Data = await mapFields(localeEntry, slug, v3Entry.id, locale);

      // Remove localizations array from the payload — v5 manages this internally
      delete v5Data.localizations;
      delete v5Data.locale; // will be set explicitly

      // Create or update in v5
      const { success, v5Id, error } = await createOrUpdateLocaleVariant(
        slug,
        v5DefaultId,
        locale,
        v5Data
      );

      if (success) {
        logger.create(
          `Locale variant ${locale} migrated to v5 (id: ${v5Id ?? v5DefaultId})`,
          slug,
          v3Entry.id,
          locale
        );
        results.push({ locale, success: true, v5Id: v5Id ?? v5DefaultId });
      } else {
        logger.error(
          `Failed to migrate locale ${locale}: ${error}`,
          slug,
          v3Entry.id,
          locale
        );
        results.push({ locale, success: false, v5Id: null });
      }
    } catch (err) {
      logger.error(
        `Exception migrating locale ${locale} for ${slug}/${v3Entry.id}: ${err.message}`,
        slug,
        v3Entry.id,
        locale
      );
      results.push({ locale, success: false, v5Id: null });
    }
  }

  return results;
}

/**
 * Migrate all locale variants of a v3 single type.
 *
 * @param {string} slug - single type slug
 * @param {number} v5Id - the v5 ID of the single type
 */
async function migrateSingleTypeLocales(slug, v3Entry, v5Id, defaultLocale) {
  const allLocales = extractLocales(v3Entry);
  const results = [];

  for (const locale of allLocales) {
    if (locale === defaultLocale) continue;

    try {
      const localeResult = await v3.getSingleType(slug, locale);
      if (localeResult.error || !localeResult.data) {
        logger.warn(`No v3 data for single type ${slug} in locale ${locale}. Skipping.`, slug, null, locale);
        continue;
      }

      const v5Data = await mapFields(localeResult.data, slug, null, locale);
      delete v5Data.localizations;
      delete v5Data.locale;

      const updateResult = await v5.updateSingleType(slug, { data: v5Data }, locale);
      if (updateResult.error) {
        logger.error(`Failed to update single type ${slug} locale ${locale}: ${updateResult.error}`, slug, null, locale);
        results.push({ locale, success: false });
      } else {
        logger.update(`Single type ${slug} locale ${locale} updated in v5.`, slug, null, locale);
        results.push({ locale, success: true });
      }
    } catch (err) {
      logger.error(`Exception migrating single type ${slug} locale ${locale}: ${err.message}`, slug, null, locale);
      results.push({ locale, success: false });
    }
  }

  return results;
}

module.exports = { migrateLocales, migrateSingleTypeLocales, extractLocales, FALLBACK_LOCALES };
