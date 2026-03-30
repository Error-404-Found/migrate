'use strict';

/**
 * i18nHandler.js
 * Handles multilingual migration.
 *
 * For each entry: fetches all locale variants from v3, maps their fields,
 * then creates them in v5 via POST /api/:slug/:id/localizations.
 *
 * v5 localization endpoint body: { data: { ...fields, locale } }
 */

const { v3, v5 } = require('./apiClient');
const { mapFields } = require('./fieldMapper');
const logger = require('./logger');

function getLocales(entry) {
  const locales = new Set();
  if (entry?.locale) locales.add(entry.locale);
  (entry?.localizations || []).forEach(l => {
    if (l?.locale) locales.add(l.locale);
    if (typeof l === 'string') locales.add(l);
  });
  if (!locales.size) {
    (process.env.SUPPORTED_LOCALES || 'en').split(',').map(s => s.trim()).filter(Boolean).forEach(l => locales.add(l));
  }
  return [...locales];
}

async function fetchLocaleEntry(slug, v3Id, locale) {
  try {
    const r = await v3.getEntry(slug, v3Id, locale);
    if (r.error || !r.data || typeof r.data !== 'object') return null;
    return r.data;
  } catch (e) {
    logger.warn(`Could not fetch ${slug}/${v3Id} locale=${locale}: ${e.message}`);
    return null;
  }
}

async function createLocaleVariant(slug, v5Id, locale, v5Data) {
  // v5 localizations endpoint: POST /api/:slug/:id/localizations
  const body = { data: { ...v5Data, locale } };
  const r = await v5.createLocalization(slug, v5Id, body);

  if (!r.error) {
    return { ok: true, id: r.data?.id ?? r.data?.data?.id ?? v5Id };
  }

  // 400/409/422 may mean it already exists — try PUT update instead
  if ([400, 409, 422].includes(r.status)) {
    const upd = await v5.update(slug, v5Id, { data: { ...v5Data, locale } });
    if (!upd.error) return { ok: true, id: upd.data?.data?.id ?? v5Id };
    return { ok: false, error: upd.error };
  }

  return { ok: false, error: r.error };
}

async function migrateLocales(v3Entry, slug, v5DefaultId, defaultLocale) {
  const results = [];
  for (const locale of getLocales(v3Entry)) {
    if (locale === defaultLocale) continue;
    try {
      logger.info(`Migrating locale "${locale}"`, slug, v3Entry.id, locale);
      const locEntry = await fetchLocaleEntry(slug, v3Entry.id, locale);
      if (!locEntry) { results.push({ locale, ok: false }); continue; }

      const data = await mapFields(locEntry, slug, v3Entry.id, locale);
      delete data.localizations;
      delete data.locale;
      delete data.publishedAt;

      const { ok, id, error } = await createLocaleVariant(slug, v5DefaultId, locale, data);
      if (ok) logger.create(`Locale "${locale}" → v5 id:${id}`, slug, v3Entry.id, locale);
      else    logger.error(`Locale "${locale}" failed: ${error}`, slug, v3Entry.id, locale);
      results.push({ locale, ok, id });
    } catch (e) {
      logger.error(`Locale "${locale}" exception: ${e.message}`, slug, v3Entry.id, locale);
      results.push({ locale, ok: false });
    }
  }
  return results;
}

async function migrateSingleTypeLocales(slug, v3Entry, defaultLocale) {
  for (const locale of getLocales(v3Entry)) {
    if (locale === defaultLocale) continue;
    try {
      const r = await v3.getSingleType(slug, locale);
      if (r.error || !r.data) continue;
      const data = await mapFields(r.data, slug, null, locale);
      delete data.localizations; delete data.locale; delete data.publishedAt;
      const upd = await v5.updateSingleType(slug, { data: { ...data, locale } }, locale);
      if (upd.error) logger.error(`Single type "${slug}" locale "${locale}" failed: ${upd.error}`, slug, null, locale);
      else           logger.update(`Single type "${slug}" locale "${locale}" updated`, slug, null, locale);
    } catch (e) {
      logger.error(`Single type locale exception: ${e.message}`, slug, null, locale);
    }
  }
}

module.exports = { migrateLocales, migrateSingleTypeLocales, getLocales };
