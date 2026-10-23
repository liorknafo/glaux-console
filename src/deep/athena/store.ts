import type { QueryContext, QueryState } from './types';

/**
 * Query history, saved queries, and the editor's execution context.
 *
 * All three live in browser storage, keyed by endpoint URL, for the reason the
 * endpoint list does: v1 keeps no server-side state. Keeping history local also
 * means it survives targets that do not implement `ListQueryExecutions` or the
 * named-query APIs — glaux v0.1 documents neither — and it records what *this*
 * console ran, including the queries that failed before the target ever gave
 * them an execution id.
 */

export interface HistoryEntry {
  id: string;
  queryExecutionId?: string;
  sql: string;
  state: QueryState;
  ranAt: string;
  database?: string;
  catalog?: string;
  dataScannedInBytes?: number;
  engineExecutionTimeInMillis?: number;
  /** The failure message, when the run failed. */
  failure?: string;
  unsupportedConstruct?: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  sql: string;
  savedAt: string;
}

const HISTORY_KEY = 'glaux-console.athena.history.v1';
const SAVED_KEY = 'glaux-console.athena.savedQueries.v1';
const CONTEXT_KEY = 'glaux-console.athena.context.v1';

export const HISTORY_LIMIT = 50;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readMap(key: string): Record<string, unknown> {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `setItem` throws on quota and on storage policies, not only on access. */
function writeMap(key: string, value: Record<string, unknown>): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is unavailable; the in-memory state still works for this session.
  }
}

function readList<T>(key: string, endpointKey: string, isValid: (entry: unknown) => boolean): T[] {
  const entries = readMap(key)[endpointKey];
  return Array.isArray(entries) ? (entries.filter(isValid) as T[]) : [];
}

function writeList<T>(key: string, endpointKey: string, entries: T[]): void {
  writeMap(key, { ...readMap(key), [endpointKey]: entries });
}

function isHistoryEntry(entry: unknown): boolean {
  const record = entry as Partial<HistoryEntry> | null;
  return typeof record?.id === 'string' && typeof record?.sql === 'string';
}

function isSavedQuery(entry: unknown): boolean {
  const record = entry as Partial<SavedQuery> | null;
  return (
    typeof record?.id === 'string' &&
    typeof record?.name === 'string' &&
    typeof record?.sql === 'string'
  );
}

export function loadHistory(endpointKey: string): HistoryEntry[] {
  return readList<HistoryEntry>(HISTORY_KEY, endpointKey, isHistoryEntry);
}

/** Newest first, capped — the console keeps a working set, not an audit log. */
export function appendHistory(endpointKey: string, entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...loadHistory(endpointKey).filter(item => item.id !== entry.id)].slice(
    0,
    HISTORY_LIMIT,
  );
  writeList(HISTORY_KEY, endpointKey, next);
  return next;
}

export function clearHistory(endpointKey: string): HistoryEntry[] {
  writeList<HistoryEntry>(HISTORY_KEY, endpointKey, []);
  return [];
}

export function loadSavedQueries(endpointKey: string): SavedQuery[] {
  return readList<SavedQuery>(SAVED_KEY, endpointKey, isSavedQuery);
}

/** Saving under a name that already exists replaces it, as the console does. */
export function saveQuery(endpointKey: string, query: SavedQuery): SavedQuery[] {
  const rest = loadSavedQueries(endpointKey).filter(
    item => item.id !== query.id && item.name !== query.name,
  );
  const next = [query, ...rest].sort((a, b) => a.name.localeCompare(b.name));
  writeList(SAVED_KEY, endpointKey, next);
  return next;
}

export function deleteSavedQuery(endpointKey: string, id: string): SavedQuery[] {
  const next = loadSavedQueries(endpointKey).filter(item => item.id !== id);
  writeList(SAVED_KEY, endpointKey, next);
  return next;
}

export function loadQueryContext(endpointKey: string): QueryContext {
  const stored = readMap(CONTEXT_KEY)[endpointKey];
  if (typeof stored !== 'object' || stored === null) return {};
  const record = stored as Record<string, unknown>;
  const pick = (field: string) =>
    typeof record[field] === 'string' ? (record[field] as string) : undefined;
  return {
    catalog: pick('catalog'),
    database: pick('database'),
    workGroup: pick('workGroup'),
    outputLocation: pick('outputLocation'),
  };
}

export function saveQueryContext(endpointKey: string, context: QueryContext): void {
  writeMap(CONTEXT_KEY, { ...readMap(CONTEXT_KEY), [endpointKey]: context });
}

let counter = 0;

/** Ids only need to be unique within a session's storage, not unguessable. */
export function newLocalId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
