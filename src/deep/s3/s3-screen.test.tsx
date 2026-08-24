import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';

/**
 * The S3 browser end to end, through the real shell and the real request path.
 *
 * S3 is a `rest-xml` service, so the stub routes on method and path the way the
 * wire does, and answers with the XML documents the S3 model declares — not
 * with anything emulator-specific.
 */

interface Envelope {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: string;
}

interface Reply {
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

const LIST_BUCKETS = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Buckets>
    <Bucket><Name>lake</Name><CreationDate>2026-08-01T00:00:00.000Z</CreationDate></Bucket>
    <Bucket><Name>staging</Name><CreationDate>2026-08-02T00:00:00.000Z</CreationDate></Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;

const ROOT_LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>lake</Name>
  <Prefix></Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <CommonPrefixes><Prefix>orders/</Prefix></CommonPrefixes>
  <Contents>
    <Key>manifest.json</Key>
    <LastModified>2026-08-24T09:00:00.000Z</LastModified>
    <ETag>&quot;d41d8&quot;</ETag>
    <Size>2048</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`;

const ORDERS_LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>lake</Name>
  <Prefix>orders/</Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>orders/part-0.parquet</Key>
    <LastModified>2026-08-24T09:30:00.000Z</LastModified>
    <Size>1048576</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`;

function backendResponse(payload: {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: string;
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ...payload,
      bodyEncoding: payload.bodyEncoding ?? 'utf8',
      durationMs: 2,
    }),
  } as Response;
}

/** Route on method and path, the way an S3 request actually routes. */
function stubTarget(routes: Record<string, (envelope: Envelope) => Reply>) {
  const calls: Envelope[] = [];
  const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope;
    calls.push(envelope);

    if (envelope.path === '/_fakecloud/health') {
      return backendResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'test', services: ['s3'] }),
      });
    }

    const key = `${envelope.method} ${envelope.path}`;
    const route = routes[key];
    if (!route) {
      return backendResponse({
        status: 404,
        headers: { 'content-type': 'application/xml' },
        body: `<Error><Code>NoSuchKey</Code><Message>no stub for ${key}</Message></Error>`,
      });
    }
    const reply = route(envelope);
    return backendResponse({
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/xml', ...reply.headers },
      body: reply.body,
    });
  });
  return { fetchStub, calls };
}

