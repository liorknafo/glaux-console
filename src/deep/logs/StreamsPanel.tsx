import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { formatEpochMillis } from '../format';
import { fetchLogStreams, type LogStreamSummary } from './events';

/** The streams in one log group, newest activity first. */
export function StreamsPanel({
  catalog,
  logGroupName,
  onTailStream,
}: {
  catalog: ServiceCatalog;
  logGroupName: string;
  onTailStream(name: string): void;
}) {
  const { active } = useEndpoints();
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    streams?: LogStreamSummary[];
    error?: { header: string; detail: string };
  }>();

  const key = `${active.url}|${logGroupName}|${reload}`;
  const current = loaded?.key === key ? loaded : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchLogStreams(active, catalog, logGroupName, controller.signal).then(
      streams => !controller.signal.aborted && setLoaded({ key, streams }),
      caught => !controller.signal.aborted && setLoaded({ key, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, logGroupName, key]);

  const streams = current?.streams ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = streams.filter(stream => !needle || stream.name.toLowerCase().includes(needle));

  return (
    <SpaceBetween size="l">
      {current?.error && (
        <Alert type="error" header={current.error.header} data-testid="streams-error">
          {current.error.detail}
        </Alert>
      )}

      <Table
        data-testid="stream-table"
        variant="embedded"
        loading={!current}
        loadingText="Listing log streams"
        trackBy="name"
        columnDefinitions={[
          {
            id: 'name',
            header: 'Log stream',
            cell: (stream: LogStreamSummary) => (
              <Link
                href={`#${stream.name}`}
                data-testid={`tail-stream-${stream.name}`}
                onFollow={event => {
                  event.preventDefault();
                  onTailStream(stream.name);
                }}
              >
                {stream.name}
              </Link>
            ),
          },
          {
            id: 'lastEventTimestamp',
            header: 'Last event',
            cell: (stream: LogStreamSummary) => formatEpochMillis(stream.lastEventTimestamp),
          },
          {
            id: 'firstEventTimestamp',
            header: 'First event',
            cell: (stream: LogStreamSummary) => formatEpochMillis(stream.firstEventTimestamp),
          },
          {
            id: 'lastIngestionTime',
            header: 'Last ingestion',
            cell: (stream: LogStreamSummary) => formatEpochMillis(stream.lastIngestionTime),
          },
          {
            id: 'creationTime',
            header: 'Created',
            cell: (stream: LogStreamSummary) => formatEpochMillis(stream.creationTime),
          },
        ]}
        items={visible}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            {needle ? 'No stream matches that filter.' : 'This log group has no streams.'}
          </Box>
        }
        filter={
          <TextFilter
            filteringText={filter}
            filteringPlaceholder="Find a stream"
            filteringAriaLabel="Find a stream"
            onChange={event => setFilter(event.detail.filteringText)}
          />
        }
        header={
          <Header
            variant="h3"
            counter={current?.streams ? `(${current.streams.length})` : undefined}
            description="Ordered by last event time, newest first. Choosing one narrows the tail to that stream."
            actions={
              <Button
                iconName="refresh"
                ariaLabel="Reload the stream list"
                loading={!current}
                onClick={() => setReload(count => count + 1)}
              />
            }
          >
            Log streams
          </Header>
        }
      />
    </SpaceBetween>
  );
}
