# Strapi v3 → v5 Migration Middleware

Migrates content, images, relations, dynamic zones, components, and i18n from Strapi v3.6.8 to Strapi v5.

---

## Setup

```bash
cd migration
npm install
cp .env.example .env
# Edit .env with your v3 and v5 URLs
```

---

## Usage

```bash
# Migrate a collection
node index.js --collection articles

# Migrate multiple collections
node index.js --collection articles --collection authors --collection categories

# Migrate a single type
node index.js --single homepage

# Mix
node index.js --collection articles --collection authors --single homepage
```

Re-running the same command resumes from the last checkpoint — no duplicates.

---

## How it works

| Step | What happens |
|------|-------------|
| Schema fetch | Reads field types from `/content-manager/content-types/:uid` on v3 (then v5 as fallback) |
| Field mapping | Maps each v3 field to the correct v5 camelCase key with the right type handling |
| Media | Downloads from v3 URL (S3 or local), uploads to v5 via multipart `POST /api/upload` |
| Relations | Looks up v5 ID by slug/title/name; falls back to stateManager ID map |
| Dynamic zones | Fetches component schema for each `__component` UID, processes fields recursively |
| Components | Single and repeatable components processed with their own schema |
| i18n | Fetches each locale from v3 and posts to `POST /api/:slug/:id/localizations` |
| Publish | Calls `POST /api/:slug/:id/actions/publish` if `published_at` was set in v3 |

---

## Checkpoint / Resume

`migration-state.json` is created on first run and updated after every entry.
Delete it to start over completely.

---

## Required Strapi permissions

**Strapi v3 — Settings → Roles → Public:**
- `find` and `findone` on every collection/single type you migrate
- `count` on every collection

**Strapi v5 — Settings → Roles → Public:**
- `find`, `create`, `update` on every collection/single type
- `upload.upload` for media
- `publish` action if draft/publish is enabled
