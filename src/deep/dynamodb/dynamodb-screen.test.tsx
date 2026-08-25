import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';

/**
 * The DynamoDB screen end to end, through the real shell and the real request
 * path. DynamoDB is a `json` protocol service, so the stub routes on
 * `X-Amz-Target`.
 */

interface Envelope {
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

type Route = (input: Record<string, unknown>) => unknown;

const TABLE = {
  Table: {
    TableName: 'orders',
    TableStatus: 'ACTIVE',
    TableArn: 'arn:aws:dynamodb:us-east-1:0:table/orders',
    ItemCount: 2,
    TableSizeBytes: 2048,
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'N' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'by-status',
        IndexStatus: 'ACTIVE',
        KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
};

const FIRST_PAGE = {
  Items: [
    { pk: { S: 'cust-1' }, sk: { N: '1' }, total: { N: '19.5' } },
    { pk: { S: 'cust-2' }, sk: { N: '1' }, note: { S: 'gift' } },
  ],
  Count: 2,
  ScannedCount: 2,
  LastEvaluatedKey: { pk: { S: 'cust-2' }, sk: { N: '1' } },
};

const SECOND_PAGE = {
  Items: [{ pk: { S: 'cust-3' }, sk: { N: '1' } }],
  Count: 1,
  ScannedCount: 1,
};

function backendResponse(payload: { status: number; body: string }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: payload.status,
      headers: { 'content-type': 'application/x-amz-json-1.0' },
      body: payload.body,
      bodyEncoding: 'utf8',
      durationMs: 2,
    }),
  } as Response;
}

function stubTarget(routes: Record<string, Route>) {
  const calls: { target: string; input: Record<string, unknown> }[] = [];
  const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;

    if (envelope.path === '/_fakecloud/health') {
      return backendResponse({
        status: 200,
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['dynamodb'] }),
      });
    }

    const target = (envelope.headers?.['x-amz-target'] ?? '').split('.').pop() ?? '';
    const input = JSON.parse(envelope.body ?? '{}') as Record<string, unknown>;
    calls.push({ target, input });

    const route = routes[target];
    if (!route) {
      return backendResponse({
        status: 400,
        body: JSON.stringify({
          __type: 'com.amazon.coral.validate#ValidationException',
          message: `no stub for ${target}`,
        }),
      });
    }
    return backendResponse({ status: 200, body: JSON.stringify(route(input)) });
  });
  return { fetchStub, calls };
}

const BASE_ROUTES: Record<string, Route> = {
  ListTables: () => ({ TableNames: ['orders', 'sessions'] }),
  DescribeTable: () => TABLE,
  Scan: input => (input.ExclusiveStartKey ? SECOND_PAGE : FIRST_PAGE),
};

async function openTables() {
  window.location.hash = '#/service/dynamodb';
  render(<App />);
  return screen.findByTestId('table-list');
}

