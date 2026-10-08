import { callOperation } from '../../api/client';
import type { Operation, ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';

/**
 * The EventBridge data layer: buses, the rules on a bus, and the targets a rule
 * fans out to, plus enabling/disabling a rule and putting a test event.
 *
 * Pattern evaluation is deliberately not here — see `pattern.ts`, which answers
 * in the browser so the tester works whatever the target implements.
 */

export interface EventBus {
  name: string;
  arn?: string;
  description?: string;
  policy?: string;
  creationTime?: unknown;
  lastModifiedTime?: unknown;
}

export interface EventRule {
  name: string;
  arn?: string;
  eventPattern?: string;
  scheduleExpression?: string;
  state?: string;
  description?: string;
  roleArn?: string;
  managedBy?: string;
  eventBusName?: string;
}

export interface RuleTarget {
  id: string;
  arn?: string;
  roleArn?: string;
  /** Constant JSON passed to the target instead of the event. */
  input?: string;
  inputPath?: string;
  /** True when the target uses an input transformer rather than a raw event. */
  transformed: boolean;
  deadLetterArn?: string;
  retryAttempts?: number;
  maximumEventAgeInSeconds?: number;
}

export interface PutEventOutcome {
  eventId?: string;
  errorCode?: string;
  errorMessage?: string;
  failedEntryCount: number;
}

/** The bus every account has, and the one an emulator is most likely to serve. */
export const DEFAULT_BUS = 'default';

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

export function readBuses(output: unknown): EventBus[] {
  return asArray(asRecord(output)?.EventBuses).flatMap<EventBus>(entry => {
    const bus = asRecord(entry);
    const name = asString(bus?.Name);
    if (!name) return [];
    return [
      {
        name,
        arn: asString(bus?.Arn),
        description: asString(bus?.Description),
        policy: asString(bus?.Policy),
        creationTime: bus?.CreationTime,
        lastModifiedTime: bus?.LastModifiedTime,
      },
    ];
  });
}

export function readRules(output: unknown): EventRule[] {
  return asArray(asRecord(output)?.Rules).flatMap<EventRule>(entry => {
    const rule = asRecord(entry);
    const name = asString(rule?.Name);
    if (!name) return [];
    return [
      {
        name,
        arn: asString(rule?.Arn),
        eventPattern: asString(rule?.EventPattern),
        scheduleExpression: asString(rule?.ScheduleExpression),
        state: asString(rule?.State),
        description: asString(rule?.Description),
        roleArn: asString(rule?.RoleArn),
        managedBy: asString(rule?.ManagedBy),
        eventBusName: asString(rule?.EventBusName),
      },
    ];
  });
}

export function readTargets(output: unknown): RuleTarget[] {
  return asArray(asRecord(output)?.Targets).flatMap<RuleTarget>(entry => {
    const target = asRecord(entry);
    const id = asString(target?.Id);
    if (!id) return [];
    const retry = asRecord(target?.RetryPolicy);
    return [
      {
        id,
        arn: asString(target?.Arn),
        roleArn: asString(target?.RoleArn),
        input: asString(target?.Input),
        inputPath: asString(target?.InputPath),
        transformed: asRecord(target?.InputTransformer) !== undefined,
        deadLetterArn: asString(asRecord(target?.DeadLetterConfig)?.Arn),
        retryAttempts: asNumber(retry?.MaximumRetryAttempts),
        maximumEventAgeInSeconds: asNumber(retry?.MaximumEventAgeInSeconds),
      },
    ];
  });
}

function operation(catalog: ServiceCatalog, name: string): Operation {
  const found = catalog.operations[name];
  if (!found) throw new Error(`The EventBridge model has no ${name} operation`);
  return found;
}

/** Follow a listing's own `NextToken` to the end. */
async function collect<T>(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  operationName: string,
  input: Record<string, unknown>,
  read: (output: unknown) => T[],
  signal?: AbortSignal,
): Promise<T[]> {
  const op = operation(catalog, operationName);
  const collected: T[] = [];
  let token: string | undefined;
  // A target that echoes the same token forever would otherwise spin here.
  for (let page = 0; page < 20; page += 1) {
    const request = token ? { ...input, NextToken: token } : input;
    const result = await callOperation(endpoint, catalog, op, request, signal);
    collected.push(...read(result.output));
    const next = asString(asRecord(result.output)?.NextToken);
    if (!next || next === token) break;
    token = next;
  }
  return collected;
}

export async function fetchBuses(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  signal?: AbortSignal,
): Promise<EventBus[]> {
  return collect(endpoint, catalog, 'ListEventBuses', {}, readBuses, signal);
}

export async function fetchRules(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  busName: string,
  signal?: AbortSignal,
): Promise<EventRule[]> {
  return collect(endpoint, catalog, 'ListRules', { EventBusName: busName }, readRules, signal);
}

export async function fetchTargets(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  busName: string,
  ruleName: string,
  signal?: AbortSignal,
): Promise<RuleTarget[]> {
  return collect(
    endpoint,
    catalog,
    'ListTargetsByRule',
    { Rule: ruleName, EventBusName: busName },
    readTargets,
    signal,
  );
}

export async function setRuleState(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  busName: string,
  ruleName: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await callOperation(
    endpoint,
    catalog,
    operation(catalog, enabled ? 'EnableRule' : 'DisableRule'),
    { Name: ruleName, EventBusName: busName },
    signal,
  );
}

export interface PutEventRequest {
  busName: string;
  source: string;
  detailType: string;
  /** The event's `detail`, as the JSON text the user typed. */
  detail: string;
  resources?: string[];
}

/**
 * Put one event on the bus.
 *
 * `PutEvents` reports a per-entry failure inside a 200 response rather than as
 * an error, so a failed entry is read off the result and surfaced instead of
 * being reported as a success.
 */
export async function putEvent(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  request: PutEventRequest,
  signal?: AbortSignal,
): Promise<PutEventOutcome> {
  const entry: Record<string, unknown> = {
    EventBusName: request.busName,
    Source: request.source,
    DetailType: request.detailType,
    Detail: request.detail,
  };
  if (request.resources && request.resources.length > 0) entry.Resources = request.resources;

  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'PutEvents'),
    { Entries: [entry] },
    signal,
  );
  const record = asRecord(result.output);
  const first = asRecord(asArray(record?.Entries)[0]);
  return {
    eventId: asString(first?.EventId),
    errorCode: asString(first?.ErrorCode),
    errorMessage: asString(first?.ErrorMessage),
    failedEntryCount: asNumber(record?.FailedEntryCount) ?? 0,
  };
}

