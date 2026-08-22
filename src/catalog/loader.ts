import type { ServiceCatalog, ServiceIndexEntry } from './types';
import rawIndex from './generated/index.json';

/**
 * Per-service catalog chunks are loaded lazily: the index (a few KiB) ships in
 * the initial bundle, each service's operations and shapes arrive as their own
 * chunk the first time that service's screen is opened.
 */
const chunks = import.meta.glob<{ default: ServiceCatalog }>([
  './generated/*.json',
  '!./generated/index.json',
  '!./generated/manifest.json',
]);

export const serviceIndex: ServiceIndexEntry[] = rawIndex as ServiceIndexEntry[];

const byId = new Map(serviceIndex.map(entry => [entry.id, entry]));

/** Index entries grouped by category, both sorted for stable navigation order. */
export function servicesByCategory(): { category: string; services: ServiceIndexEntry[] }[] {
  const groups = new Map<string, ServiceIndexEntry[]>();
  for (const service of serviceIndex) {
    const bucket = groups.get(service.category);
    if (bucket) bucket.push(service);
    else groups.set(service.category, [service]);
  }
  return [...groups.entries()]
    .map(([category, services]) => ({
      category,
      services: [...services].sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export function findService(id: string): ServiceIndexEntry | undefined {
  return byId.get(id);
}

/**
 * Match an identifier reported by a target's `/_fakecloud/health` to a catalog
 * service. Emulators disagree on names (`sfn` vs `states` vs `stepfunctions`),
 * so the catalog carries aliases and matching is case/punctuation-insensitive.
 */
const normalized = new Map<string, string>();
for (const service of serviceIndex) {
  for (const key of [service.id, service.endpointPrefix, ...service.aliases]) {
    normalized.set(normalizeServiceKey(key), service.id);
  }
}

export function normalizeServiceKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function matchReportedService(reported: string): string | undefined {
  return normalized.get(normalizeServiceKey(reported));
}

const cache = new Map<string, Promise<ServiceCatalog>>();

export function loadServiceCatalog(id: string): Promise<ServiceCatalog> {
  const cached = cache.get(id);
  if (cached) return cached;
  const chunk = chunks[`./generated/${id}.json`];
  if (!chunk) {
    return Promise.reject(new Error(`No catalog chunk generated for service "${id}"`));
  }
  const promise = chunk().then(module => module.default);
  cache.set(id, promise);
  return promise;
}
