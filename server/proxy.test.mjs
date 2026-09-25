import { describe, expect, it, vi } from 'vitest';
import {
  ALLOW_HOSTS_ENV,
  checkEndpoint,
  isLocalAddress,
  METADATA_REFUSAL_MESSAGE,
  REFUSAL_MESSAGE,
  resolveLocalDestination,
} from './endpoint-safety.mjs';
import { createProxyHandler } from './proxy.mjs';
import { signRequest } from './sigv4.mjs';

/**
 * The console backend is the layer that actually enforces the local-only rule
 * and holds the credentials, so it is tested on its own rather than only
 * through the UI.
 */

function fakeResponse(res) {
  res.headers = {};
  res.chunks = [];
  res.setHeader = (key, value) => {
    res.headers[key] = value;
  };
  res.end = body => {
    res.body = body;
  };
  return res;
}

function request(body, { method = 'POST', url = '/api/request' } = {}) {
  const listeners = {};
  return {
    method,
    url,
    on(event, handler) {
      listeners[event] = handler;
      if (event === 'end') {
        listeners.data?.(Buffer.from(JSON.stringify(body)));
        handler();
      }
      return this;
    },
    destroy() {},
  };
}

async function call(handler, body, options) {
  const res = fakeResponse({});
  let nextCalled = false;
  await handler(request(body, options), res, () => {
    nextCalled = true;
  });
  return {
    status: res.statusCode,
    payload: res.body ? JSON.parse(res.body) : undefined,
    nextCalled,
    res,
  };
}

describe('endpoint safety', () => {
  it('refuses real AWS hosts', () => {
    for (const url of [
      'https://s3.amazonaws.com',
      'https://athena.us-east-1.amazonaws.com',
      'https://x.amazonaws.com.cn',
      'https://y.api.aws',
    ]) {
      const result = checkEndpoint(url);
      expect(result.ok, url).toBe(false);
      expect(result.reason).toBe(REFUSAL_MESSAGE);
    }
  });

  it('accepts local emulator endpoints', () => {
    expect(checkEndpoint('http://localhost:4566').ok).toBe(true);
    expect(checkEndpoint('http://127.0.0.1:9000/minio').ok).toBe(true);
  });

  it('refuses cloud instance-metadata addresses', () => {
    // The backend signs and forwards whatever it is handed, so a metadata
    // address would turn it into a way to read instance credentials.
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.170.2/v2/credentials',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://[fe80::1]/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://100.100.100.200/latest/meta-data/',
    ]) {
      const result = checkEndpoint(url);
      expect(result.ok, url).toBe(false);
      expect(result.reason).toBe(METADATA_REFUSAL_MESSAGE);
    }
  });
});

describe('local-only destinations', () => {
  /**
   * Refusing real AWS and the metadata services is a deny list, and a deny list
   * only names what someone thought of. The backend signs and forwards whatever
   * it is handed, so the destination has to be on the allow side of a positive
   * rule: a local address, or a host the operator named.
   */
  it('accepts loopback and private literals', () => {
    for (const url of [
      'http://127.0.0.1:9000/minio',
      'http://0.0.0.0:4566',
      'http://10.1.2.3:4566',
      'http://172.16.0.9:4566',
      'http://172.31.255.254:4566',
      'http://192.168.1.10:4566',
      'http://[::1]:4566',
      'http://[fd12:3456::1]:4566',
      'http://[::ffff:127.0.0.1]:4566',
      'http://localhost:4566',
      'http://glaux.localhost:4566',
    ]) {
      expect(checkEndpoint(url).ok, url).toBe(true);
    }
  });

  it('refuses literal addresses outside the local ranges', () => {
    for (const url of [
      'http://93.184.216.34:4566',
      'http://8.8.8.8',
      'http://172.32.0.1:4566',
      'http://172.15.255.255:4566',
      'http://191.168.1.10:4566',
      'http://100.64.0.1:4566',
      'http://[2606:4700:4700::1111]:4566',
      // WHATWG URL rewrites this to [::ffff:5db8:d822]; it is still 93.184.216.34.
      'http://[::ffff:93.184.216.34]:4566',
    ]) {
      const result = checkEndpoint(url);
      expect(result.ok, url).toBe(false);
      expect(result.reason, url).toMatch(/not a local address/);
    }
  });

  it('lets an operator name a host, but never a refused one', () => {
    const env = { [ALLOW_HOSTS_ENV]: 'emulator.example.com, 93.184.216.34' };
    expect(checkEndpoint('http://emulator.example.com:4566', env).ok).toBe(true);
    expect(checkEndpoint('http://93.184.216.34:4566', env).ok).toBe(true);
    // The override covers the local-only rule. It does not reopen the two that
    // exist because this backend holds credentials.
    expect(checkEndpoint('https://s3.amazonaws.com', env)).toMatchObject({
      ok: false,
      reason: REFUSAL_MESSAGE,
    });
    expect(
      checkEndpoint('http://169.254.169.254/', { [ALLOW_HOSTS_ENV]: '169.254.169.254' }),
    ).toMatchObject({ ok: false, reason: METADATA_REFUSAL_MESSAGE });
  });

  it('classifies addresses, not names', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('169.254.169.254')).toBe(false);
    expect(isLocalAddress('fd00:ec2::254')).toBe(false);
    expect(isLocalAddress('example.com')).toBe(false);
  });
});

