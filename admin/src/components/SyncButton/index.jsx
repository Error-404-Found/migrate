/**
 * SyncButton — injected into Content Manager edit view right-links zone.
 * Uses only confirmed @strapi/design-system v2 exports.
 *
 * @module env-sync/admin/src/components/SyncButton
 */

import React, { useState, useEffect } from 'react';
import { Button, Tooltip, Flex, Loader } from '@strapi/design-system';
import { usePluginConfig } from '../../hooks/usePluginConfig';
import { SyncModal } from '../SyncModal';
import { api } from '../../utils/api';

/**
 * Strapi v5 injects this with no props.
 * Content type + documentId are parsed from the URL.
 */
export function SyncButton() {
  const { config, loading: configLoading } = usePluginConfig();
  const [modalOpen,     setModalOpen]     = useState(false);
  const [targetStatus,  setTargetStatus]  = useState({});
  const [statusLoading, setStatusLoading] = useState(false);

  const { contentType, documentId } = _parseLocationInfo();

  useEffect(() => {
    if (!config?.targets?.length) return;
    setStatusLoading(true);
    api.getStatus()
      .then((res) => setTargetStatus(res.targets || {}))
      .catch(() => {})
      .finally(() => setStatusLoading(false));
  }, [config]);

  if (configLoading) return null;
  if (!config)       return null;

  const { currentEnv, targets = [], enableDryRun, conflictStrategy } = config;

  // No targets configured → nothing to show
  if (!targets || targets.length === 0) return null;

  // QA and PROD don't push outbound
  if (currentEnv === 'QA' || currentEnv === 'PROD') {
    return (
      <Tooltip label={'Sync is not available from the ' + currentEnv + ' environment.'}>
        <Button variant="secondary" size="S" disabled>
          🔒 Env Sync (disabled)
        </Button>
      </Tooltip>
    );
  }

  if (!contentType || !documentId) return null;

  return (
    <>
      <Flex gap={2} alignItems="center">
        {targets.map((targetEnv) => {
          const health    = targetStatus[targetEnv];
          const isHealthy = !health || health.status === 'reachable' || health.status === 'unknown';
          const latency   = health?.status === 'reachable' ? ' (' + health.latencyMs + 'ms)' : '';
          const tooltip   =
            health?.status === 'unreachable' ? targetEnv + ' is currently unreachable' :
            health?.status === 'timeout'     ? targetEnv + ' timed out'                :
            'Sync this document to ' + targetEnv;

          return (
            <Tooltip key={targetEnv} label={tooltip}>
              <Button
                variant="secondary"
                size="S"
                onClick={() => setModalOpen(targetEnv)}
                disabled={!isHealthy}
                loading={statusLoading}
              >
                {'↑ Sync → ' + targetEnv + latency}
              </Button>
            </Tooltip>
          );
        })}
      </Flex>

      {targets.map((targetEnv) => (
        <SyncModal
          key={targetEnv}
          isOpen={modalOpen === targetEnv}
          onClose={() => setModalOpen(false)}
          contentType={contentType}
          documentId={documentId}
          targetEnv={targetEnv}
          defaultStrategy={config.perContentType?.[contentType]?.conflictStrategy || conflictStrategy}
          enableDryRun={enableDryRun}
          onSuccess={() => {
            setModalOpen(false);
            api.getStatus().then((res) => setTargetStatus(res.targets || {})).catch(() => {});
          }}
        />
      ))}
    </>
  );
}

// ─── Private ──────────────────────────────────────────────────────────────────

function _parseLocationInfo() {
  try {
    const pathname = window.location.pathname;
    // Collection type: /admin/content-manager/collection-types/api::article.article/{docId}
    let match = pathname.match(/\/content-manager\/collection-types\/([^/]+)\/([^/]+)/);
    if (match) return { contentType: decodeURIComponent(match[1]), documentId: match[2] };
    // Single type: /admin/content-manager/single-types/api::homepage.homepage
    match = pathname.match(/\/content-manager\/single-types\/([^/]+)/);
    if (match) return { contentType: decodeURIComponent(match[1]), documentId: '__single__' };
    return { contentType: null, documentId: null };
  } catch {
    return { contentType: null, documentId: null };
  }
}
