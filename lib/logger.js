'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_FILE = process.env.LOG_FILE
  ? path.resolve(process.env.LOG_FILE)
  : path.resolve(process.cwd(), 'migration.log');

// Ensure log directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function ts() { return new Date().toISOString(); }

function fmt(ct, id, locale, action, msg) {
  const c = ct     ? `[${ct}]`          : '[system]';
  const i = id     ? `[v3:${id}]`       : '[v3:-]';
  const l = locale ? `[${locale}]`      : '[-]';
  return `[${ts()}] ${c} ${i} ${l} [${action}] ${msg}`;
}

function write(line, isErr = false) {
  (isErr ? console.error : console.log)(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}

const logger = {
  info  (msg, ct, id, locale) { write(fmt(ct, id, locale, 'INFO',    msg)); },
  warn  (msg, ct, id, locale) { write(fmt(ct, id, locale, 'WARN',    msg)); },
  error (msg, ct, id, locale) { write(fmt(ct, id, locale, 'ERROR',   msg), true); },
  fetch (msg, ct, id, locale) { write(fmt(ct, id, locale, 'FETCH',   msg)); },
  create(msg, ct, id, locale) { write(fmt(ct, id, locale, 'CREATE',  msg)); },
  update(msg, ct, id, locale) { write(fmt(ct, id, locale, 'UPDATE',  msg)); },
  skip  (msg, ct, id, locale) { write(fmt(ct, id, locale, 'SKIP',    msg)); },

  summary(ct, { total, success, skipped, failed }) {
    write(fmt(ct, null, null, 'SUMMARY',
      `total:${total} success:${success} skipped:${skipped} failed:${failed}`));
  },

  grandSummary(results) {
    write('\n' + '='.repeat(72));
    write('GRAND MIGRATION SUMMARY');
    write('='.repeat(72));
    let T = 0, S = 0, K = 0, F = 0;
    for (const [slug, s] of Object.entries(results)) {
      write(`  ${slug.padEnd(32)} total:${s.total}  ok:${s.success}  skip:${s.skipped}  fail:${s.failed}`);
      T += s.total || 0; S += s.success || 0; K += s.skipped || 0; F += s.failed || 0;
    }
    write('-'.repeat(72));
    write(`  ${'TOTAL'.padEnd(32)} total:${T}  ok:${S}  skip:${K}  fail:${F}`);
    write('='.repeat(72) + '\n');
  },

  separator() { write('-'.repeat(72)); },
  getLogFilePath() { return LOG_FILE; },
};

module.exports = logger;
