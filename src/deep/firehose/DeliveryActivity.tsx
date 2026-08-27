import { useEffect, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';
import { formatBytes, formatDateTime } from '../format';
import { byNewest, prefixOfKey, totalBytes, type ObjectListing } from './activity';
import { bucketFromLocation, listObjects, loadS3Catalog, type ObjectSummary } from '../s3/objects';
import { staticPrefixOf, type StreamDestination } from './streams';

/**
 * What the stream has actually delivered.
 *
 * Firehose reports no delivery metrics of its own without CloudWatch, so this
 * reads the destination bucket directly: the objects written under the stream's
 * prefix, and separately the records parked under its error output prefix. That
 * is the same evidence a person would go looking for by hand, and it needs
 * nothing of the target beyond S3.
 */

export function DeliveryActivity({
  endpoint,
  destination,
  reloadCount,
  onBrowse,
}: {
  endpoint: EndpointConfig;
  destination: StreamDestination;
  /** Bumped by the screen's reload button so the listing refetches. */
  reloadCount: number;
  onBrowse(bucket: string, prefix: string): void;
}) {
  const bucket = bucketFromLocation(destination.bucketArn);
  const deliveredPrefix = staticPrefixOf(destination.prefix);
  const errorPrefix = staticPrefixOf(destination.errorOutputPrefix);

  const requestKey = `${endpoint.url}|${bucket ?? ''}|${deliveredPrefix}|${errorPrefix}|${reloadCount}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    delivered?: ObjectListing;
    errors?: ObjectListing;
    error?: { header: string; detail: string };
  }>();
  const current = loaded?.key === requestKey ? loaded : undefined;

  useEffect(() => {
    if (!bucket) return;
    const controller = new AbortController();
    const catalog = loadS3Catalog();
    const listing = async (prefix: string | undefined): Promise<ObjectListing | undefined> => {
      if (prefix === undefined) return undefined;
      const s3: ServiceCatalog = await catalog;
      // Undelimited: the objects live under the expanded date partitions, so a
      // delimiter would return the partitions instead of the objects.
      const page = await listObjects(
        endpoint,
        s3,
        { bucket, prefix, delimited: false },
        controller.signal,
      );
      return { objects: page.objects, truncated: page.truncated };
    };

    Promise.all([listing(deliveredPrefix), listing(errorPrefix || undefined)]).then(
      ([delivered, errors]) =>
        !controller.signal.aborted && setLoaded({ key: requestKey, delivered, errors }),
      caught =>
        !controller.signal.aborted && setLoaded({ key: requestKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [endpoint, bucket, deliveredPrefix, errorPrefix, requestKey]);

  if (!destination.writesToS3 || !bucket) {
    return (
      <Box color="text-body-secondary" padding="s" data-testid="no-s3-destination">
        This destination does not write to S3, so there are no delivered objects to read. Its
        configuration is on the Destination tab.
      </Box>
    );
  }

  const delivered = current?.delivered?.objects ?? [];
  const errors = current?.errors?.objects ?? [];

  return (
    <SpaceBetween size="l">
      {current?.error && (
        <Box color="text-status-error" data-testid="activity-error">
          {current.error.detail}
        </Box>
      )}

      <ColumnLayout columns={4} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">Objects written</Box>
          <Box data-testid="objects-written">
            {current ? `${delivered.length}${current.delivered?.truncated ? '+' : ''}` : '—'}
          </Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Bytes delivered</Box>
          <Box data-testid="bytes-delivered">
            {current ? formatBytes(totalBytes(delivered)) : '—'}
          </Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Error-prefix objects</Box>
          <Box data-testid="error-objects">
            {errorPrefix === '' ? 'No error prefix' : current ? String(errors.length) : '—'}
          </Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Bucket</Box>
          <Box>
            <Link
              href={`#/service/s3`}
              data-testid="browse-destination"
              onFollow={event => {
                event.preventDefault();
                onBrowse(bucket, deliveredPrefix);
              }}
            >
              {bucket}
            </Link>
          </Box>
        </div>
      </ColumnLayout>

      <ObjectTable
        testId="delivered-objects"
        title="Delivered objects"
        description={`s3://${bucket}/${deliveredPrefix}`}
        objects={delivered}
        truncated={current?.delivered?.truncated ?? false}
        loading={!current}
        emptyText="This stream has written nothing under its prefix yet."
        onOpen={key => onBrowse(bucket, prefixOfKey(key))}
      />

      {errorPrefix !== '' && (
        <ObjectTable
          testId="error-objects-table"
          title="Error-prefix records"
          description={`s3://${bucket}/${errorPrefix}`}
          objects={errors}
          truncated={current?.errors?.truncated ?? false}
          loading={!current}
          emptyText="No records have been parked under the error output prefix."
          onOpen={key => onBrowse(bucket, prefixOfKey(key))}
        />
      )}
    </SpaceBetween>
  );
}

function ObjectTable({
  testId,
  title,
  description,
  objects,
  truncated,
  loading,
  emptyText,
  onOpen,
}: {
  testId: string;
  title: string;
  description: string;
  objects: ObjectSummary[];
  truncated: boolean;
  loading: boolean;
  emptyText: string;
  onOpen(key: string): void;
}) {
  return (
    <Table
      variant="embedded"
      data-testid={testId}
      loading={loading}
      loadingText="Reading the destination bucket"
      columnDefinitions={[
        {
          id: 'key',
          header: 'Key',
          cell: (object: ObjectSummary) => (
            <Link
              href="#/service/s3"
              onFollow={event => {
                event.preventDefault();
                onOpen(object.key);
              }}
            >
              {object.key}
            </Link>
          ),
        },
        { id: 'size', header: 'Size', cell: (object: ObjectSummary) => formatBytes(object.size) },
        {
          id: 'lastModified',
          header: 'Written',
          cell: (object: ObjectSummary) => formatDateTime(object.lastModified),
        },
      ]}
      items={byNewest(objects)}
      empty={
        <Box color="text-body-secondary" padding="s">
          {emptyText}
        </Box>
      }
      footer={
        truncated ? (
          <Box color="text-body-secondary" variant="small" data-testid={`${testId}-truncated`}>
            More objects exist under this prefix than one listing returns; these are the first page,
            newest first.
          </Box>
        ) : undefined
      }
      header={
        <Header
          variant="h3"
          counter={`(${objects.length}${truncated ? '+' : ''})`}
          description={description}
        >
          {title}
        </Header>
      }
    />
  );
}
