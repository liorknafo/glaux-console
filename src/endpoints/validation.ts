import realAwsHosts from '../../shared/real-aws-hosts.json';

/**
 * The same rules the console backend enforces, applied in the form so the
 * refusal is immediate and explained rather than a failed request. The backend
 * is the enforcement point; this is the explanation point.
 *
 * One rule cannot be mirrored here: the backend re-resolves a hostname and
 * checks every address it answers with before forwarding. The browser cannot
 * resolve names, so a name is accepted by the form and decided by the backend.
 */
export const REAL_AWS_SUFFIXES: string[] = realAwsHosts.suffixes;
export const BLOCKED_HOSTS: string[] = realAwsHosts.blockedHosts;

export const REFUSAL_MESSAGE =
  'glaux-console targets local emulators only. This host belongs to real AWS, and the console ' +
  'refuses to send requests to it — full CRUD against a production account is designed out.';

export const METADATA_REFUSAL_MESSAGE =
  'This is a cloud instance-metadata address. The console backend signs and forwards whatever it ' +
  'is given, so it refuses these outright rather than becoming a way to read instance credentials.';

export function nonLocalRefusalMessage(host: string): string {
  return (
    `"${host}" is not a local address. The console backend signs and forwards whatever it is ` +
    'given, so it only sends requests to loopback and private addresses — otherwise anything ' +
    'that can reach it could use it to reach the rest of your network. An operator can set ' +
    'GLAUX_CONSOLE_ALLOW_HOSTS on the backend to target an emulator elsewhere.'
  );
}

export type EndpointCheck = { ok: true; url: string } | { ok: false; reason: string };

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

/**
 * Link-local ranges: IPv4 169.254.0.0/16 (which carries the EC2/Azure metadata
 * service) and IPv6 fe80::/10 plus the EC2 IPv6 metadata address.
 */
function isLinkLocal(host: string): boolean {
  const bare = stripBrackets(host);
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  return bare === 'fd00:ec2::254';
}

function parseIpv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.some(octet => octet > 255) ? null : octets;
}

/** Loopback, "this host", and the three RFC 1918 ranges. */
function isLocalIpv4([a, b]: number[]): boolean {
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
function parseIpv6(host: string): number[] | null {
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
function isLocalIpv6(host: string): boolean {
  const groups = parseIpv6(host);
  if (!groups) return false;
  if (groups.slice(0, 7).every(group => group === 0)) return groups[7] === 0 || groups[7] === 1;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    // An IPv4 address wearing an IPv6 coat is judged as the IPv4 address.
    return isLocalIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return (groups[0] & 0xfe00) === 0xfc00;
}

/** Whether a literal IP address is one the console may send a request to. */
export function isLocalAddress(address: string): boolean {
  const bare = stripBrackets(address.toLowerCase());
  if (isLinkLocal(bare)) return false;
  const octets = parseIpv4(bare);
  if (octets) return isLocalIpv4(octets);
  return bare.includes(':') ? isLocalIpv6(bare) : false;
}

/**
 * Sorts a host into what can be decided from the string alone — the same split
 * the backend makes.
 *
 * - `local`  — a literal address in a local range, or a name reserved for loopback.
 * - `remote` — a literal address that is not local. Decidable now, so refused now.
 * - `name`   — anything else; the backend decides it by resolving the name.
 */
export function classifyHost(hostname: string): 'local' | 'remote' | 'name' {
  const bare = stripBrackets(hostname.toLowerCase().replace(/\.$/, ''));
  if (parseIpv4(bare) || bare.includes(':')) return isLocalAddress(bare) ? 'local' : 'remote';
  if (bare === 'localhost' || bare.endsWith('.localhost')) return 'local';
  return 'name';
}

export function checkEndpointUrl(value: string): EndpointCheck {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: 'Enter an endpoint URL.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: `"${trimmed}" is not a valid URL. Include the scheme, e.g. http://localhost:4566`,
    };
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
  if (classifyHost(host) === 'remote') {
    return { ok: false, reason: nonLocalRefusalMessage(host) };
  }
  return { ok: true, url: url.origin + url.pathname.replace(/\/$/, '') };
}

/**
 * Not a refusal — a nudge for the one case the form cannot decide: a hostname,
 * which the backend will resolve and may still refuse.
 */
export function isLikelyLocal(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    if (classifyHost(host) === 'local') return true;
    return /(^|\.)(local|internal)$|^host\.docker\.internal$/i.test(stripBrackets(host));
  } catch {
    return false;
  }
}
