import {
  ALLOW_HOSTS_ENV,
  checkEndpoint,
  operatorAllowedHosts,
  REAL_AWS_SUFFIXES,
  REFUSAL_MESSAGE,
  resolveLocalDestination,
} from './endpoint-safety.mjs';
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
/** A response is buffered in memory, so it is capped independently. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Undici's per-stage defaults are 300s; a local emulator has no such excuse. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Response bodies that are safe to hand back as text rather than base64. */
const TEXTUAL = /^(text\/|application\/(json|xml|x-amz-json|x-www-form-urlencoded))/i;

export function createProxyHandler({ fetchImpl = globalThis.fetch, lookupImpl } = {}) {
  return async function handle(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://console.local');

    if (url.pathname === '/api/limits' && req.method === 'GET') {
      return json(res, 200, {
        refusedHostSuffixes: REAL_AWS_SUFFIXES,
        refusalMessage: REFUSAL_MESSAGE,
        allowedNonLocalHosts: operatorAllowedHosts(),
        allowHostsEnvVar: ALLOW_HOSTS_ENV,
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

    // The host passed the rules that can be decided from the string. A name
    // still has to be resolved and checked before anything is sent to it, and
    // that happens per request rather than once when the endpoint was stored.
    const destination = await resolveLocalDestination(safety.url, { lookupImpl });
    if (!destination.ok) {
      return json(res, destination.unreachable ? 502 : 403, {
        message: destination.reason,
        refused: !destination.unreachable,
        unreachable: destination.unreachable ?? undefined,
      });
    }

    const targetUrl = buildTargetUrl(safety.url, envelope);
    if (!targetUrl.ok) {
      return json(res, 400, { message: targetUrl.reason, refused: true });
    }
    const target = targetUrl.url;

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
    let raw;
    const startedAt = Date.now();
    try {
      upstream = await fetchImpl(target, {
        method: envelope.method ?? 'POST',
        headers,
        body: ['GET', 'HEAD'].includes((envelope.method ?? 'POST').toUpperCase())
          ? undefined
          : body,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Reading the body can stall or run away long after the headers land, so
      // it is bounded here rather than buffered whole with arrayBuffer().
      raw = await readBoundedBody(upstream);
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return json(res, 504, {
          message: `${target.origin} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`,
          unreachable: true,
        });
      }
      if (error?.code === 'RESPONSE_TOO_LARGE') {
        return json(res, 502, { message: error.message });
      }
      return json(res, 502, {
        message: `Could not reach ${target.origin}: ${error.cause?.code ?? error.message}`,
        unreachable: true,
      });
    }
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

/**
 * Builds the target URL, taking the host from the validated endpoint and only
 * the path from the browser.
 *
 * `new URL(path, origin)` is NOT safe here: a path of "//host/x" or
 * "http://host/x" replaces the origin outright, which would let the page reach
 * any host and walk straight past the real-AWS refusal. Such a path is a bug or
 * an attack, so it is rejected rather than quietly rewritten.
 *
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
function buildTargetUrl(endpointUrl, envelope) {
  const requested =
    envelope.path === undefined || envelope.path === null || envelope.path === ''
      ? '/'
      : String(envelope.path);

  // Backslashes are folded to slashes by WHATWG URL parsing for http(s), so
  // "\\host" escapes just as "//host" does.
  const normalized = requested.replace(/\\/g, '/');
  // SigV4 canonicalisation decodes each segment, so a malformed escape such as
  // "/%ZZ" would throw a URIError out of the handler and answer nothing at all.
  try {
    decodeURIComponent(normalized);
  } catch {
    return { ok: false, reason: `Request path has a malformed percent-escape: "${requested}".` };
  }
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return {
      ok: false,
      reason:
        `Request path must be a single absolute path on the target endpoint, got "${requested}". ` +
        'The host is always taken from the selected endpoint.',
    };
  }

  const base = endpointUrl.pathname.replace(/\/$/, '');
  const target = new URL(endpointUrl.origin);
  // Assigning pathname cannot change the host, unlike resolving a URL.
  target.pathname = `${base}${normalized}`;

  for (const [key, value] of Object.entries(envelope.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) target.searchParams.append(key, item);
    else target.searchParams.append(key, value);
  }

  if (target.origin !== endpointUrl.origin) {
    return { ok: false, reason: 'Refusing to send a request to a host other than the endpoint.' };
  }
  return { ok: true, url: target };
}

/**
 * Streams the response, failing once it exceeds the cap instead of letting a
 * runaway body exhaust the process.
 */
async function readBoundedBody(upstream) {
  if (!upstream.body) return Buffer.from(await upstream.arrayBuffer());
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_RESPONSE_BYTES) {
      const error = new Error(
        `Response exceeded ${MAX_RESPONSE_BYTES} bytes and was not buffered.`,
      );
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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
