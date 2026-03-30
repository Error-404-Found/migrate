'use strict';

/**
 * slugValidator.js
 * Pings the v3 API to confirm each slug is valid and accessible
 * before any migration begins. Invalid slugs are skipped with a warning.
 */

const { v3 } = require('./apiClient');
const logger = require('./logger');

/**
 * Validate a list of collection slugs against the v3 API.
 *
 * @param {string[]} slugs - e.g. ['articles', 'authors']
 * @returns {Promise<string[]>} - only the valid, accessible slugs
 */
async function validateCollections(slugs) {
  const valid = [];
  for (const slug of slugs) {
    logger.info(`Validating collection slug: ${slug}`);
    try {
      const result = await v3.ping(slug);
      if (result.error) {
        logger.warn(
          `Collection "${slug}" is invalid or unreachable (${result.statusCode}: ${result.error}). Skipping.`
        );
        continue;
      }
      // v3 returns an array for collections; check it's not an object (which would be a single type)
      if (!Array.isArray(result.data) && typeof result.data !== 'object') {
        logger.warn(`Collection "${slug}" returned unexpected data type. Skipping.`);
        continue;
      }
      logger.info(`Collection "${slug}" ✓ valid`);
      valid.push(slug);
    } catch (err) {
      logger.warn(`Exception validating collection "${slug}": ${err.message}. Skipping.`);
    }
  }
  return valid;
}

/**
 * Validate a list of single type slugs against the v3 API.
 *
 * @param {string[]} slugs - e.g. ['homepage', 'global']
 * @returns {Promise<string[]>} - only the valid, accessible slugs
 */
async function validateSingleTypes(slugs) {
  const valid = [];
  for (const slug of slugs) {
    logger.info(`Validating single type slug: ${slug}`);
    try {
      const result = await v3.getSingleType(slug);
      if (result.error) {
        logger.warn(
          `Single type "${slug}" is invalid or unreachable (${result.statusCode}: ${result.error}). Skipping.`
        );
        continue;
      }
      // Single types return an object (not an array)
      if (typeof result.data !== 'object' || result.data === null) {
        logger.warn(`Single type "${slug}" returned unexpected data. Skipping.`);
        continue;
      }
      logger.info(`Single type "${slug}" ✓ valid`);
      valid.push(slug);
    } catch (err) {
      logger.warn(`Exception validating single type "${slug}": ${err.message}. Skipping.`);
    }
  }
  return valid;
}

module.exports = { validateCollections, validateSingleTypes };
