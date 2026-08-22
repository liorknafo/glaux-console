/**
 * Endpoint list persistence.
 *
 * v1 keeps no server-side state (see the spec's out-of-scope list), so the
 * endpoint list lives in browser storage. The default target is the origin
 * serving the console: embedded in glaux, that is the emulator itself, and the
 * console works with zero configuration.
 */

export interface EndpointConfig {
  id: string;
  name: string;
  url: string;
  region: string;
}

const STORAGE_KEY = 'glaux-console.endpoints.v1';
const ACTIVE_KEY = 'glaux-console.activeEndpoint.v1';

export function defaultEndpoint(origin: string): EndpointConfig {
  return {
    id: 'origin',
    name: 'This origin',
    url: origin.replace(/\/$/, ''),
    region: 'us-east-1',
  };
}

function readStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadEndpoints(origin: string): EndpointConfig[] {
  const fallback = [defaultEndpoint(origin)];
  const storage = readStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as EndpointConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
    return parsed.filter(entry => typeof entry?.url === 'string' && typeof entry?.id === 'string');
  } catch {
    return fallback;
  }
}

export function saveEndpoints(endpoints: EndpointConfig[]): void {
  readStorage()?.setItem(STORAGE_KEY, JSON.stringify(endpoints));
}

export function loadActiveEndpointId(): string | undefined {
  return readStorage()?.getItem(ACTIVE_KEY) ?? undefined;
}

export function saveActiveEndpointId(id: string): void {
  readStorage()?.setItem(ACTIVE_KEY, id);
}

export function newEndpointId(): string {
  return `ep-${Math.random().toString(36).slice(2, 10)}`;
}
