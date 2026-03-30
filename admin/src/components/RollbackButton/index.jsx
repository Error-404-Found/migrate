/**
 * RollbackButton — confirm-then-rollback dialog.
 * Uses Dialog (confirmed export from @strapi/design-system v2).
 *
 * @module env-sync/admin/src/components/RollbackButton
 */

import React, { useState } from 'react';
import { Button, Dialog, Flex, Typography, Loader } from '@strapi/design-system';
import { api } from '../../utils/api';

/**
 * @param {object}   props
 * @param {string}   props.snapshotId
 * @param {string}   props.contentType
 * @param {string}   props.documentId
 * @param {function} props.onSuccess
 */
export function RollbackButton({ snapshotId, contentType, documentId, onSuccess }) {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  if (!snapshotId) return null;

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.rollback(snapshotId);
      setOpen(false);
      onSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button variant="tertiary" size="S" onClick={() => setOpen(true)}>
        ↩ Rollback
      </Button>

      <Dialog.Root open={open} onOpenChange={(v) => !loading && setOpen(v)}>
        <Dialog.Content>
          <Dialog.Header>Confirm Rollback</Dialog.Header>
          <Dialog.Body>
            <Flex direction="column" alignItems="center" gap={4} padding={2}>
              {loading ? (
                <>
                  <Loader small />
                  <Typography variant="omega">Restoring…</Typography>
                </>
              ) : (
                <Typography variant="omega" textAlign="center">
                  This will restore <strong>{contentType?.split('.').pop()}</strong>{' '}
                  (ID: <code>{documentId?.slice(0, 8)}…</code>) to the state before this sync.
                  <br /><br />
                  <strong>This cannot be undone.</strong>
                </Typography>
              )}
              {error && (
                <Box padding={3} background="danger100" borderRadius="4px" width="100%">
                  <Typography variant="pi" textColor="danger600">{error}</Typography>
                </Box>
              )}
            </Flex>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="tertiary" onClick={() => setOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button variant="danger-light" onClick={handleConfirm} disabled={loading}>
              Yes, rollback
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
