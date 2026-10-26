import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';

/**
 * The Firehose delivery monitor end to end, through the real shell and the real
 * request path.
 *
 * Firehose is JSON-1.1 and S3 is rest-xml, and this screen uses both — the
 * stream configuration comes from Firehose, and what the stream actually
 * delivered is read out of the destination bucket. The stub answers each on its
 * own wire, with the shapes those two models declare.
 */

interface Envelope {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: string;
}

const STREAM = {
  DeliveryStreamDescription: {
    DeliveryStreamName: 'orders-to-lake',
    DeliveryStreamARN: 'arn:aws:firehose:us-east-1:000000000000:deliverystream/orders-to-lake',
    DeliveryStreamStatus: 'ACTIVE',
    DeliveryStreamType: 'DirectPut',
    VersionId: '1',
    CreateTimestamp: 1_756_000_000,
    Destinations: [
      {
        DestinationId: 'destinationId-000000000001',
        ExtendedS3DestinationDescription: {
          BucketARN: 'arn:aws:s3:::lake',
          Prefix: 'orders/!{timestamp:yyyy/MM/dd}/',
          ErrorOutputPrefix: 'errors/!{firehose:error-output-type}/',
          BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 60 },
          CompressionFormat: 'GZIP',
          RoleARN: 'arn:aws:iam::000000000000:role/firehose',
        },
      },
    ],
  },
};

const DELIVERED = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>lake</Name>
  <Prefix>orders/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>orders/2026/08/24/orders-1.json.gz</Key>
    <LastModified>2026-08-24T09:00:00.000Z</LastModified>
    <Size>1024</Size>
  </Contents>
  <Contents>
    <Key>orders/2026/08/24/orders-2.json.gz</Key>
    <LastModified>2026-08-24T10:00:00.000Z</LastModified>
    <Size>2048</Size>
  </Contents>
</ListBucketResult>`;

const ERRORS = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>lake</Name>
  <Prefix>errors/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>errors/processing-failed/2026/08/24/rejected-1</Key>
    <LastModified>2026-08-24T10:05:00.000Z</LastModified>
    <Size>128</Size>
  </Contents>
</ListBucketResult>`;

function backendResponse(payload: { status: number; headers: unknown; body: string }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ...payload, bodyEncoding: 'utf8', durationMs: 2 }),
  } as Response;
}

function stubTarget({
  firehose = {} as Record<string, (envelope: Envelope) => unknown>,
  s3 = {} as Record<string, (envelope: Envelope) => string>,
} = {}) {
  const calls: Envelope[] = [];
  const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    calls.push(envelope);

    if (envelope.path === '/_fakecloud/health') {
      return backendResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['firehose', 's3'] }),
      });
    }

    const target = envelope.headers?.['x-amz-target'];
    if (target) {
      const route = firehose[target];
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
    }

    const prefix = String(envelope.query?.prefix ?? '');
    const known = Object.hasOwn(s3, prefix);
    return backendResponse({
      status: known ? 200 : 404,
      headers: { 'content-type': 'application/xml' },
      body: known
        ? s3[prefix](envelope)
        : `<Error><Code>NoSuchBucket</Code><Message>no stub for prefix "${prefix}"</Message></Error>`,
    });
  });
  return { fetchStub, calls };
}

const WORKING_TARGET = {
  firehose: {
    'Firehose_20150804.ListDeliveryStreams': () => ({
      DeliveryStreamNames: ['orders-to-lake'],
      HasMoreDeliveryStreams: false,
    }),
    'Firehose_20150804.DescribeDeliveryStream': () => STREAM,
    'Firehose_20150804.PutRecordBatch': () => ({
      FailedPutCount: 0,
      RequestResponses: [{ RecordId: 'r-1' }, { RecordId: 'r-2' }],
    }),
  },
  s3: {
    'orders/': () => DELIVERED,
    'errors/': () => ERRORS,
  },
};

