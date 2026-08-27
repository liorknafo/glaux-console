import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

/**
 * The generic layer end to end: choose an operation, run it against a stubbed
 * target, and get a console table with the service's own pagination — plus the
 * destructive-action guard on the Actions tab.
 *
 * Responses here are shaped by the SQS and Athena service models, not by an
 * assumption about how any particular emulator answers.
 */

interface Exchange {
  target?: string;
  body: unknown;
  status?: number;
}

function stubTarget(respond: (envelope: Record<string, any>) => Exchange) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}'));
    if (envelope.path === '/_fakecloud/health') {
      return jsonResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['sqs', 'athena'] }),
        bodyEncoding: 'utf8',
        durationMs: 1,
      });
    }
    const exchange = respond(envelope);
    return jsonResponse({
      status: exchange.status ?? 200,
      headers: { 'content-type': 'application/x-amz-json-1.0' },
      body: JSON.stringify(exchange.body),
      bodyEncoding: 'utf8',
      durationMs: 7,
    });
  });
}

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(await screen.findByLabelText(label));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByText(option));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Resources tab', () => {
  it('renders a list operation as a table and pages with the service’s own token', async () => {
    const user = userEvent.setup();
    const fetchStub = stubTarget(envelope => {
      const body = JSON.parse(envelope.body);
      return body.NextToken
        ? { body: { QueueUrls: ['http://localhost:4566/000000000000/second'] } }
        : {
            body: {
              QueueUrls: ['http://localhost:4566/000000000000/first'],
              NextToken: 'page-2',
            },
          };
    });
    vi.stubGlobal('fetch', fetchStub);

    window.location.hash = '#/service/sqs';
    render(<App />);

    // SQS opens on its hand-built queue screen; the generated tabs sit behind it.
    await user.click(await screen.findByRole('tab', { name: 'Resources' }));
    await chooseOption(user, 'Read operation', 'ListQueues');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() =>
      expect(
        within(table).getByText('http://localhost:4566/000000000000/first'),
      ).toBeInTheDocument(),
    );

    await user.click(within(table).getByLabelText('Next page'));
    await waitFor(() =>
      expect(
        within(table).getByText('http://localhost:4566/000000000000/second'),
      ).toBeInTheDocument(),
    );

    const tokenSent = fetchStub.mock.calls
      .map(call => JSON.parse(String((call[1] as RequestInit).body)))
      .filter(envelope => envelope.path === '/')
      .map(envelope => JSON.parse(envelope.body).NextToken);
    expect(tokenSent).toContain('page-2');
  });

  it('infers columns from the output shape', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({
        body: {
          DataCatalogsSummary: [
            { CatalogName: 'awsdatacatalog', Type: 'GLUE', Status: 'CREATE_COMPLETE' },
          ],
        },
      })),
    );

    window.location.hash = '#/service/athena';
    render(<App />);

    // Athena opens on its hand-built query editor; the generated tabs sit behind it.
    await user.click(await screen.findByRole('tab', { name: 'Resources' }));
    await chooseOption(user, 'Read operation', 'ListDataCatalogs');
    await user.click(await screen.findByTestId('run-read-operation'));

    const table = await screen.findByTestId('resources-table');
    await waitFor(() => expect(within(table).getByText('awsdatacatalog')).toBeInTheDocument());
    expect(within(table).getByText('Catalog name')).toBeInTheDocument();
    expect(within(table).getByText('Type')).toBeInTheDocument();
    expect(within(table).getByText('GLUE')).toBeInTheDocument();
  });

  it('surfaces the target’s error instead of an empty table', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({
        status: 400,
        body: {
          __type: 'InvalidRequestException',
          message: 'Unsupported construct: GROUPING SETS',
        },
      })),
    );

    window.location.hash = '#/service/athena';
    render(<App />);

    // Athena opens on its hand-built query editor; the generated tabs sit behind it.
    await user.click(await screen.findByRole('tab', { name: 'Resources' }));
    await chooseOption(user, 'Read operation', 'ListDataCatalogs');
    await user.click(await screen.findByTestId('run-read-operation'));

    const alert = await screen.findByTestId('resources-error');
    expect(alert).toHaveTextContent('InvalidRequestException');
    expect(alert).toHaveTextContent('Unsupported construct: GROUPING SETS');
  });
});

