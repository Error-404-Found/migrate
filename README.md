# Strapi v3.6.8 → v5 Migration Middleware

A standalone Node.js background process for migrating content from **Strapi v3.6.8** to **Strapi v5** — including media (S3), relations, dynamic zones, components, and multilingual (i18n) content.

Neither Strapi instance is stopped or modified during the migration.

---

## Features

- ✅ Migrates collections and single types
- ✅ Handles all field types: text, numbers, booleans, dates, richtext, JSON
- ✅ Re-uploads media from S3 → v5 media library (with deduplication)
- ✅ Resolves and remaps relations between entries
- ✅ Handles dynamic zones and nested components (recursive)
- ✅ Full multilingual support via `strapi-plugin-i18n` — all locales migrated
- ✅ 100-entry batches with 30-second delay between every API call
- ✅ Resumes from last checkpoint on restart (no duplicate entries)
- ✅ Per-entry retry logic (3 attempts before permanent skip)
- ✅ Exponential backoff on HTTP 429 rate limit responses
- ✅ Detailed structured logging to console + `migration.log`
- ✅ Per-collection and grand summary at the end of each run

---

## Requirements

- Node.js 18+
- Access to both Strapi v3 and v5 instances (both must be running)
- Full-access API tokens for both instances
- AWS credentials (if S3 media needs to be migrated)

---

## Setup

```bash
# 1. Clone or copy the migration/ directory to your server

# 2. Install dependencies
cd migration
npm install

# 3. Create your .env file
cp .env.example .env
# Then edit .env with your actual values

# 4. Run a test migration on a small collection first
node index.js --collection articles
```

---

## CLI Usage

```bash
# Migrate a single collection
node index.js --collection articles

# Migrate multiple collections in one run
node index.js --collection articles --collection authors --collection categories

# Migrate a single type
node index.js --single homepage

# Migrate multiple single types
node index.js --single homepage --single global

# Mix collections and single types
node index.js --collection articles --collection authors --single homepage

# Migrate everything defined in ALL_COLLECTIONS and ALL_SINGLE_TYPES in .env
node index.js --all

# Show help
node index.js --help
```

---

## Required Environment Variables

| Variable | Description |
|---|---|
| `STRAPI_V3_URL` | Base URL of Strapi v3, e.g. `http://localhost:1337` |
| `STRAPI_V5_URL` | Base URL of Strapi v5, e.g. `http://localhost:1338` |
| `STRAPI_V3_TOKEN` | Full-access API token for v3 |
| `STRAPI_V5_TOKEN` | Full-access API token for v5 |

See `.env.example` for the full list including optional configuration.

---

## Key Optional Variables

### Relation Field Mapping
The middleware uses heuristics to detect relation fields, but for reliable remapping you should explicitly define which fields point to which collection:

```env
RELATION_SLUG_MAP={"articles":{"author":"authors","tags":"tags","category":"categories"}}
```

### Dynamic Zone Fields
```env
DYNAMIC_ZONE_FIELDS={"articles":["content","sections"],"pages":["blocks"]}
```

### Multilingual Locales
```env
SUPPORTED_LOCALES=en,fr,de,es
```
The **first** locale in this list is treated as the default locale.

### Batch Size & Delay
```env
BATCH_SIZE=100
DELAY_MS=30000
```

---

## File Structure

```
migration/
├── index.js                   # Entry point — CLI → validate → migrate → summarise
├── .env.example               # All env vars documented
├── migration.log              # Created on first run
├── migration-state.json       # Created on first run, tracks progress
├── lib/
│   ├── cliParser.js           # Parses --collection, --single, --all flags
│   ├── slugValidator.js       # Pings v3 API to confirm each slug exists
│   ├── apiClient.js           # Axios wrappers for v3 + v5, retry, backoff, delay
│   ├── mediaHandler.js        # S3 download → v5 upload + dedup cache
│   ├── fieldMapper.js         # v3 → v5 field mapping (auto-detects types)
│   ├── relationResolver.js    # Resolves v3 IDs to v5 IDs via unique fields
│   ├── dynamicZoneHandler.js  # Processes dynamic zones + nested components
│   ├── i18nHandler.js         # Fetches + migrates all locales per entry
│   ├── stateManager.js        # Reads/writes migration-state.json
│   └── logger.js              # Structured logger → console + file
└── README.md
```

---

## How Migration State Works

On first run, a `migration-state.json` file is created. It tracks:
- Which collections/single types are fully done (`status: "done"`)
- The last successfully processed page per content type
- The ID mapping: v3 entry ID → v5 entry ID
- Permanently failed entry IDs (failed 3 times)

**If the process is interrupted**, simply re-run the same command. It will resume from where it left off without duplicating already-migrated entries.

To force a full re-migration, delete `migration-state.json`.

---

## Log Format

```
[2025-01-15T10:23:45Z] [articles] [v3_id:42] [locale:en] [CREATE] Created in v5 with id 87
[2025-01-15T10:23:45Z] [articles] [v3_id:43] [locale:fr] [ERROR] Failed to upload image hero.jpg
[2025-01-15T10:23:45Z] [articles] [v3_id:43] [locale:-] [SKIP] Entry permanently failed. Skipping.
[2025-01-15T10:23:45Z] [articles] [v3_id:-] [locale:-] [SUMMARY] DONE — total:100 success:97 skipped:2 failed:1
```

---

## Recommended Migration Order

Migrate **independent** content types first, then those that depend on them:

1. Simple types with no relations: `tags`, `categories`
2. Author/user-related types: `authors`
3. Content that references the above: `articles`, `products`
4. Single types last: `homepage`, `global`

This ensures relation resolution works correctly since the target entries will already exist in v5 when the relation is being remapped.

---

## Troubleshooting

**"Relation field X has no entry in RELATION_SLUG_MAP"**
Add the field to `RELATION_SLUG_MAP` in your `.env`:
```env
RELATION_SLUG_MAP={"articles":{"author":"authors"}}
```

**Media not uploading**
Check that S3 URLs in v3 are publicly accessible, or that your AWS credentials in `.env` are correct.

**Entry keeps failing**
Check `migration.log` for the specific error. Common causes: required fields missing in v5 schema, component UID mismatch, or a relation pointing to an entry not yet migrated.

**Component UID mismatch**
If component UIDs changed between v3 and v5, define the mapping:
```env
COMPONENT_UID_MAP={"sections.old-name":"sections.new-name"}
```
