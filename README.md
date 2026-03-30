# Strapi v3.6.8 → v5 Migration Middleware

A standalone Node.js background process for migrating content from **Strapi v3.6.8** to **Strapi v5** — including media, relations, dynamic zones, components, and multilingual (i18n) content.

Neither Strapi instance is stopped or modified during the migration.

---

## How It Works

- **Schema auto-detection** — Relations, dynamic zones, and component field types are fetched automatically from the Strapi v3 Content Manager API (`/content-manager/content-types/:uid` and `/content-manager/components/:uid`). No manual mapping needed.
- **Media via Strapi v5** — The middleware passes the S3 file URL from v3 directly to Strapi v5's upload endpoint. Strapi v5 fetches and registers the file in its own media library. No AWS credentials or manual S3 access needed.
- **i18n** — All locale variants of each entry are fetched from v3 and migrated to v5 preserving translations.
- **Resumable** — A `migration-state.json` checkpoint file lets you resume from exactly where you left off if the process is interrupted.

---

## Features

- Migrates collections and single types
- All field types: text, numbers, booleans, dates, richtext, JSON
- Media registered in v5 via URL (Strapi v5 handles S3 fetch internally)
- Relations auto-resolved from schema — no manual slug mapping
- Dynamic zones and nested components processed via schema auto-fetch
- Full multilingual support via `strapi-plugin-i18n` — all locales migrated
- 100-entry batches with 30-second delay between every API call (configurable)
- Resumes from last checkpoint on restart — no duplicate entries
- Per-entry retry logic (3 attempts before permanent skip)
- Exponential backoff on HTTP 429 rate limit responses
- Detailed structured logging to console and `migration.log`
- Per-collection and grand summary at end of each run

---

## Requirements

- Node.js 18+
- Both Strapi v3 and v5 running and reachable
- **Full-access API tokens** for both instances (must include Content Manager API access)

---

## Setup

```bash
# 1. Install dependencies
cd migration
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — only URLs, tokens, locales, and log path needed

# 3. Run
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
| `STRAPI_V3_TOKEN` | Full-access API token for v3 (needs Content Manager access) |
| `STRAPI_V5_TOKEN` | Full-access API token for v5 (needs Content Manager access) |

See `.env.example` for the full list.

> **No AWS / S3 credentials needed.** Media is handled by Strapi v5 internally.
> **No manual field mapping needed.** Schema is fetched automatically from the API.

---

## File Structure

```
migration/
├── index.js                   # Entry point — CLI → validate → migrate → summarise
├── .env.example               # All env vars documented (minimal config)
├── migration.log              # Created on first run
├── migration-state.json       # Created on first run, tracks progress
├── lib/
│   ├── cliParser.js           # Parses --collection, --single, --all flags
│   ├── slugValidator.js       # Pings v3 API to confirm each slug exists
│   ├── apiClient.js           # Axios wrappers for v3 + v5, retry, backoff, delay
│   ├── schemaInspector.js     # Fetches & caches content type and component schemas
│   ├── mediaHandler.js        # Passes S3 URL to v5 upload API + dedup cache
│   ├── fieldMapper.js         # Maps v3 fields to v5 using schema (not env vars)
│   ├── relationResolver.js    # Resolves v3 IDs to v5 IDs via unique fields
│   ├── dynamicZoneHandler.js  # Processes dynamic zones using component schemas
│   ├── i18nHandler.js         # Fetches + migrates all locales per entry
│   ├── stateManager.js        # Reads/writes migration-state.json
│   └── logger.js              # Structured logger → console + file
└── README.md
```

---

## How Schema Auto-Detection Works

When the migration starts processing a content type (e.g. `articles`), it calls:

```
GET /content-manager/content-types/application::article.article
```

This returns all field definitions including their types (`media`, `relation`, `dynamiczone`, `component`). For relations, it extracts the target UID and derives the related collection slug automatically.

For dynamic zone components (e.g. `sections.hero`), it calls:

```
GET /content-manager/components/sections.hero
```

Both are cached in memory for the duration of the run. If a schema fetch fails, the middleware falls back to runtime value heuristics and logs a warning.

---

## How Migration State Works

On first run, a `migration-state.json` file is created. It tracks:
- Which collections/single types are fully done (`status: "done"`)
- The last successfully processed page per content type
- The ID mapping: v3 entry ID → v5 entry ID
- Permanently failed entry IDs (failed 3 times)

**If the process is interrupted**, re-run the same command. It resumes from where it left off without duplicating entries. To force a full re-migration, delete `migration-state.json`.

---

## Log Format

```
[2025-01-15T10:23:45Z] [articles] [v3_id:42] [locale:en] [CREATE] Created in v5 with id 87
[2025-01-15T10:23:45Z] [articles] [v3_id:42] [locale:fr] [CREATE] Locale fr migrated to v5
[2025-01-15T10:23:45Z] [articles] [v3_id:43] [locale:-]  [SKIP]   Already migrated (v5_id: 88)
[2025-01-15T10:23:45Z] [articles] [v3_id:-]  [locale:-]  [SUMMARY] DONE — total:100 success:98 skipped:1 failed:1
```

---

## Recommended Migration Order

Migrate independent types first so relations resolve correctly:

1. Types with no relations: `tags`, `categories`
2. Author/reference types: `authors`, `brands`
3. Content that references the above: `articles`, `products`
4. Single types last: `homepage`, `global`

---

## Troubleshooting

**"Could not fetch v3 schema"**
Ensure your `STRAPI_V3_TOKEN` has access to the Content Manager API, not just the public API. In Strapi v3 Admin → Settings → API Tokens, set token type to "Full access".

**Media not registering in v5**
Ensure your `STRAPI_V5_TOKEN` has upload permissions. The S3 URL from v3 must be publicly accessible or accessible by the v5 server.

**Entry keeps failing**
Check `migration.log` for the specific error. Common causes: required fields in v5 schema that weren't in v3, or a relation pointing to an entry not yet migrated (migrate in dependency order).

**Relation field skipped with warning**
If schema fetch succeeds but a relation field is still skipped, the v3 schema may not include a `target` on that relation attribute. Check the v3 Content Manager API response for that content type.
