import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';

/**
 * The Glue catalog browser end to end, through the real shell and the real
 * request path. Glue is a JSON-1.1 service, so the stub routes on the target
 * header the way the wire does and answers with the shapes the Glue model
 * declares.
 */

interface Envelope {
  path: string;
  body: string;
  headers?: Record<string, string>;
}

const DATABASES = {
  DatabaseList: [
    { Name: 'analytics', Description: 'the lake', LocationUri: 's3://lake/' },
    { Name: 'staging' },
  ],
};

const TABLES = {
  TableList: [
    {
      Name: 'orders',
      DatabaseName: 'analytics',
      TableType: 'EXTERNAL_TABLE',
      CreateTime: 1_756_000_000,
      StorageDescriptor: {
        Location: 's3://lake/orders/',
        InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
        SerdeInfo: {
          SerializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          Parameters: { 'serialization.format': '1' },
        },
        Columns: [
          { Name: 'order_id', Type: 'string' },
          { Name: 'total', Type: 'double' },
        ],
      },
      PartitionKeys: [{ Name: 'dt', Type: 'string' }],
      Parameters: {
        classification: 'parquet',
        'projection.enabled': 'true',
        'projection.dt.type': 'date',
        'projection.dt.range': '2026-01-01,NOW',
        'storage.location.template': 's3://lake/orders/${dt}/',
      },
    },
  ],
};

const PARTITIONS = {
  Partitions: [
    {
      Values: ['2026-08-24'],
      StorageDescriptor: { Location: 's3://lake/orders/dt=2026-08-24/' },
      CreationTime: 1_756_000_500,
    },
  ],
};

function backendResponse(payload: { status: number; headers: unknown; body: string }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ...payload, bodyEncoding: 'utf8', durationMs: 3 }),
  } as Response;
}

function stubTarget(routes: Record<string, (envelope: Envelope) => unknown>) {
  const calls: Envelope[] = [];
  const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    calls.push(envelope);

    if (envelope.path === '/_fakecloud/health') {
      return backendResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['glue', 'athena'] }),
      });
    }

    const target = envelope.headers?.['x-amz-target'] ?? '';
    const route = routes[target];
    if (!route) {
      return backendResponse({
        status: 400,
        headers: { 'content-type': 'application/x-amz-json-1.1' },
        body: JSON.stringify({ __type: 'UnknownOperation', message: `no stub for ${target}` }),
      });
    }
    return backendResponse({
      status: 200,
      headers: { 'content-type': 'application/x-amz-json-1.1' },
      body: JSON.stringify(route(envelope)),
    });
  });
  return { fetchStub, calls };
}

const FULL_CATALOG = {
  'AWSGlue.GetDatabases': () => DATABASES,
  'AWSGlue.GetTables': () => TABLES,
  'AWSGlue.GetPartitions': () => PARTITIONS,
};

