import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import { useEndpoints } from '../../endpoints/context';
import { formatDateTime } from '../format';
import { stashAthenaQuery } from '../handoff';
import {
  fetchDatabases,
  fetchTables,
  selectStatement,
  type GlueDatabase,
  type GlueTable,
} from './catalog';
import { TableDetail } from './TableDetail';

/**
 * The Glue catalog browser: databases, their tables, and one table in detail.
 *
 * "Query this table" hands the Athena screen a statement and the database to
 * run it in, which is the other half of the prefill the Athena schema tree
 * already does from its side.
 */
export function GlueScreen({ catalog }: { catalog: ServiceCatalog }) {
  const { active } = useEndpoints();
  const navigate = useNavigate();

  const [database, setDatabase] = useState<string>();
  const [table, setTable] = useState<string>();
  const [databaseFilter, setDatabaseFilter] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [reload, setReload] = useState(0);

  const databasesKey = `${active.url}|${active.region}|${reload}`;
  const [databases, setDatabases] = useState<{
    key: string;
    list?: GlueDatabase[];
    error?: { header: string; detail: string };
  }>();
  const currentDatabases = databases?.key === databasesKey ? databases : undefined;

  useEffect(() => {
    const controller = new AbortController();
    fetchDatabases(active, catalog, controller.signal).then(
      list => !controller.signal.aborted && setDatabases({ key: databasesKey, list }),
      caught =>
        !controller.signal.aborted &&
        setDatabases({ key: databasesKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, databasesKey]);

  const tablesKey = database ? `${databasesKey}|${database}` : undefined;
  const [tables, setTables] = useState<{
    key: string;
    list?: GlueTable[];
    error?: { header: string; detail: string };
  }>();
  const currentTables = tablesKey && tables?.key === tablesKey ? tables : undefined;

  useEffect(() => {
    if (!database || !tablesKey) return;
    const controller = new AbortController();
    fetchTables(active, catalog, database, controller.signal).then(
      list => !controller.signal.aborted && setTables({ key: tablesKey, list }),
      caught =>
        !controller.signal.aborted && setTables({ key: tablesKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [active, catalog, database, tablesKey]);

  // Switching targets must not leave a database from the previous one selected.
  const [scopedTo, setScopedTo] = useState(active.url);
  if (scopedTo !== active.url) {
    setScopedTo(active.url);
    setDatabase(undefined);
    setTable(undefined);
  }

  const databaseNeedle = databaseFilter.trim().toLowerCase();
  const visibleDatabases = (currentDatabases?.list ?? []).filter(
    entry => !databaseNeedle || entry.name.toLowerCase().includes(databaseNeedle),
  );

  const tableNeedle = tableFilter.trim().toLowerCase();
  const visibleTables = (currentTables?.list ?? []).filter(
    entry => !tableNeedle || entry.name.toLowerCase().includes(tableNeedle),
  );
  const selectedTable = currentTables?.list?.find(entry => entry.name === table);

  function queryTable(databaseName: string, target: GlueTable) {
    stashAthenaQuery({
      sql: selectStatement(databaseName, target),
      database: databaseName,
    });
    navigate('/service/athena');
  }

  return (
    <SpaceBetween size="l">
      {currentDatabases?.error && (
        <Alert type="error" header={currentDatabases.error.header} data-testid="glue-error">
          {currentDatabases.error.detail}
        </Alert>
      )}

      <Grid
        gridDefinition={[{ colspan: { default: 12, m: 4 } }, { colspan: { default: 12, m: 8 } }]}
      >
        <Table
          data-testid="database-table"
          variant="container"
          loading={!currentDatabases}
          loadingText="Listing databases"
          selectionType="single"
          trackBy="name"
          selectedItems={visibleDatabases.filter(entry => entry.name === database)}
          ariaLabels={{
            selectionGroupLabel: 'Database selection',
            itemSelectionLabel: (_state, entry: GlueDatabase) => `Select ${entry.name}`,
          }}
          onSelectionChange={event => {
            setDatabase(event.detail.selectedItems[0]?.name);
            setTable(undefined);
          }}
          columnDefinitions={[
            {
              id: 'name',
              header: 'Database',
              cell: (entry: GlueDatabase) => (
                <Link
                  href={`#${entry.name}`}
                  data-testid={`open-database-${entry.name}`}
                  onFollow={event => {
                    event.preventDefault();
                    setDatabase(entry.name);
                    setTable(undefined);
                  }}
                >
                  {entry.name}
                </Link>
              ),
            },
            {
              id: 'location',
              header: 'Location',
              cell: (entry: GlueDatabase) => entry.locationUri ?? '—',
            },
          ]}
          items={visibleDatabases}
          empty={
            <Box textAlign="center" color="text-body-secondary" padding="m">
              {databaseNeedle
                ? 'No database matches that filter.'
                : 'The target’s Glue catalog has no databases yet.'}
            </Box>
          }
          filter={
            <TextFilter
              filteringText={databaseFilter}
              filteringPlaceholder="Find a database"
              filteringAriaLabel="Find a database"
              onChange={event => setDatabaseFilter(event.detail.filteringText)}
            />
          }
          header={
            <Header
              variant="h2"
              counter={currentDatabases?.list ? `(${currentDatabases.list.length})` : undefined}
              actions={
                <Button
                  iconName="refresh"
                  ariaLabel="Reload the catalog"
                  loading={!currentDatabases}
                  onClick={() => setReload(count => count + 1)}
                />
              }
            >
              Databases
            </Header>
          }
        />

        <SpaceBetween size="l">
          {currentTables?.error && (
            <Alert type="error" header={currentTables.error.header} data-testid="tables-error">
              {currentTables.error.detail}
            </Alert>
          )}

          <Table
            data-testid="table-list"
            variant="container"
            loading={Boolean(database) && !currentTables}
            loadingText="Listing tables"
            selectionType="single"
            trackBy="name"
            selectedItems={visibleTables.filter(entry => entry.name === table)}
            ariaLabels={{
              selectionGroupLabel: 'Table selection',
              itemSelectionLabel: (_state, entry: GlueTable) => `Select ${entry.name}`,
            }}
            onSelectionChange={event => setTable(event.detail.selectedItems[0]?.name)}
            columnDefinitions={[
              {
                id: 'name',
                header: 'Table',
                cell: (entry: GlueTable) => (
                  <Link
                    href={`#${entry.name}`}
                    data-testid={`open-table-${entry.name}`}
                    onFollow={event => {
                      event.preventDefault();
                      setTable(entry.name);
                    }}
                  >
                    {entry.name}
                  </Link>
                ),
              },
              {
                id: 'type',
                header: 'Type',
                cell: (entry: GlueTable) => entry.tableType ?? '—',
              },
              {
                id: 'columns',
                header: 'Columns',
                cell: (entry: GlueTable) => entry.columns.length,
              },
              {
                id: 'partitions',
                header: 'Partitioned by',
                cell: (entry: GlueTable) =>
                  entry.columns
                    .filter(column => column.partitionKey)
                    .map(column => column.name)
                    .join(', ') || '—',
              },
              {
                id: 'location',
                header: 'Location',
                cell: (entry: GlueTable) => entry.storage.location ?? '—',
              },
              {
                id: 'updated',
                header: 'Updated',
                cell: (entry: GlueTable) => formatDateTime(entry.updateTime ?? entry.createTime),
              },
            ]}
            items={visibleTables}
            empty={
              <Box textAlign="center" color="text-body-secondary" padding="m">
                {!database
                  ? 'Select a database to see its tables.'
                  : tableNeedle
                    ? 'No table matches that filter.'
                    : 'This database has no tables.'}
              </Box>
            }
            filter={
              database ? (
                <TextFilter
                  filteringText={tableFilter}
                  filteringPlaceholder="Find a table"
                  filteringAriaLabel="Find a table"
                  onChange={event => setTableFilter(event.detail.filteringText)}
                />
              ) : undefined
            }
            header={
              <Header
                variant="h2"
                counter={currentTables?.list ? `(${currentTables.list.length})` : undefined}
                description={database ? `Tables in ${database}` : undefined}
              >
                Tables
              </Header>
            }
          />

          {database && selectedTable && (
            <TableDetail
              endpoint={active}
              glue={catalog}
              databaseName={database}
              table={selectedTable}
              key={`${database}|${selectedTable.name}`}
              onQuery={() => queryTable(database, selectedTable)}
            />
          )}
        </SpaceBetween>
      </Grid>
    </SpaceBetween>
  );
}
