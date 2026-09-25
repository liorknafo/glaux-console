import { lookup as dnsLookup } from 'node:dns/promises';
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

/** The environment variable an operator sets to reach an emulator off this machine. */
export const ALLOW_HOSTS_ENV = 'GLAUX_CONSOLE_ALLOW_HOSTS';

export function nonLocalRefusalMessage(host) {
  return (
    `"${host}" is not a local address. The console backend signs and forwards whatever it is ` +
    'given, so it only sends requests to loopback and private addresses — otherwise anything ' +
    'that can reach this backend could use it to reach the rest of your network. Set ' +
    `${ALLOW_HOSTS_ENV} to a comma-separated host list to target an emulator elsewhere.`
  );
}

export function rebindRefusalMessage(host, address) {
  return (
    `"${host}" resolved to ${address}, which is not a local address. The name is re-resolved and ` +
    'checked on every request, so an endpoint that looks local cannot later point the backend at ' +
    'something that is not.'
  );
}

/**
 * Link-local ranges: IPv4 169.254.0.0/16 (which carries the EC2/Azure metadata
 * service) and IPv6 fe80::/10 plus the EC2 IPv6 metadata address.
 */
function isLinkLocal(host) {
  const bare = stripBrackets(host);
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  if (bare === 'fd00:ec2::254') return true;
  return false;
}

function stripBrackets(host) {
  return host.replace(/^\[|\]$/g, '');
}

function parseIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.some(octet => octet > 255) ? null : octets;
}

/** Loopback, "this host", and the three RFC 1918 ranges. */
function isLocalIpv4([a, b]) {
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/**
 * Expands an IPv6 literal to its eight 16-bit groups, or null if it is not one.
 *
 * The groups are needed rather than a prefix match on the text: WHATWG URL
 * parsing rewrites "::ffff:127.0.0.1" to "::ffff:7f00:1", so the mapped form an
 * operator types is not the form this code sees.
 */
function parseIpv6(host) {
  let text = host.toLowerCase();
  if (!text.includes(':')) return null;
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = parseIpv4(dotted[1]);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const values = groups.map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return values.some(Number.isNaN) ? null : values;
}

/** Loopback, unspecified, IPv4-mapped equivalents, and unique-local fc00::/7. */
function isLocalIpv6(host) {
  const groups = parseIpv6(host);
  if (!groups) return false;
  if (groups.slice(0, 7).every(group => group === 0)) return groups[7] === 0 || groups[7] === 1;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    // An IPv4 address wearing an IPv6 coat is judged as the IPv4 address.
    return isLocalIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return (groups[0] & 0xfe00) === 0xfc00;
}

/**
 * Whether a literal IP address is one the console may send a request to.
 * Names are not addresses — see `classifyHost`.
 */
export function isLocalAddress(address) {
  const bare = stripBrackets(String(address).toLowerCase());
  if (isLinkLocal(bare)) return false;
  const octets = parseIpv4(bare);
  if (octets) return isLocalIpv4(octets);
  return bare.includes(':') ? isLocalIpv6(bare) : false;
}

/**
 * Sorts a host into what can be decided from the string alone.
 *
 * - `local`  — a literal address in a local range, or a name reserved for loopback.
 * - `remote` — a literal address that is not local. Decidable now, so refused now.
 * - `name`   — anything else. A name says nothing about where it points, so the
 *              decision waits for `resolveLocalDestination` at request time.
 */
export function classifyHost(hostname) {
  const bare = stripBrackets(hostname.toLowerCase().replace(/\.$/, ''));
  if (parseIpv4(bare) || bare.includes(':')) return isLocalAddress(bare) ? 'local' : 'remote';
  if (bare === 'localhost' || bare.endsWith('.localhost')) return 'local';
  return 'name';
}

/** Hosts the operator has explicitly allowed, lowercased. Read per call so tests can set it. */
export function operatorAllowedHosts(env = process.env) {
  return String(env[ALLOW_HOSTS_ENV] ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decides whether the console may send a request to an endpoint.
 *
 * Real-AWS and instance-metadata hosts are refused first and are never
 * overridable; the local-only rule that follows is.
 *
 * @param {string} endpoint
 * @returns {{ ok: true, url: URL, hostKind: 'local' | 'name' | 'allowed' } | { ok: false, reason: string }}
 */
export function checkEndpoint(endpoint, env = process.env) {
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
  if (operatorAllowedHosts(env).includes(stripBrackets(host))) {
    return { ok: true, url, hostKind: 'allowed' };
  }
  const kind = classifyHost(host);
  if (kind === 'remote') {
    return { ok: false, reason: nonLocalRefusalMessage(host) };
  }
  return { ok: true, url, hostKind: kind };
}

/**
 * The second half of the local-only rule: a name is re-resolved and every
 * address it answers with is checked, on every request, immediately before the
 * request is forwarded. Without this, `checkEndpoint` alone would let any name
 * through, since a name says nothing about where it points.
 *
 * A narrow window remains between this check and the socket connecting, which
 * only a custom transport-level lookup can close; the proxy still uses `fetch`.
 * Re-resolving per request keeps that window to the length of one request
 * rather than the lifetime of a stored endpoint.
 *
 * @returns {Promise<{ ok: true, addresses: string[] } | { ok: false, reason: string, unreachable?: boolean }>}
 */
export async function resolveLocalDestination(url, { lookupImpl = dnsLookup, env } = {}) {
  const host = stripBrackets(url.hostname.toLowerCase().replace(/\.$/, ''));
  if (operatorAllowedHosts(env).includes(host)) return { ok: true, addresses: [] };
  if (parseIpv4(host) || host.includes(':')) {
    return isLocalAddress(host)
      ? { ok: true, addresses: [host] }
      : { ok: false, reason: nonLocalRefusalMessage(host) };
  }

  let records;
  try {
    records = await lookupImpl(host, { all: true, verbatim: true });
  } catch (error) {
    return {
      ok: false,
      reason: `Could not resolve "${host}": ${error?.code ?? error?.message ?? 'lookup failed'}.`,
      unreachable: true,
    };
  }
  const answers = (Array.isArray(records) ? records : [records]).filter(Boolean);
  if (answers.length === 0) {
    return { ok: false, reason: `"${host}" did not resolve to any address.`, unreachable: true };
  }
  for (const record of answers) {
    const address = record.address ?? record;
    if (!isLocalAddress(address)) {
      return { ok: false, reason: rebindRefusalMessage(host, address) };
    }
  }
  return { ok: true, addresses: answers.map(record => record.address ?? record) };
}
