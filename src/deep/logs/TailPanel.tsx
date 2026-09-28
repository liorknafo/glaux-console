import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { formatEpochMillisPrecise } from '../format';
import {
  emptyTail,
  fetchTailPage,
  mergeTail,
  tailStartTime,
  MAX_TAIL_EVENTS,
  TAIL_INTERVAL_MS,
  type LogEvent,
  type TailState,
} from './events';

/**
 * The tail: every stream in one log group, read forward from a moving window.
 *
 * It is a polled tail rather than a live subscription — see `events.ts` for why
 * — and the panel says so rather than implying a stream the request path does
 * not carry. Following is off until it is started, so opening the screen sends
 * one request and then nothing.
 */
export function TailPanel({
  catalog,
  logGroupName,
  logStreamName,
  onClearStream,
}: {
  catalog: ServiceCatalog;
  logGroupName: string;
  /** Set from the Streams tab to narrow the tail to one stream. */
  logStreamName?: string;
  onClearStream(): void;
}) {
  const { active } = useEndpoints();
  const [filterPattern, setFilterPattern] = useState('');
  // The pattern is only sent when it is applied, so typing does not re-poll on
  // every keystroke against a half-written pattern.
  const [appliedPattern, setAppliedPattern] = useState('');
  const [following, setFollowing] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<{ header: string; detail: string }>();
  const [truncated, setTruncated] = useState(false);

  const [tail, setTail] = useState<TailState>(emptyTail);
  // One poll at a time: a target slower than the interval would otherwise stack
  // requests, and each would advance the window from the same start.
  const inFlight = useRef(false);
  // Which scope a poll was started under. A poll still in flight when the group,
  // stream or pattern changes belongs to the previous one, and its events must
  // not land in the fresh tail.
  const sequence = useRef(0);

  // The window belongs to one group, one stream selection and one pattern.
  // Changing any of them makes the events already on screen the wrong answer.
  const scope = `${active.url}|${logGroupName}|${logStreamName ?? ''}|${appliedPattern}`;
  const [scopedTo, setScopedTo] = useState(scope);
  if (scopedTo !== scope) {
    setScopedTo(scope);
    setTail(emptyTail());
    setError(undefined);
    setTruncated(false);
    setPolling(false);
  }

  useEffect(() => {
    sequence.current += 1;
    inFlight.current = false;
  }, [scope]);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    sequence.current += 1;
    const started = sequence.current;
    const current = () => sequence.current === started;
    setPolling(true);
    try {
      const page = await fetchTailPage(active, catalog, {
        logGroupName,
        startTime: tailStartTime(tail, Date.now()),
        filterPattern: appliedPattern || undefined,
        logStreamNames: logStreamName ? [logStreamName] : undefined,
      });
      if (!current()) return;
      // Merging from the state at hand rather than from `tail` keeps a poll
      // that overlapped a render from dropping what the last one added.
      setTail(existing => mergeTail(existing, page.events));
      setTruncated(page.truncated);
      setError(undefined);
    } catch (caught) {
      if (!current()) return;
      // A failed poll stops the tail rather than retrying into the same error
      // every two seconds.
      setFollowing(false);
      setError(describeError(caught));
    } finally {
      if (current()) {
        inFlight.current = false;
        setPolling(false);
      }
    }
  }, [active, catalog, logGroupName, logStreamName, appliedPattern, tail]);

  // `poll` closes over the tail, so it is a new function after every poll that
  // brought something. The interval reads the newest through this rather than
  // being torn down and rebuilt — which would restart the clock on every event.
  const latestPoll = useRef(poll);
  useEffect(() => {
    latestPoll.current = poll;
  }, [poll]);

  useEffect(() => {
    if (!following) return;
    void latestPoll.current();
    const timer = setInterval(() => void latestPoll.current(), TAIL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [following]);

  return (
    <SpaceBetween size="l">
      <Grid
        gridDefinition={[{ colspan: { default: 12, s: 8 } }, { colspan: { default: 12, s: 4 } }]}
      >
        <FormField
          label="Filter pattern"
          description="CloudWatch filter-pattern syntax, evaluated by the target. Empty matches everything."
        >
          <Input
            value={filterPattern}
            placeholder="?ERROR ?Exception"
            onChange={event => setFilterPattern(event.detail.value)}
            onKeyDown={event => {
              if (event.detail.key === 'Enter') setAppliedPattern(filterPattern.trim());
            }}
          />
        </FormField>
        <FormField label="Stream">
          {logStreamName ? (
            <SpaceBetween direction="horizontal" size="xs">
              <Box padding={{ top: 'xxs' }} data-testid="tail-stream">
                {logStreamName}
              </Box>
              <Button data-testid="tail-all-streams" onClick={onClearStream}>
                Tail the whole group
              </Button>
            </SpaceBetween>
          ) : (
            <Box padding={{ top: 'xxs' }} color="text-body-secondary" data-testid="tail-all">
              Every stream in the group
            </Box>
          )}
        </FormField>
      </Grid>

      {error && (
        <Alert type="error" header={error.header} data-testid="tail-error">
          {error.detail}
        </Alert>
      )}

      {truncated && (
        <Alert type="info" header="Showing part of this window" data-testid="tail-truncated">
          The target had more events in this window than one poll reads. The newest are shown;
          narrow the filter pattern or pick a single stream to see fewer, older ones.
        </Alert>
      )}

      <Table
        data-testid="tail-table"
        variant="embedded"
        loading={polling && tail.events.length === 0}
        loadingText="Reading log events"
        resizableColumns
        wrapLines
        columnDefinitions={[
          {
            id: 'timestamp',
            header: 'Time',
            width: 160,
            cell: (event: LogEvent) => formatEpochMillisPrecise(event.timestamp),
          },
          {
            id: 'stream',
            header: 'Stream',
            width: 220,
            cell: (event: LogEvent) => event.logStreamName ?? '–',
          },
          {
            id: 'message',
            header: 'Message',
            cell: (event: LogEvent) => (
              <Box variant="code" fontSize="body-s">
                {event.message}
              </Box>
            ),
          },
        ]}
        items={tail.events}
        trackBy={event => event.eventId ?? `${event.logStreamName}|${event.timestamp}`}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            <span data-testid="tail-empty">
              No events yet. The tail reads forward from five minutes ago; start it and write to the
              group to see events arrive.
            </span>
          </Box>
        }
        header={
          <Header
            variant="h3"
            counter={`(${tail.events.length})`}
            description={`Polled every ${TAIL_INTERVAL_MS / 1000} s with FilterLogEvents across the group. CloudWatch's own live tail is an event stream this console's request path does not carry.`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {following ? (
                  <StatusIndicator type="loading">Following</StatusIndicator>
                ) : (
                  <Badge color="grey">Paused</Badge>
                )}
                <Button
                  data-testid="tail-apply-filter"
                  disabled={filterPattern.trim() === appliedPattern}
                  onClick={() => setAppliedPattern(filterPattern.trim())}
                >
                  Apply filter
                </Button>
                <Button data-testid="tail-refresh" loading={polling} onClick={() => void poll()}>
                  Refresh
                </Button>
                <Button
                  variant="primary"
                  data-testid="tail-follow"
                  onClick={() => setFollowing(current => !current)}
                >
                  {following ? 'Stop' : 'Start tailing'}
                </Button>
              </SpaceBetween>
            }
          >
            Events
          </Header>
        }
        footer={
          tail.dropped > 0 ? (
            <Box color="text-body-secondary" fontSize="body-s" data-testid="tail-dropped">
              {tail.dropped} older event{tail.dropped === 1 ? '' : 's'} dropped — the panel keeps
              the most recent {MAX_TAIL_EVENTS}.
            </Box>
          ) : undefined
        }
      />
    </SpaceBetween>
  );
}
