import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Single source of truth, shared with the browser-side endpoint form. */
const hosts = JSON.parse(readFileSync(join(HERE, '..', 'shared', 'real-aws-hosts.json'), 'utf8'));

export const REAL_AWS_SUFFIXES = hosts.suffixes;
export const BLOCKED_HOSTS = hosts.blockedHosts;

export const REFUSAL_MESSAGE =
  'glaux-console targets local emulators only. This host belongs to real AWS, and the console ' +
  'refuses to send requests to it — full CRUD against a production account is designed out.';

export const METADATA_REFUSAL_MESSAGE =
  'This is a cloud instance-metadata address. The console backend signs and forwards whatever it ' +
  'is given, so it refuses these outright rather than becoming a way to read instance credentials.';

/**
 * Link-local ranges: IPv4 169.254.0.0/16 (which carries the EC2/Azure metadata
 * service) and IPv6 fe80::/10 plus the EC2 IPv6 metadata address.
 */
function isLinkLocal(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  if (bare === 'fd00:ec2::254') return true;
  return false;
}

/**
 * Decides whether the console may send a request to an endpoint.
 *
 * @param {string} endpoint
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function checkEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: `"${endpoint}" is not a valid URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol "${url.protocol}". Use http or https.` };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  for (const suffix of REAL_AWS_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return { ok: false, reason: REFUSAL_MESSAGE };
    }
  }
  if (BLOCKED_HOSTS.includes(host) || isLinkLocal(host)) {
    return { ok: false, reason: METADATA_REFUSAL_MESSAGE };
  }
  return { ok: true, url };
}