async function openBrowser() {
  window.location.hash = '#/service/s3';
  render(<App />);
  return screen.findByTestId('bucket-table');
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('S3 browser', () => {
  it('lists buckets and browses into a prefix', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      'GET /': () => ({ body: LIST_BUCKETS }),
      'GET /lake': envelope => ({
        body: envelope.query.prefix === 'orders/' ? ORDERS_LISTING : ROOT_LISTING,
      }),
    });
    vi.stubGlobal('fetch', fetchStub);

    const buckets = await openBrowser();
    await waitFor(() => expect(within(buckets).getByText('lake')).toBeInTheDocument());
    expect(within(buckets).getByText('staging')).toBeInTheDocument();

    await user.click(screen.getByTestId('open-bucket-lake'));

    const objects = await screen.findByTestId('object-table');
    await waitFor(() => expect(within(objects).getByText('manifest.json')).toBeInTheDocument());
    // A CommonPrefix is a row of its own, not a key.
    expect(within(objects).getByTestId('open-prefix-orders/')).toBeInTheDocument();
    expect(within(objects).getByText('2.00 KB')).toBeInTheDocument();

    await user.click(screen.getByTestId('open-prefix-orders/'));

    await waitFor(() =>
      expect(
        within(screen.getByTestId('object-table')).getByText('part-0.parquet'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('object-table')).toHaveTextContent('1.00 MB');

    // The listing is delimiter-based, which is what makes the flat key space
    // browsable at all.
    const listing = calls.find(envelope => envelope.query?.prefix === 'orders/');
    expect(listing?.query.delimiter).toBe('/');
    expect(listing?.query['list-type']).toBe('2');
  });

  it('shows an object’s metadata from HeadObject, including user metadata', async () => {
    const user = userEvent.setup();
    const { fetchStub } = stubTarget({
      'GET /': () => ({ body: LIST_BUCKETS }),
      'GET /lake': () => ({ body: ROOT_LISTING }),
      'HEAD /lake/manifest.json': () => ({
        body: '',
        headers: {
          'content-type': 'application/json',
          'content-length': '2048',
          etag: '"d41d8"',
          'last-modified': 'Mon, 24 Aug 2026 09:00:00 GMT',
          'x-amz-meta-produced-by': 'firehose',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await openBrowser();
    await user.click(await screen.findByTestId('open-bucket-lake'));
    await screen.findByTestId('object-table');

    await user.click(await screen.findByRole('radio', { name: 'Select manifest.json' }));

    const details = await screen.findByTestId('object-details');
    await waitFor(() =>
      expect(within(details).getByTestId('metadata-size')).toHaveTextContent('2.00 KB'),
    );
    expect(details).toHaveTextContent('application/json');
    expect(within(details).getByTestId('user-metadata')).toHaveTextContent('produced-by');
    expect(within(details).getByTestId('user-metadata')).toHaveTextContent('firehose');
  });

  it('uploads a file to the prefix in view', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      'GET /': () => ({ body: LIST_BUCKETS }),
      'GET /lake': envelope => ({
        body: envelope.query.prefix === 'orders/' ? ORDERS_LISTING : ROOT_LISTING,
      }),
      'PUT /lake/orders/notes.txt': () => ({ body: '', headers: { etag: '"n"' } }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await openBrowser();
    await user.click(await screen.findByTestId('open-bucket-lake'));
    await screen.findByTestId('object-table');
    await user.click(screen.getByTestId('open-prefix-orders/'));
    await screen.findByText('part-0.parquet');

    await user.click(screen.getByTestId('upload-object'));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput, {
      target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
    });
    // The key defaults to the prefix in view plus the file's own name.
    await waitFor(() =>
      expect(within(screen.getByTestId('upload-key')).getByRole('textbox')).toHaveValue(
        'orders/notes.txt',
      ),
    );
    await user.click(screen.getByTestId('confirm-upload'));

    await waitFor(() =>
      expect(calls.some(envelope => envelope.path === '/lake/orders/notes.txt')).toBe(true),
    );
    const put = calls.find(envelope => envelope.path === '/lake/orders/notes.txt');
    expect(put?.method).toBe('PUT');
    // A blob payload travels base64 — the object's own bytes, not a JSON body.
    expect(put?.bodyEncoding).toBe('base64');
    expect(atob(String(put?.body))).toBe('hello');
    expect(put?.headers?.['content-type']).toBe('text/plain');
    expect(await screen.findByTestId('s3-notice')).toHaveTextContent('orders/notes.txt');
  });

  it('requires typing the key before it deletes an object', async () => {
    const user = userEvent.setup();
    const { fetchStub, calls } = stubTarget({
      'GET /': () => ({ body: LIST_BUCKETS }),
      'GET /lake': () => ({ body: ROOT_LISTING }),
      'HEAD /lake/manifest.json': () => ({ body: '', headers: { 'content-length': '2048' } }),
      'DELETE /lake/manifest.json': () => ({ body: '', status: 204 }),
    });
    vi.stubGlobal('fetch', fetchStub);

    await openBrowser();
    await user.click(await screen.findByTestId('open-bucket-lake'));
    await screen.findByTestId('object-table');
    await user.click(await screen.findByRole('radio', { name: 'Select manifest.json' }));
    await user.click(screen.getByTestId('delete-object'));

    const confirm = await screen.findByTestId('confirm-destructive');
    expect(confirm).toBeDisabled();
    expect(calls.some(envelope => envelope.method === 'DELETE')).toBe(false);

    await user.type(
      within(screen.getByTestId('destructive-phrase')).getByRole('textbox'),
      'manifest.json',
    );
    await waitFor(() => expect(screen.getByTestId('confirm-destructive')).toBeEnabled());
    await user.click(screen.getByTestId('confirm-destructive'));

    await waitFor(() => expect(calls.some(envelope => envelope.method === 'DELETE')).toBe(true));
  });

  it('reports a listing failure instead of showing an empty bucket', async () => {
    const { fetchStub } = stubTarget({
      'GET /': () => ({
        body: '<Error><Code>AccessDenied</Code><Message>no credentials</Message></Error>',
        status: 403,
      }),
    });
    vi.stubGlobal('fetch', fetchStub);

    window.location.hash = '#/service/s3';
    render(<App />);

    const error = await screen.findByTestId('s3-error');
    expect(error).toHaveTextContent('AccessDenied');
    expect(error).toHaveTextContent('no credentials');
  });
});
