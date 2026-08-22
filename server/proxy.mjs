import { checkEndpoint, REAL_AWS_SUFFIXES, REFUSAL_MESSAGE } from './endpoint-safety.mjs';
import { signRequest } from './sigv4.mjs';

/**
 * The console backend.
 *
 * Every call the browser makes to a target goes through here:
 * browser -> console backend -> target endpoint. That removes CORS from the
 * picture, keeps SigV4 (and therefore any credential material) out of the page,
 * and gives one place to refuse real-AWS hosts.
 *
 * The browser sends a request envelope built from the service catalog; this
 * layer only signs, forwards, and reports back. It never interprets the
 * service protocol.
 */

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Response bodies that are safe to hand back as text rather than base64. */
const TEXTUAL = /^(text\/|application\/(json|xml|x-amz-json|x-www-form-urlencoded))/i;

export function createProxyHandler({ fetchImpl = globalThis.fetch } = {}) {
  return async function handle(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://console.local');

    if (url.pathname === '/api/limits' && req.method === 'GET') {
      return json(res, 200, {
        refusedHostSuffixes: REAL_AWS_SUFFIXES,
        refusalMessage: REFUSAL_MESSAGE,
      });
    }

    if (url.pathname !== '/api/request') {
      if (next) return next();
      return json(res, 404, { message: 'Not found' });
    }

    if (req.method !== 'POST') {
      return json(res, 405, { message: 'Use POST' });
    }

    let envelope;
    try {
      envelope = JSON.parse(await readBody(req));
    } catch (error) {
      return json(res, 400, { message: `Malformed request envelope: ${error.message}` });
    }

    const safety = checkEndpoint(envelope.endpoint ?? '');
    if (!safety.ok) {
      return json(res, 403, { message: safety.reason, refused: true });
    }

    const target = buildTargetUrl(safety.url, envelope);
    const body = decodeBody(envelope);
    if (body.length > MAX_BODY_BYTES) {
      return json(res, 413, { message: 'Request body too large' });
    }

    const headers = normalizeHeaders(envelope.headers);
    Object.assign(
      headers,
      signRequest({
        method: envelope.method ?? 'POST',
        url: target,
        headers,
        body,
        service: envelope.signingName || 'execute-api',
        region: envelope.region || 'us-east-1',
      }),
    );

    let upstream;
    const startedAt = Date.now();
    try {
      upstream = await fetchImpl(target, {
        method: envelope.method ?? 'POST',
        headers,
        body: ['GET', 'HEAD'].includes((envelope.method ?? 'POST').toUpperCase())
          ? undefined
          : body,
        redirect: 'manual',
      });
    } catch (error) {
      return json(res, 502, {
        message: `Could not reach ${target.origin}: ${error.cause?.code ?? error.message}`,
        unreachable: true,
      });
    }

    const raw = Buffer.from(await upstream.arrayBuffer());
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    const contentType = responseHeaders['content-type'] ?? '';
    const textual = TEXTUAL.test(contentType) || (!contentType && looksLikeText(raw));

    return json(res, 200, {
      status: upstream.status,
      headers: responseHeaders,
      body: textual ? raw.toString('utf8') : raw.toString('base64'),
      bodyEncoding: textual ? 'utf8' : 'base64',
      durationMs: Date.now() - startedAt,
    });
  };
}

function buildTargetUrl(endpointUrl, envelope) {
  const base = endpointUrl.pathname.replace(/\/$/, '');
  const path = envelope.path && envelope.path !== '/' ? envelope.path : '/';
  const target = new URL(`${base}${path === '/' && base ? '/' : path}`, endpointUrl.origin);
  for (const [key, value] of Object.entries(envelope.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) target.searchParams.append(key, item);
    else target.searchParams.append(key, value);
  }
  return target;
}

function decodeBody(envelope) {
  if (envelope.body === undefined || envelope.body === null) return Buffer.alloc(0);
  return Buffer.from(envelope.body, envelope.bodyEncoding === 'base64' ? 'base64' : 'utf8');
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  // The browser cannot set these; the backend owns them.
  delete out.host;
  delete out['content-length'];
  return out;
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 512);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}
