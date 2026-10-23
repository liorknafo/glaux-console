import { describe, expect, it } from 'vitest';
import { keyAttributesOf, readItemPage, readKeySchema, readTable } from './tables';

const DESCRIBE_OUTPUT = {
  Table: {
    TableName: 'orders',
    TableArn: 'arn:aws:dynamodb:us-east-1:0:table/orders',
    TableStatus: 'ACTIVE',
    ItemCount: 12,
    TableSizeBytes: 4096,
    CreationDateTime: 1756080000,
    KeySchema: [
      { AttributeName: 'sk', KeyType: 'RANGE' },
      { AttributeName: 'pk', KeyType: 'HASH' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'N' },
      { AttributeName: 'status', AttributeType: 'S' },
    ],
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    BillingModeSummary: { BillingMode: 'PROVISIONED' },
    GlobalSecondaryIndexes: [
      {
        IndexName: 'by-status',
        IndexStatus: 'ACTIVE',
        KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['total'] },
        ItemCount: 12,
      },
    ],
    LocalSecondaryIndexes: [
      {
        IndexName: 'by-created',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'created', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    DeletionProtectionEnabled: false,
  },
};

describe('reading a table description', () => {
  const table = readTable(DESCRIBE_OUTPUT);

  it('reads the identity, size and status', () => {
    expect(table.name).toBe('orders');
    expect(table.status).toBe('ACTIVE');
    expect(table.itemCount).toBe(12);
    expect(table.sizeBytes).toBe(4096);
    expect(table.arn).toBe('arn:aws:dynamodb:us-east-1:0:table/orders');
  });

  it('reads throughput, billing mode and the stream specification', () => {
    expect(table.readCapacityUnits).toBe(5);
    expect(table.billingMode).toBe('PROVISIONED');
    expect(table.streamEnabled).toBe(true);
    expect(table.streamViewType).toBe('NEW_AND_OLD_IMAGES');
    expect(table.deletionProtection).toBe(false);
  });

  it('reads both kinds of secondary index, tagged by kind', () => {
    expect(table.indexes.map(index => [index.name, index.kind])).toEqual([
      ['by-status', 'global'],
      ['by-created', 'local'],
    ]);
    expect(table.indexes[0].projectionType).toBe('INCLUDE');
    expect(table.indexes[0].nonKeyAttributes).toEqual(['total']);
  });

  it('reads attribute definitions', () => {
    expect(table.attributeDefinitions).toContainEqual({ name: 'sk', type: 'N' });
  });

  it('answers a description the target did not fill in without inventing one', () => {
    const empty = readTable({});
    expect(empty.name).toBe('');
    expect(empty.keySchema).toEqual([]);
    expect(empty.indexes).toEqual([]);
    expect(empty.streamEnabled).toBe(false);
    expect(empty.deletionProtection).toBeUndefined();
  });
});

describe('key attributes', () => {
  const table = readTable(DESCRIBE_OUTPUT);

  it('puts the hash key before the range key whatever order the schema arrived in', () => {
    expect(readKeySchema(DESCRIBE_OUTPUT.Table.KeySchema)[0].name).toBe('sk');
    expect(keyAttributesOf(table)).toEqual(['pk', 'sk']);
  });

  it('takes the key schema of an index when one is named', () => {
    expect(keyAttributesOf(table, 'by-status')).toEqual(['status']);
    expect(keyAttributesOf(table, 'by-created')).toEqual(['pk', 'created']);
  });

  it('answers empty for an index the table does not have', () => {
    expect(keyAttributesOf(table, 'nope')).toEqual([]);
  });
});

describe('reading a page of items', () => {
  it('reads items and the counts alongside them', () => {
    const page = readItemPage({
      Items: [{ pk: { S: 'a' } }],
      Count: 1,
      ScannedCount: 7,
      LastEvaluatedKey: { pk: { S: 'a' } },
    });
    expect(page.items).toEqual([{ pk: { S: 'a' } }]);
    expect(page.count).toBe(1);
    expect(page.scannedCount).toBe(7);
    expect(page.lastEvaluatedKey).toEqual({ pk: { S: 'a' } });
  });

  it('treats an empty LastEvaluatedKey as the end of the read', () => {
    // An empty map is not a cursor; paging on it would loop forever.
    expect(readItemPage({ Items: [], LastEvaluatedKey: {} }).lastEvaluatedKey).toBeUndefined();
    expect(readItemPage({ Items: [] }).lastEvaluatedKey).toBeUndefined();
  });
});
