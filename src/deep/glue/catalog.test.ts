import { describe, expect, it } from 'vitest';
import {
  readDatabases,
  readNextToken,
  readParameters,
  readPartitions,
  readTables,
  selectStatement,
} from './catalog';

/**
 * The readers work against the shapes the Glue model declares, so the fixtures
 * here are `GetDatabases`, `GetTables` and `GetPartitions` responses — nothing
 * emulator-specific.
 */

const TABLES_RESPONSE = {
  TableList: [
    {
      Name: 'orders',
      DatabaseName: 'analytics',
      TableType: 'EXTERNAL_TABLE',
      Owner: 'hadoop',
      CreateTime: 1_756_000_000,
      StorageDescriptor: {
        Location: 's3://lake/orders/',
        InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
        OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
        Compressed: true,
        NumberOfBuckets: 4,
        BucketColumns: ['order_id'],
        SerdeInfo: {
          SerializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
          Parameters: { 'serialization.format': '1' },
        },
        Columns: [
          { Name: 'order_id', Type: 'string', Comment: 'primary key' },
          { Name: 'total', Type: 'double' },
        ],
      },
      PartitionKeys: [{ Name: 'dt', Type: 'string' }],
      Parameters: { classification: 'json', 'projection.enabled': 'true' },
    },
    { NotATable: true },
  ],
  NextToken: 'more',
};

describe('readDatabases', () => {
  it('reads databases, skipping entries without a name', () => {
    expect(
      readDatabases({
        DatabaseList: [
          {
            Name: 'analytics',
            Description: 'the lake',
            LocationUri: 's3://lake/',
            Parameters: { owner: 'data' },
          },
          { Description: 'nameless' },
        ],
      }),
    ).toEqual([
      {
        name: 'analytics',
        description: 'the lake',
        locationUri: 's3://lake/',
        createTime: undefined,
        parameters: { owner: 'data' },
      },
    ]);
  });

  it('returns nothing for a response that is not a listing', () => {
    expect(readDatabases({ DatabaseList: 'nope' })).toEqual([]);
    expect(readDatabases(null)).toEqual([]);
  });
});

describe('readTables', () => {
  it('reads a table’s columns with partition keys last and flagged', () => {
    const [table] = readTables(TABLES_RESPONSE);
    expect(table.name).toBe('orders');
    expect(table.tableType).toBe('EXTERNAL_TABLE');
    expect(table.columns).toEqual([
      { name: 'order_id', type: 'string', comment: 'primary key', partitionKey: false },
      { name: 'total', type: 'double', comment: undefined, partitionKey: false },
      { name: 'dt', type: 'string', comment: undefined, partitionKey: true },
    ]);
  });

  it('reads the storage descriptor and the SerDe', () => {
    const [table] = readTables(TABLES_RESPONSE);
    expect(table.storage.location).toBe('s3://lake/orders/');
    expect(table.storage.inputFormat).toBe('org.apache.hadoop.mapred.TextInputFormat');
    expect(table.storage.compressed).toBe(true);
    expect(table.storage.numberOfBuckets).toBe(4);
    expect(table.storage.bucketColumns).toEqual(['order_id']);
    expect(table.storage.serde).toEqual({
      name: undefined,
      serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
      parameters: { 'serialization.format': '1' },
    });
  });

  it('describes a table with no storage descriptor rather than failing on it', () => {
    const [table] = readTables({ TableList: [{ Name: 'view' }] });
    expect(table.columns).toEqual([]);
    expect(table.storage).toEqual({
      location: undefined,
      inputFormat: undefined,
      outputFormat: undefined,
      compressed: false,
      numberOfBuckets: undefined,
      bucketColumns: [],
      serde: undefined,
      parameters: {},
    });
  });

  it('reads the continuation token', () => {
    expect(readNextToken(TABLES_RESPONSE)).toBe('more');
    expect(readNextToken({ NextToken: '' })).toBeUndefined();
    expect(readNextToken({})).toBeUndefined();
  });
});

describe('readPartitions', () => {
  it('reads partition values in the order the table declares its keys', () => {
    expect(
      readPartitions({
        Partitions: [
          {
            Values: ['2026-08-24', 'eu'],
            CreationTime: 1_756_000_000,
            StorageDescriptor: { Location: 's3://lake/orders/dt=2026-08-24/region=eu/' },
            Parameters: { rows: '10' },
          },
        ],
      }),
    ).toEqual([
      {
        values: ['2026-08-24', 'eu'],
        location: 's3://lake/orders/dt=2026-08-24/region=eu/',
        creationTime: 1_756_000_000,
        lastAccessTime: undefined,
        parameters: { rows: '10' },
      },
    ]);
  });

  it('returns nothing for a response with no partitions', () => {
    expect(readPartitions({})).toEqual([]);
  });
});

describe('readParameters', () => {
  it('renders a non-textual value rather than dropping the key', () => {
    expect(readParameters({ a: 'x', b: 3, c: { nested: true } })).toEqual({
      a: 'x',
      b: '3',
      c: '{"nested":true}',
    });
  });

  it('reads an absent map as empty', () => {
    expect(readParameters(undefined)).toEqual({});
    expect(readParameters('nope')).toEqual({});
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
