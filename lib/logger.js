'use strict';

const fs = require('fs');
const path = require('path');

// Log file path — configurable via LOG_FILE env var, defaults to migration.log
const LOG_FILE = process.env.LOG_FILE
  ? path.resolve(process.env.LOG_FILE)
  : path.resolve(process.cwd(), 'migration.log');

// Ensure the log file directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Valid action labels
const ACTIONS = {
  FETCH: 'FETCH',
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  SKIP: 'SKIP',
  ERROR: 'ERROR',
  INFO: 'INFO',
  WARN: 'WARN',
  SUMMARY: 'SUMMARY',
};

/**
 * Format a log line with consistent structure.
 * Format: [timestamp] [contentType] [v3_id:X] [locale:Y] [ACTION] message
 */
function formatLine(contentType, v3Id, locale, action, message) {
  const ts = new Date().toISOString();
  const ct = contentType ? `[${contentType}]` : '[system]';
  const id = v3Id != null ? `[v3_id:${v3Id}]` : '[v3_id:-]';
  const lc = locale ? `[locale:${locale}]` : '[locale:-]';
  const ac = `[${action}]`;
  return `[${ts}] ${ct} ${id} ${lc} ${ac} ${message}`;
}

/**
 * Write a line to both console and log file.
 * Never throws — file write errors are silently ignored to keep the migration running.
 */
function writeLine(line, isError = false) {
  if (isError) {
    console.error(line);
  } else {
    console.log(line);
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    // If we can't write to the log file, just continue — don't kill the process
    console.error(`[logger] Failed to write to log file: ${e.message}`);
  }
}

/**
 * General purpose log helpers. Each accepts optional contextual parameters.
 */
const logger = {
  info(message, contentType = null, v3Id = null, locale = null) {
    writeLine(formatLine(contentType, v3Id, locale, ACTIONS.INFO, message));
  },
  warn(message, contentType = null, v3Id = null, locale = null) {
    writeLine(formatLine(contentType, v3Id, locale, ACTIONS.WARN, message));
  },
  error(message, contentType = null, v3Id = null, locale = null) {
    writeLine(formatLine(contentType, v3Id, locale, ACTIONS.ERROR, message), true);
  },
  fetch(message, contentType, v3Id = null, locale = null) {
    writeLine(formatLine(contentType, v3Id, locale, ACTIONS.FETCH, message));
  },
  create(message, contentType, v3Id, locale = null) {
    writeLine(formatLine(contentType, v3Id, locale, ACTIONS.CREATE, message));
  },
  update(message, contentType, v3Id, locale = null) {
    writeLine(formatLine(contentType, v3Id, locale, ACTIONS.UPDATE, message));
  },
  skip(message, contentType, v3Id, locale = null) {
    writeLine(formatLine(contentType, v3Id, locale, ACTIONS.SKIP, message));
  },

  /**
   * Print a per-content-type summary after migration of that type completes.
   */
  summary(contentType, { total, success, skipped, failed }) {
    const line = formatLine(
      contentType,
      null,
      null,
      ACTIONS.SUMMARY,
      `DONE — total:${total} success:${success} skipped:${skipped} failed:${failed}`
    );
    writeLine(line);
  },

  /**
   * Print a grand summary at the very end of the run.
   */
  grandSummary(results) {
    writeLine('\n' + '='.repeat(80));
    writeLine('GRAND MIGRATION SUMMARY');
    writeLine('='.repeat(80));
    let totalAll = 0, successAll = 0, skippedAll = 0, failedAll = 0;
    for (const [slug, stats] of Object.entries(results)) {
      writeLine(
        `  ${slug.padEnd(30)} total:${stats.total}  success:${stats.success}  skipped:${stats.skipped}  failed:${stats.failed}`
      );
      totalAll += stats.total || 0;
      successAll += stats.success || 0;
      skippedAll += stats.skipped || 0;
      failedAll += stats.failed || 0;
    }
    writeLine('-'.repeat(80));
    writeLine(
      `  ${'TOTAL'.padEnd(30)} total:${totalAll}  success:${successAll}  skipped:${skippedAll}  failed:${failedAll}`
    );
    writeLine('='.repeat(80) + '\n');
  },

  /** Log a blank separator line — useful between content type runs */
  separator() {
    writeLine('-'.repeat(80));
  },

  /** Return the resolved log file path for display in startup messages */
  getLogFilePath() {
    return LOG_FILE;
  },
};

module.exports = logger;
