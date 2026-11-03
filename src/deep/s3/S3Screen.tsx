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
import { formatDateTime } from '../format';
import { clearS3Location, peekS3Location } from '../handoff';
import { ObjectBrowser } from './ObjectBrowser';
import { fetchBuckets, type BucketSummary } from './objects';

/**
 * The S3 screen: a bucket list, and a prefix browser for the bucket in hand.
 *
 * Parquet preview is deliberately not here — the queue entry says so, and the
 * Athena screen is where a Parquet table is meant to be read anyway.
 */
export function S3Screen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  // A handoff from another screen (Firehose's "browse delivered objects")
  // decides which bucket opens first.
  const [handoff] = useState(() => peekS3Location());
  const [bucket, setBucket] = useState<string | undefined>(handoff?.bucket);
  const [buckets, setBuckets] = useState<BucketSummary[]>();
  const [error, setError] = useState<{ header: string; detail: string }>();
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    clearS3Location();
  }, []);

  const requestKey = `${active.url}|${active.region}|${reload}`;
  const [loadedKey, setLoadedKey] = useState<string>();
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    fetchBuckets(active, catalog, controller.signal).then(
      listed => {
        if (controller.signal.aborted) return;
        setBuckets(listed);
        setError(undefined);
        setLoadedKey(requestKey);
      },
      caught => {
        if (controller.signal.aborted) return;
        setError(describeError(caught));
        setBuckets([]);
        setLoadedKey(requestKey);
      },
    );
    return () => controller.abort();
  }, [active, catalog, requestKey]);

  // Switching targets must not leave the browser open on a bucket the new
  // target may not have.
  const [scopedTo, setScopedTo] = useState(active.url);
  if (scopedTo !== active.url) {
    setScopedTo(active.url);
    setBucket(undefined);
  }

  if (bucket) {
    return (
      <ObjectBrowser
        endpoint={active}
        catalog={catalog}
        bucket={bucket}
        initialPrefix={handoff?.bucket === bucket ? handoff.prefix : undefined}
        key={`${active.url}|${bucket}`}
        onExit={() => setBucket(undefined)}
      />
    );
  }

  const needle = filter.trim().toLowerCase();
  const visible = (buckets ?? []).filter(
    entry => !needle || entry.name.toLowerCase().includes(needle),
  );

  return (
    <SpaceBetween size="l">
      {error && (
        <Alert type="error" header={error.header} data-testid="s3-error">
          {error.detail}
        </Alert>
      )}

      <Table
        data-testid="bucket-table"
        variant="container"
        loading={loading}
        loadingText="Listing buckets"
        columnDefinitions={[
          {
            id: 'name',
            header: 'Name',
            cell: (entry: BucketSummary) => (
              <Link
                href={`#${entry.name}`}
                data-testid={`open-bucket-${entry.name}`}
                onFollow={event => {
                  event.preventDefault();
                  setBucket(entry.name);
                }}
              >
                {entry.name}
              </Link>
            ),
          },
          {
            id: 'creationDate',
            header: 'Created',
            cell: (entry: BucketSummary) => formatDateTime(entry.creationDate),
          },
        ]}
        items={visible}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            {needle ? 'No bucket matches that filter.' : 'This target has no buckets yet.'}
          </Box>
        }
        filter={
          <TextFilter
            filteringText={filter}
            filteringPlaceholder="Find a bucket"
            filteringAriaLabel="Find a bucket"
            onChange={event => setFilter(event.detail.filteringText)}
          />
        }
        header={
          <Header
            variant="h2"
            counter={buckets ? `(${buckets.length})` : undefined}
            description="Buckets on the target, from ListBuckets."
            actions={
              <Button
                iconName="refresh"
                ariaLabel="Reload the bucket list"
                loading={loading}
                onClick={() => setReload(count => count + 1)}
              />
            }
          >
            Buckets
          </Header>
        }
      />
    </SpaceBetween>
  );
}
