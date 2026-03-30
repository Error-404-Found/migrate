'use strict';

const { v3 }  = require('./apiClient');
const logger  = require('./logger');

async function validateCollections(slugs) {
  const valid = [];
  for (const slug of slugs) {
    logger.info(`Validating collection: "${slug}"`);
    const r = await v3.ping(slug);
    if (r.error) { logger.warn(`"${slug}" unreachable (${r.status}: ${r.error}). Skipping.`); continue; }
    logger.info(`"${slug}" ✓`);
    valid.push(slug);
  }
  return valid;
}

async function validateSingleTypes(slugs) {
  const valid = [];
  for (const slug of slugs) {
    logger.info(`Validating single type: "${slug}"`);
    const r = await v3.getSingleType(slug);
    if (r.error) { logger.warn(`"${slug}" unreachable (${r.status}: ${r.error}). Skipping.`); continue; }
    logger.info(`"${slug}" ✓`);
    valid.push(slug);
  }
  return valid;
}

module.exports = { validateCollections, validateSingleTypes };
