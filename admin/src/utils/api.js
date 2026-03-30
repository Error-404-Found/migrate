/**
 * API utility — typed wrappers around all plugin endpoints.
 * Uses Strapi's built-in admin axios instance so auth headers are managed automatically.
 *
 * @module env-sync/admin/src/utils/api
 */

const BASE = '/env-sync';

/**
 * Helper: GET via Strapi admin fetch.
 */
async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = '/api' + BASE + path + (qs ? '?' + qs : '');
  const res = await fetch(url, { headers: _headers() });
  return _handle(res);
}

/**
 * Helper: POST via Strapi admin fetch.
 */
async function post(path, body = {}) {
  const res = await fetch('/api' + BASE + path, {
    method:  'POST',
    headers: _headers(),
    body:    JSON.stringify(body),
  });
  return _handle(res);
}

// ── Public API ────────────────────────────────────────────────────────────────

export const api = {

  /** Get sanitised plugin config (current env, targets, feature flags). */
  getConfig: () => get('/config'),

  /** Get cached target environment health statuses. */
  getStatus: () => get('/status'),

  /** Force refresh health checks. */
  refreshStatus: () => post('/status/refresh'),

  /**
   * Trigger a sync.
   * @param {object} p
   * @param {string}  p.contentType
   * @param {string}  p.documentId
   * @param {string}  p.targetEnv
   * @param {string|null} p.locale
   * @param {boolean} p.isDryRun
   * @param {string}  [p.conflictStrategyOverride]
   */
  triggerSync: (p) => post('/trigger', p),

  /**
   * Fetch audit logs with optional filters.
   * @param {object} filters
   */
  getLogs: (filters = {}) => get('/logs', { ...filters, page: filters.page || 1, pageSize: filters.pageSize || 25 }),

  /** Get a single log entry. */
  getLog: (documentId) => get('/logs/' + documentId),

  /**
   * Trigger a rollback from a snapshot.
   * @param {string} snapshotDocumentId
   */
  rollback: (snapshotDocumentId) => post('/rollback', { snapshotDocumentId }),

  /** Export logs as CSV — returns a blob URL. */
  exportCsv: async (filters = {}) => {
    const qs  = new URLSearchParams(filters).toString();
    const res = await fetch('/api' + BASE + '/logs/export' + (qs ? '?' + qs : ''), { headers: _headers() });
    if (!res.ok) throw new Error('CSV export failed.');
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
};

// ── Private ───────────────────────────────────────────────────────────────────

function _headers() {
  const token = _getAdminToken();
  return {
    'Content-Type':  'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };
}

function _getAdminToken() {
  try {
    // Strapi stores the admin JWT in localStorage under this key
    return localStorage.getItem('jwtToken') || '';
  } catch {
    return '';
  }
}

async function _handle(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const message = data?.error?.message || data?.message || 'Request failed (' + res.status + ')';
    throw new Error(message);
  }
  return data;
}
