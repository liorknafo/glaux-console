import { useEffect, useState, type ReactNode } from 'react';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';
import { formatDateTime } from '../format';
import { fetchPartitions, type GlueColumn, type GluePartition, type GlueTable } from './catalog';
import { readPartitionProjection, type ProjectedColumn } from './projection';

/**
 * Everything the catalog records about one table: its columns, its partitions,
 * how it is stored and deserialized, and whether Athena projects its partitions
 * instead of listing them.
 */
export function TableDetail({
  endpoint,
  glue,
  databaseName,
  table,
  onQuery,
}: {
  endpoint: EndpointConfig;
  glue: ServiceCatalog;
  databaseName: string;
  table: GlueTable;
  onQuery(): void;
}) {
  const projection = readPartitionProjection(table.parameters);
  const partitionKeys = table.columns.filter(column => column.partitionKey);

  return (
    <Container
      data-testid="table-detail"
      header={
        <Header
          variant="h2"
          description={table.description ?? table.storage.location ?? 'No location recorded'}
          actions={
            <Button variant="primary" data-testid="query-this-table" onClick={onQuery}>
              Query this table
            </Button>
          }
        >
          {table.name}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <ColumnLayout columns={4} variant="text-grid">
          <Field label="Database">{databaseName}</Field>
          <Field label="Table type">{table.tableType ?? '—'}</Field>
          <Field label="Partition keys">
            {partitionKeys.length > 0 ? partitionKeys.map(key => key.name).join(', ') : 'None'}
          </Field>
          <Field label="Created">{formatDateTime(table.createTime)}</Field>
        </ColumnLayout>

        <Tabs
          tabs={[
            {
              id: 'columns',
              label: `Columns (${table.columns.length})`,
              content: <ColumnsTable columns={table.columns} />,
            },
            {
              id: 'partitions',
              label: 'Partitions',
              content: (
                <PartitionsTable
                  endpoint={endpoint}
                  glue={glue}
                  databaseName={databaseName}
                  table={table}
                  projectionEnabled={projection.enabled}
                />
              ),
            },
            {
              id: 'storage',
              label: 'Storage and SerDe',
              content: <StoragePanel table={table} />,
            },
            {
              id: 'projection',
              label: 'Partition projection',
              content: <ProjectionPanel table={table} />,
            },
            {
              id: 'parameters',
              label: `Parameters (${Object.keys(table.parameters).length})`,
              content: (
                <ParametersTable
                  parameters={table.parameters}
                  testId="table-parameters"
                  emptyText="This table records no parameters."
                />
              ),
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}

function ColumnsTable({ columns }: { columns: GlueColumn[] }) {
  return (
    <Table
      variant="embedded"
      data-testid="columns-table"
      columnDefinitions={[
        {
          id: 'name',
          header: 'Name',
          cell: (column: GlueColumn) => (
            <SpaceBetween size="xxs" direction="horizontal">
              <span>{column.name}</span>
              {column.partitionKey && <Badge color="blue">partition</Badge>}
            </SpaceBetween>
          ),
        },
        { id: 'type', header: 'Type', cell: (column: GlueColumn) => column.type ?? 'unknown' },
        { id: 'comment', header: 'Comment', cell: (column: GlueColumn) => column.comment ?? '—' },
      ]}
      items={columns}
      empty={
        <Box color="text-body-secondary" padding="s">
          The catalog records no columns for this table.
        </Box>
      }
    />
  );
}

function PartitionsTable({
  endpoint,
  glue,
  databaseName,
  table,
  projectionEnabled,
}: {
  endpoint: EndpointConfig;
  glue: ServiceCatalog;
  databaseName: string;
  table: GlueTable;
  projectionEnabled: boolean;
}) {
  const partitionKeys = table.columns.filter(column => column.partitionKey);
  const [reload, setReload] = useState(0);
  const requestKey = `${endpoint.url}|${databaseName}|${table.name}|${reload}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    partitions?: GluePartition[];
    error?: { header: string; detail: string };
  }>();
  const current = loaded?.key === requestKey ? loaded : undefined;

  useEffect(() => {
    if (partitionKeys.length === 0) return;
    const controller = new AbortController();
    fetchPartitions(endpoint, glue, databaseName, table.name, controller.signal).then(
      partitions => !controller.signal.aborted && setLoaded({ key: requestKey, partitions }),
      caught =>
        !controller.signal.aborted && setLoaded({ key: requestKey, error: describeError(caught) }),
    );
    return () => controller.abort();
    // `partitionKeys` is derived from `table`, which the request key covers.
  }, [endpoint, glue, databaseName, table.name, requestKey, partitionKeys.length]);

  if (partitionKeys.length === 0) {
    return (
      <Box color="text-body-secondary" padding="s" data-testid="unpartitioned">
        This table is not partitioned.
      </Box>
    );
  }

  return (
    <SpaceBetween size="s">
      {projectionEnabled && (
        <Box color="text-body-secondary" data-testid="projection-note">
          Partition projection is enabled on this table, so Athena computes partitions from the
          table’s parameters. The catalog may hold none of them.
        </Box>
      )}
      {current?.error && (
        <Box color="text-status-error" data-testid="partitions-error">
          {current.error.detail}
        </Box>
      )}
      <Table
        variant="embedded"
        data-testid="partitions-table"
        loading={!current}
        loadingText="Listing partitions"
        columnDefinitions={[
          ...partitionKeys.map((key, index) => ({
            id: `key-${key.name}`,
            header: key.name,
            cell: (partition: GluePartition) => partition.values[index] ?? '—',
          })),
          {
            id: 'location',
            header: 'Location',
            cell: (partition: GluePartition) => partition.location ?? '—',
          },
          {
            id: 'created',
            header: 'Created',
            cell: (partition: GluePartition) => formatDateTime(partition.creationTime),
          },
        ]}
        items={current?.partitions ?? []}
        empty={
          <Box color="text-body-secondary" padding="s">
            The catalog holds no partitions for this table.
          </Box>
        }
        header={
          <Header variant="h3" counter={`(${current?.partitions?.length ?? 0})`}>
            Partitions
          </Header>
        }
      />
      <Button iconName="refresh" onClick={() => setReload(count => count + 1)}>
        Reload partitions
      </Button>
    </SpaceBetween>
  );
}

function StoragePanel({ table }: { table: GlueTable }) {
  const { storage } = table;
  return (
    <SpaceBetween size="l">
      <ColumnLayout columns={3} variant="text-grid">
        <Field label="Location">
          <span data-testid="storage-location">{storage.location ?? '—'}</span>
        </Field>
        <Field label="Input format">{storage.inputFormat ?? '—'}</Field>
        <Field label="Output format">{storage.outputFormat ?? '—'}</Field>
        <Field label="Serialization library">
          <span data-testid="serde-library">{storage.serde?.serializationLibrary ?? '—'}</span>
        </Field>
        <Field label="Compressed">{storage.compressed ? 'Yes' : 'No'}</Field>
        <Field label="Buckets">
          {storage.numberOfBuckets
            ? `${storage.numberOfBuckets} on ${storage.bucketColumns.join(', ') || 'unnamed columns'}`
            : 'Not bucketed'}
        </Field>
      </ColumnLayout>

      <ParametersTable
        parameters={storage.serde?.parameters ?? {}}
        testId="serde-parameters"
        emptyText="The SerDe records no parameters."
        title="SerDe parameters"
      />
    </SpaceBetween>
  );
}

function ProjectionPanel({ table }: { table: GlueTable }) {
  const projection = readPartitionProjection(table.parameters);

  if (!projection.configured) {
    return (
      <Box color="text-body-secondary" padding="s" data-testid="no-projection">
        This table does not configure partition projection.
      </Box>
    );
  }

  return (
    <SpaceBetween size="m">
      <StatusIndicator
        type={projection.enabled ? 'success' : 'stopped'}
        data-testid="projection-state"
      >
        {projection.enabled
          ? 'Partition projection is enabled'
          : 'Partition projection is configured but switched off'}
      </StatusIndicator>

      {projection.storageLocationTemplate && (
        <div>
          <Box variant="awsui-key-label">Storage location template</Box>
          <Box data-testid="projection-template">{projection.storageLocationTemplate}</Box>
        </div>
      )}

      <Table
        variant="embedded"
        data-testid="projection-table"
        columnDefinitions={[
          { id: 'column', header: 'Column', cell: (entry: ProjectedColumn) => entry.column },
          { id: 'type', header: 'Type', cell: (entry: ProjectedColumn) => entry.type ?? '—' },
          {
            id: 'settings',
            header: 'Settings',
            cell: (entry: ProjectedColumn) =>
              Object.entries(entry.settings)
                .map(([name, value]) => `${name} = ${value}`)
                .join('; ') || '—',
          },
        ]}
        items={projection.columns}
        empty={
          <Box color="text-body-secondary" padding="s">
            No column declares a projection type.
          </Box>
        }
      />
    </SpaceBetween>
  );
}

export function ParametersTable({
  parameters,
  testId,
  emptyText,
  title,
}: {
  parameters: Record<string, string>;
  testId: string;
  emptyText: string;
  title?: string;
}) {
  const items = Object.entries(parameters).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <Table
      variant="embedded"
      data-testid={testId}
      columnDefinitions={[
        { id: 'key', header: 'Key', cell: (entry: [string, string]) => entry[0] },
        { id: 'value', header: 'Value', cell: (entry: [string, string]) => entry[1] },
      ]}
      items={items}
      empty={
        <Box color="text-body-secondary" padding="s">
          {emptyText}
        </Box>
      }
      header={title ? <Header variant="h3">{title}</Header> : undefined}
    />
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
