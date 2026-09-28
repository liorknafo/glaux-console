import { callOperation } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';
import { readResultPage } from './results';
import {
  isTerminal,
  type QueryContext,
  type QueryExecutionSnapshot,
  type QueryState,
  type ResultPage,
} from './types';

/**
 * The Athena query lifecycle: start, poll to a terminal state, fetch results,
 * cancel.
 *
 * It is an interface rather than four free functions so the screen can be
 * driven by a stub in tests, and so `waitForTerminal` — the part with the
 * timing in it — can be exercised without a fake clock.
 */
export interface QueryRunner {
  start(sql: string, context: QueryContext, signal?: AbortSignal): Promise<string>;
  poll(queryExecutionId: string, signal?: AbortSignal): Promise<QueryExecutionSnapshot>;
  stop(queryExecutionId: string, signal?: AbortSignal): Promise<void>;
  results(
    queryExecutionId: string,
    token: string | undefined,
    signal?: AbortSignal,
  ): Promise<ResultPage>;
}

const QUERY_STATES: QueryState[] = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asIsoDate(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  return undefined;
}

/** `GetQueryExecution` output -> snapshot, tolerating a partial response. */
export function readSnapshot(output: unknown, fallbackId: string): QueryExecutionSnapshot {
  const execution = asRecord(asRecord(output)?.QueryExecution);
  const status = asRecord(execution?.Status);
  const error = asRecord(status?.AthenaError);
  const statistics = asRecord(execution?.Statistics);
  const rawState = asString(status?.State)?.toUpperCase();
  return {
    id: asString(execution?.QueryExecutionId) ?? fallbackId,
    state: QUERY_STATES.includes(rawState as QueryState) ? (rawState as QueryState) : 'UNKNOWN',
    stateChangeReason: asString(status?.StateChangeReason),
    athenaError: error
      ? {
          category: asNumber(error.ErrorCategory),
          type: asNumber(error.ErrorType),
          retryable: typeof error.Retryable === 'boolean' ? error.Retryable : undefined,
          message: asString(error.ErrorMessage),
        }
      : undefined,
    statistics: statistics
      ? {
          dataScannedInBytes: asNumber(statistics.DataScannedInBytes),
          engineExecutionTimeInMillis: asNumber(statistics.EngineExecutionTimeInMillis),
          totalExecutionTimeInMillis: asNumber(statistics.TotalExecutionTimeInMillis),
          queryQueueTimeInMillis: asNumber(statistics.QueryQueueTimeInMillis),
          queryPlanningTimeInMillis: asNumber(statistics.QueryPlanningTimeInMillis),
          serviceProcessingTimeInMillis: asNumber(statistics.ServiceProcessingTimeInMillis),
        }
      : undefined,
    statementType: asString(execution?.StatementType),
    query: asString(execution?.Query),
    submittedAt: asIsoDate(status?.SubmissionDateTime),
    completedAt: asIsoDate(status?.CompletionDateTime),
    outputLocation: asString(asRecord(execution?.ResultConfiguration)?.OutputLocation),
  };
}

/**
 * Build `StartQueryExecutionInput`. Empty context fields are omitted rather than
 * sent as empty strings: a target that takes its output location from the
 * workgroup should not receive `ResultConfiguration: {OutputLocation: ""}`.
 */
export function startInput(sql: string, context: QueryContext): Record<string, unknown> {
  const input: Record<string, unknown> = { QueryString: sql };
  const executionContext: Record<string, unknown> = {};
  if (context.database?.trim()) executionContext.Database = context.database.trim();
  if (context.catalog?.trim()) executionContext.Catalog = context.catalog.trim();
  if (Object.keys(executionContext).length > 0) input.QueryExecutionContext = executionContext;
  if (context.outputLocation?.trim()) {
    input.ResultConfiguration = { OutputLocation: context.outputLocation.trim() };
  }
  if (context.workGroup?.trim()) input.WorkGroup = context.workGroup.trim();
  return input;
}

export function createQueryRunner(endpoint: EndpointConfig, catalog: ServiceCatalog): QueryRunner {
  const call = (name: string, input: Record<string, unknown>, signal?: AbortSignal) => {
    const operation = catalog.operations[name];
    if (!operation) {
      return Promise.reject(new Error(`The Athena model has no ${name} operation`));
    }
    return callOperation(endpoint, catalog, operation, input, signal);
  };

  return {
    async start(sql, context, signal) {
      const result = await call('StartQueryExecution', startInput(sql, context), signal);
      const id = asString(asRecord(result.output)?.QueryExecutionId);
      if (!id) {
        throw new Error('StartQueryExecution returned no QueryExecutionId.');
      }
      return id;
    },
    async poll(queryExecutionId, signal) {
      const result = await call(
        'GetQueryExecution',
        { QueryExecutionId: queryExecutionId },
        signal,
      );
      return readSnapshot(result.output, queryExecutionId);
    },
    async stop(queryExecutionId, signal) {
      await call('StopQueryExecution', { QueryExecutionId: queryExecutionId }, signal);
    },
    async results(queryExecutionId, token, signal) {
      const input: Record<string, unknown> = { QueryExecutionId: queryExecutionId };
      if (token) input.NextToken = token;
      const result = await call('GetQueryResults', input, signal);
      return readResultPage(result.output, token === undefined);
    },
  };
}

export interface WaitOptions {
  signal?: AbortSignal;
  onUpdate?(snapshot: QueryExecutionSnapshot): void;
  /** Injected in tests; production uses the backoff below. */
  wait?(millis: number): Promise<void>;
}

const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

function sleep(millis: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, millis));
}

/**
 * Poll until the query reaches a terminal state.
 *
 * The delay backs off from 250 ms to 2 s: a local emulator usually finishes on
 * the first poll, and a long query should not spend the whole run hammering the
 * target. An aborted wait resolves with the last snapshot rather than throwing,
 * so cancelling leaves the screen showing where the query got to.
 */
export async function waitForTerminal(
  runner: QueryRunner,
  queryExecutionId: string,
  options: WaitOptions = {},
): Promise<QueryExecutionSnapshot> {
  const { signal, onUpdate, wait = sleep } = options;
  let delay = FIRST_DELAY_MS;
  let snapshot = await runner.poll(queryExecutionId, signal);
  onUpdate?.(snapshot);

  while (!isTerminal(snapshot.state) && !signal?.aborted) {
    await wait(delay);
    if (signal?.aborted) break;
    delay = Math.min(delay * 2, MAX_DELAY_MS);
    snapshot = await runner.poll(queryExecutionId, signal);
    onUpdate?.(snapshot);
  }
  return snapshot;
}
