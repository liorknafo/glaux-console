import { callOperation } from '../../api/client';
import type { Operation, ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';

/**
 * The CloudWatch Logs data layer: log groups, their streams, and the tail.
 *
 * **How the tail works, and what it is not.** CloudWatch models a real live
 * tail as `StartLiveTail`, an HTTP/2 event stream. The console's request path is
 * browser → console backend → target, one request and one response; it does not
 * carry an event stream, and no local emulator this run could check implements
 * that operation anyway. So the tail here is what `aws logs tail --follow` does:
 * repeated `FilterLogEvents` calls over a moving window, across every stream in
 * the group at once. That is an honest polled tail, and the screen says so —
 * it is not presented as a live subscription.
 *
 * **Why the window overlaps.** Each poll asks for events from the newest
 * timestamp already seen, *inclusive*. `startTime` is inclusive, so the last
 * event comes back every time; asking for `+1 ms` instead would silently drop
 * any sibling event written in that same millisecond, which is a routine thing
 * for a batch of log events. The overlap is removed by `mergeTail` deduplicating
 * on `eventId` rather than by narrowing the window.
 */

export interface LogGroupSummary {
  name: string;
  arn?: string;
  creationTime?: number;
  retentionInDays?: number;
  storedBytes?: number;
  logGroupClass?: string;
  metricFilterCount?: number;
}

export interface LogStreamSummary {
  name: string;
  creationTime?: number;
  firstEventTimestamp?: number;
  lastEventTimestamp?: number;
  lastIngestionTime?: number;
}

export interface LogEvent {
  /** FilterLogEvents assigns one; GetLogEvents does not, so it may be absent. */
  eventId?: string;
  logStreamName?: string;
  timestamp?: number;
  ingestionTime?: number;
  message: string;
}

/** How far back the first poll looks when a tail starts. */
export const TAIL_LOOKBACK_MS = 5 * 60_000;

/** How often a running tail polls. */
export const TAIL_INTERVAL_MS = 2_000;

/** Events kept in the panel; older ones are dropped as newer arrive. */
export const MAX_TAIL_EVENTS = 1_000;

/** Events asked for per `FilterLogEvents` call. */
const PAGE_LIMIT = 500;

/** Pages followed within a single poll, so one busy window cannot spin. */
const MAX_PAGES_PER_POLL = 5;

/** Streams listed for a group. */
const MAX_STREAMS = 200;

/* ------------------------------------------------------------------ reading */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function readLogGroups(output: unknown): LogGroupSummary[] {
  return asArray(asRecord(output)?.logGroups).flatMap<LogGroupSummary>(entry => {
    const group = asRecord(entry);
    const name = asString(group?.logGroupName);
    if (!group || !name) return [];
    return [
      {
        name,
        arn: asString(group.arn) ?? asString(group.logGroupArn),
        creationTime: asNumber(group.creationTime),
        retentionInDays: asNumber(group.retentionInDays),
        storedBytes: asNumber(group.storedBytes),
        logGroupClass: asString(group.logGroupClass),
        metricFilterCount: asNumber(group.metricFilterCount),
      },
    ];
  });
}

export function readLogStreams(output: unknown): LogStreamSummary[] {
  return asArray(asRecord(output)?.logStreams).flatMap<LogStreamSummary>(entry => {
    const stream = asRecord(entry);
    const name = asString(stream?.logStreamName);
    if (!stream || !name) return [];
    return [
      {
        name,
        creationTime: asNumber(stream.creationTime),
        firstEventTimestamp: asNumber(stream.firstEventTimestamp),
        lastEventTimestamp: asNumber(stream.lastEventTimestamp),
        lastIngestionTime: asNumber(stream.lastIngestionTime),
      },
    ];
  });
}

export function readEvents(output: unknown): LogEvent[] {
  return asArray(asRecord(output)?.events).flatMap<LogEvent>(entry => {
    const event = asRecord(entry);
    if (!event) return [];
    return [
      {
        eventId: asString(event.eventId),
        logStreamName: asString(event.logStreamName),
        timestamp: asNumber(event.timestamp),
        ingestionTime: asNumber(event.ingestionTime),
        message: typeof event.message === 'string' ? event.message : '',
      },
    ];
  });
}

/* --------------------------------------------------------------- tail state */

export interface TailState {
  /** Oldest first, which is the order a log reads in. */
  events: LogEvent[];
  /** Identities already shown, so an overlapping window adds nothing twice. */
  seen: string[];
  /**
   * `startTime` for the next poll — inclusive, see the module comment. Absent
   * until an event has been seen, because where a tail starts depends on when
   * it is started, which is not something the component knows while rendering.
   */
  nextStartTime?: number;
  /** Events dropped from the top because the panel is full. */
  dropped: number;
}

export function emptyTail(): TailState {
  return { events: [], seen: [], dropped: 0 };
}

/**
 * Where the next poll starts: after the newest event already shown, or a fixed
 * look-back for a tail that has not seen one yet.
 */
export function tailStartTime(state: TailState, now: number): number {
  return state.nextStartTime ?? now - TAIL_LOOKBACK_MS;
}

/**
 * An event's identity.
 *
 * `FilterLogEvents` returns an `eventId`, which is the right key. A target that
 * omits it is not an error — the stream, timestamp and message together
 * identify an event well enough to stop the overlap from duplicating it, and
 * two genuinely identical log lines written in the same millisecond in the same
 * stream are indistinguishable on the wire anyway.
 */
export function eventKey(event: LogEvent): string {
  return event.eventId ?? `${event.logStreamName ?? ''}|${event.timestamp ?? ''}|${event.message}`;
}

/**
 * Folds a poll's events into the tail: drops what has been shown already, keeps
 * the result in timestamp order, caps the panel, and advances the window.
 */
export function mergeTail(state: TailState, incoming: LogEvent[]): TailState {
  const seen = new Set(state.seen);
  const fresh = incoming.filter(event => !seen.has(eventKey(event)));
  if (fresh.length === 0) return state;

  for (const event of fresh) seen.add(eventKey(event));

  // Sort is stable in every engine this runs on, so events sharing a timestamp
  // stay in the order the service returned them.
  const combined = [...state.events, ...fresh].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  );
  const overflow = Math.max(0, combined.length - MAX_TAIL_EVENTS);
  const kept = overflow > 0 ? combined.slice(overflow) : combined;
  // Forgetting a trimmed event's key cannot resurrect it: the window has
  // already moved past its timestamp.
  if (overflow > 0) {
    for (const event of combined.slice(0, overflow)) seen.delete(eventKey(event));
  }

  const newest = fresh.reduce(
    (latest, event) => Math.max(latest, event.timestamp ?? 0),
    state.nextStartTime ?? 0,
  );

  return {
    events: kept,
    seen: [...seen],
    nextStartTime: newest,
    dropped: state.dropped + overflow,
  };
}

