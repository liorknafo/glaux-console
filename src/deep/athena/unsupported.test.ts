import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  classifyMessage,
  errorCategoryLabel,
  looksUnsupported,
  namedConstruct,
} from './unsupported';
import type { QueryExecutionSnapshot } from './types';

describe('recognising an unsupported construct', () => {
  it.each([
    'Unsupported SQL construct: GROUPING SETS',
    'Unsupported construct - LATERAL VIEW',
    'GROUPING SETS is not supported',
    'This engine does not support window functions',
    'NOT_SUPPORTED: correlated subquery',
    'Feature is not yet supported',
  ])('recognises %j', message => {
    expect(looksUnsupported(message)).toBe(true);
    expect(classifyMessage(message).kind).toBe('unsupported-construct');
  });

  it.each([
    'SYNTAX_ERROR: line 1:8: Column x cannot be resolved',
    'Table awsdatacatalog.default.orders does not exist',
    'Query timed out',
  ])('leaves %j as an ordinary error', message => {
    expect(looksUnsupported(message)).toBe(false);
    expect(classifyMessage(message).kind).toBe('error');
  });

  it('names the construct when the message names one', () => {
    expect(namedConstruct('Unsupported SQL construct: GROUPING SETS')).toBe('GROUPING SETS');
    expect(namedConstruct('Unsupported construct - LATERAL VIEW.')).toBe('LATERAL VIEW');
    expect(namedConstruct('`ROLLUP` is not supported')).toBe('ROLLUP');
    expect(namedConstruct('GROUPING SETS is not supported')).toBe('GROUPING SETS');
    expect(namedConstruct('This engine does not support window functions')).toBe(
      'window functions',
    );
  });

  it('leaves the construct unnamed rather than inventing one', () => {
    expect(namedConstruct('Unsupported')).toBeUndefined();
    expect(classifyMessage('Unsupported')).toEqual({
      kind: 'unsupported-construct',
      construct: undefined,
    });
  });

  it('rejects a capture long enough to be a sentence rather than a construct', () => {
    const message =
      'Unsupported construct: ' + 'a'.repeat(200) + ' which cannot be planned by this engine';
    expect(namedConstruct(message)).toBeUndefined();
  });
});

describe('classifyFailure', () => {
  const base: QueryExecutionSnapshot = { id: 'q-1', state: 'FAILED' };

  it('is undefined for a query that did not fail', () => {
    expect(classifyFailure({ id: 'q-1', state: 'SUCCEEDED' })).toBeUndefined();
    expect(classifyFailure({ id: 'q-1', state: 'CANCELLED' })).toBeUndefined();
  });

  it('prefers AthenaError.ErrorMessage over StateChangeReason', () => {
    const failure = classifyFailure({
      ...base,
      stateChangeReason: 'see the error',
      athenaError: { message: 'Unsupported SQL construct: TABLESAMPLE', category: 2, type: 1001 },
    });
    expect(failure).toMatchObject({
      kind: 'unsupported-construct',
      construct: 'TABLESAMPLE',
      category: 'User',
      errorType: 1001,
    });
  });

  it('falls back to StateChangeReason', () => {
    expect(classifyFailure({ ...base, stateChangeReason: 'SYNTAX_ERROR: bad' })).toMatchObject({
      kind: 'error',
      message: 'SYNTAX_ERROR: bad',
    });
  });

  it('says so plainly when the target gave no reason at all', () => {
    const failure = classifyFailure(base);
    expect(failure?.kind).toBe('error');
    expect(failure?.message).toContain('without giving a reason');
  });

  it('labels the error categories the model defines', () => {
    expect(errorCategoryLabel(1)).toBe('System');
    expect(errorCategoryLabel(2)).toBe('User');
    expect(errorCategoryLabel(3)).toBe('Other');
    expect(errorCategoryLabel(9)).toBe('Category 9');
    expect(errorCategoryLabel(undefined)).toBeUndefined();
  });
});
