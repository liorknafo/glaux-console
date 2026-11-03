import { useEffect, useState, type ReactNode } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import TextFilter from '@cloudscape-design/components/text-filter';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { formatBytes, formatDateTime } from '../format';
import { ItemBrowser } from './ItemBrowser';
import {
  describeTable,
  fetchTableNames,
  type SecondaryIndex,
  type TableDescription,
} from './tables';

/**
 * The DynamoDB screen: the tables on the target, one table's key schema and
 * indexes, and a browser for its items.
 */
export function DynamoDbScreen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);

  const listKey = `${active.url}|${active.region}|${reload}`;
  const [listed, setListed] = useState<{
    key: string;
    names?: string[];
    error?: { header: string; detail: string };
  }>();
  const currentList = listed?.key === listKey ? listed : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchTableNames(active, catalog, controller.signal).then(
      names => !controller.signal.aborted && setListed({ key: listKey, names }),
      caught =>
        !controller.signal.aborted && setListed({ key: listKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, listKey]);

  // Switching targets must not leave a table from the previous one selected.
  const [scopedTo, setScopedTo] = useState(active.url);
  if (scopedTo !== active.url) {
    setScopedTo(active.url);
    setSelected(undefined);
  }

  const needle = filter.trim().toLowerCase();
  const rows = (currentList?.names ?? [])
    .filter(name => !needle || name.toLowerCase().includes(needle))
    .map(name => ({ name }));

  if (selected) {
    return (
      <TableDetail
        key={`${active.url}|${selected}`}
        catalog={catalog}
        tableName={selected}
        onExit={() => setSelected(undefined)}
      />
    );
  }

  return (
    <SpaceBetween size="l">
      {currentList?.error && (
        <Alert type="error" header={currentList.error.header} data-testid="dynamodb-error">
          {currentList.error.detail}
        </Alert>
      )}

      <Table
        data-testid="table-list"
        variant="container"
        loading={!currentList}
        loadingText="Listing tables"
        columnDefinitions={[
          {
            id: 'name',
            header: 'Table',
            cell: (row: { name: string }) => (
              <Link
                href={`#${row.name}`}
                data-testid={`open-table-${row.name}`}
                onFollow={event => {
                  event.preventDefault();
                  setSelected(row.name);
                }}
              >
                {row.name}
              </Link>
            ),
          },
        ]}
        items={rows}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            {needle ? 'No table matches that filter.' : 'This target has no tables.'}
          </Box>
        }
        filter={
          <TextFilter
            filteringText={filter}
            filteringPlaceholder="Find a table"
            filteringAriaLabel="Find a table"
            onChange={event => setFilter(event.detail.filteringText)}
          />
        }
        header={
          <Header
            variant="h2"
            counter={currentList?.names ? `(${currentList.names.length})` : undefined}
            description="Tables on the target, from ListTables."
            actions={
              <Button
                iconName="refresh"
                ariaLabel="Reload the table list"
                loading={!currentList}
                onClick={() => setReload(count => count + 1)}
              />
            }
          >
            Tables
          </Header>
        }
      />
    </SpaceBetween>
  );
}

