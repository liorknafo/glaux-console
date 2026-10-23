import { callOperation } from '../../api/client';
import type { Operation, ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';
import type { Item } from './items';

/**
 * The DynamoDB data layer: tables, their key schema and indexes, and the two
 * ways of reading items — `Query` against a key condition, `Scan` across the
 * whole table.
 *
 * Paging here is DynamoDB's own: `LastEvaluatedKey` from one page becomes
 * `ExclusiveStartKey` of the next, and its absence — not an empty page — is
 * what means the read is finished.
 */

export interface KeyElement {
  name: string;
  type: 'HASH' | 'RANGE' | string;
}

export interface SecondaryIndex {
  name: string;
  kind: 'global' | 'local';
  keySchema: KeyElement[];
  projectionType?: string;
  nonKeyAttributes: string[];
  status?: string;
  itemCount?: number;
  sizeBytes?: number;
}

export interface TableDescription {
  name: string;
  arn?: string;
  status?: string;
  keySchema: KeyElement[];
  attributeDefinitions: { name: string; type: string }[];
  itemCount?: number;
  sizeBytes?: number;
  creationDateTime?: unknown;
  billingMode?: string;
  readCapacityUnits?: number;
  writeCapacityUnits?: number;
  indexes: SecondaryIndex[];
  streamEnabled: boolean;
  streamViewType?: string;
  deletionProtection?: boolean;
}

export interface ItemPage {
  items: Item[];
  count?: number;
  scannedCount?: number;
  /** DynamoDB's own cursor; absent means the read reached the end. */
  lastEvaluatedKey?: Item;
}

/** One page of items, matching the console's own default page size. */
export const PAGE_SIZE = 50;

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

export function readKeySchema(value: unknown): KeyElement[] {
  return asArray(value).flatMap<KeyElement>(entry => {
    const element = asRecord(entry);
    const name = asString(element?.AttributeName);
    if (!name) return [];
    return [{ name, type: asString(element?.KeyType) ?? 'HASH' }];
  });
}

function readIndexes(value: unknown, kind: 'global' | 'local'): SecondaryIndex[] {
  return asArray(value).flatMap<SecondaryIndex>(entry => {
    const index = asRecord(entry);
    const name = asString(index?.IndexName);
    if (!name) return [];
    const projection = asRecord(index?.Projection);
    return [
      {
        name,
        kind,
        keySchema: readKeySchema(index?.KeySchema),
        projectionType: asString(projection?.ProjectionType),
        nonKeyAttributes: asArray(projection?.NonKeyAttributes).map(String),
        status: asString(index?.IndexStatus),
        itemCount: asNumber(index?.ItemCount),
        sizeBytes: asNumber(index?.IndexSizeBytes),
      },
    ];
  });
}

export function readTable(output: unknown): TableDescription {
  const table = asRecord(asRecord(output)?.Table) ?? {};
  const throughput = asRecord(table.ProvisionedThroughput);
  const stream = asRecord(table.StreamSpecification);
  return {
    name: asString(table.TableName) ?? '',
    arn: asString(table.TableArn),
    status: asString(table.TableStatus),
    keySchema: readKeySchema(table.KeySchema),
    attributeDefinitions: asArray(table.AttributeDefinitions).flatMap(entry => {
      const definition = asRecord(entry);
      const name = asString(definition?.AttributeName);
      if (!name) return [];
      return [{ name, type: asString(definition?.AttributeType) ?? 'S' }];
    }),
    itemCount: asNumber(table.ItemCount),
    sizeBytes: asNumber(table.TableSizeBytes),
    creationDateTime: table.CreationDateTime,
    billingMode: asString(asRecord(table.BillingModeSummary)?.BillingMode),
    readCapacityUnits: asNumber(throughput?.ReadCapacityUnits),
    writeCapacityUnits: asNumber(throughput?.WriteCapacityUnits),
    indexes: [
      ...readIndexes(table.GlobalSecondaryIndexes, 'global'),
      ...readIndexes(table.LocalSecondaryIndexes, 'local'),
    ],
    streamEnabled: stream?.StreamEnabled === true,
    streamViewType: asString(stream?.StreamViewType),
    deletionProtection:
      typeof table.DeletionProtectionEnabled === 'boolean'
        ? table.DeletionProtectionEnabled
        : undefined,
  };
}

export function readItemPage(output: unknown): ItemPage {
  const record = asRecord(output);
  const lastKey = asRecord(record?.LastEvaluatedKey);
  return {
    items: asArray(record?.Items).flatMap<Item>(entry => {
      const item = asRecord(entry);
      return item ? [item as Item] : [];
    }),
    count: asNumber(record?.Count),
    scannedCount: asNumber(record?.ScannedCount),
    // An empty `LastEvaluatedKey` map is not a cursor; only a populated one is.
    lastEvaluatedKey: lastKey && Object.keys(lastKey).length > 0 ? (lastKey as Item) : undefined,
  };
}

/** The hash and range attribute names of a table, or of one of its indexes. */
export function keyAttributesOf(table: TableDescription, indexName?: string): string[] {
  const schema = indexName
    ? (table.indexes.find(index => index.name === indexName)?.keySchema ?? [])
    : table.keySchema;
  const hash = schema.filter(element => element.type === 'HASH').map(element => element.name);
  const range = schema.filter(element => element.type === 'RANGE').map(element => element.name);
  return [...hash, ...range];
}

function operation(catalog: ServiceCatalog, name: string): Operation {
  const found = catalog.operations[name];
  if (!found) throw new Error(`The DynamoDB model has no ${name} operation`);
  return found;
}

/**
 * Every table on the target.
 *
 * `ListTables` pages on a table name rather than on a token, so the cursor is
 * `LastEvaluatedTableName`.
 */
export async function fetchTableNames(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  signal?: AbortSignal,
): Promise<string[]> {
  const op = operation(catalog, 'ListTables');
  const names: string[] = [];
  let start: string | undefined;
  // A target that echoes the same cursor forever would otherwise spin here.
  for (let page = 0; page < 20; page += 1) {
    const input = start ? { ExclusiveStartTableName: start } : {};
    const result = await callOperation(endpoint, catalog, op, input, signal);
    const record = asRecord(result.output);
    names.push(...asArray(record?.TableNames).map(String));
    const next = asString(record?.LastEvaluatedTableName);
    if (!next || next === start) break;
    start = next;
  }
  return names;
}

export async function describeTable(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  tableName: string,
  signal?: AbortSignal,
): Promise<TableDescription> {
  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'DescribeTable'),
    { TableName: tableName },
    signal,
  );
  return readTable(result.output);
}