describe('resolved destinations', () => {
  /**
   * A name says nothing about where it points, so it is resolved and every
   * answer checked, on every request. An endpoint stored while it resolved
   * locally cannot later be pointed somewhere else.
   */
  const url = new URL('http://emulator.test:4566');

  it('accepts a name that resolves inside the local ranges', async () => {
    const lookupImpl = vi.fn(async () => [{ address: '10.0.0.7', family: 4 }]);
    await expect(resolveLocalDestination(url, { lookupImpl, env: {} })).resolves.toEqual({
      ok: true,
      addresses: ['10.0.0.7'],
    });
    expect(lookupImpl).toHaveBeenCalledWith('emulator.test', { all: true, verbatim: true });
  });

  it('refuses a name that resolves outside them', async () => {
    const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
    const result = await resolveLocalDestination(url, { lookupImpl, env: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/resolved to 93\.184\.216\.34/);
  });

  it('refuses when any one answer is not local', async () => {
    const lookupImpl = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '203.0.113.5', family: 4 },
    ];
    const result = await resolveLocalDestination(url, { lookupImpl, env: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/203\.0\.113\.5/);
  });

  it('reports a name that does not resolve as unreachable, not refused', async () => {
    const lookupImpl = async () => {
      const error = new Error('getaddrinfo ENOTFOUND');
      error.code = 'ENOTFOUND';
      throw error;
    };
    const result = await resolveLocalDestination(url, { lookupImpl, env: {} });
    expect(result).toMatchObject({ ok: false, unreachable: true });
    expect(result.reason).toMatch(/ENOTFOUND/);
  });

  it('does not resolve a host the operator named', async () => {
    const lookupImpl = vi.fn();
    const result = await resolveLocalDestination(new URL('http://box.example.com:4566'), {
      lookupImpl,
      env: { [ALLOW_HOSTS_ENV]: 'box.example.com' },
    });
    expect(result.ok).toBe(true);
    expect(lookupImpl).not.toHaveBeenCalled();
  });
});

describe('target host confinement', () => {
  /**
   * The path in the request envelope comes from the browser. Resolving it as a
   * URL would let "//host" or "http://host" replace the endpoint's origin and
   * walk straight past the real-AWS refusal, so it must be rejected.
   */
  const escapes = [
    '//sqs.us-east-1.amazonaws.com/',
    'http://169.254.169.254/latest/meta-data/',
    'https://evil.example.com/x',
    '\\\\evil.example.com/x',
    '//evil.example.com',
  ];

  it.each(escapes)('refuses a path that would leave the endpoint host: %s', async path => {
    const fetchImpl = vi.fn();
    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'http://localhost:4566',
      signingName: 'sqs',
      method: 'GET',
      path,
    });

    expect(status).toBe(400);
    expect(payload.refused).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a path with a malformed percent-escape before signing it', async () => {
    // SigV4 canonicalisation decodes each segment; "/%ZZ" would throw a URIError
    // out of the handler and answer nothing at all.
    const fetchImpl = vi.fn();
    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'http://localhost:4566',
      signingName: 's3',
      method: 'GET',
      path: '/%ZZ',
    });

    expect(status).toBe(400);
    expect(payload.message).toContain('percent-escape');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the endpoint host for ordinary paths, including a mounted base path', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: { forEach: callback => callback('application/json', 'content-type') },
      arrayBuffer: async () => new TextEncoder().encode('{}').buffer,
    }));
    const handler = createProxyHandler({ fetchImpl });

    await call(handler, {
      endpoint: 'http://localhost:4566/emulator',
      signingName: 's3',
      method: 'GET',
      path: '/my-bucket/a%20key',
    });

    expect(fetchImpl.mock.calls[0][0].toString()).toBe(
      'http://localhost:4566/emulator/my-bucket/a%20key',
    );
  });
});

