import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, {
  type StatusIndicatorProps,
} from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { formatBytes, formatDuration } from '../format';
import type { QueryExecutionSnapshot, QueryState, ResultPage } from './types';

/**
 * Query status and results: the state, what the query cost, and the rows.
 *
 * Paging follows `GetQueryResults`' own `NextToken` — pages already fetched
 * stay in memory, and the next one is only requested when the user asks for it.
 */

const STATUS_TYPE: Record<QueryState, StatusIndicatorProps.Type> = {
  QUEUED: 'pending',
  RUNNING: 'in-progress',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'stopped',
  UNKNOWN: 'info',
};

export function QueryStatusLine({ snapshot }: { snapshot: QueryExecutionSnapshot }) {
  const statistics = snapshot.statistics ?? {};
  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={
            <StatusIndicator type={STATUS_TYPE[snapshot.state]} data-testid="query-state">
              {snapshot.state}
            </StatusIndicator>
          }
        >
          Query execution
        </Header>
      }
    >
      <ColumnLayout columns={4} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">Data scanned</Box>
          <Box data-testid="bytes-scanned">{formatBytes(statistics.dataScannedInBytes)}</Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Engine time</Box>
          <Box data-testid="engine-time">
            {formatDuration(statistics.engineExecutionTimeInMillis)}
          </Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Total run time</Box>
          <Box>{formatDuration(statistics.totalExecutionTimeInMillis)}</Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Execution ID</Box>
          <Box data-testid="query-execution-id">{snapshot.id}</Box>
        </div>
        {snapshot.statementType && (
          <div>
            <Box variant="awsui-key-label">Statement type</Box>
            <Box>{snapshot.statementType}</Box>
          </div>
        )}
        {statistics.queryQueueTimeInMillis !== undefined && (
          <div>
            <Box variant="awsui-key-label">Queue time</Box>
            <Box>{formatDuration(statistics.queryQueueTimeInMillis)}</Box>
          </div>
        )}
        {statistics.queryPlanningTimeInMillis !== undefined && (
          <div>
            <Box variant="awsui-key-label">Planning time</Box>
            <Box>{formatDuration(statistics.queryPlanningTimeInMillis)}</Box>
          </div>
        )}
        {snapshot.outputLocation && (
          <div>
            <Box variant="awsui-key-label">Result location</Box>
            <Box>{snapshot.outputLocation}</Box>
          </div>
        )}
      </ColumnLayout>
    </Container>
  );
}

export function ResultsPanel({
  pages,
  pageIndex,
  loading,
  updateCount,
  onPageChange,
  onFetchNext,
}: {
  pages: ResultPage[];
  pageIndex: number;
  loading: boolean;
  updateCount?: number;
  onPageChange(index: number): void;
  onFetchNext(token: string): void;
}) {
  const page = pages[pageIndex];
  const columns = pages[0]?.columns ?? [];

  if (columns.length === 0 && updateCount !== undefined) {
    return (
      <Container header={<Header variant="h2">Results</Header>}>
        <Box data-testid="update-count">
          {updateCount} {updateCount === 1 ? 'row' : 'rows'} written.
        </Box>
      </Container>
    );
  }

  return (
    <Table
      data-testid="query-results"
      variant="container"
      loading={loading}
      loadingText="Fetching results"
      resizableColumns
      columnDefinitions={columns.map((column, index) => ({
        id: column.name || `column-${index}`,
        header: (
          <SpaceBetween size="xxs" direction="horizontal">
            <span>{column.label || column.name}</span>
            {column.type && <Badge color="grey">{column.type}</Badge>}
          </SpaceBetween>
        ),
        cell: (row: (string | undefined)[]) =>
          row[index] === undefined ? (
            <Box color="text-body-secondary" variant="small">
              null
            </Box>
          ) : (
            row[index]
          ),
      }))}
      items={page?.rows ?? []}
      empty={
        <Box textAlign="center" color="text-body-secondary" padding="m">
          The query returned no rows.
        </Box>
      }
      header={
        <Header variant="h2" counter={`(${page?.rows.length ?? 0})`}>
          Results
        </Header>
      }
      pagination={
        <Pagination
          currentPageIndex={pageIndex + 1}
          pagesCount={Math.max(pages.length, 1)}
          openEnd={Boolean(page?.nextToken)}
          disabled={loading}
          ariaLabels={{
            nextPageLabel: 'Next page',
            previousPageLabel: 'Previous page',
            pageLabel: pageNumber => `Page ${pageNumber}`,
          }}
          onChange={event => {
            const requested = event.detail.currentPageIndex - 1;
            if (requested < pages.length) onPageChange(requested);
          }}
          onNextPageClick={() => {
            if (pageIndex === pages.length - 1 && page?.nextToken) onFetchNext(page.nextToken);
            else if (pageIndex < pages.length - 1) onPageChange(pageIndex + 1);
          }}
          onPreviousPageClick={() => onPageChange(Math.max(0, pageIndex - 1))}
        />
      }
    />
  );
}
