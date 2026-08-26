import { createHash, createHmac } from 'node:crypto';

/**
 * SigV4 with dummy credentials.
 *
 * Local emulators do not verify signatures, but they do parse the
 * Authorization header for the region and service, and some reject requests
 * that carry none. Signing here — rather than in the browser — is what keeps
 * credentials out of the page entirely.
 */
export const DUMMY_CREDENTIALS = {
  accessKeyId: 'glaux-console',
  secretAccessKey: 'glaux-console-local-emulator-only',
};

const UNSIGNED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'expect',
  'proxy-authorization',
  'te',
  'transfer-encoding',
  'upgrade',
  'user-agent',
]);

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

/** RFC 3986 encoding, which is stricter than encodeURIComponent. */
function uriEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(path) {
  return (
    path
      .split('/')
      .map(segment => uriEncode(decodeURIComponent(segment)))
      .join('/') || '/'
  );
}

function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([uriEncode(key), uriEncode(value)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/**
 * @param {{ method: string, url: URL, headers: Record<string,string>, body: Buffer,
 *           service: string, region: string, now?: Date }} request
 * @returns {Record<string, string>} headers to add
 */
export function signRequest({ method, url, headers, body, service, region, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

  const signedHeaders = { ...headers, host: url.host, 'x-amz-date': amzDate };
  signedHeaders['x-amz-content-sha256'] = payloadHash;

  const canonicalHeaderEntries = Object.entries(signedHeaders)
    .map(([key, value]) => [key.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .filter(([key]) => !UNSIGNED_HEADERS.has(key))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = canonicalHeaderEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaderNames = canonicalHeaderEntries.map(([k]) => k).join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  let signingKey = hmac(`AWS4${DUMMY_CREDENTIALS.secretAccessKey}`, dateStamp);
  signingKey = hmac(signingKey, region);
  signingKey = hmac(signingKey, service);
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${DUMMY_CREDENTIALS.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
  };
}
