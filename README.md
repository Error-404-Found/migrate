# strapi-plugin-env-sync

> Enterprise-grade on-demand content synchronisation between Strapi v5 environments.

**SIT → QA → UAT → PROD** — sync any single type or collection item with one click, directly from the Content Manager.

---

## Features

| Feature | Details |
|---|---|
| **On-demand sync** | Button in every edit view — never automated |
| **Full content support** | Scalars, rich text, media, relations, components, dynamic zones, i18n |
| **Media deduplication** | Checks file hash before re-uploading |
| **Conflict strategies** | `source-wins`, `target-wins`, `manual` — per content type |
| **Dry-run mode** | Preview diffs before committing |
| **Rollback** | Snapshot taken before every write; restore from Logs UI |
| **Audit logs** | Full log of every sync with user, timestamp, diff, and duration |
| **RBAC** | Only Super Admin or `Reviewer` role can trigger syncs |
| **Health checks** | Live connectivity badges next to each Sync button |
| **Webhook notifications** | Optional Slack/Teams alerts on success or failure |
| **Strapi v5 native** | Uses Document Service API throughout — no Entity Service |

---

## Environment Topology

```
SIT ──→ QA
             (QA and UAT share the same DB — no sync needed)
UAT ──→ PROD
```

---

## Installation

```bash
# From npm (once published)
npm install strapi-plugin-env-sync

# Or locally during development
npm install ./path/to/strapi-plugin-env-sync
```

---

## Configuration

Add to `config/plugins.js` (or `config/plugins.ts`) in **each** Strapi environment:

```js
// config/plugins.js

module.exports = {
  'env-sync': {
    enabled: true,
    config: {
      // Which environment is THIS Strapi instance?
      currentEnv: 'SIT', // 'SIT' | 'QA' | 'UAT' | 'PROD'

      // Which environments can THIS instance push TO?
      // Only define targets valid for this env:
      //   SIT  → QA
      //   UAT  → PROD
      //   QA   → (none — shares DB with UAT)
      //   PROD → (none — final destination)
      targets: {
        QA: {
          url:    'https://qa.api.example.com',
          secret: process.env.ENV_SYNC_QA_SECRET,
        },
        // PROD: { url: '...', secret: process.env.ENV_SYNC_PROD_SECRET },
      },

      // Global conflict strategy (overrideable per content type)
      conflictStrategy: 'source-wins', // 'source-wins' | 'target-wins' | 'manual'

      // Per-content-type strategy overrides
      perContentType: {
        'api::page.page': { conflictStrategy: 'manual' },
      },

      retryAttempts:          3,
      requestTimeoutMs:       30000,
      enableDryRun:           true,
      enableRollback:         true,
      maxSnapshotsPerDocument: 5,

      // Optional: Slack / Teams webhook
      // webhook: {
      //   url:       process.env.ENV_SYNC_WEBHOOK_URL,
      //   onSuccess: true,
      //   onFailure: true,
      // },
    },
  },
};
```

---

## Environment Variables

Set these in each environment's `.env` file:

| Variable | Used in | Description |
|---|---|---|
| `ENV_SYNC_QA_SECRET` | SIT config | Shared secret for SIT → QA syncs |
| `ENV_SYNC_PROD_SECRET` | UAT config | Shared secret for UAT → PROD syncs |
| `ENV_SYNC_WEBHOOK_URL` | Any | Optional Slack/Teams webhook URL |

> **Security:** Secrets must be the same value in both the source env's `targets[X].secret` AND the target env's `targets[SOURCE].secret`. The target uses it to validate inbound requests.

---

## Permissions & Roles

On first boot, the plugin automatically:

1. Creates a `Reviewer` admin role (if not present)
2. Assigns the following RBAC actions to `Reviewer`:
   - `plugin::env-sync.trigger` — trigger syncs
   - `plugin::env-sync.view-logs` — view audit logs
   - `plugin::env-sync.dry-run` — run dry-run previews

**Super Admins** automatically have all permissions.

To grant sync access to other admins:
1. Go to **Settings → Administration Panel → Roles**
2. Assign the `Reviewer` role to the relevant users

