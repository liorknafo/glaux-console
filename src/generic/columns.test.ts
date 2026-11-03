import { describe, expect, it } from 'vitest';
import { loadServiceCatalog } from '../catalog/loader';
import { humanize, inferResultShape, readCollection, renderCell } from './columns';

describe('column inference', () => {
  it('uses the paginator’s result key to find the collection', async () => {
    const s3 = await loadServiceCatalog('s3');
    const operation = s3.operations.ListObjectsV2;
    const result = inferResultShape(s3, operation.output, operation.pagination?.resultKey);

    expect(result?.path).toEqual(['Contents']);
    expect(result?.columns.map(column => column.id)).toContain('Key');
    expect(result?.columns.map(column => column.id)).toContain('Size');
  });

  it('falls back to the first list member when the model has no paginator', async () => {
    const athena = await loadServiceCatalog('athena');
    const operation = athena.operations.ListDataCatalogs;
    const result = inferResultShape(athena, operation.output, operation.pagination?.resultKey);
    expect(result?.path).toEqual(['DataCatalogsSummary']);
  });

  it('puts scalar columns first and keeps complex members visible', async () => {
    const dynamodb = await loadServiceCatalog('dynamodb');
    const operation = dynamodb.operations.ListTables;
    const result = inferResultShape(dynamodb, operation.output, operation.pagination?.resultKey);
    // TableNames is a list of strings: a single value column.
    expect(result?.columns).toEqual([{ id: '$value', header: 'Value', scalar: true }]);
  });

  it('returns nothing for operations that produce no collection', async () => {
    const sqs = await loadServiceCatalog('sqs');
    expect(inferResultShape(sqs, sqs.operations.GetQueueUrl.output, undefined)).toBeUndefined();
  });
});

describe('reading the collection out of a response', () => {
  it('follows the inferred path', () => {
    expect(readCollection({ Contents: [{ Key: 'a' }] }, ['Contents'])).toEqual([{ Key: 'a' }]);
    expect(readCollection({}, ['Contents'])).toEqual([]);
    expect(readCollection({ a: { b: ['x'] } }, ['a', 'b'])).toEqual(['x']);
  });

  it('wraps a single object so the table still renders it', () => {
    expect(readCollection({ Item: { Key: 'a' } }, ['Item'])).toEqual([{ Key: 'a' }]);
  });
});

describe('cell rendering', () => {
  it('shows scalars as themselves and complex values as JSON', () => {
    expect(renderCell('a')).toBe('a');
    expect(renderCell(12)).toBe('12');
    expect(renderCell(false)).toBe('false');
    expect(renderCell(undefined)).toBe('–');
    expect(renderCell({ a: 1 })).toBe('{"a":1}');
  });
});

describe('humanize', () => {
  it('reads member names the way console column headers do', () => {
    expect(humanize('QueryExecutionId')).toBe('Query execution id');
    expect(humanize('Name')).toBe('Name');
    expect(humanize('DBInstanceClass')).toBe('Db instance class');
  });
});
