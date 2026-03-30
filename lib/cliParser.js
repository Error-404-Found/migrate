'use strict';

/**
 * cliParser.js
 * Parses process.argv for --collection and --single flags.
 * Uses ONLY Node built-ins — no external libraries.
 */

const HELP_TEXT = `
╔══════════════════════════════════════════════════════════════════════╗
║           Strapi v3 → v5 Migration Middleware                        ║
╚══════════════════════════════════════════════════════════════════════╝

USAGE:
  node index.js [options]

OPTIONS:
  --collection <slug>   Migrate a collection type (repeatable)
  --single <slug>       Migrate a single type (repeatable)
  --help                Show this help message

EXAMPLES:
  node index.js --collection articles
  node index.js --collection articles --collection authors
  node index.js --single homepage
  node index.js --single homepage --single global
  node index.js --collection articles --single homepage
  node index.js --collection articles --collection authors --single homepage --single global

NOTES:
  - You must have a valid .env file configured before running.
  - Each slug is validated against the v3 API before migration starts.
  - Invalid or unreachable slugs are skipped without aborting the run.
  - Run the same command again to resume from where it left off.
`;

/**
 * Parse process.argv and return a structured result object.
 *
 * @returns {{
 *   collections: string[],
 *   singleTypes: string[],
 *   showHelp: boolean,
 *   valid: boolean,
 *   errors: string[]
 * }}
 */
function parseArgs(argv) {
  const args = argv.slice(2); // strip "node" and script path

  const result = {
    collections: [],
    singleTypes: [],
    showHelp: false,
    valid: true,
    errors: [],
  };

  if (args.length === 0) {
    result.valid = false;
    result.showHelp = true;
    result.errors.push('No arguments provided.');
    return result;
  }

  let i = 0;
  while (i < args.length) {
    const token = args[i];

    if (token === '--help' || token === '-h') {
      result.showHelp = true;
      result.valid = false;
      return result;
    }

    if (token === '--collection') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        result.errors.push(`--collection requires a slug value (got: "${value || 'nothing'}")`);
        result.valid = false;
      } else {
        const slug = value.trim().toLowerCase();
        if (!result.collections.includes(slug)) result.collections.push(slug);
        i += 2;
        continue;
      }
    }

    if (token === '--single') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        result.errors.push(`--single requires a slug value (got: "${value || 'nothing'}")`);
        result.valid = false;
      } else {
        const slug = value.trim().toLowerCase();
        if (!result.singleTypes.includes(slug)) result.singleTypes.push(slug);
        i += 2;
        continue;
      }
    }

    if (token.startsWith('--')) {
      result.errors.push(`Unknown flag: ${token} (ignored)`);
    }

    i++;
  }

  if (result.collections.length === 0 && result.singleTypes.length === 0) {
    result.valid = false;
    if (result.errors.length === 0) {
      result.errors.push('No migration targets specified. Use --collection or --single.');
      result.showHelp = true;
    }
  }

  return result;
}

function printHelp() {
  console.log(HELP_TEXT);
}

module.exports = { parseArgs, printHelp };