---

## Usage

### Syncing a document

1. Open any **Collection Type** or **Single Type** in the Content Manager
2. Click the **"Sync → QA"** (or `→ PROD`) button in the top-right header
3. Optionally click **Preview diff** to see exactly what will change
4. Select a conflict strategy if needed
5. Click **Confirm & Sync**

### Viewing logs

Navigate to **Env Sync** in the left sidebar → full audit log table with:
- Filter by status, env, content type, date range
- Expand any row to see the field-level diff
- Click **Rollback** on any successful sync to restore the previous state
- Click **Export CSV** to download the log

---

## API Reference

### Admin endpoints (require admin JWT)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/env-sync/trigger` | Trigger a sync |
| `GET`  | `/api/env-sync/config`  | Get sanitised plugin config |
| `GET`  | `/api/env-sync/logs`    | List audit logs |
| `GET`  | `/api/env-sync/logs/:id`| Get single log entry |
| `GET`  | `/api/env-sync/logs/export` | Download CSV |
| `POST` | `/api/env-sync/rollback`| Restore from snapshot |
| `GET`  | `/api/env-sync/status`  | Get target env health |
| `POST` | `/api/env-sync/status/refresh` | Force health re-check |

### Machine-to-machine endpoints (require Bearer token)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/env-sync/receive` | Receive and apply sync payload |
| `POST` | `/api/env-sync/peek`    | Fetch document for pre-sync diff |
| `GET`  | `/api/env-sync/health`  | Liveness probe |

---

## Trigger payload (POST /api/env-sync/trigger)

```json
{
  "contentType": "api::article.article",
  "documentId":  "clx1abc123def456",
  "targetEnv":   "QA",
  "locale":      null,
  "isDryRun":    false,
  "conflictStrategyOverride": "source-wins"
}
```

---

## Architecture

```
SOURCE ENV                              TARGET ENV
──────────────────────────────────────────────────────────────────
Admin clicks "Sync → QA"
  │
  ▼
sync-engine.triggerSync()
  ├── Serialise document (all locales, media, relations)
  ├── Build media manifest
  ├── Compute diff (via diff-engine)
  ├── Apply conflict strategy
  ├── [dry-run] → return diff to UI ──────────────────────────────
  └── POST /api/env-sync/receive ──────────▶  receive controller
                                                │
                                                ├── Validate token (verify-sync-token middleware)
                                                ├── Validate payload schema
                                                ├── payload-writer.applyPayload()
                                                │     ├── rollback.takeSnapshot()
                                                │     ├── mediaSync.ensureMediaExists()
                                                │     ├── relationResolver.resolveRelations()
                                                │     └── strapi.db.transaction() → upsert all locales
                                                └── Return { success, snapshotId, brokenRelations }
```

---

## Troubleshooting

### Sync button not visible
- Check that `currentEnv` is set to `SIT` or `UAT` (buttons are hidden on QA/PROD)
- Ensure your admin user has the `Reviewer` role or is a Super Admin
- Verify `targets` is configured and non-empty

### "Unauthorized" on receive endpoint
- Both envs must share the **same secret value** for that env pair
- Verify the `Authorization: Bearer <secret>` header matches `targets[sourceEnv].secret` on the receiving end

### Media not syncing
- The target env's upload provider must be reachable and writable
- Check that the file's source URL is publicly accessible (the target downloads from it)
- Review logs: broken media appears as warnings, not fatal errors

### Relations show as broken
- Related documents must be synced **before** the document that references them
- Sync parent content types first, then child/referencing types

### Database errors on target
- All writes are wrapped in `strapi.db.transaction()` — a failure rolls back the entire locale batch
- Check the log entry's `errorMessage` field for the specific Strapi/DB error

---

## Development

```bash
# Clone into your Strapi project's plugins directory
cd my-strapi-project
mkdir -p src/plugins
cp -r path/to/strapi-plugin-env-sync src/plugins/env-sync

# Add to config/plugins.js then install deps
cd src/plugins/env-sync
npm install

# Run tests
npm test

# Run with coverage
npm run test:coverage
```

---

## License

MIT © Your Organisation