function TableDetail({
  catalog,
  tableName,
  onExit,
}: {
  catalog: ServiceCatalog;
  tableName: string;
  onExit(): void;
}) {
  const { active } = useEndpoints();
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    table?: TableDescription;
    error?: { header: string; detail: string };
  }>();

  const key = `${active.url}|${tableName}|${reload}`;
  const current = loaded?.key === key ? loaded : undefined;
  const table = current?.table ?? loaded?.table;

  useEffect(() => {
    const controller = new AbortController();
    describeTable(active, catalog, tableName, controller.signal).then(
      described => !controller.signal.aborted && setLoaded({ key, table: described }),
      caught => !controller.signal.aborted && setLoaded({ key, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, tableName, key]);

  return (
    <SpaceBetween size="l">
      {current?.error && (
        <Alert type="error" header={current.error.header} data-testid="table-error">
          {current.error.detail}
        </Alert>
      )}

      <Container
        data-testid="table-detail"
        header={
          <Header
            variant="h2"
            description={table?.arn}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <StatusIndicator type={table?.status === 'ACTIVE' ? 'success' : 'in-progress'}>
                  {table?.status ?? 'UNKNOWN'}
                </StatusIndicator>
                <Button
                  iconName="refresh"
                  ariaLabel="Reload this table"
                  loading={!current}
                  onClick={() => setReload(count => count + 1)}
                />
                <Button data-testid="back-to-tables" onClick={onExit}>
                  All tables
                </Button>
              </SpaceBetween>
            }
          >
            {tableName}
          </Header>
        }
      >
        <SpaceBetween size="l">
          <ColumnLayout columns={4} variant="text-grid">
            <Field label="Partition key">
              <span data-testid="partition-key">
                {table?.keySchema.find(element => element.type === 'HASH')?.name ?? '—'}
              </span>
            </Field>
            <Field label="Sort key">
              <span data-testid="sort-key">
                {table?.keySchema.find(element => element.type === 'RANGE')?.name ?? '—'}
              </span>
            </Field>
            <Field label="Items">
              <span data-testid="item-count">{table?.itemCount ?? '—'}</span>
            </Field>
            <Field label="Size">{formatBytes(table?.sizeBytes)}</Field>
            <Field label="Created">{formatDateTime(table?.creationDateTime)}</Field>
            <Field label="Billing mode">{table?.billingMode ?? 'PROVISIONED'}</Field>
            <Field label="Capacity">
              {table?.readCapacityUnits === undefined
                ? '—'
                : `${table.readCapacityUnits} read / ${table.writeCapacityUnits ?? 0} write`}
            </Field>
            <Field label="Stream">
              {table?.streamEnabled ? (table.streamViewType ?? 'Enabled') : 'Disabled'}
            </Field>
          </ColumnLayout>

          {table && (
            <Tabs
              tabs={[
                {
                  id: 'items',
                  label: 'Items',
                  content: (
                    <ItemBrowser
                      catalog={catalog}
                      table={table}
                      onChanged={() => setReload(count => count + 1)}
                    />
                  ),
                },
                {
                  id: 'indexes',
                  label: 'Indexes',
                  content: <IndexTable table={table} />,
                },
                {
                  id: 'schema',
                  label: 'Attribute definitions',
                  content: <AttributeDefinitions table={table} />,
                },
              ]}
            />
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

function IndexTable({ table }: { table: TableDescription }) {
  return (
    <Table
      data-testid="index-table"
      variant="embedded"
      columnDefinitions={[
        { id: 'name', header: 'Index', cell: (index: SecondaryIndex) => index.name },
        {
          id: 'kind',
          header: 'Type',
          cell: (index: SecondaryIndex) => (
            <Badge color={index.kind === 'global' ? 'blue' : 'grey'}>
              {index.kind === 'global' ? 'Global' : 'Local'}
            </Badge>
          ),
        },
        {
          id: 'keys',
          header: 'Keys',
          cell: (index: SecondaryIndex) =>
            index.keySchema.map(element => `${element.name} (${element.type})`).join(', ') || '—',
        },
        {
          id: 'projection',
          header: 'Projection',
          cell: (index: SecondaryIndex) =>
            index.projectionType === 'INCLUDE'
              ? `INCLUDE: ${index.nonKeyAttributes.join(', ')}`
              : (index.projectionType ?? '—'),
        },
        {
          id: 'status',
          header: 'Status',
          cell: (index: SecondaryIndex) => index.status ?? '—',
        },
      ]}
      items={table.indexes}
      empty={
        <Box textAlign="center" color="text-body-secondary" padding="m">
          This table has no secondary indexes.
        </Box>
      }
      header={
        <Header
          variant="h3"
          description="A query can read the table or any of these; a global index cannot be read consistently."
        >
          Secondary indexes
        </Header>
      }
    />
  );
}

function AttributeDefinitions({ table }: { table: TableDescription }) {
  return (
    <Table
      data-testid="attribute-definitions"
      variant="embedded"
      columnDefinitions={[
        {
          id: 'name',
          header: 'Attribute',
          cell: (row: { name: string; type: string }) => row.name,
        },
        {
          id: 'type',
          header: 'Type',
          cell: (row: { name: string; type: string }) =>
            ({ S: 'String', N: 'Number', B: 'Binary' })[row.type] ?? row.type,
        },
      ]}
      items={table.attributeDefinitions}
      empty={
        <Box textAlign="center" color="text-body-secondary" padding="m">
          The target declared no attribute definitions.
        </Box>
      }
      header={
        <Header
          variant="h3"
          description="Only key attributes are declared — everything else about an item is up to the item."
        >
          Attribute definitions
        </Header>
      }
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
