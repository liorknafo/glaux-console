import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';

/**
 * The EventBridge screen end to end, through the real shell and the real
 * request path. EventBridge is a `json` protocol service, so the stub routes on
 * `X-Amz-Target`.
 */

interface Envelope {
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

type Route = (input: Record<string, unknown>) => unknown;

const ORDER_PATTERN = JSON.stringify({
  source: ['shop.orders'],
  'detail-type': ['Order placed'],
  detail: { total: [{ numeric: ['>', 10] }] },
});

function backendResponse(payload: { status: number; body: string }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: payload.status,
      headers: { 'content-type': 'application/x-amz-json-1.1' },
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
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['events'] }),
      });
    }

    const target = (envelope.headers?.['x-amz-target'] ?? '').split('.').pop() ?? '';
    const input = JSON.parse(envelope.body ?? '{}') as Record<string, unknown>;
    calls.push({ target, input });

    const route = routes[target];
    if (!route) {
      return backendResponse({
        status: 400,
        body: JSON.stringify({ __type: 'InvalidAction', message: `no stub for ${target}` }),
      });
    }
    return backendResponse({ status: 200, body: JSON.stringify(route(input)) });
  });
  return { fetchStub, calls };
}

const BASE_ROUTES: Record<string, Route> = {
  ListEventBuses: () => ({ EventBuses: [{ Name: 'default' }, { Name: 'orders' }] }),
  ListRules: input => ({
    Rules:
      input.EventBusName === 'orders'
        ? [{ Name: 'orders-only', State: 'ENABLED', EventPattern: '{"source":["shop.orders"]}' }]
        : [
            {
              Name: 'orders-to-queue',
              State: 'ENABLED',
              Arn: 'arn:aws:events:us-east-1:0:rule/orders-to-queue',
              EventPattern: ORDER_PATTERN,
              Description: 'Orders over 10',
            },
            { Name: 'nightly', State: 'DISABLED', ScheduleExpression: 'rate(1 day)' },
          ],
  }),
  ListTargetsByRule: () => ({
    Targets: [
      { Id: 'to-queue', Arn: 'arn:aws:sqs:us-east-1:0:orders' },
      { Id: 'to-lambda', Arn: 'arn:aws:lambda:us-east-1:0:function:notify', Input: '{"x":1}' },
    ],
  }),
};

async function openRules() {
  window.location.hash = '#/service/events';
  render(<App />);
  return screen.findByTestId('rule-table');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EventBridge rules', () => {
  it('lists the rules on the default bus and their trigger kind', async () => {
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    const table = await openRules();
    await waitFor(() => expect(within(table).getByText('orders-to-queue')).toBeInTheDocument());
    expect(within(table).getByText('Event pattern')).toBeInTheDocument();
    expect(within(table).getByText('Schedule')).toBeInTheDocument();
    expect(within(table).getByText('DISABLED')).toBeInTheDocument();
  });

  it('switches buses and re-lists against the bus chosen', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await screen.findByText('orders-to-queue');

    await user.click(screen.getByRole('button', { name: /Event bus/ }));
    await user.click(await screen.findByRole('option', { name: 'orders' }));

    await waitFor(() => expect(screen.getByTestId('rule-table')).toHaveTextContent('orders-only'));
    expect(
      calls.some(call => call.target === 'ListRules' && call.input.EventBusName === 'orders'),
    ).toBe(true);
  });

  it('shows a rule’s targets and how each is given its input', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await user.click(await screen.findByTestId('open-rule-orders-to-queue'));
    await screen.findByTestId('rule-detail');
    await user.click(screen.getByRole('tab', { name: 'Targets' }));

    const targets = await screen.findByTestId('target-table');
    await waitFor(() => expect(targets).toHaveTextContent('to-queue'));
    expect(targets).toHaveTextContent('Matched event');
    expect(targets).toHaveTextContent('Constant');
  });

  it('seeds the tester with an event that the rule already matches', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await user.click(await screen.findByTestId('open-rule-orders-to-queue'));
    await screen.findByTestId('rule-detail');

    const verdict = await screen.findByTestId('match-verdict');
    expect(verdict).toHaveTextContent('This event matches the pattern');
  });

  it('explains which member rejected an event that does not match', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await user.click(await screen.findByTestId('open-rule-orders-to-queue'));
    await screen.findByTestId('rule-detail');
    await screen.findByTestId('match-verdict');

    const input = within(screen.getByTestId('event-input')).getByRole('textbox');
    await user.clear(input);
    await user.paste(
      JSON.stringify({
        source: 'shop.orders',
        'detail-type': 'Order placed',
        detail: { total: 5 },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('match-verdict')).toHaveTextContent('does not match'),
    );
    // The verdict names the member, not just "false".
    expect(screen.getByTestId('mismatch-reason')).toHaveTextContent('detail.total');
  });

  it('rejects an invalid pattern with the operator named, rather than calling it a mismatch', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await user.click(await screen.findByTestId('open-rule-orders-to-queue'));
    await screen.findByTestId('rule-detail');
    await screen.findByTestId('match-verdict');

    const input = within(screen.getByTestId('pattern-input')).getByRole('textbox');
    await user.clear(input);
    await user.paste('{"source":[{"starts-with":"shop"}]}');

    const problems = await screen.findByTestId('pattern-problems');
    expect(problems).toHaveTextContent('Unknown operator "starts-with"');
    expect(screen.queryByTestId('match-verdict')).not.toBeInTheDocument();
  });

  it('disables a rule through the model’s own operation', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, DisableRule: () => ({}) });
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await user.click(await screen.findByTestId('open-rule-orders-to-queue'));
    await screen.findByTestId('rule-detail');
    await user.click(screen.getByTestId('toggle-rule-state'));

    await waitFor(() => expect(calls.some(call => call.target === 'DisableRule')).toBe(true));
    const disable = calls.find(call => call.target === 'DisableRule');
    expect(disable?.input).toEqual({ Name: 'orders-to-queue', EventBusName: 'default' });
  });

  it('puts a test event and reports a rejected entry as a failure', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      ...BASE_ROUTES,
      PutEvents: () => ({
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: 'InvalidArgument', ErrorMessage: 'Detail must be an object' }],
      }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await user.click(await screen.findByTestId('open-rule-orders-to-queue'));
    await screen.findByTestId('rule-detail');
    await user.click(screen.getByRole('tab', { name: 'Put a test event' }));
    await user.click(await screen.findByTestId('put-event'));

    const result = await screen.findByTestId('put-event-result');
    // A 200 carrying a failed entry is a failure, not a success.
    expect(result).toHaveTextContent('InvalidArgument');
    expect(result).toHaveTextContent('Detail must be an object');
    const put = calls.find(call => call.target === 'PutEvents');
    expect((put?.input.Entries as { EventBusName: string }[])[0].EventBusName).toBe('default');
  });

  it('falls back to the default bus when the target cannot list buses', async () => {
    const { fetchStub } = stubTarget({ ListRules: BASE_ROUTES.ListRules });
    vi.stubGlobal('fetch', fetchStub);

    await openRules();
    await screen.findByTestId('bus-error');
    // The rules still list, because the default bus is always offered.
    await waitFor(() =>
      expect(screen.getByTestId('rule-table')).toHaveTextContent('orders-to-queue'),
    );
  });
});