async function openGlue() {
  window.location.hash = '#/service/glue';
  render(<App />);
  return screen.findByTestId('database-table');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Glue catalog browser', () => {
  it('browses databases, tables, and a table’s columns', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(FULL_CATALOG);
    vi.stubGlobal('fetch', fetchStub);

    const databases = await openGlue();
    await waitFor(() => expect(within(databases).getByText('analytics')).toBeInTheDocument());
    expect(within(databases).getByText('staging')).toBeInTheDocument();

    await user.click(screen.getByTestId('open-database-analytics'));

    const tables = await screen.findByTestId('table-list');
    await waitFor(() => expect(within(tables).getByText('orders')).toBeInTheDocument());
    expect(tables).toHaveTextContent('EXTERNAL_TABLE');
    expect(tables).toHaveTextContent('s3://lake/orders/');

    await user.click(screen.getByTestId('open-table-orders'));

    const detail = await screen.findByTestId('table-detail');
    const columns = within(detail).getByTestId('columns-table');
    expect(columns).toHaveTextContent('order_id');
    expect(columns).toHaveTextContent('double');
    // The partition key is a column too, badged and last.
    expect(columns).toHaveTextContent('dt');
    expect(within(columns).getByText('partition')).toBeInTheDocument();
  });

  it('shows storage, SerDe, and partition projection', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(FULL_CATALOG);
    vi.stubGlobal('fetch', fetchStub);

    await openGlue();
    await user.click(await screen.findByTestId('open-database-analytics'));
    await user.click(await screen.findByTestId('open-table-orders'));
    await screen.findByTestId('table-detail');

    await user.click(screen.getByText('Storage and SerDe'));
    expect(await screen.findByTestId('storage-location')).toHaveTextContent('s3://lake/orders/');
    expect(screen.getByTestId('serde-library')).toHaveTextContent('ParquetHiveSerDe');
    expect(screen.getByTestId('serde-parameters')).toHaveTextContent('serialization.format');

    await user.click(screen.getByText('Partition projection'));
    expect(await screen.findByTestId('projection-state')).toHaveTextContent('enabled');
    expect(screen.getByTestId('projection-template')).toHaveTextContent('s3://lake/orders/');
    const projection = screen.getByTestId('projection-table');
    expect(projection).toHaveTextContent('dt');
    expect(projection).toHaveTextContent('date');
    expect(projection).toHaveTextContent('range = 2026-01-01,NOW');
  });

  it('lists the partitions the catalog holds', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(FULL_CATALOG);
    vi.stubGlobal('fetch', fetchStub);

    await openGlue();
    await user.click(await screen.findByTestId('open-database-analytics'));
    await user.click(await screen.findByTestId('open-table-orders'));
    await screen.findByTestId('table-detail');

    await user.click(screen.getByText('Partitions'));

    const partitions = await screen.findByTestId('partitions-table');
    await waitFor(() => expect(partitions).toHaveTextContent('2026-08-24'));
    expect(partitions).toHaveTextContent('s3://lake/orders/dt=2026-08-24/');
    // Projection is explained where a reader would otherwise wonder why the
    // catalog holds fewer partitions than the data has.
    expect(screen.getByTestId('projection-note')).toBeInTheDocument();

    const request = calls.find(
      envelope => envelope.headers?.['x-amz-target'] === 'AWSGlue.GetPartitions',
    );
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      DatabaseName: 'analytics',
      TableName: 'orders',
    });
  });

  it('hands "Query this table" to the Athena editor with the statement ready', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      ...FULL_CATALOG,
      'AmazonAthena.StartQueryExecution': () => ({ QueryExecutionId: 'q-1' }),
      'AmazonAthena.GetQueryExecution': () => ({
        QueryExecution: {
          QueryExecutionId: 'q-1',
          Status: { State: 'SUCCEEDED' },
          Statistics: { DataScannedInBytes: 1024 },
        },
      }),
      'AmazonAthena.GetQueryResults': () => ({
        ResultSet: { ResultSetMetadata: { ColumnInfo: [] }, Rows: [] },
      }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await openGlue();
    await user.click(await screen.findByTestId('open-database-analytics'));
    await user.click(await screen.findByTestId('open-table-orders'));
    await user.click(await screen.findByTestId('query-this-table'));

    // The Athena screen opens with the statement already in the editor.
    const run = await screen.findByTestId('run-query');
    await user.click(run);

    await waitFor(() => {
      const start = calls.find(
        envelope => envelope.headers?.['x-amz-target'] === 'AmazonAthena.StartQueryExecution',
      );
      expect(start).toBeDefined();
      const sent = JSON.parse(start?.body ?? '{}') as {
        QueryString: string;
        QueryExecutionContext?: { Database?: string };
      };
      expect(sent.QueryString).toBe(
        'SELECT "order_id", "total"\nFROM "analytics"."orders"\nLIMIT 10;',
      );
      expect(sent.QueryExecutionContext?.Database).toBe('analytics');
    });
  });

  it('reports a catalog failure instead of an empty database list', async () => {
    const { fetchStub } = stubTarget({});
    vi.stubGlobal('fetch', fetchStub);

    window.location.hash = '#/service/glue';
    render(<App />);

    const error = await screen.findByTestId('glue-error');
    expect(error).toHaveTextContent('UnknownOperation');
  });

  it('says plainly when a table is not partitioned', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      'AWSGlue.GetDatabases': () => DATABASES,
      'AWSGlue.GetTables': () => ({
        TableList: [
          {
            Name: 'flat',
            DatabaseName: 'analytics',
            StorageDescriptor: { Columns: [{ Name: 'id', Type: 'string' }] },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await openGlue();
    await user.click(await screen.findByTestId('open-database-analytics'));
    await user.click(await screen.findByTestId('open-table-flat'));
    await screen.findByTestId('table-detail');
    await user.click(screen.getByText('Partitions'));

    expect(await screen.findByTestId('unpartitioned')).toBeInTheDocument();
    expect(screen.queryByTestId('partitions-table')).not.toBeInTheDocument();
  });
});
