import { matchReportedService } from '../catalog/loader';
import type { EndpointConfig } from '../endpoints/store';
import { sendWireRequest } from './client';

/**
 * Capability discovery.
 *
 * `GET /_fakecloud/health` tells the console which services the target
 * actually runs, so unimplemented services render greyed out instead of
 * failing mysteriously. Targets that do not serve it are not an error — the
 * console falls back to "capabilities unknown" and leaves everything enabled.
 */

export interface HealthReport {
  /** Raw identifiers the target reported. */
  reported: string[];
  /** Catalog service ids the reported identifiers resolved to. */
  supported: Set<string>;
  /** Reported identifiers with no catalog entry — surfaced, not swallowed. */
  unmatched: string[];
  version?: string;
  status?: string;
}

export type Capabilities =
  { state: 'unknown'; reason: string } | { state: 'known'; report: HealthReport };

const HEALTH_PATH = '/_fakecloud/health';

export async function discoverCapabilities(
  endpoint: EndpointConfig,
  signal?: AbortSignal,
): Promise<Capabilities> {
  let response;
  try {
    response = await sendWireRequest(
      endpoint,
      { method: 'GET', path: HEALTH_PATH, query: {}, headers: { accept: 'application/json' } },
      'glaux-console',
      signal,
    );
  } catch (error) {
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }

  if (response.status >= 400) {
    return {
      state: 'unknown',
      reason: `${HEALTH_PATH} returned HTTP ${response.status}. The target may not implement capability discovery.`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return { state: 'unknown', reason: `${HEALTH_PATH} did not return JSON.` };
  }

  return { state: 'known', report: toReport(body) };
}

export function toReport(body: unknown): HealthReport {
  const record = (body ?? {}) as Record<string, unknown>;
  const reported = normalizeServiceList(record.services);
  const supported = new Set<string>();
  const unmatched: string[] = [];

  for (const name of reported) {
    const id = matchReportedService(name);
    if (id) supported.add(id);
    else unmatched.push(name);
  }

  return {
    reported,
    supported,
    unmatched,
    version: typeof record.version === 'string' ? record.version : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
  };
}

/**
 * Emulators report the service list in more than one shape. We have verified
 * fakecloud documents `{"status","version","services":[...]}`; the object and
 * object-of-booleans forms are accepted defensively rather than assumed.
 */
function normalizeServiceList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(entry =>
        typeof entry === 'string'
          ? entry
          : typeof entry === 'object' && entry !== null
            ? String(
                (entry as Record<string, unknown>).name ??
                  (entry as Record<string, unknown>).service ??
                  '',
              )
            : '',
      )
      .filter(Boolean);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => enabled !== false && enabled !== 'disabled')
      .map(([name]) => name);
  }
  return [];
}