async function openFirehose() {
  window.location.hash = '#/service/firehose';
  render(<App />);
  return screen.findByTestId('stream-table');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Firehose delivery monitor', () => {
  it('lists streams and shows the buffering and destination configuration', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget(WORKING_TARGET);
    vi.stubGlobal('fetch', fetchStub);

    const streams = await openFirehose();
    await waitFor(() => expect(within(streams).getByText('orders-to-lake')).toBeInTheDocument());

    await user.click(screen.getByTestId('open-stream-orders-to-lake'));

    const detail = await screen.findByTestId('stream-detail');
    await waitFor(() =>
      expect(within(detail).getByTestId('stream-status')).toHaveTextContent('ACTIVE'),
    );
    expect(detail).toHaveTextContent('DirectPut');

    await user.click(screen.getByText('Destination'));
    expect(await screen.findByTestId('buffer-size')).toHaveTextContent('5.00 MB');
    expect(screen.getByTestId('buffer-interval')).toHaveTextContent('60 s');
    expect(screen.getByTestId('destination-prefix')).toHaveTextContent(
      'orders/!{timestamp:yyyy/MM/dd}/',
    );
    expect(screen.getByTestId('error-output-prefix')).toHaveTextContent(
      'errors/!{firehose:error-output-type}/',
    );
  });

  it('reads what the stream delivered out of the destination bucket', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(WORKING_TARGET);
    vi.stubGlobal('fetch', fetchStub);

    await openFirehose();
    await user.click(await screen.findByTestId('open-stream-orders-to-lake'));
    await screen.findByTestId('stream-detail');

    await waitFor(() => expect(screen.getByTestId('objects-written')).toHaveTextContent('2'));
    expect(screen.getByTestId('bytes-delivered')).toHaveTextContent('3.00 KB');
    expect(screen.getByTestId('error-objects')).toHaveTextContent('1');

    const delivered = screen.getByTestId('delivered-objects');
    expect(delivered).toHaveTextContent('orders/2026/08/24/orders-2.json.gz');
    expect(screen.getByTestId('error-objects-table')).toHaveTextContent(
      'errors/processing-failed/2026/08/24/rejected-1',
    );

    // Both listings are undelimited and start at the literal part of the
    // stream's prefix — the expressions in it cannot be listed.
    const listings = calls.filter(envelope => envelope.query?.['list-type'] === '2');
    expect(listings.map(envelope => envelope.query.prefix).sort()).toEqual(['errors/', 'orders/']);
    expect(listings.every(envelope => envelope.query.delimiter === undefined)).toBe(true);
  });

  it('opens the S3 browser at the prefix a delivered object sits in', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      ...WORKING_TARGET,
      s3: {
        ...WORKING_TARGET.s3,
        '': () => `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult><Buckets><Bucket><Name>lake</Name></Bucket></Buckets></ListAllMyBucketsResult>`,
        'orders/2026/08/24/': () => DELIVERED,
      },
    });
    vi.stubGlobal('fetch', fetchStub);

    await openFirehose();
    await user.click(await screen.findByTestId('open-stream-orders-to-lake'));
    await screen.findByTestId('delivered-objects');
    await waitFor(() =>
      expect(screen.getByTestId('delivered-objects')).toHaveTextContent('orders-2.json.gz'),
    );

    await user.click(screen.getByText('orders/2026/08/24/orders-2.json.gz'));

    // The S3 screen opens on the bucket, at the object's own prefix.
    const objects = await screen.findByTestId('object-table');
    await waitFor(() => expect(objects).toHaveTextContent('orders-2.json.gz'));
    expect(screen.getByTestId('prefix-crumbs')).toHaveTextContent('lake');
  });

  it('puts test records through PutRecordBatch and reports what was accepted', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget(WORKING_TARGET);
    vi.stubGlobal('fetch', fetchStub);

    await openFirehose();
    await user.click(await screen.findByTestId('open-stream-orders-to-lake'));
    await screen.findByTestId('stream-detail');

    await user.click(screen.getByText('Put test records'));
    await user.click(await screen.findByTestId('put-records'));

    const result = await screen.findByTestId('put-result');
    expect(result).toHaveTextContent('2 records accepted');

    const put = calls.find(
      envelope => envelope.headers?.['x-amz-target'] === 'Firehose_20150804.PutRecordBatch',
    );
    const sent = JSON.parse(put?.body ?? '{}') as {
      DeliveryStreamName: string;
      Records: { Data: string }[];
    };
    expect(sent.DeliveryStreamName).toBe('orders-to-lake');
    expect(sent.Records).toHaveLength(2);
    // Record data is a blob member: base64, and newline-terminated so a
    // JSON-lines destination stays readable.
    expect(atob(sent.Records[0].Data)).toBe('{"order_id":"A-1","total":19.5}\n');
  });

  it('reports a rejected record instead of claiming success', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      ...WORKING_TARGET,
      firehose: {
        ...WORKING_TARGET.firehose,
        'Firehose_20150804.PutRecordBatch': () => ({
          FailedPutCount: 1,
          RequestResponses: [
            { RecordId: 'r-1' },
            { ErrorCode: 'ServiceUnavailableException', ErrorMessage: 'slow down' },
          ],
        }),
      },
    });
    vi.stubGlobal('fetch', fetchStub);

    await openFirehose();
    await user.click(await screen.findByTestId('open-stream-orders-to-lake'));
    await screen.findByTestId('stream-detail');
    await user.click(screen.getByText('Put test records'));
    await user.click(await screen.findByTestId('put-records'));

    const result = await screen.findByTestId('put-result');
    expect(result).toHaveTextContent('1 of 2 records failed');
    expect(result).toHaveTextContent('ServiceUnavailableException: slow down');
  });

  it('reports a listing failure rather than showing an empty stream list', async () => {
    const { fetchStub } = stubTarget();
    vi.stubGlobal('fetch', fetchStub);

    window.location.hash = '#/service/firehose';
    render(<App />);

    expect(await screen.findByTestId('firehose-error')).toHaveTextContent('UnknownOperation');
  });
});
