import { describe, expect, it } from 'vitest';
import { readDatabases, readNextToken, readTables, selectStatement } from './schema';

const TABLES_RESPONSE = {
  TableList: [
    {
      Name: 'orders',
      DatabaseName: 'analytics',
      TableType: 'EXTERNAL_TABLE',
      StorageDescriptor: {
        Location: 's3://lake/orders/',
        Columns: [
          { Name: 'order_id', Type: 'string', Comment: 'primary key' },
          { Name: 'total', Type: 'double' },
        ],
      },
      PartitionKeys: [{ Name: 'dt', Type: 'string' }],
    },
    { NotATable: true },
  ],
  NextToken: 'more',
};

describe('reading the Glue catalog', () => {
  it('reads databases, skipping entries without a name', () => {
    expect(
      readDatabases({
        DatabaseList: [
          { Name: 'analytics', Description: 'the lake', LocationUri: 's3://lake/' },
          { Description: 'nameless' },
        ],
      }),
    ).toEqual([{ name: 'analytics', description: 'the lake', locationUri: 's3://lake/' }]);
  });

  it('reads a table’s columns with partition keys last and flagged', () => {
    const [table] = readTables(TABLES_RESPONSE);
    expect(table.name).toBe('orders');
    expect(table.location).toBe('s3://lake/orders/');
    expect(table.columns).toEqual([
      { name: 'order_id', type: 'string', comment: 'primary key', partitionKey: false },
      { name: 'total', type: 'double', comment: undefined, partitionKey: false },
      { name: 'dt', type: 'string', comment: undefined, partitionKey: true },
    ]);
  });

  it('reads the continuation token', () => {
    expect(readNextToken(TABLES_RESPONSE)).toBe('more');
    expect(readNextToken({ NextToken: '' })).toBeUndefined();
    expect(readNextToken({})).toBeUndefined();
  });

  it('returns nothing for a response that is not a listing', () => {
    expect(readTables(null)).toEqual([]);
    expect(readDatabases({ DatabaseList: 'nope' })).toEqual([]);
  });
});

describe('selectStatement', () => {
  it('names the non-partition columns and quotes every identifier', () => {
    const [table] = readTables(TABLES_RESPONSE);
    expect(selectStatement('analytics', table)).toBe(
      'SELECT "order_id", "total"\nFROM "analytics"."orders"\nLIMIT 10;',
    );
  });

  it('falls back to * for a wide table', () => {
    const table = {
      name: 'wide',
      columns: Array.from({ length: 30 }, (_unused, index) => ({
        name: `c${index}`,
        partitionKey: false,
      })),
    };
    expect(selectStatement('analytics', table)).toContain('SELECT *');
  });

  it('falls back to * when the catalog records no columns', () => {
    expect(selectStatement('analytics', { name: 'empty', columns: [] })).toContain('SELECT *');
  });
});
