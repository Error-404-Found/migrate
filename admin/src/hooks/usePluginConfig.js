/**
 * usePluginConfig — fetches and caches plugin config from the server.
 *
 * @module env-sync/admin/src/hooks/usePluginConfig
 */

import { useState, useEffect } from 'react';
import { api } from '../utils/api';

let _cache = null;
let _promise = null;

/**
 * Returns { config, loading, error }
 * Config shape: { currentEnv, targets: string[], conflictStrategy, enableDryRun, enableRollback, perContentType }
 */
export function usePluginConfig() {
  const [config,  setConfig]  = useState(_cache);
  const [loading, setLoading] = useState(!_cache);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (_cache) { setConfig(_cache); setLoading(false); return; }
    if (!_promise) {
      _promise = api.getConfig().then((data) => { _cache = data; return data; });
    }
    _promise
      .then((data) => { setConfig(data); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  return { config, loading, error };
}