/**
 * The envelope EventBridge itself puts around every event. A pattern may match
 * on any of it, so the tester starts from a complete one rather than from a
 * bare `detail`.
 */
export function envelopeEvent(region: string): Record<string, unknown> {
  return {
    version: '0',
    id: '00000000-0000-0000-0000-000000000000',
    'detail-type': 'Example detail type',
    source: 'example.source',
    account: '000000000000',
    time: '2026-01-01T00:00:00Z',
    region,
    resources: [],
    detail: { example: true },
  };
}

/**
 * A sample event seeded from a rule's own pattern.
 *
 * Starting the tester from an event that the rule already matches makes the
 * screen useful straight away: the interesting edit is then "what would stop
 * this matching", not "what would ever match". The seed is a convenience, not
 * an assertion — the tester re-evaluates it immediately, so a member this
 * cannot derive shows up as a mismatch rather than as a wrong claim.
 */
export function seedEventFromPattern(
  patternText: string | undefined,
  region: string,
): Record<string, unknown> {
  const event = envelopeEvent(region);
  if (!patternText) return event;
  let pattern: unknown;
  try {
    pattern = JSON.parse(patternText);
  } catch {
    return event;
  }
  if (!asRecord(pattern)) return event;
  seedInto(event, asRecord(pattern) as Record<string, unknown>);
  return event;
}

