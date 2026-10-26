import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  clearHistory,
  deleteSavedQuery,
  HISTORY_LIMIT,
  loadHistory,
  loadQueryContext,
  loadSavedQueries,
  newLocalId,
  saveQuery,
  saveQueryContext,
  type HistoryEntry,
} from './store';

const A = 'http://localhost:4566';
const B = 'http://localhost:9000';

function entry(id: string, sql = 'SELECT 1'): HistoryEntry {
  return { id, sql, state: 'SUCCEEDED', ranAt: '2026-08-23T00:00:00.000Z' };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('query history', () => {
  it('keeps newest first and is scoped to the endpoint', () => {
    appendHistory(A, entry('1', 'SELECT 1'));
    appendHistory(A, entry('2', 'SELECT 2'));
    appendHistory(B, entry('3', 'SELECT 3'));

    expect(loadHistory(A).map(item => item.sql)).toEqual(['SELECT 2', 'SELECT 1']);
    expect(loadHistory(B).map(item => item.sql)).toEqual(['SELECT 3']);
  });

  it('caps the list rather than growing without bound', () => {
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      appendHistory(A, entry(`e-${index}`));
    }
    expect(loadHistory(A)).toHaveLength(HISTORY_LIMIT);
    expect(loadHistory(A)[0].id).toBe(`e-${HISTORY_LIMIT + 9}`);
  });

  it('replaces an entry re-recorded under the same id', () => {
    appendHistory(A, entry('1', 'SELECT 1'));
    appendHistory(A, { ...entry('1', 'SELECT 1'), state: 'FAILED' });
    expect(loadHistory(A)).toHaveLength(1);
    expect(loadHistory(A)[0].state).toBe('FAILED');
  });

  it('clears one endpoint without touching another', () => {
    appendHistory(A, entry('1'));
    appendHistory(B, entry('2'));
    expect(clearHistory(A)).toEqual([]);
    expect(loadHistory(B)).toHaveLength(1);
  });

  it('ignores a corrupted record instead of throwing', () => {
    window.localStorage.setItem('glaux-console.athena.history.v1', 'not json');
    expect(loadHistory(A)).toEqual([]);
    window.localStorage.setItem(
      'glaux-console.athena.history.v1',
      JSON.stringify({ [A]: [{ nope: true }, entry('good')] }),
    );
    expect(loadHistory(A).map(item => item.id)).toEqual(['good']);
  });
});

describe('saved queries', () => {
  const saved = (name: string, sql: string) => ({
    id: newLocalId('saved'),
    name,
    sql,
    savedAt: '2026-08-23T00:00:00.000Z',
  });

  it('sorts by name and replaces a query saved under an existing name', () => {
    saveQuery(A, saved('zeta', 'SELECT 3'));
    saveQuery(A, saved('alpha', 'SELECT 1'));
    expect(loadSavedQueries(A).map(item => item.name)).toEqual(['alpha', 'zeta']);

    saveQuery(A, saved('alpha', 'SELECT 2'));
    const queries = loadSavedQueries(A);
    expect(queries).toHaveLength(2);
    expect(queries.find(item => item.name === 'alpha')?.sql).toBe('SELECT 2');
  });

  it('deletes by id, per endpoint', () => {
    const first = saved('one', 'SELECT 1');
    saveQuery(A, first);
    saveQuery(B, saved('one', 'SELECT 9'));
    expect(deleteSavedQuery(A, first.id)).toEqual([]);
    expect(loadSavedQueries(B)).toHaveLength(1);
  });
});

describe('execution context', () => {
  it('round-trips per endpoint and ignores unknown fields', () => {
    saveQueryContext(A, { database: 'default', outputLocation: 's3://results/' });
    expect(loadQueryContext(A)).toEqual({
      catalog: undefined,
      database: 'default',
      workGroup: undefined,
      outputLocation: 's3://results/',
    });
    expect(loadQueryContext(B)).toEqual({});
  });
});

describe('newLocalId', () => {
  it('does not repeat within a session', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newLocalId('run')));
    expect(ids.size).toBe(50);
  });
});
