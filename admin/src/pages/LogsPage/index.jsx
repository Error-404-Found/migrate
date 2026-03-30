/**
 * LogsPage — audit log viewer.
 * Uses only confirmed @strapi/design-system v2 exports:
 *   Table, Thead, Tbody, Tr, Th, Td, Typography, Box, Flex, Button,
 *   Badge, Loader, SingleSelect, SingleSelectOption, TextInput,
 *   Pagination, PreviousLink, NextLink, PageLink, IconButton, Tooltip
 *
 * @module env-sync/admin/src/pages/LogsPage
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Flex, Button, Badge,
  Table, Thead, Tbody, Tr, Th, Td,
  Pagination, PreviousLink, NextLink, PageLink,
  SingleSelect, SingleSelectOption,
  Loader, TextInput, IconButton, Tooltip,
} from '@strapi/design-system';
import { RollbackButton } from '../../components/RollbackButton';
import { DiffViewer }     from '../../components/DiffViewer';
import { api }            from '../../utils/api';

const STATUS_COLORS = {
  pending:     'neutral',
  in_progress: 'warning',
  success:     'success',
  failed:      'danger',
  rolled_back: 'secondary',
  dry_run:     'primary',
};

const STATUS_OPTIONS = ['', 'pending', 'in_progress', 'success', 'failed', 'rolled_back', 'dry_run'];
const ENV_OPTIONS    = ['', 'SIT', 'QA', 'UAT', 'PROD'];

export function LogsPage() {
  const [logs,        setLogs]        = useState([]);
  const [pagination,  setPagination]  = useState({ page: 1, pageSize: 25, total: 0, pageCount: 1 });
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);
  const [exporting,   setExporting]   = useState(false);
  const [filters,     setFilters]     = useState({
    page: 1, pageSize: 25,
    status: '', sourceEnv: '', targetEnv: '', contentType: '',
  });

  const loadLogs = useCallback(async (f) => {
    setLoading(true);
    setError(null);
    try {
      const active = f || filters;
      const clean  = Object.fromEntries(Object.entries(active).filter(([, v]) => v !== ''));
      const res    = await api.getLogs(clean);
      setLogs(res.data || []);
      setPagination(res.pagination || { page: 1, pageSize: 25, total: 0, pageCount: 1 });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { loadLogs(); }, []); // eslint-disable-line

  const setFilter = (key, val) => setFilters((prev) => ({ ...prev, [key]: val, page: 1 }));

  const handleSearch = () => loadLogs(filters);

  const handleReset = () => {
    const reset = { page: 1, pageSize: 25, status: '', sourceEnv: '', targetEnv: '', contentType: '' };
    setFilters(reset);
    loadLogs(reset);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const clean    = Object.fromEntries(Object.entries(filters).filter(([k, v]) => v !== '' && !['page','pageSize'].includes(k)));
      const blobUrl  = await api.exportCsv(clean);
      const a        = document.createElement('a');
      a.href         = blobUrl;
      a.download     = 'env-sync-logs-' + Date.now() + '.csv';
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError('CSV export failed: ' + err.message);
    } finally {
      setExporting(false);
    }
  };

  const handlePage = (page) => {
    const next = { ...filters, page };
    setFilters(next);
    loadLogs(next);
  };

  return (
    <Box>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <Box padding={6} paddingBottom={0}>
        <Flex justifyContent="space-between" alignItems="flex-start" marginBottom={4}>
          <Box>
            <Typography variant="alpha" as="h1">Environment Sync Logs</Typography>
            <Typography variant="epsilon" textColor="neutral500">
              Audit trail of all content sync operations — {pagination.total} total
            </Typography>
          </Box>
          <Flex gap={2}>
            <Button
              variant="secondary"
              onClick={() => loadLogs(filters)}
              disabled={loading}
            >
              ↻ Refresh
            </Button>
            <Button
              variant="secondary"
              onClick={handleExport}
              disabled={exporting || logs.length === 0}
            >
              {exporting ? '…' : '↓ Export CSV'}
            </Button>
          </Flex>
        </Flex>
      </Box>

      <Box padding={6}>
        {/* ── Filters ──────────────────────────────────────────────── */}
        <Box
          background="neutral0"
          padding={4}
          borderRadius="4px"
          marginBottom={6}
          borderColor="neutral200"
          borderWidth="1px"
          borderStyle="solid"
        >
          <Typography variant="sigma" textColor="neutral600" marginBottom={3} display="block">
            Filters
          </Typography>
          <Flex gap={3} wrap="wrap" alignItems="flex-end">
            <Box minWidth="160px">
              <SingleSelect
                label="Status"
                value={filters.status}
                onChange={(v) => setFilter('status', v)}
                size="S"
              >
                {STATUS_OPTIONS.map((s) => (
                  <SingleSelectOption key={s} value={s}>{s || 'All statuses'}</SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>
            <Box minWidth="120px">
              <SingleSelect
                label="Source env"
                value={filters.sourceEnv}
                onChange={(v) => setFilter('sourceEnv', v)}
                size="S"
              >
                {ENV_OPTIONS.map((e) => (
                  <SingleSelectOption key={e} value={e}>{e || 'All'}</SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>
            <Box minWidth="120px">
              <SingleSelect
                label="Target env"
                value={filters.targetEnv}
                onChange={(v) => setFilter('targetEnv', v)}
                size="S"
              >
                {ENV_OPTIONS.map((e) => (
                  <SingleSelectOption key={e} value={e}>{e || 'All'}</SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>
            <Box minWidth="200px">
              <TextInput
                label="Content type"
                placeholder="e.g. api::article"
                value={filters.contentType}
                onChange={(e) => setFilter('contentType', e.target.value)}
                size="S"
              />
            </Box>
            <Flex gap={2} paddingTop={5}>
              <Button size="S" onClick={handleSearch}>Search</Button>
              <Button size="S" variant="tertiary" onClick={handleReset}>Reset</Button>
            </Flex>
          </Flex>
        </Box>

        {/* ── Error ────────────────────────────────────────────────── */}
        {error && (
          <Box padding={4} background="danger100" borderRadius="4px" marginBottom={4}>
            <Typography textColor="danger600">{error}</Typography>
          </Box>
        )}

        {/* ── Table ────────────────────────────────────────────────── */}
        <Box
          background="neutral0"
          borderRadius="4px"
          borderColor="neutral200"
          borderWidth="1px"
          borderStyle="solid"
          overflow="hidden"
        >
          {loading ? (
            <Flex justifyContent="center" padding={10}><Loader /></Flex>
          ) : logs.length === 0 ? (
            <Flex justifyContent="center" padding={10}>
              <Typography textColor="neutral500">No log entries found.</Typography>
            </Flex>
          ) : (
            <Table colCount={8} rowCount={logs.length + 1}>
              <Thead>
                <Tr>
                  {['Status', 'Content type', 'Document ID', 'Route', 'Triggered by', 'When', 'Duration', 'Actions'].map((h) => (
                    <Th key={h}><Typography variant="sigma">{h}</Typography></Th>
                  ))}
                </Tr>
              </Thead>
              <Tbody>
                {logs.map((log) => {
                  const isExpanded = expandedRow === log.documentId;
                  const user = log.triggeredBy
                    ? (log.triggeredBy.firstname + ' ' + log.triggeredBy.lastname).trim() || log.triggeredBy.email
                    : '—';

                  return (
                    <React.Fragment key={log.documentId}>
                      <Tr
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedRow(isExpanded ? null : log.documentId)}
                      >
                        <Td>
                          <Badge active={log.status === 'success'}>
                            {log.isDryRun ? 'dry run' : log.status}
                          </Badge>
                        </Td>
                        <Td>
                          <Typography variant="omega" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                            {log.contentType?.split('.').pop() || log.contentType}
                          </Typography>
                        </Td>
                        <Td>
                          <Typography variant="omega" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                            {log.documentId?.slice(0, 8)}…
                          </Typography>
                        </Td>
                        <Td>
                          <Typography variant="omega">
                            {log.sourceEnv} → {log.targetEnv}
                          </Typography>
                        </Td>
                        <Td><Typography variant="omega">{user}</Typography></Td>
                        <Td>
                          <Typography variant="omega">
                            {log.triggeredAt ? new Date(log.triggeredAt).toLocaleString() : '—'}
                          </Typography>
                        </Td>
                        <Td>
                          <Typography variant="omega">
                            {log.duration != null ? log.duration + 'ms' : '—'}
                          </Typography>
                        </Td>
                        <Td onClick={(e) => e.stopPropagation()}>
                          <Flex gap={2}>
                            {log.status === 'success' && log.snapshotId && (
                              <RollbackButton
                                snapshotId={log.snapshotId}
                                contentType={log.contentType}
                                documentId={log.documentId}
                                onSuccess={() => loadLogs(filters)}
                              />
                            )}
                            <Button
                              variant="ghost"
                              size="S"
                              onClick={() => setExpandedRow(isExpanded ? null : log.documentId)}
                            >
                              {isExpanded ? '▲' : '▼'}
                            </Button>
                          </Flex>
                        </Td>
                      </Tr>

                      {/* Expanded diff row */}
                      {isExpanded && (
                        <Tr>
                          <Td colSpan={8}>
                            <Box padding={4} background="neutral50">
                              {log.errorMessage && (
                                <Box padding={3} background="danger100" borderRadius="4px" marginBottom={3}>
                                  <Typography variant="pi" textColor="danger600">
                                    {log.errorMessage}
                                  </Typography>
                                </Box>
                              )}
                              <DiffViewer diff={log.diffSummary} />
                              {!log.diffSummary && !log.errorMessage && (
                                <Typography variant="pi" textColor="neutral500">
                                  No diff data available.
                                </Typography>
                              )}
                            </Box>
                          </Td>
                        </Tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </Tbody>
            </Table>
          )}
        </Box>

        {/* ── Pagination ───────────────────────────────────────────── */}
        {pagination.pageCount > 1 && (
          <Flex justifyContent="center" marginTop={6}>
            <Pagination activePage={pagination.page} pageCount={pagination.pageCount}>
              <PreviousLink onClick={() => handlePage(Math.max(1, pagination.page - 1))}>
                Previous
              </PreviousLink>
              {Array.from({ length: Math.min(pagination.pageCount, 10) }, (_, i) => i + 1).map((p) => (
                <PageLink key={p} number={p} onClick={() => handlePage(p)}>
                  {p}
                </PageLink>
              ))}
              <NextLink onClick={() => handlePage(Math.min(pagination.pageCount, pagination.page + 1))}>
                Next
              </NextLink>
            </Pagination>
          </Flex>
        )}

      </Box>
    </Box>
  );
}
