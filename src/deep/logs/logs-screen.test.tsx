import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';
import { TAIL_INTERVAL_MS } from './events';

/**
 * The CloudWatch Logs screen end to end, through the real shell and the real
 * request path. Logs is a `json` protocol service, so the stub routes on
 * `X-Amz-Target` and answers with the shapes the model declares.
 *
 * No live target was available to this run, so nothing here asserts how any
 * particular emulator behaves — only that the console sends what the model
 * says and renders what the model returns.
 */

interface Envelope {
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

type Route = (input: Record<string, unknown>) => unknown;

const GROUP = '/glaux/firehose/orders';
const AT = 1_756_000_000_000;

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
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['logs'] }),
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
          __type: 'InvalidAction',
          message: `no stub for ${target}`,
        }),
      });
    }
    return backendResponse({ status: 200, body: JSON.stringify(route(input)) });
  });
  return { fetchStub, calls };
}

const BASE_ROUTES: Record<string, Route> = {
  DescribeLogGroups: () => ({
    logGroups: [
      {
        logGroupName: GROUP,
        arn: `arn:aws:logs:us-east-1:000000000000:log-group:${GROUP}:*`,
        creationTime: AT - 86_400_000,
        retentionInDays: 7,
        storedBytes: 4096,
        logGroupClass: 'STANDARD',
      },
      { logGroupName: '/glaux/lambda/ingest', creationTime: AT - 3_600_000 },
    ],
  }),
  DescribeLogStreams: () => ({
    logStreams: [
      {
        logStreamName: '2026/08/27/[$LATEST]a1',
        creationTime: AT - 60_000,
        firstEventTimestamp: AT - 50_000,
        lastEventTimestamp: AT,
        lastIngestionTime: AT + 45_000,
      },
      { logStreamName: '2026/08/26/[$LATEST]b2', creationTime: AT - 90_000_000 },
    ],
  }),
  FilterLogEvents: () => ({
    events: [
      {
        eventId: '1',
        logStreamName: '2026/08/27/[$LATEST]a1',
        timestamp: AT,
        ingestionTime: AT + 5,
        message: 'delivery succeeded: 12 objects',
      },
    ],
  }),
};

async function openLogs() {
  window.location.hash = '#/service/logs';
  render(<App />);
  return screen.findByTestId('log-group-table');
}

/** Selects the delivery log group and waits for its detail panel. */
async function openGroup(user: ReturnType<typeof userEvent.setup>) {
  const table = await openLogs();
  await waitFor(() => expect(within(table).getByText(GROUP)).toBeInTheDocument());
  await user.click(screen.getByTestId(`open-log-group-${GROUP}`));
  return screen.findByTestId('log-group-detail');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the log group list', () => {
  it('is the Tail tab, in front of the generated ones', async () => {
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openLogs();
    const tabs = screen.getAllByRole('tab').map(tab => tab.textContent);
    expect(tabs).toEqual(['Tail', 'Resources', 'Actions']);
  });

  it('lists the groups on the target and filters them by name', async () => {
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    const table = await openLogs();
    await waitFor(() => expect(within(table).getByText(GROUP)).toBeInTheDocument());
    expect(within(table).getByText('/glaux/lambda/ingest')).toBeInTheDocument();

    await user.type(within(table).getByPlaceholderText('Find a log group'), 'lambda');
    await waitFor(() => expect(within(table).queryByText(GROUP)).not.toBeInTheDocument());
    expect(within(table).getByText('/glaux/lambda/ingest')).toBeInTheDocument();
  });

  it('shows a group’s retention and stored size, reading its times as milliseconds', async () => {
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    const detail = await openGroup(user);
    expect(within(detail).getByTestId('group-retention')).toHaveTextContent('7 days');
    expect(within(detail).getByText('4.00 KB')).toBeInTheDocument();
    expect(
      within(detail).getByText(new Date(AT - 86_400_000).toLocaleString()),
    ).toBeInTheDocument();
  });

  it('reports a target that cannot list log groups', async () => {
    const { fetchStub } = stubTarget({});
    vi.stubGlobal('fetch', fetchStub);

    await openLogs();
    const alert = await screen.findByTestId('logs-error');
    expect(alert).toHaveTextContent('no stub for DescribeLogGroups');
  });
});