describe('POST /api/request', () => {
  it('refuses a real AWS target without contacting it', async () => {
    const fetchImpl = vi.fn();
    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'https://sqs.us-east-1.amazonaws.com',
      method: 'POST',
      path: '/',
    });

    expect(status).toBe(403);
    expect(payload.refused).toBe(true);
    expect(payload.message).toBe(REFUSAL_MESSAGE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-local target before contacting it', async () => {
    const fetchImpl = vi.fn();
    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'http://93.184.216.34:4566',
      method: 'POST',
      path: '/',
    });

    expect(status).toBe(403);
    expect(payload.refused).toBe(true);
    expect(payload.message).toMatch(/not a local address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a name that resolves off the local ranges, without sending anything', async () => {
    const fetchImpl = vi.fn();
    const handler = createProxyHandler({
      fetchImpl,
      lookupImpl: async () => [{ address: '203.0.113.5', family: 4 }],
    });
    const { status, payload } = await call(handler, {
      endpoint: 'http://emulator.test:4566',
      method: 'POST',
      path: '/',
    });

    expect(status).toBe(403);
    expect(payload.refused).toBe(true);
    expect(payload.message).toMatch(/resolved to 203\.0\.113\.5/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signs the request with dummy credentials and forwards it', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: new Map([['content-type', 'application/x-amz-json-1.0']]),
      arrayBuffer: async () => new TextEncoder().encode('{"QueueUrls":[]}').buffer,
    }));
    fetchImpl.mockImplementation(async () => ({
      status: 200,
      headers: {
        forEach: callback => callback('application/x-amz-json-1.0', 'content-type'),
      },
      arrayBuffer: async () => new TextEncoder().encode('{"QueueUrls":[]}').buffer,
    }));

    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'http://localhost:4566',
      region: 'eu-west-1',
      signingName: 'sqs',
      method: 'POST',
      path: '/',
      headers: { 'x-amz-target': 'AmazonSQS.ListQueues' },
      body: '{}',
      bodyEncoding: 'utf8',
    });

    expect(status).toBe(200);
    expect(payload.status).toBe(200);
    expect(payload.body).toBe('{"QueueUrls":[]}');
    expect(payload.bodyEncoding).toBe('utf8');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url.toString()).toBe('http://localhost:4566/');
    expect(init.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=glaux-console\/\d{8}\/eu-west-1\/sqs\/aws4_request/,
    );
    expect(init.headers['x-amz-target']).toBe('AmazonSQS.ListQueues');
    // The page never sees a credential; the backend adds it.
    expect(init.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('appends the query the browser built', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: { forEach: callback => callback('application/xml', 'content-type') },
      arrayBuffer: async () => new TextEncoder().encode('<ListBucketResult/>').buffer,
    }));
    const handler = createProxyHandler({ fetchImpl });
    await call(handler, {
      endpoint: 'http://localhost:4566',
      signingName: 's3',
      method: 'GET',
      path: '/my-bucket',
      query: { 'list-type': '2', prefix: 'raw/' },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url.toString()).toBe('http://localhost:4566/my-bucket?list-type=2&prefix=raw%2F');
    expect(init.body).toBeUndefined();
  });

  it('base64-encodes binary responses', async () => {
    const bytes = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0x00, 0xff]);
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: { forEach: callback => callback('application/octet-stream', 'content-type') },
      arrayBuffer: async () => bytes.buffer,
    }));
    const handler = createProxyHandler({ fetchImpl });
    const { payload } = await call(handler, {
      endpoint: 'http://localhost:4566',
      signingName: 's3',
      method: 'GET',
      path: '/b/k',
    });

    expect(payload.bodyEncoding).toBe('base64');
    expect(Buffer.from(payload.body, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('gives up on a target that never answers', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'http://localhost:4566',
      signingName: 'sqs',
      method: 'POST',
      path: '/',
    });

    expect(status).toBe(504);
    expect(payload.unreachable).toBe(true);
    expect(payload.message).toContain('did not answer');
  });

  it('refuses to buffer a response larger than the cap', async () => {
    // 64 MiB cap: stream three 32 MiB chunks and expect the read to stop.
    const chunk = new Uint8Array(32 * 1024 * 1024);
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: { forEach: callback => callback('application/octet-stream', 'content-type') },
      body: (async function* stream() {
        yield chunk;
        yield chunk;
        yield chunk;
      })(),
    }));
    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'http://localhost:4566',
      signingName: 's3',
      method: 'GET',
      path: '/b/k',
    });

    expect(status).toBe(502);
    expect(payload.message).toMatch(/exceeded .* bytes/);
  });

  it('reports an unreachable target rather than hanging', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    });
    const handler = createProxyHandler({ fetchImpl });
    const { status, payload } = await call(handler, {
      endpoint: 'http://localhost:4566',
      signingName: 'sqs',
      method: 'POST',
      path: '/',
    });

    expect(status).toBe(502);
    expect(payload.unreachable).toBe(true);
    expect(payload.message).toContain('ECONNREFUSED');
  });

  it('passes non-API paths to the static handler', async () => {
    const handler = createProxyHandler({ fetchImpl: vi.fn() });
    const { nextCalled, payload } = await call(handler, {}, { method: 'GET', url: '/index.html' });
    expect(nextCalled).toBe(true);
    expect(payload).toBeUndefined();
  });
});

describe('sigv4', () => {
  it('produces a stable signature for a fixed request and clock', () => {
    const headers = signRequest({
      method: 'POST',
      url: new URL('http://localhost:4566/'),
      headers: { 'content-type': 'application/x-amz-json-1.0' },
      body: Buffer.from('{}'),
      service: 'sqs',
      region: 'us-east-1',
      now: new Date('2026-08-22T09:00:00Z'),
    });

    expect(headers['x-amz-date']).toBe('20260822T090000Z');
    expect(headers.authorization).toContain('20260822/us-east-1/sqs/aws4_request');
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(headers['x-amz-content-sha256']).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });
});
