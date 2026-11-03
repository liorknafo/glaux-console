import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';

/**
 * The SQS screen end to end, through the real shell and the real request path.
 *
 * SQS is a `json` protocol service, so the stub routes on the `X-Amz-Target`
 * header the way the wire does and answers with the documents the SQS model
 * declares.
 */

interface Envelope {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

const QUEUE_BASE = 'http://localhost:4566/000000000000';

const ATTRIBUTES = {
  QueueArn: 'arn:aws:sqs:us-east-1:000000000000:orders',
  ApproximateNumberOfMessages: '2',
  ApproximateNumberOfMessagesNotVisible: '1',
  ApproximateNumberOfMessagesDelayed: '0',
  VisibilityTimeout: '30',
  MessageRetentionPeriod: '345600',
  MaximumMessageSize: '262144',
  DelaySeconds: '0',
  ReceiveMessageWaitTimeSeconds: '0',
  CreatedTimestamp: '1756080000',
  RedrivePolicy:
    '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:000000000000:orders-dlq","maxReceiveCount":5}',
};

const MESSAGES = {
  Messages: [
    {
      MessageId: 'm-1',
      ReceiptHandle: 'handle-1',
      Body: '{"order_id":"A-1","total":19.5}',
      MD5OfBody: 'abc123',
      Attributes: { SentTimestamp: '1756080000000', ApproximateReceiveCount: '2' },
      MessageAttributes: { source: { DataType: 'String', StringValue: 'console' } },
    },
  ],
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

type Route = (input: Record<string, unknown>) => unknown;

/** Route on the JSON protocol's own target header. */
function stubTarget(routes: Record<string, Route>) {
  const calls: { target: string; input: Record<string, unknown> }[] = [];
  const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;

    if (envelope.path === '/_fakecloud/health') {
      return backendResponse({
        status: 200,
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['sqs'] }),
      });
    }

    const target = (envelope.headers?.['x-amz-target'] ?? '').split('.').pop() ?? '';
    calls.push({
      target,
      input: JSON.parse(envelope.body ?? '{}') as Record<string, unknown>,
    });

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
    return backendResponse({ status: 200, body: JSON.stringify(route(calls.at(-1)!.input)) });
  });
  return { fetchStub, calls };
}

const BASE_ROUTES: Record<string, Route> = {
  ListQueues: () => ({ QueueUrls: [`${QUEUE_BASE}/orders`, `${QUEUE_BASE}/orders-dlq`] }),
  GetQueueAttributes: () => ({ Attributes: ATTRIBUTES }),
  ListDeadLetterSourceQueues: () => ({ queueUrls: [] }),
};

