import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Single source of truth, shared with the browser-side endpoint form. */
export const REAL_AWS_SUFFIXES = JSON.parse(
  readFileSync(join(HERE, '..', 'shared', 'real-aws-hosts.json'), 'utf8'),
).suffixes;

export const REFUSAL_MESSAGE =
  'glaux-console targets local emulators only. This host belongs to real AWS, and the console ' +
  'refuses to send requests to it — full CRUD against a production account is designed out.';

/**
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
  return { ok: true, url };
}