describe('Actions tab', () => {
  it('shows the equivalent CLI command for the generated form', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      stubTarget(() => ({ body: { QueueUrl: 'http://localhost:4566/000000000000/orders' } })),
    );

    window.location.hash = '#/service/sqs';
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Actions' }));
    await chooseOption(user, 'Operation', 'CreateQueue');

    await user.type(await screen.findByLabelText('Queue name'), 'orders');
    await user.click(screen.getAllByText('View as CLI')[0]);

    const command = await screen.findByTestId('cli-command');
    const text = command.textContent ?? '';
    expect(text).toContain('aws');
    expect(text).toContain('sqs');
    expect(text).toContain('create-queue');
    expect(text).toContain('--endpoint-url');
    expect(text).toContain('--queue-name orders');
  });

  it('requires typing the resource name before a destructive operation runs', async () => {
    const user = userEvent.setup();
    const fetchStub = stubTarget(() => ({ body: {} }));
    vi.stubGlobal('fetch', fetchStub);

    window.location.hash = '#/service/sqs';
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Actions' }));
    await chooseOption(user, 'Operation', 'DeleteQueue');

    const queueUrl = 'http://localhost:4566/000000000000/orders';
    await user.type(await screen.findByLabelText('Queue url'), queueUrl);
    await user.click(screen.getByTestId('run-operation'));

    const confirm = await screen.findByTestId('confirm-destructive');
    expect(confirm).toBeDisabled();

    const callsBefore = fetchStub.mock.calls.length;
    await user.type(within(screen.getByTestId('destructive-phrase')).getByRole('textbox'), 'wrong');
    expect(screen.getByTestId('confirm-destructive')).toBeDisabled();
    expect(fetchStub.mock.calls.length).toBe(callsBefore);

    await user.clear(within(screen.getByTestId('destructive-phrase')).getByRole('textbox'));
    await user.type(
      within(screen.getByTestId('destructive-phrase')).getByRole('textbox'),
      queueUrl,
    );
    await waitFor(() => expect(screen.getByTestId('confirm-destructive')).toBeEnabled());
    await user.click(screen.getByTestId('confirm-destructive'));

    await waitFor(() =>
      expect(
        fetchStub.mock.calls.some(call => {
          const envelope = JSON.parse(String((call[1] as RequestInit).body));
          return envelope.headers?.['x-amz-target'] === 'AmazonSQS.DeleteQueue';
        }),
      ).toBe(true),
    );
  });

  it('accepts a raw JSON payload as the escape hatch', async () => {
    const user = userEvent.setup();
    const fetchStub = stubTarget(() => ({ body: { MessageId: 'm-1' } }));
    vi.stubGlobal('fetch', fetchStub);

    window.location.hash = '#/service/sqs';
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Actions' }));
    await chooseOption(user, 'Operation', 'SendMessage');

    await user.click(within(screen.getByTestId('raw-json-toggle')).getByRole('checkbox'));
    const textarea = await screen.findByRole('textbox', { name: /Request payload/ });
    await user.clear(textarea);
    await user.type(textarea, '{{"QueueUrl":"http://localhost:4566/q/a","MessageBody":"hi"}');
    await user.click(screen.getByTestId('run-operation'));

    await waitFor(() => expect(screen.getByTestId('operation-response')).toHaveTextContent('m-1'));
    const sent = fetchStub.mock.calls
      .map(call => JSON.parse(String((call[1] as RequestInit).body)))
      .find(envelope => envelope.headers?.['x-amz-target'] === 'AmazonSQS.SendMessage');
    expect(JSON.parse(sent.body)).toEqual({
      QueueUrl: 'http://localhost:4566/q/a',
      MessageBody: 'hi',
    });
  });
});
