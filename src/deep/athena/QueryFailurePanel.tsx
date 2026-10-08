import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { SQL_COVERAGE_URL, type QueryFailure } from './unsupported';

/**
 * A failed query, explained.
 *
 * An unsupported construct is not an error in the usual sense — nothing is
 * broken and retrying will not help — so it renders as a warning that names the
 * construct and points at the coverage table, which is glaux's "never silently
 * wrong" rule made visible. Everything else renders as the error it is.
 */
export function QueryFailurePanel({ failure }: { failure: QueryFailure }) {
  if (failure.kind === 'unsupported-construct') {
    return (
      <Alert
        type="warning"
        header={
          failure.construct
            ? `Unsupported SQL construct: ${failure.construct}`
            : 'Unsupported SQL construct'
        }
        data-testid="unsupported-construct"
      >
        <SpaceBetween size="s">
          <Box variant="p">
            The target refused this query rather than answering it approximately. That is by design:
            an engine that does not implement a construct says so instead of returning results that
            are quietly wrong.
          </Box>
          <Box variant="code" data-testid="failure-message">
            {failure.message}
          </Box>
          <Box variant="p">
            Rewrite the query without{' '}
            {failure.construct ? <b>{failure.construct}</b> : 'the construct above'}, or check{' '}
            <Link href={SQL_COVERAGE_URL} external target="_blank">
              glaux&apos;s SQL coverage table
            </Link>{' '}
            for what this release implements.
          </Box>
        </SpaceBetween>
      </Alert>
    );
  }

  return (
    <Alert type="error" header="Query failed" data-testid="query-failed">
      <SpaceBetween size="s">
        <Box variant="code" data-testid="failure-message">
          {failure.message}
        </Box>
        {(failure.category || failure.errorType !== undefined) && (
          <Box variant="small">
            {failure.category ? `Error category: ${failure.category}` : null}
            {failure.category && failure.errorType !== undefined ? ' · ' : null}
            {failure.errorType !== undefined ? `Error type: ${failure.errorType}` : null}
            {failure.retryable ? ' · The target reports this query may succeed if retried.' : null}
          </Box>
        )}
      </SpaceBetween>
    </Alert>
  );
}
