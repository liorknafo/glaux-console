import { describe, expect, it, vi } from 'vitest';
import { readSnapshot, startInput, waitForTerminal, type QueryRunner } from './execution';
import type { QueryExecutionSnapshot, ResultPage } from './types';

function runnerReturning(states: QueryExecutionSnapshot[]): QueryRunner & { polls: number } {
  let polls = 0;
  const runner = {
    get polls() {
      return polls;
    },
    start: vi.fn(async () => 'q-1'),
    poll: vi.fn(async () => {
      const snapshot = states[Math.min(polls, states.length - 1)];
      polls += 1;
      return snapshot;
    }),
    stop: vi.fn(async () => {}),
    results: vi.fn(async (): Promise<ResultPage> => ({ columns: [], rows: [] })),
  };
  return runner as unknown as QueryRunner & { polls: number };
}

describe('startInput', () => {
  it('sends only the context fields that are set', () => {
    expect(startInput('SELECT 1', {})).toEqual({ QueryString: 'SELECT 1' });
  });

  it('drops blank fields rather than sending empty strings', () => {
    expect(startInput('SELECT 1', { database: '  ', outputLocation: '', workGroup: ' ' })).toEqual({
      QueryString: 'SELECT 1',
    });
  });

  it('maps the context onto the model’s own members', () => {
    expect(
      startInput('SELECT 1', {
        catalog: 'awsdatacatalog',
        database: 'default',
        workGroup: 'primary',
        outputLocation: 's3://results/ ',
      }),
    ).toEqual({
      QueryString: 'SELECT 1',
      QueryExecutionContext: { Catalog: 'awsdatacatalog', Database: 'default' },
      ResultConfiguration: { OutputLocation: 's3://results/' },
      WorkGroup: 'primary',
    });
  });
});

describe('readSnapshot', () => {
  it('reads state, statistics and the Athena error', () => {
    const snapshot = readSnapshot(
      {
        QueryExecution: {
          QueryExecutionId: 'q-9',
          Query: 'SELECT 1',
          StatementType: 'DML',
          Status: {
            State: 'FAILED',
            StateChangeReason: 'boom',
            AthenaError: {
              ErrorCategory: 2,
              ErrorType: 1001,
              Retryable: false,
              ErrorMessage: 'no',
            },
          },
          Statistics: { DataScannedInBytes: 4096, EngineExecutionTimeInMillis: 120 },
          ResultConfiguration: { OutputLocation: 's3://results/q-9' },
        },
      },
      'fallback',
    );
    expect(snapshot).toMatchObject({
      id: 'q-9',
      state: 'FAILED',
      stateChangeReason: 'boom',
      athenaError: { category: 2, type: 1001, retryable: false, message: 'no' },
      statistics: { dataScannedInBytes: 4096, engineExecutionTimeInMillis: 120 },
      outputLocation: 's3://results/q-9',
    });
  });

  it('falls back to the requested id and marks an unknown state', () => {
    const snapshot = readSnapshot({ QueryExecution: { Status: { State: 'WEIRD' } } }, 'q-2');
    expect(snapshot.id).toBe('q-2');
    expect(snapshot.state).toBe('UNKNOWN');
  });

  it('reads a timestamp the wire may have delivered as epoch seconds', () => {
    const snapshot = readSnapshot(
      { QueryExecution: { Status: { State: 'SUCCEEDED', SubmissionDateTime: 1_700_000_000 } } },
      'q-3',
    );
    expect(snapshot.submittedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe('waitForTerminal', () => {
  it('polls until the query reaches a terminal state', async () => {
    const runner = runnerReturning([
      { id: 'q-1', state: 'QUEUED' },
      { id: 'q-1', state: 'RUNNING' },
      { id: 'q-1', state: 'SUCCEEDED' },
    ]);
    const seen: string[] = [];
    const final = await waitForTerminal(runner, 'q-1', {
      wait: async () => {},
      onUpdate: snapshot => seen.push(snapshot.state),
    });
    expect(final.state).toBe('SUCCEEDED');
    expect(seen).toEqual(['QUEUED', 'RUNNING', 'SUCCEEDED']);
  });

  it('returns after a single poll when the target answers terminally', async () => {
    const runner = runnerReturning([{ id: 'q-1', state: 'SUCCEEDED' }]);
    const wait = vi.fn(async () => {});
    await waitForTerminal(runner, 'q-1', { wait });
    expect(wait).not.toHaveBeenCalled();
    expect(runner.polls).toBe(1);
  });

  it('stops polling when the run is aborted, keeping the last snapshot', async () => {
    const runner = runnerReturning([{ id: 'q-1', state: 'RUNNING' }]);
    const controller = new AbortController();
    const final = await waitForTerminal(runner, 'q-1', {
      signal: controller.signal,
      wait: async () => controller.abort(),
    });
    expect(final.state).toBe('RUNNING');
    expect(runner.polls).toBe(1);
  });

  it('does not spin on a state the model does not define', async () => {
    const runner = runnerReturning([{ id: 'q-1', state: 'UNKNOWN' }]);
    const controller = new AbortController();
    let waits = 0;
    await waitForTerminal(runner, 'q-1', {
      signal: controller.signal,
      wait: async () => {
        waits += 1;
        if (waits > 2) controller.abort();
      },
    });
    // UNKNOWN is not terminal, so it keeps polling — but the abort ends it.
    expect(waits).toBe(3);
  });
});