export type ReadMode = 'scan' | 'query';

export interface ReadRequest {
  mode: ReadMode;
  tableName: string;
  indexName?: string;
  /**
   * True when `indexName` names a global secondary index. A GSI cannot be read
   * consistently, so a consistent read is dropped rather than sent and rejected.
   */
  globalIndex?: boolean;
  /** Required for a query; DynamoDB has no query without a key condition. */
  keyConditionExpression?: string;
  filterExpression?: string;
  projectionExpression?: string;
  /** `ExpressionAttributeNames`, already parsed from the editor's JSON. */
  expressionAttributeNames?: Record<string, string>;
  /** `ExpressionAttributeValues`, in DynamoDB's own tagged form. */
  expressionAttributeValues?: Item;
  consistentRead?: boolean;
  limit?: number;
  exclusiveStartKey?: Item;
}

/**
 * One page of a `Scan` or a `Query`.
 *
 * Only the members the caller actually filled in are sent: DynamoDB rejects an
 * empty `ExpressionAttributeValues` map, and an empty `FilterExpression` is not
 * the same request as no filter at all.
 */
export async function readItems(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  request: ReadRequest,
  signal?: AbortSignal,
): Promise<ItemPage> {
  const input: Record<string, unknown> = {
    TableName: request.tableName,
    Limit: request.limit ?? PAGE_SIZE,
  };
  if (request.indexName) input.IndexName = request.indexName;
  if (request.mode === 'query') {
    if (!request.keyConditionExpression) {
      throw new Error('A query needs a key condition expression');
    }
    input.KeyConditionExpression = request.keyConditionExpression;
  }
  if (request.filterExpression) input.FilterExpression = request.filterExpression;
  if (request.projectionExpression) input.ProjectionExpression = request.projectionExpression;
  if (
    request.expressionAttributeNames &&
    Object.keys(request.expressionAttributeNames).length > 0
  ) {
    input.ExpressionAttributeNames = request.expressionAttributeNames;
  }
  if (
    request.expressionAttributeValues &&
    Object.keys(request.expressionAttributeValues).length > 0
  ) {
    input.ExpressionAttributeValues = request.expressionAttributeValues;
  }
  // A consistent read is not available on a global secondary index.
  if (request.consistentRead && !request.globalIndex) input.ConsistentRead = true;
  if (request.exclusiveStartKey) input.ExclusiveStartKey = request.exclusiveStartKey;

  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, request.mode === 'query' ? 'Query' : 'Scan'),
    input,
    signal,
  );
  return readItemPage(result.output);
}

export async function putItem(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  tableName: string,
  item: Item,
  signal?: AbortSignal,
): Promise<void> {
  await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'PutItem'),
    { TableName: tableName, Item: item },
    signal,
  );
}

export async function deleteItem(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  tableName: string,
  key: Item,
  signal?: AbortSignal,
): Promise<void> {
  await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'DeleteItem'),
    { TableName: tableName, Key: key },
    signal,
  );
}