async function openOrders(user: ReturnType<typeof userEvent.setup>) {
  await openTables();
  await user.click(await screen.findByTestId('open-table-orders'));
  return screen.findByTestId('table-detail');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DynamoDB tables', () => {
  it('lists tables and shows the key schema of the one opened', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    const list = await openTables();
    await waitFor(() => expect(within(list).getByText('orders')).toBeInTheDocument());
    expect(within(list).getByText('sessions')).toBeInTheDocument();

    const detail = await openOrders(user);
    await waitFor(() =>
      expect(within(detail).getByTestId('partition-key')).toHaveTextContent('pk'),
    );
    expect(within(detail).getByTestId('sort-key')).toHaveTextContent('sk');
    expect(within(detail).getByTestId('item-count')).toHaveTextContent('2');
  });

  it('scans the table as soon as it is opened, keys first', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);

    const items = await screen.findByTestId('item-table');
    await waitFor(() => expect(items).toHaveTextContent('cust-1'));
    // The key attributes lead the columns, then whatever the items carry.
    const headers = within(items)
      .getAllByRole('columnheader')
      .map(cell => cell.textContent);
    expect(headers.slice(1, 5)).toEqual(['pk (key)', 'sk (key)', 'total', 'note']);
    expect(calls.some(call => call.target === 'Scan')).toBe(true);
  });

  it('pages with DynamoDB’s own cursor and stops when it stops coming', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');

    await user.click(screen.getByTestId('next-page'));
    await waitFor(() => expect(screen.getByTestId('item-table')).toHaveTextContent('cust-3'));

    const second = calls.filter(call => call.target === 'Scan')[1];
    expect(second.input.ExclusiveStartKey).toEqual({ pk: { S: 'cust-2' }, sk: { N: '1' } });
    // The second page returned no LastEvaluatedKey, so there is nowhere further.
    await waitFor(() => expect(screen.getByTestId('next-page')).toBeDisabled());
    expect(screen.getByTestId('previous-page')).toBeEnabled();
  });

  it('runs a query with the expression inputs, and only the ones filled in', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, Query: () => SECOND_PAGE });
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');

    await user.click(screen.getByRole('button', { name: 'Query' }));
    await user.type(
      within(await screen.findByTestId('key-condition')).getByRole('textbox'),
      '#pk = :pk',
    );
    await user.click(screen.getByRole('button', { name: /Expression attribute names/ }));
    const names = within(screen.getByTestId('attribute-names')).getByRole('textbox');
    await user.click(names);
    await user.paste('{"#pk": "pk"}');
    const values = within(screen.getByTestId('attribute-values')).getByRole('textbox');
    await user.click(values);
    await user.paste('{":pk": {"S": "cust-3"}}');

    await user.click(screen.getByTestId('run-read'));

    await waitFor(() => expect(calls.some(call => call.target === 'Query')).toBe(true));
    const query = calls.find(call => call.target === 'Query');
    expect(query?.input.KeyConditionExpression).toBe('#pk = :pk');
    expect(query?.input.ExpressionAttributeNames).toEqual({ '#pk': 'pk' });
    expect(query?.input.ExpressionAttributeValues).toEqual({ ':pk': { S: 'cust-3' } });
    // Nothing was typed into these, so they are not sent at all.
    expect(query?.input.FilterExpression).toBeUndefined();
    expect(query?.input.ProjectionExpression).toBeUndefined();
  });

  it('will not run a query without a key condition', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');
    await user.click(screen.getByRole('button', { name: 'Query' }));

    await waitFor(() => expect(screen.getByTestId('run-read')).toBeDisabled());
    expect(calls.some(call => call.target === 'Query')).toBe(false);
  });

  it('drops a consistent read on a global secondary index rather than being rejected', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');

    await user.click(within(screen.getByTestId('consistent-read')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Index/ }));
    await user.click(await screen.findByRole('option', { name: /by-status/ }));
    await user.click(screen.getByTestId('run-read'));

    await waitFor(() => expect(calls.filter(call => call.target === 'Scan')).toHaveLength(2));
    const scan = calls.filter(call => call.target === 'Scan')[1];
    expect(scan.input.IndexName).toBe('by-status');
    expect(scan.input.ConsistentRead).toBeUndefined();
  });

  it('edits an item in DynamoDB JSON and writes exactly that', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, PutItem: () => ({}) });
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');

    await user.click(await screen.findByRole('radio', { name: 'Select pk=cust-1, sk=1' }));
    await user.click(screen.getByTestId('edit-item'));

    const editor = await screen.findByTestId('item-editor');
    const json = within(editor).getByTestId('item-json');
    const textbox = within(json).getByRole('textbox');
    await user.clear(textbox);
    await user.paste('{"pk":{"S":"cust-1"},"sk":{"N":"1"},"total":{"N":"25"}}');
    await user.click(screen.getByTestId('save-item'));

    await waitFor(() => expect(calls.some(call => call.target === 'PutItem')).toBe(true));
    const put = calls.find(call => call.target === 'PutItem');
    expect(put?.input.Item).toEqual({
      pk: { S: 'cust-1' },
      sk: { N: '1' },
      total: { N: '25' },
    });
  });

  it('refuses to save an item whose attribute has no type tag', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, PutItem: () => ({}) });
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');
    await user.click(screen.getByTestId('create-item'));

    const editor = await screen.findByTestId('item-editor');
    const textbox = within(within(editor).getByTestId('item-json')).getByRole('textbox');
    await user.clear(textbox);
    await user.paste('{"pk":"cust-9"}');

    await waitFor(() => expect(screen.getByTestId('save-item')).toBeDisabled());
    // The message names the attribute rather than leaving it to a service error.
    expect(editor).toHaveTextContent('"pk"');
    expect(calls.some(call => call.target === 'PutItem')).toBe(false);
  });

  it('converts a plain-JSON edit into tagged values on save', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, PutItem: () => ({}) });
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');
    await user.click(screen.getByTestId('create-item'));

    const editor = await screen.findByTestId('item-editor');
    await user.click(within(editor).getByRole('button', { name: 'Plain JSON' }));
    const textbox = within(within(editor).getByTestId('item-json')).getByRole('textbox');
    await user.clear(textbox);
    await user.paste('{"pk":"cust-9","sk":2,"tags":["a"]}');
    await user.click(screen.getByTestId('save-item'));

    await waitFor(() => expect(calls.some(call => call.target === 'PutItem')).toBe(true));
    const put = calls.find(call => call.target === 'PutItem');
    // A JSON list becomes an L, never a set — nothing in the text said which.
    expect(put?.input.Item).toEqual({
      pk: { S: 'cust-9' },
      sk: { N: '2' },
      tags: { L: [{ S: 'a' }] },
    });
  });

  it('requires typing the key before it deletes an item', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, DeleteItem: () => ({}) });
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await screen.findByText('cust-1');
    await user.click(await screen.findByRole('radio', { name: 'Select pk=cust-1, sk=1' }));
    await user.click(screen.getByTestId('edit-item'));
    await user.click(await screen.findByTestId('delete-item'));

    const confirm = await screen.findByTestId('confirm-destructive');
    expect(confirm).toBeDisabled();
    expect(calls.some(call => call.target === 'DeleteItem')).toBe(false);

    await user.click(within(screen.getByTestId('destructive-phrase')).getByRole('textbox'));
    await user.paste('pk=cust-1, sk=1');
    await waitFor(() => expect(screen.getByTestId('confirm-destructive')).toBeEnabled());
    await user.click(screen.getByTestId('confirm-destructive'));

    await waitFor(() => expect(calls.some(call => call.target === 'DeleteItem')).toBe(true));
    // Only the key goes to DeleteItem, not the whole item.
    expect(calls.find(call => call.target === 'DeleteItem')?.input.Key).toEqual({
      pk: { S: 'cust-1' },
      sk: { N: '1' },
    });
  });

  it('shows both kinds of secondary index', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);
    await user.click(screen.getByRole('tab', { name: 'Indexes' }));

    const indexes = await screen.findByTestId('index-table');
    expect(indexes).toHaveTextContent('by-status');
    expect(indexes).toHaveTextContent('Global');
    expect(indexes).toHaveTextContent('status (HASH)');
  });

  it('reports a read failure instead of showing an empty table', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      ListTables: BASE_ROUTES.ListTables,
      DescribeTable: () => TABLE,
    });
    vi.stubGlobal('fetch', fetchStub);

    await openOrders(user);

    const error = await screen.findByTestId('items-error');
    expect(error).toHaveTextContent('no stub for Scan');
  });
});