function seedInto(event: Record<string, unknown>, pattern: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(pattern)) {
    if (key === '$or') {
      // Seed from the first branch; any branch matching makes the whole $or
      // match, and the tester shows which.
      const first = asRecord(asArray(value)[0]);
      if (first) seedInto(event, first);
      continue;
    }
    if (Array.isArray(value)) {
      const literal = literalFor(value);
      if (literal.kind === 'value') event[key] = literal.value;
      else if (literal.kind === 'absent') delete event[key];
      continue;
    }
    const nested = asRecord(value);
    if (!nested) continue;
    const existing = asRecord(event[key]);
    const child: Record<string, unknown> = existing ? { ...existing } : {};
    seedInto(child, nested);
    event[key] = child;
  }
}

type Seeded =
  | { kind: 'value'; value: unknown }
  /** `{"exists": false}` — the member has to be missing for the rule to match. */
  | { kind: 'absent' }
  /** Nothing can be derived; whatever the envelope already has is kept. */
  | { kind: 'unknown' };

function literalFor(matchers: unknown[]): Seeded {
  for (const matcher of matchers) {
    const seeded = seedFromMatcher(matcher);
    if (seeded.kind !== 'unknown') return seeded;
  }
  return { kind: 'unknown' };
}

function seedFromMatcher(matcher: unknown): Seeded {
  if (matcher === null || typeof matcher !== 'object') return { kind: 'value', value: matcher };
  const record = asRecord(matcher);
  if (!record) return { kind: 'unknown' };
  const keys = Object.keys(record);
  if (keys.length !== 1) return { kind: 'unknown' };
  const [operator] = keys;
  const argument = record[operator];
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : asString(asRecord(value)?.['equals-ignore-case']);

  switch (operator) {
    case 'prefix': {
      const prefix = text(argument);
      return prefix === undefined
        ? { kind: 'unknown' }
        : { kind: 'value', value: `${prefix}example` };
    }
    case 'suffix': {
      const suffix = text(argument);
      return suffix === undefined
        ? { kind: 'unknown' }
        : { kind: 'value', value: `example${suffix}` };
    }
    case 'equals-ignore-case':
      return typeof argument === 'string'
        ? { kind: 'value', value: argument }
        : { kind: 'unknown' };
    case 'wildcard': {
      if (typeof argument !== 'string') return { kind: 'unknown' };
      // An escaped asterisk stands for a literal one, so it is parked on a
      // character an event pattern cannot contain while the real wildcards
      // are filled in, then restored.
      const parked = '\u0000';
      const value = argument
        .replaceAll('\\*', parked)
        .replaceAll('*', 'example')
        .replaceAll(parked, '*');
      return { kind: 'value', value };
    }
    case 'numeric': {
      const number = numberSatisfying(argument);
      return number === undefined ? { kind: 'unknown' } : { kind: 'value', value: number };
    }
    case 'cidr': {
      const address = typeof argument === 'string' ? argument.split('/')[0] : undefined;
      return address ? { kind: 'value', value: address } : { kind: 'unknown' };
    }
    case 'exists':
      return argument === false ? { kind: 'absent' } : { kind: 'value', value: 'example' };
    default:
      // `anything-but` and anything unrecognised: the envelope's own value
      // stands, and the tester says whether it matches.
      return { kind: 'unknown' };
  }
}

/** Some number that satisfies every comparison in a `numeric` matcher. */
export function numberSatisfying(argument: unknown): number | undefined {
  if (!Array.isArray(argument) || argument.length === 0 || argument.length % 2 !== 0) {
    return undefined;
  }
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  let lowerExclusive = false;
  let upperExclusive = false;
  for (let index = 0; index < argument.length; index += 2) {
    const operator = argument[index];
    const value = argument[index + 1];
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (operator === '=') return value;
    if (operator === '>' || operator === '>=') {
      if (value >= lower) {
        lower = value;
        lowerExclusive = operator === '>';
      }
    } else if (operator === '<' || operator === '<=') {
      if (value <= upper) {
        upper = value;
        upperExclusive = operator === '<';
      }
    }
  }
  if (Number.isFinite(lower) && Number.isFinite(upper)) return (lower + upper) / 2;
  if (Number.isFinite(lower)) return lowerExclusive ? lower + 1 : lower;
  if (Number.isFinite(upper)) return upperExclusive ? upper - 1 : upper;
  return 0;
}
