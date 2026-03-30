/**
 * DiffViewer — displays a structured diff summary in the sync confirmation modal.
 * Uses only components confirmed exported by @strapi/design-system v2.
 *
 * @module env-sync/admin/src/components/DiffViewer
 */

import React, { useState } from 'react';
import {
  Box, Typography, Badge, Flex,
  Accordion,
} from '@strapi/design-system';

/**
 * @param {{ diff: object }} props
 */
export function DiffViewer({ diff }) {
  const [openSections, setOpenSections] = useState([]);

  if (!diff) return null;

  if (!diff.hasChanges && !diff.isNew) {
    return (
      <Box padding={4} background="neutral100" borderRadius="4px">
        <Typography variant="omega" textColor="neutral600">
          ✓ Source and target are identical — no changes will be applied.
        </Typography>
      </Box>
    );
  }

  const toggle = (id) =>
    setOpenSections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );

  return (
    <Box>
      {/* Summary badges */}
      <Flex gap={2} marginBottom={4} wrap="wrap">
        {diff.isNew && (
          <Badge active>New document</Badge>
        )}
        {diff.fieldsChanged?.length > 0 && (
          <Badge>
            {diff.fieldsChanged.length} field{diff.fieldsChanged.length !== 1 ? 's' : ''} changed
          </Badge>
        )}
        {diff.relationsUpdated?.length > 0 && (
          <Badge>
            {diff.relationsUpdated.length} relation{diff.relationsUpdated.length !== 1 ? 's' : ''} updated
          </Badge>
        )}
        {diff.mediaReuploaded?.length > 0 && (
          <Badge>
            {diff.mediaReuploaded.length} media file{diff.mediaReuploaded.length !== 1 ? 's' : ''}
          </Badge>
        )}
        {diff.localesSynced?.length > 0 && (
          <Badge>
            {diff.localesSynced.length} locale{diff.localesSynced.length !== 1 ? 's' : ''}
          </Badge>
        )}
      </Flex>

      {/* Changed fields */}
      {diff.fieldsChanged?.length > 0 && (
        <_Section
          id="fields"
          title={'Changed fields (' + diff.fieldsChanged.length + ')'}
          open={openSections.includes('fields')}
          onToggle={() => toggle('fields')}
        >
          {diff.fieldsChanged.map((f, i) => (
            <Box key={i} marginBottom={2} padding={3} background="neutral100" borderRadius="4px">
              <Flex alignItems="center" gap={2} marginBottom={1}>
                <Typography variant="sigma" textColor="neutral800">{f.field}</Typography>
                <Typography variant="pi" textColor="neutral500">({f.type})</Typography>
              </Flex>
              <Flex gap={3}>
                <Box flex={1}>
                  <Typography variant="pi" textColor="danger600">
                    − {f.oldValue || 'empty'}
                  </Typography>
                </Box>
                <Box flex={1}>
                  <Typography variant="pi" textColor="success600">
                    + {f.newValue || 'empty'}
                  </Typography>
                </Box>
              </Flex>
            </Box>
          ))}
        </_Section>
      )}

      {/* Relations */}
      {diff.relationsUpdated?.length > 0 && (
        <_Section
          id="relations"
          title={'Relations (' + diff.relationsUpdated.length + ')'}
          open={openSections.includes('relations')}
          onToggle={() => toggle('relations')}
        >
          {diff.relationsUpdated.map((r, i) => (
            <Box key={i} marginBottom={2} padding={3} background="neutral100" borderRadius="4px">
              <Typography variant="sigma">{r.field}</Typography>
              <Typography variant="pi" textColor="neutral500"> → {r.target || r.targetContentType}</Typography>
              {r.addedIds?.length > 0 && (
                <Typography variant="pi" display="block" textColor="success600">
                  + Added: {r.addedIds.join(', ')}
                </Typography>
              )}
              {r.removedIds?.length > 0 && (
                <Typography variant="pi" display="block" textColor="danger600">
                  − Removed: {r.removedIds.join(', ')}
                </Typography>
              )}
            </Box>
          ))}
        </_Section>
      )}

      {/* Media */}
      {diff.mediaReuploaded?.length > 0 && (
        <_Section
          id="media"
          title={'Media files (' + diff.mediaReuploaded.length + ')'}
          open={openSections.includes('media')}
          onToggle={() => toggle('media')}
        >
          {diff.mediaReuploaded.map((m, i) => (
            <Box key={i} marginBottom={1} padding={2} background="neutral100" borderRadius="4px">
              <Typography variant="pi">
                {m.field}: {m.addedFiles?.length || 0} added, {m.removedFiles?.length || 0} removed
              </Typography>
            </Box>
          ))}
        </_Section>
      )}

      {/* Locales */}
      {diff.localesSynced?.length > 0 && (
        <_Section
          id="locales"
          title={'Locales to sync (' + diff.localesSynced.length + ')'}
          open={openSections.includes('locales')}
          onToggle={() => toggle('locales')}
        >
          <Box padding={2} background="neutral100" borderRadius="4px">
            <Typography variant="pi">{diff.localesSynced.join(', ')}</Typography>
          </Box>
        </_Section>
      )}
    </Box>
  );
}

/** Simple collapsible section built from Box/Flex — no AccordionGroup needed */
function _Section({ id, title, open, onToggle, children }) {
  return (
    <Box marginBottom={2} borderColor="neutral200" borderWidth="1px" borderStyle="solid" borderRadius="4px" overflow="hidden">
      <Box
        padding={3}
        background={open ? 'primary100' : 'neutral0'}
        onClick={onToggle}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <Flex justifyContent="space-between" alignItems="center">
          <Typography variant="sigma" textColor={open ? 'primary600' : 'neutral700'}>
            {title}
          </Typography>
          <Typography variant="pi" textColor="neutral500">{open ? '▲' : '▼'}</Typography>
        </Flex>
      </Box>
      {open && (
        <Box padding={3} background="neutral0">
          {children}
        </Box>
      )}
    </Box>
  );
}