describe('the tail', () => {
  it('sends nothing until it is asked to, then reads the whole group', async () => {
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    await openGroup(user);
    // Opening a group lists its groups; the tail itself has sent nothing.
    expect(calls.filter(call => call.target === 'FilterLogEvents')).toHaveLength(0);
    expect(screen.getByTestId('tail-all')).toBeInTheDocument();

    await user.click(screen.getByTestId('tail-refresh'));

    const table = await screen.findByTestId('tail-table');
    await waitFor(() =>
      expect(within(table).getByText('delivery succeeded: 12 objects')).toBeInTheDocument(),
    );
    expect(within(table).getByText('2026/08/27/[$LATEST]a1')).toBeInTheDocument();

    const [poll] = calls.filter(call => call.target === 'FilterLogEvents');
    expect(poll.input.logGroupName).toBe(GROUP);
    expect(poll.input.logStreamNames).toBeUndefined();
    expect(typeof poll.input.startTime).toBe('number');
  });

  it('polls forward from the newest event, and shows it only once', async () => {
    // The first poll's window start is wall-clock (five minutes ago), so the
    // fixture's events are placed relative to whatever the console asks for
    // rather than at a fixed instant.
    let base: number | undefined;
    const { fetchStub, calls } = stubTarget({
      ...BASE_ROUTES,
      FilterLogEvents: input => {
        const startTime = Number(input.startTime);
        base ??= startTime + 10;
        // startTime is inclusive, so a target answering honestly returns the
        // event the console already has alongside anything newer.
        return {
          events: [
            {
              eventId: '1',
              logStreamName: '2026/08/27/[$LATEST]a1',
              timestamp: base,
              message: 'first line',
            },
            {
              eventId: '2',
              logStreamName: '2026/08/27/[$LATEST]a1',
              timestamp: base + 1_000,
              message: 'second line',
            },
          ].filter(event => event.timestamp >= startTime),
        };
      },
    });
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    await openGroup(user);
    await user.click(screen.getByTestId('tail-refresh'));

    const table = await screen.findByTestId('tail-table');
    await waitFor(() => expect(within(table).getByText('second line')).toBeInTheDocument());

    await user.click(screen.getByTestId('tail-refresh'));
    await waitFor(() => {
      const polls = calls.filter(call => call.target === 'FilterLogEvents');
      expect(polls).toHaveLength(2);
      // The second poll starts at the newest timestamp, inclusive.
      expect(polls[1].input.startTime).toBe((base as number) + 1_000);
    });

    // The re-delivered event is recognised rather than shown twice.
    expect(within(table).getAllByText('first line')).toHaveLength(1);
    expect(within(table).getAllByText('second line')).toHaveLength(1);
  });

  it('sends an applied filter pattern and starts the window again', async () => {
    const { fetchStub, calls } = stubTarget({
      ...BASE_ROUTES,
      FilterLogEvents: input =>
        input.filterPattern === 'ERROR'
          ? {
              events: [
                {
                  eventId: '9',
                  logStreamName: '2026/08/27/[$LATEST]a1',
                  timestamp: AT + 5,
                  message: 'ERROR delivery failed',
                },
              ],
            }
          : { events: [] },
    });
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    await openGroup(user);
    await user.type(screen.getByPlaceholderText('?ERROR ?Exception'), 'ERROR');
    await user.click(screen.getByTestId('tail-apply-filter'));
    await user.click(screen.getByTestId('tail-refresh'));

    const table = await screen.findByTestId('tail-table');
    await waitFor(() =>
      expect(within(table).getByText('ERROR delivery failed')).toBeInTheDocument(),
    );
    expect(calls.at(-1)?.input.filterPattern).toBe('ERROR');
  });

  it('keeps polling on its own once it is following', async () => {
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

    try {
      await openGroup(user);
      await user.click(screen.getByTestId('tail-follow'));

      // Following polls once immediately…
      await waitFor(() =>
        expect(calls.filter(call => call.target === 'FilterLogEvents')).toHaveLength(1),
      );
      expect(screen.getByTestId('tail-follow')).toHaveTextContent('Stop');

      // …and again on the interval, which is what makes it a tail rather than
      // a refresh button.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TAIL_INTERVAL_MS + 100);
      });
      await waitFor(() =>
        expect(calls.filter(call => call.target === 'FilterLogEvents').length).toBeGreaterThan(1),
      );

      await user.click(screen.getByTestId('tail-follow'));
      const afterStopping = calls.filter(call => call.target === 'FilterLogEvents').length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TAIL_INTERVAL_MS * 3);
      });
      expect(calls.filter(call => call.target === 'FilterLogEvents')).toHaveLength(afterStopping);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops following when a poll fails rather than retrying into it', async () => {
    const { fetchStub } = stubTarget({ ...BASE_ROUTES, FilterLogEvents: undefined as never });
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    await openGroup(user);
    await user.click(screen.getByTestId('tail-follow'));

    const alert = await screen.findByTestId('tail-error');
    expect(alert).toHaveTextContent('no stub for FilterLogEvents');
    await waitFor(() =>
      expect(screen.getByTestId('tail-follow')).toHaveTextContent('Start tailing'),
    );
  });
});

describe('the stream list', () => {
  it('lists a group’s streams newest first, and reads their times as milliseconds', async () => {
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    await openGroup(user);
    await user.click(screen.getByRole('tab', { name: 'Streams' }));

    const table = await screen.findByTestId('stream-table');
    await waitFor(() =>
      expect(within(table).getByText('2026/08/27/[$LATEST]a1')).toBeInTheDocument(),
    );
    expect(within(table).getByText(new Date(AT).toLocaleString())).toBeInTheDocument();

    const listing = calls.find(call => call.target === 'DescribeLogStreams');
    expect(listing?.input).toMatchObject({
      logGroupName: GROUP,
      orderBy: 'LastEventTime',
      descending: true,
    });
  });

  it('narrows the tail to one stream, and hands it back', async () => {
    const { fetchStub, calls } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();

    await openGroup(user);
    await user.click(screen.getByRole('tab', { name: 'Streams' }));
    await user.click(await screen.findByTestId('tail-stream-2026/08/27/[$LATEST]a1'));

    // Choosing a stream returns to the Tail tab with that stream selected.
    expect(await screen.findByTestId('tail-stream')).toHaveTextContent('2026/08/27/[$LATEST]a1');
    await user.click(screen.getByTestId('tail-refresh'));

    await waitFor(() => {
      const poll = calls.filter(call => call.target === 'FilterLogEvents').at(-1);
      expect(poll?.input.logStreamNames).toEqual(['2026/08/27/[$LATEST]a1']);
    });

    await user.click(screen.getByTestId('tail-all-streams'));
    expect(await screen.findByTestId('tail-all')).toBeInTheDocument();
  });
});
