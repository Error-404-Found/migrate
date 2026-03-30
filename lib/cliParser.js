'use strict';

const HELP = `
╔══════════════════════════════════════════════════════════════════╗
║        Strapi v3.6.8 → v5  Migration Middleware                  ║
╚══════════════════════════════════════════════════════════════════╝

USAGE:
  node index.js --collection <slug> [--collection <slug> ...]
  node index.js --single <slug>     [--single <slug> ...]
  node index.js --collection articles --single homepage

OPTIONS:
  --collection <slug>   Migrate a collection type
  --single <slug>       Migrate a single type
  --help                Show this message

NOTES:
  • Both --collection and --single are repeatable.
  • Slugs are validated against v3 before migration starts.
  • Re-run the same command to resume from the last checkpoint.
`;

function parseArgs(argv) {
  const args   = argv.slice(2);
  const result = { collections: [], singleTypes: [], showHelp: false, valid: true, errors: [] };

  if (!args.length) {
    result.valid = false; result.showHelp = true;
    result.errors.push('No arguments provided.');
    return result;
  }

  let i = 0;
  while (i < args.length) {
    const t = args[i];

    if (t === '--help' || t === '-h') { result.showHelp = true; result.valid = false; return result; }

    if (t === '--collection' || t === '--single') {
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        result.errors.push(`${t} requires a slug value.`);
        result.valid = false;
        i++; continue;
      }
      const slug = val.trim().toLowerCase();
      const list = t === '--collection' ? result.collections : result.singleTypes;
      if (!list.includes(slug)) list.push(slug);
      i += 2; continue;
    }

    if (t.startsWith('--')) result.errors.push(`Unknown flag: ${t} (ignored)`);
    i++;
  }

  if (!result.collections.length && !result.singleTypes.length) {
    result.valid = false;
    if (!result.errors.length) { result.errors.push('No migration targets specified.'); result.showHelp = true; }
  }

  return result;
}

function printHelp() { console.log(HELP); }

module.exports = { parseArgs, printHelp };
