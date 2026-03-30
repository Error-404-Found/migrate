/**
 * SyncModal — confirmation dialog before triggering a sync.
 * Uses Modal, Dialog — confirmed exports from @strapi/design-system v2.
 *
 * @module env-sync/admin/src/components/SyncModal
 */

import React, { useState, useCallback } from 'react';
import {
  Modal, Button, Typography, Box, Flex,
  Loader, SingleSelect, SingleSelectOption,
} from '@strapi/design-system';
import { DiffViewer } from '../DiffViewer';
import { api } from '../../utils/api';

const STEPS = {
  CONFIRM:    'CONFIRM',
  DIFFING:    'DIFFING',
  DIFF_READY: 'DIFF_READY',
  SYNCING:    'SYNCING',
  DONE:       'DONE',
};

const STRATEGY_OPTIONS = [
  { value: 'source-wins', label: 'Source wins (overwrite target)' },
  { value: 'target-wins', label: 'Target wins (skip if target is newer)' },
  { value: 'manual',      label: 'Manual (block and notify)' },
];

/**
 * @param {object} props
 * @param {boolean}  props.isOpen
 * @param {function} props.onClose
 * @param {string}   props.contentType
 * @param {string}   props.documentId
 * @param {string}   props.targetEnv
 * @param {string}   props.defaultStrategy
 * @param {boolean}  props.enableDryRun
 * @param {function} props.onSuccess
 */
export function SyncModal({
  isOpen,
  onClose,
  contentType,
  documentId,
  targetEnv,
  defaultStrategy = 'source-wins',
  enableDryRun    = true,
  onSuccess,
}) {
  const [step,     setStep]     = useState(STEPS.CONFIRM);
  const [diff,     setDiff]     = useState(null);
  const [strategy, setStrategy] = useState(defaultStrategy);
  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState(null);

  const reset = useCallback(() => {
    setStep(STEPS.CONFIRM);
    setDiff(null);
    setResult(null);
    setError(null);
    setStrategy(defaultStrategy);
  }, [defaultStrategy]);

  const handleClose = () => { reset(); onClose(); };

  const handlePreview = useCallback(async () => {
    setStep(STEPS.DIFFING);
    setError(null);
    try {
      const res = await api.triggerSync({ contentType, documentId, targetEnv, locale: null, isDryRun: true, conflictStrategyOverride: strategy });
      setDiff(res.diff);
      setStep(STEPS.DIFF_READY);
    } catch (err) {
      setError(err.message);
      setStep(STEPS.CONFIRM);
    }
  }, [contentType, documentId, targetEnv, strategy]);

  const handleSync = useCallback(async () => {
    setStep(STEPS.SYNCING);
    setError(null);
    try {
      const res = await api.triggerSync({ contentType, documentId, targetEnv, locale: null, isDryRun: false, conflictStrategyOverride: strategy });
      setResult(res);
      setStep(STEPS.DONE);
      if (res.success) onSuccess?.(res);
    } catch (err) {
      setError(err.message);
      setStep(STEPS.DIFF_READY);
    }
  }, [contentType, documentId, targetEnv, strategy, onSuccess]);

  if (!isOpen) return null;

  return (
    <Modal.Root onClose={handleClose} labelledBy="sync-modal-title">
      <Modal.Overlay />
      <Modal.Content>

        <Modal.Header>
          <Typography id="sync-modal-title" variant="beta" fontWeight="bold">
            Sync to {targetEnv}
          </Typography>
        </Modal.Header>

        <Modal.Body>
          <Box padding={2}>

            {/* CONFIRM */}
            {step === STEPS.CONFIRM && (
              <Box>
                <Typography variant="omega">
                  You are about to sync <strong>{contentType}</strong> (ID: <code>{documentId}</code>) to <strong>{targetEnv}</strong>.
                </Typography>
                <Box marginTop={4}>
                  <Typography variant="pi" textColor="neutral600" marginBottom={2} display="block">
                    Conflict resolution strategy
                  </Typography>
                  <SingleSelect value={strategy} onChange={setStrategy} size="S">
                    {STRATEGY_OPTIONS.map((o) => (
                      <SingleSelectOption key={o.value} value={o.value}>{o.label}</SingleSelectOption>
                    ))}
                  </SingleSelect>
                </Box>
                {error && (
                  <Box marginTop={4} padding={3} background="danger100" borderRadius="4px">
                    <Typography variant="pi" textColor="danger600">{error}</Typography>
                  </Box>
                )}
              </Box>
            )}

            {/* DIFFING */}
            {step === STEPS.DIFFING && (
              <Flex justifyContent="center" padding={8} direction="column" alignItems="center" gap={4}>
                <Loader />
                <Typography variant="omega" textColor="neutral600">Computing diff…</Typography>
              </Flex>
            )}

            {/* DIFF_READY */}
            {step === STEPS.DIFF_READY && (
              <Box>
                <Typography variant="omega" marginBottom={4} display="block">
                  Preview of changes that will be applied to <strong>{targetEnv}</strong>:
                </Typography>
                <DiffViewer diff={diff} />
                {error && (
                  <Box marginTop={4} padding={3} background="danger100" borderRadius="4px">
                    <Typography variant="pi" textColor="danger600">{error}</Typography>
                  </Box>
                )}
              </Box>
            )}

            {/* SYNCING */}
            {step === STEPS.SYNCING && (
              <Flex justifyContent="center" padding={8} direction="column" alignItems="center" gap={4}>
                <Loader />
                <Typography variant="omega" textColor="neutral600">Syncing to {targetEnv}…</Typography>
              </Flex>
            )}

            {/* DONE */}
            {step === STEPS.DONE && result && (
              <Box>
                <Box
                  padding={4}
                  background={result.success ? 'success100' : 'danger100'}
                  borderRadius="4px"
                >
                  <Typography variant="omega" textColor={result.success ? 'success600' : 'danger600'}>
                    {result.success
                      ? '✓ Sync complete! ' + (result.diff?.fieldsChanged?.length || 0) + ' field(s) updated.' + (result.snapshotId ? ' Snapshot saved for rollback.' : '')
                      : 'Sync did not complete: ' + result.message
                    }
                  </Typography>
                </Box>
              </Box>
            )}

          </Box>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="tertiary" onClick={handleClose}>
            {step === STEPS.DONE ? 'Close' : 'Cancel'}
          </Button>

          {step === STEPS.CONFIRM && enableDryRun && (
            <Button variant="secondary" onClick={handlePreview}>
              Preview diff
            </Button>
          )}

          {step === STEPS.CONFIRM && (
            <Button variant="danger-light" onClick={handleSync}>
              Sync to {targetEnv}
            </Button>
          )}

          {step === STEPS.DIFF_READY && (
            <>
              <Button variant="secondary" onClick={reset}>Back</Button>
              <Button
                variant="danger-light"
                onClick={handleSync}
                disabled={diff && !diff.hasChanges}
              >
                {diff && !diff.hasChanges ? 'No changes' : 'Confirm & Sync'}
              </Button>
            </>
          )}
        </Modal.Footer>

      </Modal.Content>
    </Modal.Root>
  );
}
