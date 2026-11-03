import { useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import TextFilter from '@cloudscape-design/components/text-filter';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';
import { fetchDatabases, fetchTables, type SchemaDatabase, type SchemaTable } from './schema';

/**
 * The Glue-backed schema tree: databases, their tables, and each table's
 * columns and partition keys.
 *
 * Tables load when a database is expanded rather than up front — a catalog with
 * many databases should not cost one `GetTables` call per database on open.
 */
export function SchemaTree({
  endpoint,
  glue,
  onQueryTable,
  onUseDatabase,
}: {
  endpoint: EndpointConfig;
  glue?: ServiceCatalog;
  onQueryTable(databaseName: string, table: SchemaTable): void;
  onUseDatabase(databaseName: string): void;
}) {
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    databases?: SchemaDatabase[];
    error?: { header: string; detail: string };
  }>();

  // Deriving the result from the request key means a reload or an endpoint
  // switch shows the spinner again without resetting state inside the effect.
  const requestKey = `${endpoint.url}|${endpoint.region}|${reload}`;
  const current = loaded?.key === requestKey ? loaded : undefined;
  const loading = !current;

  useEffect(() => {
    if (!glue) return;
    const controller = new AbortController();
    fetchDatabases(endpoint, glue, controller.signal).then(
      databases => !controller.signal.aborted && setLoaded({ key: requestKey, databases }),
      caught =>
        !controller.signal.aborted && setLoaded({ key: requestKey, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [endpoint, glue, requestKey]);

  const needle = filter.trim().toLowerCase();
  const visible = (current?.databases ?? []).filter(
    database => !needle || database.name.toLowerCase().includes(needle),
  );

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Databases and tables from the target's Glue Data Catalog."
          actions={
            <Button
              iconName="refresh"
              ariaLabel="Reload the schema tree"
              loading={loading}
              onClick={() => setReload(count => count + 1)}
            />
          }
        >
          Data catalog
        </Header>
      }
    >
      <SpaceBetween size="s">
        <TextFilter
          filteringText={filter}
          filteringPlaceholder="Find a database"
          filteringAriaLabel="Find a database"
          onChange={event => setFilter(event.detail.filteringText)}
        />

        {current?.error && (
          <Alert type="error" header={current.error.header} data-testid="schema-error">
            {current.error.detail}
          </Alert>
        )}

        {loading && <Spinner />}

        {current?.databases && visible.length === 0 && (
          <Box color="text-body-secondary" data-testid="schema-empty">
            {needle
              ? 'No database matches that filter.'
              : 'The target’s Glue catalog has no databases yet.'}
          </Box>
        )}

        {visible.map(database => (
          <DatabaseNode
            key={`${requestKey}|${database.name}`}
            database={database}
            endpoint={endpoint}
            glue={glue}
            onQueryTable={onQueryTable}
            onUseDatabase={onUseDatabase}
          />
        ))}
      </SpaceBetween>
    </Container>
  );
}

function DatabaseNode({
  database,
  endpoint,
  glue,
  onQueryTable,
  onUseDatabase,
}: {
  database: SchemaDatabase;
  endpoint: EndpointConfig;
  glue?: ServiceCatalog;
  onQueryTable(databaseName: string, table: SchemaTable): void;
  onUseDatabase(databaseName: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tables, setTables] = useState<SchemaTable[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController>(undefined);

  useEffect(() => () => inFlight.current?.abort(), []);

  // Loading is driven by the expand event rather than an effect: expanding is
  // the user's action, and the request should follow it directly.
  function expand(next: boolean) {
    setExpanded(next);
    if (!next || tables || loading || !glue) return;
    const controller = new AbortController();
    inFlight.current?.abort();
    inFlight.current = controller;
    setLoading(true);
    setError(undefined);
    fetchTables(endpoint, glue, database.name, controller.signal).then(
      loaded => {
        if (controller.signal.aborted) return;
        setTables(loaded);
        setLoading(false);
      },
      caught => {
        if (controller.signal.aborted) return;
        setError(describeError(caught).detail);
        setLoading(false);
      },
    );
  }

  return (
    <ExpandableSection
      variant="footer"
      expanded={expanded}
      onChange={event => expand(event.detail.expanded)}
      headerText={database.name}
    >
      <SpaceBetween size="xs">
        <Button
          variant="inline-link"
          onClick={() => onUseDatabase(database.name)}
          data-testid={`use-database-${database.name}`}
        >
          Use as query context
        </Button>
        {database.description && <Box variant="small">{database.description}</Box>}
        {loading && <Spinner />}
        {error && (
          <Box color="text-status-error" data-testid={`tables-error-${database.name}`}>
            {error}
          </Box>
        )}
        {tables?.length === 0 && (
          <Box color="text-body-secondary">This database has no tables.</Box>
        )}
        {tables?.map(table => (
          <TableNode
            key={table.name}
            databaseName={database.name}
            table={table}
            onQueryTable={onQueryTable}
          />
        ))}
      </SpaceBetween>
    </ExpandableSection>
  );
}

function TableNode({
  databaseName,
  table,
  onQueryTable,
}: {
  databaseName: string;
  table: SchemaTable;
  onQueryTable(databaseName: string, table: SchemaTable): void;
}) {
  return (
    <ExpandableSection variant="footer" headerText={table.name}>
      <SpaceBetween size="xxs">
        <Button
          variant="inline-link"
          data-testid={`query-table-${table.name}`}
          onClick={() => onQueryTable(databaseName, table)}
        >
          Query this table
        </Button>
        {table.location && <Box variant="small">{table.location}</Box>}
        {table.columns.length === 0 && (
          <Box color="text-body-secondary" variant="small">
            The catalog records no columns for this table.
          </Box>
        )}
        {table.columns.map(column => (
          <Box key={`${column.name}-${String(column.partitionKey)}`} variant="small">
            <SpaceBetween size="xxs" direction="horizontal">
              <span>{column.name}</span>
              <Box variant="span" color="text-body-secondary">
                {column.type ?? 'unknown'}
              </Box>
              {column.partitionKey && <Badge color="blue">partition</Badge>}
            </SpaceBetween>
          </Box>
        ))}
      </SpaceBetween>
    </ExpandableSection>
  );
}
