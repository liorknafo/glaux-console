import realAwsHosts from '../../shared/real-aws-hosts.json';

/**
 * The same rules the console backend enforces, applied in the form so the
 * refusal is immediate and explained rather than a failed request. The backend
 * is the enforcement point; this is the explanation point.
 */
export const REAL_AWS_SUFFIXES: string[] = realAwsHosts.suffixes;
export const BLOCKED_HOSTS: string[] = realAwsHosts.blockedHosts;

export const REFUSAL_MESSAGE =
  'glaux-console targets local emulators only. This host belongs to real AWS, and the console ' +
  'refuses to send requests to it — full CRUD against a production account is designed out.';

export const METADATA_REFUSAL_MESSAGE =
  'This is a cloud instance-metadata address. The console backend signs and forwards whatever it ' +
  'is given, so it refuses these outright rather than becoming a way to read instance credentials.';

export type EndpointCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Link-local ranges: IPv4 169.254.0.0/16 (which carries the EC2/Azure metadata
 * service) and IPv6 fe80::/10 plus the EC2 IPv6 metadata address.
 */
function isLinkLocal(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  return bare === 'fd00:ec2::254';
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
  return { ok: true, url: url.origin + url.pathname.replace(/\/$/, '') };
}

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.*\.local|.*\.internal|host\.docker\.internal)$/i;

/** Not a refusal — a nudge, since a non-private host is unusual for an emulator. */
export function isLikelyLocal(value: string): boolean {
  try {
    return PRIVATE_HOST.test(new URL(value).hostname);
  } catch {
    return false;
  }
}
