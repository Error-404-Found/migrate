'use strict';

/**
 * cliParser.js
 * Parses process.argv for --collection, --single, and --all flags.
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
  --all                 Migrate all slugs defined in ALL_COLLECTIONS
                        and ALL_SINGLE_TYPES in your .env file
  --help                Show this help message

EXAMPLES:
  node index.js --collection articles
  node index.js --collection articles --collection authors
  node index.js --single homepage
  node index.js --single homepage --single global
  node index.js --collection articles --single homepage
  node index.js --all

NOTES:
  - You must have a valid .env file configured before running.
  - --all requires ALL_COLLECTIONS and ALL_SINGLE_TYPES set in .env
  - Each slug is validated against the v3 API before migration starts.
  - Invalid or unreachable slugs are skipped without aborting the run.
`;

/**
 * Parse process.argv and return a structured object.
 *
 * @returns {{
 *   collections: string[],
 *   singleTypes: string[],
 *   all: boolean,
 *   showHelp: boolean,
 *   valid: boolean,
 *   errors: string[]
 * }}
 */
function parseArgs(argv) {
  // argv = process.argv; argv[0] = node, argv[1] = script path, rest = args
  const args = argv.slice(2);

  const result = {
    collections: [],
    singleTypes: [],
    all: false,
    showHelp: false,
    valid: true,
    errors: [],
  };

  // Edge case: no arguments provided at all
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
      result.valid = false; // treat help as exit-early
      return result;
    }

    if (token === '--all') {
      result.all = true;
      i++;
      continue;
    }

    if (token === '--collection') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        result.errors.push(`--collection flag requires a slug value (got: "${value || 'nothing'}")`);
        result.valid = false;
      } else {
        const slug = value.trim().toLowerCase();
        if (!result.collections.includes(slug)) {
          result.collections.push(slug);
        }
        i += 2;
        continue;
      }
    }

    if (token === '--single') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        result.errors.push(`--single flag requires a slug value (got: "${value || 'nothing'}")`);
        result.valid = false;
      } else {
        const slug = value.trim().toLowerCase();
        if (!result.singleTypes.includes(slug)) {
          result.singleTypes.push(slug);
        }
        i += 2;
        continue;
      }
    }

    // Unknown flag — warn but don't crash
    if (token.startsWith('--')) {
      result.errors.push(`Unknown flag: ${token} (ignored)`);
    }

    i++;
  }

  // If --all is set and also specific slugs are given, merge them
  // --all will be expanded in index.js using env vars

  // Must have at least one valid migration target (after expansion of --all)
  if (!result.all && result.collections.length === 0 && result.singleTypes.length === 0) {
    result.valid = false;
    if (result.errors.length === 0) {
      result.errors.push('No migration targets specified. Use --collection, --single, or --all.');
      result.showHelp = true;
    }
  }

  return result;
}

/**
 * Expand --all flag using env variables ALL_COLLECTIONS and ALL_SINGLE_TYPES.
 * Returns updated collections and singleTypes arrays.
 */
function expandAllFlag(parsedArgs) {
  if (!parsedArgs.all) return parsedArgs;

  const envCollections = process.env.ALL_COLLECTIONS
    ? process.env.ALL_COLLECTIONS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const envSingleTypes = process.env.ALL_SINGLE_TYPES
    ? process.env.ALL_SINGLE_TYPES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  if (envCollections.length === 0 && envSingleTypes.length === 0) {
    parsedArgs.errors.push(
      '--all flag was used but ALL_COLLECTIONS and ALL_SINGLE_TYPES are not set in .env'
    );
    parsedArgs.valid = false;
    return parsedArgs;
  }

  // Merge env slugs with any explicitly provided slugs (deduped)
  for (const slug of envCollections) {
    if (!parsedArgs.collections.includes(slug)) {
      parsedArgs.collections.push(slug);
    }
  }
  for (const slug of envSingleTypes) {
    if (!parsedArgs.singleTypes.includes(slug)) {
      parsedArgs.singleTypes.push(slug);
    }
  }

  return parsedArgs;
}

function printHelp() {
  console.log(HELP_TEXT);
}

module.exports = { parseArgs, expandAllFlag, printHelp };
