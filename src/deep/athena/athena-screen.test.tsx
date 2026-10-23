import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';

/**
 * The Athena screen end to end, through the real shell and the real request
 * path: the screen builds Athena and Glue calls from the catalog, the stub
 * answers with the shape those service models declare, and the screen renders
 * what came back.
 *
 * Nothing here asserts on emulator-specific behaviour — the responses are
 * exactly what the Athena and Glue models say those operations return.
 */

type Envelope = {
  path: string;
  body: string;
  headers?: Record<string, string>;
};

interface Reply {
  body: unknown;
  status?: number;
}

const GLUE_DATABASES = {
  DatabaseList: [{ Name: 'analytics', Description: 'fixture database' }],
};

const GLUE_TABLES = {
  TableList: [
    {
      Name: 'orders',
      DatabaseName: 'analytics',
      StorageDescriptor: {
        Location: 's3://lake/orders/',
        Columns: [
          { Name: 'order_id', Type: 'string' },
          { Name: 'total', Type: 'double' },
        ],
      },
      PartitionKeys: [{ Name: 'dt', Type: 'string' }],
    },
  ],
};

const RESULT_SET = {
  ResultSet: {
    ResultSetMetadata: {
      ColumnInfo: [
        { Name: 'order_id', Label: 'order_id', Type: 'varchar' },
        { Name: 'total', Label: 'total', Type: 'double' },
      ],
    },
    Rows: [
      { Data: [{ VarCharValue: 'order_id' }, { VarCharValue: 'total' }] },
      { Data: [{ VarCharValue: 'A-1' }, { VarCharValue: '19.5' }] },
    ],
  },
};

function succeeded(overrides: Record<string, unknown> = {}) {
  return {
    QueryExecution: {
      QueryExecutionId: 'q-1',
      StatementType: 'DML',
      Status: { State: 'SUCCEEDED' },
      Statistics: { DataScannedInBytes: 2048, EngineExecutionTimeInMillis: 120 },
      ...overrides,
    },
  };
}

/** Route by the JSON-1.1 target header, the way the wire actually routes. */
function stubTarget(routes: Record<string, (envelope: Envelope) => Reply>) {
  const calls: Envelope[] = [];
  const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    calls.push(envelope);

    if (envelope.path === '/_fakecloud/health') {
      return backendResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['athena', 'glue'] }),
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
    const reply = route(envelope);
    return backendResponse({
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/x-amz-json-1.1' },
      body: JSON.stringify(reply.body),
    });
  });
  return { fetchStub, calls };
}

function backendResponse(payload: { status: number; headers: unknown; body: string }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ...payload, bodyEncoding: 'utf8', durationMs: 3 }),
  } as Response;
}

function sentQueryString(calls: Envelope[]): string | undefined {
  const start = calls.find(
    envelope => envelope.headers?.['x-amz-target'] === 'AmazonAthena.StartQueryExecution',
  );
  return start ? (JSON.parse(start.body) as { QueryString: string }).QueryString : undefined;
}

