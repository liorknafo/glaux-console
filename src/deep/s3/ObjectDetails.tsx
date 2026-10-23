import type { ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';
import { formatBytes, formatDateTime } from '../format';
import type { ObjectMetadata } from './objects';

/** Everything `HeadObject` reports about the selected object. */
export function ObjectDetails({
  objectKey,
  metadata,
  loading,
}: {
  objectKey: string;
  metadata?: ObjectMetadata;
  loading: boolean;
}) {
  const userMetadata = Object.entries(metadata?.userMetadata ?? {});

  return (
    <Container
      data-testid="object-details"
      header={
        <Header variant="h2" description={objectKey}>
          Object metadata
        </Header>
      }
    >
      {loading && !metadata ? (
        <Spinner />
      ) : (
        <SpaceBetween size="l">
          <ColumnLayout columns={4} variant="text-grid">
            <Field label="Size">
              <span data-testid="metadata-size">{formatBytes(metadata?.contentLength)}</span>
            </Field>
            <Field label="Content type">{metadata?.contentType ?? '—'}</Field>
            <Field label="Last modified">{formatDateTime(metadata?.lastModified)}</Field>
            <Field label="ETag">{metadata?.etag ?? '—'}</Field>
            <Field label="Storage class">{metadata?.storageClass ?? 'STANDARD'}</Field>
            <Field label="Content encoding">{metadata?.contentEncoding ?? '—'}</Field>
            <Field label="Cache control">{metadata?.cacheControl ?? '—'}</Field>
            <Field label="Server-side encryption">{metadata?.serverSideEncryption ?? '—'}</Field>
            {metadata?.versionId && <Field label="Version ID">{metadata.versionId}</Field>}
          </ColumnLayout>

          <Table
            variant="embedded"
            data-testid="user-metadata"
            columnDefinitions={[
              { id: 'key', header: 'Key', cell: (entry: [string, string]) => entry[0] },
              { id: 'value', header: 'Value', cell: (entry: [string, string]) => entry[1] },
            ]}
            items={userMetadata}
            empty={
              <Box color="text-body-secondary" padding="s">
                This object carries no user metadata.
              </Box>
            }
            header={
              <Header variant="h3" description="x-amz-meta-* headers on the object">
                User metadata
              </Header>
            }
          />
        </SpaceBetween>
      )}
    </Container>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box>{children}</Box>
    </div>
  );
}
