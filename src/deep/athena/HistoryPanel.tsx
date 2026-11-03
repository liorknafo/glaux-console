import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { formatRanAt, summarize } from './format';
import { formatBytes, formatDuration } from '../format';
import type { HistoryEntry, SavedQuery } from './store';

export function HistoryPanel({
  entries,
  onLoad,
  onClear,
}: {
  entries: HistoryEntry[];
  onLoad(entry: HistoryEntry): void;
  onClear(): void;
}) {
  return (
    <Table
      data-testid="query-history"
      variant="embedded"
      items={entries}
      trackBy="id"
      columnDefinitions={[
        {
          id: 'sql',
          header: 'Query',
          cell: (entry: HistoryEntry) => (
            <Button variant="inline-link" onClick={() => onLoad(entry)}>
              {summarize(entry.sql)}
            </Button>
          ),
        },
        {
          id: 'state',
          header: 'State',
          cell: (entry: HistoryEntry) =>
            entry.unsupportedConstruct ? (
              <Badge color="severity-medium">UNSUPPORTED</Badge>
            ) : (
              <Badge color={entry.state === 'SUCCEEDED' ? 'green' : 'grey'}>{entry.state}</Badge>
            ),
        },
        {
          id: 'scanned',
          header: 'Data scanned',
          cell: (entry: HistoryEntry) => formatBytes(entry.dataScannedInBytes),
        },
        {
          id: 'time',
          header: 'Engine time',
          cell: (entry: HistoryEntry) => formatDuration(entry.engineExecutionTimeInMillis),
        },
        {
          id: 'database',
          header: 'Database',
          cell: (entry: HistoryEntry) => entry.database ?? '—',
        },
        { id: 'ranAt', header: 'Ran at', cell: (entry: HistoryEntry) => formatRanAt(entry.ranAt) },
      ]}
      empty={
        <Box textAlign="center" color="text-body-secondary" padding="m">
          Queries you run against this endpoint appear here.
        </Box>
      }
      header={
        <Header
          variant="h3"
          counter={`(${entries.length})`}
          description="Kept in this browser, per endpoint."
          actions={
            <Button disabled={entries.length === 0} onClick={onClear} data-testid="clear-history">
              Clear
            </Button>
          }
        >
          Recent queries
        </Header>
      }
    />
  );
}

export function SavedQueriesPanel({
  queries,
  onLoad,
  onDelete,
}: {
  queries: SavedQuery[];
  onLoad(query: SavedQuery): void;
  onDelete(query: SavedQuery): void;
}) {
  return (
    <Table
      data-testid="saved-queries"
      variant="embedded"
      items={queries}
      trackBy="id"
      columnDefinitions={[
        {
          id: 'name',
          header: 'Name',
          cell: (query: SavedQuery) => (
            <Button
              variant="inline-link"
              data-testid={`load-saved-${query.name}`}
              onClick={() => onLoad(query)}
            >
              {query.name}
            </Button>
          ),
        },
        { id: 'sql', header: 'Query', cell: (query: SavedQuery) => summarize(query.sql, 70) },
        {
          id: 'savedAt',
          header: 'Saved',
          cell: (query: SavedQuery) => formatRanAt(query.savedAt),
        },
        {
          id: 'actions',
          header: '',
          cell: (query: SavedQuery) => (
            <SpaceBetween size="xs" direction="horizontal">
              <Button
                variant="inline-link"
                data-testid={`delete-saved-${query.name}`}
                onClick={() => onDelete(query)}
              >
                Delete
              </Button>
            </SpaceBetween>
          ),
        },
      ]}
      empty={
        <Box textAlign="center" color="text-body-secondary" padding="m">
          Save a query from the editor to keep it here.
        </Box>
      }
      header={
        <Header
          variant="h3"
          counter={`(${queries.length})`}
          description="Kept in this browser, per endpoint."
        >
          Saved queries
        </Header>
      }
    />
  );
}