/* ------------------------------------------------------------------ calling */

function operation(catalog: ServiceCatalog, name: string): Operation {
  const found = catalog.operations[name];
  if (!found) throw new Error(`The CloudWatch Logs model has no ${name} operation`);
  return found;
}

export async function fetchLogGroups(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  signal?: AbortSignal,
): Promise<LogGroupSummary[]> {
  const op = operation(catalog, 'DescribeLogGroups');
  const groups: LogGroupSummary[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
    const input: Record<string, unknown> = { limit: 50 };
    if (token) input.nextToken = token;
    const result = await callOperation(endpoint, catalog, op, input, signal);
    groups.push(...readLogGroups(result.output));
    const next = asString(asRecord(result.output)?.nextToken);
    // A target that echoes its own token would otherwise page forever.
    if (!next || next === token) break;
    token = next;
  }
  return groups;
}

export async function fetchLogStreams(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  logGroupName: string,
  signal?: AbortSignal,
): Promise<LogStreamSummary[]> {
  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'DescribeLogStreams'),
    {
      logGroupName,
      // Newest activity first: the stream someone wants to read is almost
      // always the one still being written to.
      orderBy: 'LastEventTime',
      descending: true,
      limit: MAX_STREAMS,
    },
    signal,
  );
  return readLogStreams(result.output);
}

export interface TailRequest {
  logGroupName: string;
  startTime: number;
  /** CloudWatch filter-pattern syntax, passed through untouched. */
  filterPattern?: string;
  /** Restrict the tail to these streams. Empty means the whole group. */
  logStreamNames?: string[];
}

export interface TailPage {
  events: LogEvent[];
  /** True when the poll stopped at its page budget with more still to read. */
  truncated: boolean;
}

/**
 * One poll: `FilterLogEvents` from `startTime`, following the service's own
 * `nextToken` up to a bounded number of pages.
 */
export async function fetchTailPage(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  request: TailRequest,
  signal?: AbortSignal,
): Promise<TailPage> {
  const op = operation(catalog, 'FilterLogEvents');
  const events: LogEvent[] = [];
  let token: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
    const input: Record<string, unknown> = {
      logGroupName: request.logGroupName,
      startTime: request.startTime,
      limit: PAGE_LIMIT,
    };
    if (request.filterPattern) input.filterPattern = request.filterPattern;
    if (request.logStreamNames?.length) input.logStreamNames = request.logStreamNames;
    if (token) input.nextToken = token;

    const result = await callOperation(endpoint, catalog, op, input, signal);
    events.push(...readEvents(result.output));
    const next = asString(asRecord(result.output)?.nextToken);
    if (!next || next === token) return { events, truncated };
    token = next;
    truncated = page === MAX_PAGES_PER_POLL - 1;
  }

  return { events, truncated };
}