async function openEditor() {
  window.location.hash = '#/service/athena';
  render(<App />);
  return screen.findByTestId('run-query');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Athena query editor', () => {
  it('runs a query and reports results, bytes scanned and timing', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      'AmazonAthena.StartQueryExecution': () => ({ body: { QueryExecutionId: 'q-1' } }),
      'AmazonAthena.GetQueryExecution': () => ({ body: succeeded() }),
      'AmazonAthena.GetQueryResults': () => ({ body: RESULT_SET }),
      'AWSGlue.GetDatabases': () => ({ body: { DatabaseList: [] } }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await user.click(await openEditor());

    const results = await screen.findByTestId('query-results');
    await waitFor(() => expect(within(results).getByText('A-1')).toBeInTheDocument());
    expect(within(results).getByText('19.5')).toBeInTheDocument();
    // The header row Athena repeats as row 0 is not shown as data.
    expect(within(results).queryAllByText('order_id')).toHaveLength(1);

    expect(screen.getByTestId('query-state')).toHaveTextContent('SUCCEEDED');
    expect(screen.getByTestId('bytes-scanned')).toHaveTextContent('2.00 KB');
    expect(screen.getByTestId('engine-time')).toHaveTextContent('120 ms');
    expect(sentQueryString(calls)).toBe('SELECT 1;');
  });

  it('explains an unsupported construct instead of showing a bare error', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      'AmazonAthena.StartQueryExecution': () => ({ body: { QueryExecutionId: 'q-1' } }),
      'AmazonAthena.GetQueryExecution': () => ({
        body: succeeded({
          Status: {
            State: 'FAILED',
            StateChangeReason: 'query failed',
            AthenaError: {
              ErrorCategory: 2,
              ErrorMessage: 'Unsupported SQL construct: GROUPING SETS',
            },
          },
        }),
      }),
      'AWSGlue.GetDatabases': () => ({ body: { DatabaseList: [] } }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await user.click(await openEditor());

    const explanation = await screen.findByTestId('unsupported-construct');
    expect(explanation).toHaveTextContent('GROUPING SETS');
    expect(explanation).toHaveTextContent('Unsupported SQL construct: GROUPING SETS');
    expect(within(explanation).getByRole('link')).toHaveAttribute(
      'href',
      expect.stringContaining('glaux'),
    );
    expect(screen.queryByTestId('query-results')).not.toBeInTheDocument();
    expect(screen.getByTestId('query-state')).toHaveTextContent('FAILED');
  });

  it('renders a failure that is not a coverage gap as an ordinary error', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      'AmazonAthena.StartQueryExecution': () => ({ body: { QueryExecutionId: 'q-1' } }),
      'AmazonAthena.GetQueryExecution': () => ({
        body: succeeded({
          Status: { State: 'FAILED', StateChangeReason: 'SYNTAX_ERROR: line 1:8: bad column' },
        }),
      }),
      'AWSGlue.GetDatabases': () => ({ body: { DatabaseList: [] } }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await user.click(await openEditor());

    const failed = await screen.findByTestId('query-failed');
    expect(failed).toHaveTextContent('SYNTAX_ERROR');
    expect(screen.queryByTestId('unsupported-construct')).not.toBeInTheDocument();
  });

  it('prefills the editor from the Glue schema tree', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      'AWSGlue.GetDatabases': () => ({ body: GLUE_DATABASES }),
      'AWSGlue.GetTables': () => ({ body: GLUE_TABLES }),
      'AmazonAthena.StartQueryExecution': () => ({ body: { QueryExecutionId: 'q-1' } }),
      'AmazonAthena.GetQueryExecution': () => ({ body: succeeded() }),
      'AmazonAthena.GetQueryResults': () => ({ body: RESULT_SET }),
    });
    vi.stubGlobal('fetch', fetchStub);

    const run = await openEditor();

    await user.click(await screen.findByText('analytics'));
    await user.click(await screen.findByText('orders'));
    await user.click(await screen.findByTestId('query-table-orders'));
    await user.click(run);

    await waitFor(() =>
      expect(sentQueryString(calls)).toBe(
        'SELECT "order_id", "total"\nFROM "analytics"."orders"\nLIMIT 10;',
      ),
    );

    const start = calls.find(
      envelope => envelope.headers?.['x-amz-target'] === 'AmazonAthena.StartQueryExecution',
    );
    expect(JSON.parse(start?.body ?? '{}').QueryExecutionContext).toEqual({
      Database: 'analytics',
    });
  });

  it('cancels a running query through StopQueryExecution', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      'AmazonAthena.StartQueryExecution': () => ({ body: { QueryExecutionId: 'q-1' } }),
      'AmazonAthena.GetQueryExecution': () => ({
        body: succeeded({ Status: { State: 'RUNNING' } }),
      }),
      'AmazonAthena.StopQueryExecution': () => ({ body: {} }),
      'AWSGlue.GetDatabases': () => ({ body: { DatabaseList: [] } }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await user.click(await openEditor());

    const cancel = await screen.findByTestId('cancel-query');
    await waitFor(() => expect(cancel).toBeEnabled());
    await user.click(cancel);

    await waitFor(() =>
      expect(
        calls.some(
          envelope => envelope.headers?.['x-amz-target'] === 'AmazonAthena.StopQueryExecution',
        ),
      ).toBe(true),
    );
  });

  it('records the run in history and reloads a saved query', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      'AmazonAthena.StartQueryExecution': () => ({ body: { QueryExecutionId: 'q-1' } }),
      'AmazonAthena.GetQueryExecution': () => ({ body: succeeded() }),
      'AmazonAthena.GetQueryResults': () => ({ body: RESULT_SET }),
      'AWSGlue.GetDatabases': () => ({ body: { DatabaseList: [] } }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await user.click(await openEditor());
    await screen.findByTestId('query-results');

    const history = await screen.findByTestId('query-history');
    await waitFor(() => expect(within(history).getByText('SELECT 1;')).toBeInTheDocument());
    expect(within(history).getByText('SUCCEEDED')).toBeInTheDocument();
    expect(within(history).getByText('2.00 KB')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save query' }));
    await user.type(within(screen.getByTestId('save-query-name')).getByRole('textbox'), 'daily');
    await user.click(screen.getByTestId('confirm-save-query'));

    await user.click(screen.getByRole('tab', { name: 'Saved queries' }));
    const saved = await screen.findByTestId('saved-queries');
    expect(within(saved).getByText('daily')).toBeInTheDocument();
  });

  it('surfaces a target that refuses the statement outright', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      'AmazonAthena.StartQueryExecution': () => ({
        status: 400,
        body: {
          __type: 'InvalidRequestException',
          message: 'Unsupported SQL construct: LATERAL VIEW',
        },
      }),
      'AWSGlue.GetDatabases': () => ({ body: { DatabaseList: [] } }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await user.click(await openEditor());

    // A synchronous refusal is the same coverage gap as a failed execution, and
    // gets the same explanation.
    const explanation = await screen.findByTestId('unsupported-construct');
    expect(explanation).toHaveTextContent('LATERAL VIEW');
  });
});