async function openQueues() {
  window.location.hash = '#/service/sqs';
  render(<App />);
  return screen.findByTestId('queue-table');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SQS queues', () => {
  it('lists queues and shows the selected queue’s attributes', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    const table = await openQueues();
    await waitFor(() => expect(within(table).getByText('orders')).toBeInTheDocument());
    expect(within(table).getByText('orders-dlq')).toBeInTheDocument();

    await user.click(screen.getByTestId('open-queue-orders'));

    const detail = await screen.findByTestId('queue-detail');
    await waitFor(() =>
      expect(within(detail).getByTestId('messages-available')).toHaveTextContent('2'),
    );
    expect(within(detail).getByTestId('messages-in-flight')).toHaveTextContent('1');
    expect(detail).toHaveTextContent('arn:aws:sqs:us-east-1:000000000000:orders');
    expect(detail).toHaveTextContent('256.0 KB');
  });

  it('peeks without consuming: a zero visibility timeout and a short poll', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, ReceiveMessage: () => MESSAGES });
    vi.stubGlobal('fetch', fetchStub);

    await openQueues();
    await user.click(await screen.findByTestId('open-queue-orders'));
    await screen.findByTestId('queue-detail');
    await user.click(await screen.findByTestId('poll-messages'));

    const messages = await screen.findByTestId('message-table');
    await waitFor(() => expect(messages).toHaveTextContent('order_id'));
    // The receive count a peek itself bumps is shown, not hidden.
    expect(messages).toHaveTextContent('2');

    const receive = calls.find(call => call.target === 'ReceiveMessage');
    expect(receive?.input.VisibilityTimeout).toBe(0);
    expect(receive?.input.WaitTimeSeconds).toBe(0);
    expect(receive?.input.MessageSystemAttributeNames).toEqual(['All']);
    // Sending the deprecated AttributeNames alongside it is an error in SQS.
    expect(receive?.input.AttributeNames).toBeUndefined();

    await user.click(await screen.findByRole('radio', { name: 'Select m-1' }));
    const body = await screen.findByTestId('message-body');
    expect(body).toHaveTextContent('"total":19.5');
    expect(screen.getByTestId('message-attributes')).toHaveTextContent('console');
  });

  it('sends a message to the queue in view', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      ...BASE_ROUTES,
      SendMessage: () => ({ MessageId: 'sent-1', MD5OfMessageBody: 'def456' }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await openQueues();
    await user.click(await screen.findByTestId('open-queue-orders'));
    await screen.findByTestId('queue-detail');
    await user.click(screen.getByRole('tab', { name: 'Send message' }));

    const input = within(await screen.findByTestId('message-body-input')).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'hello');
    await user.click(screen.getByTestId('send-message'));

    await waitFor(() => expect(screen.getByTestId('send-result')).toHaveTextContent('sent-1'));
    const sent = calls.find(call => call.target === 'SendMessage');
    expect(sent?.input.MessageBody).toBe('hello');
    expect(sent?.input.QueueUrl).toBe(`${QUEUE_BASE}/orders`);
    // A non-FIFO queue must not be sent a message group it does not accept.
    expect(sent?.input.MessageGroupId).toBeUndefined();
  });

  it('requires typing the queue name before it purges', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({ ...BASE_ROUTES, PurgeQueue: () => ({}) });
    vi.stubGlobal('fetch', fetchStub);

    await openQueues();
    await user.click(await screen.findByTestId('open-queue-orders'));
    await screen.findByTestId('queue-detail');
    await user.click(await screen.findByTestId('purge-queue'));

    const confirm = await screen.findByTestId('confirm-destructive');
    expect(confirm).toBeDisabled();
    expect(calls.some(call => call.target === 'PurgeQueue')).toBe(false);

    await user.type(
      within(screen.getByTestId('destructive-phrase')).getByRole('textbox'),
      'orders',
    );
    await waitFor(() => expect(screen.getByTestId('confirm-destructive')).toBeEnabled());
    await user.click(screen.getByTestId('confirm-destructive'));

    await waitFor(() => expect(calls.some(call => call.target === 'PurgeQueue')).toBe(true));
    expect(await screen.findByTestId('messages-notice')).toHaveTextContent('orders');
  });

  it('shows the redrive policy and links to the dead-letter queue', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(BASE_ROUTES);
    vi.stubGlobal('fetch', fetchStub);

    await openQueues();
    await user.click(await screen.findByTestId('open-queue-orders'));
    await screen.findByTestId('queue-detail');
    await user.click(screen.getByRole('tab', { name: 'Dead-letter queue' }));

    await waitFor(() => expect(screen.getByTestId('max-receive-count')).toHaveTextContent('5'));
    // The ARN resolves to a queue that is actually on this target.
    await user.click(screen.getByTestId('open-dead-letter-target'));
    await waitFor(() => expect(screen.getByTestId('queue-detail')).toHaveTextContent('orders-dlq'));
  });

  it('reports a listing failure instead of showing an empty target', async () => {
    const { fetchStub } = stubTarget({});
    vi.stubGlobal('fetch', fetchStub);

    window.location.hash = '#/service/sqs';
    render(<App />);

    const error = await screen.findByTestId('sqs-error');
    expect(error).toHaveTextContent('no stub for ListQueues');
  });
});
