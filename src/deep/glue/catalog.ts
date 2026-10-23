import { callOperation } from '../../api/client';
import { loadServiceCatalog } from '../../catalog/loader';
import type { ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';

/**
 * The Glue Data Catalog reader: databases, tables, and partitions.
 *
 * This is the one place the console reads the catalog from. The Athena
 * screen's schema tree reads through it too — its tree and this screen show the
 * same tables, so they should not be able to disagree about what a table is.
 */

export interface GlueColumn {
  name: string;
  type?: string;
  comment?: string;
  partitionKey: boolean;
}

export interface GlueSerDe {
  name?: string;
  serializationLibrary?: string;
  parameters: Record<string, string>;
}

export interface GlueStorage {
  location?: string;
  inputFormat?: string;
  outputFormat?: string;
  compressed?: boolean;
  numberOfBuckets?: number;
  bucketColumns: string[];
  serde?: GlueSerDe;
  parameters: Record<string, string>;
}

export interface GlueTable {
  name: string;
  databaseName?: string;
  description?: string;
  owner?: string;
  tableType?: string;
  createTime?: unknown;
  updateTime?: unknown;
  /** Data columns first, then partition keys — the order a DDL statement reads. */
  columns: GlueColumn[];
  storage: GlueStorage;
  parameters: Record<string, string>;
}

export interface GlueDatabase {
  name: string;
  description?: string;
  locationUri?: string;
  createTime?: unknown;
  parameters: Record<string, string>;
}

export interface GluePartition {
  /** Partition key values, in the order the table declares its partition keys. */
  values: string[];
  location?: string;
  creationTime?: unknown;
  lastAccessTime?: unknown;
  parameters: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A Glue `ParametersMap`, with anything non-textual rendered rather than lost. */
export function readParameters(value: unknown): Record<string, string> {
  const source = asRecord(value);
  if (!source) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    out[key] = typeof entry === 'string' ? entry : JSON.stringify(entry);
  }
  return out;
}

function readColumns(entries: unknown, partitionKey: boolean): GlueColumn[] {
  return asArray(entries).flatMap<GlueColumn>(entry => {
    const column = asRecord(entry);
    const name = asString(column?.Name);
    if (!name) return [];
    return [
      {
        name,
        type: asString(column?.Type),
        comment: asString(column?.Comment),
        partitionKey,
      },
    ];
  });
}

function readStorage(value: unknown): GlueStorage {
  const storage = asRecord(value);
  const serde = asRecord(storage?.SerdeInfo);
  return {
    location: asString(storage?.Location),
    inputFormat: asString(storage?.InputFormat),
    outputFormat: asString(storage?.OutputFormat),
    compressed: storage?.Compressed === true,
    numberOfBuckets: asNumber(storage?.NumberOfBuckets),
    bucketColumns: asArray(storage?.BucketColumns).filter(
      (entry): entry is string => typeof entry === 'string',
    ),
    serde: serde
      ? {
          name: asString(serde.Name),
          serializationLibrary: asString(serde.SerializationLibrary),
          parameters: readParameters(serde.Parameters),
        }
      : undefined,
    parameters: readParameters(storage?.Parameters),
  };
}

export function readDatabases(output: unknown): GlueDatabase[] {
  return asArray(asRecord(output)?.DatabaseList).flatMap<GlueDatabase>(entry => {
    const database = asRecord(entry);
    const name = asString(database?.Name);
    if (!name) return [];
    return [
      {
        name,
        description: asString(database?.Description),
        locationUri: asString(database?.LocationUri),
        createTime: database?.CreateTime,
        parameters: readParameters(database?.Parameters),
      },
    ];
  });
}

function readTable(entry: unknown): GlueTable[] {
  const table = asRecord(entry);
  const name = asString(table?.Name);
  if (!name) return [];
  return [
    {
      name,
      databaseName: asString(table?.DatabaseName),
      description: asString(table?.Description),
      owner: asString(table?.Owner),
      tableType: asString(table?.TableType),
      createTime: table?.CreateTime,
      updateTime: table?.UpdateTime,
      // Partition keys come last, as they read in a DDL statement.
      columns: [
        ...readColumns(asRecord(table?.StorageDescriptor)?.Columns, false),
        ...readColumns(table?.PartitionKeys, true),
      ],
      storage: readStorage(table?.StorageDescriptor),
      parameters: readParameters(table?.Parameters),
    },
  ];
}

export function readTables(output: unknown): GlueTable[] {
  return asArray(asRecord(output)?.TableList).flatMap(readTable);
}

export function readPartitions(output: unknown): GluePartition[] {
  return asArray(asRecord(output)?.Partitions).flatMap<GluePartition>(entry => {
    const partition = asRecord(entry);
    if (!partition) return [];
    return [
      {
        values: asArray(partition.Values).map(String),
        location: asString(asRecord(partition.StorageDescriptor)?.Location),
        creationTime: partition.CreationTime,
        lastAccessTime: partition.LastAccessTime,
        parameters: readParameters(partition.Parameters),
      },
    ];
  });
}

export function readNextToken(output: unknown): string | undefined {
  return asString(asRecord(output)?.NextToken);
}

/** Follow the operation's own continuation token to the end of the listing. */
async function collect<T>(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  operationName: string,
  input: Record<string, unknown>,
  read: (output: unknown) => T[],
  signal?: AbortSignal,
): Promise<T[]> {
  const operation = catalog.operations[operationName];
  if (!operation) throw new Error(`The Glue model has no ${operationName} operation`);

  const collected: T[] = [];
  let token: string | undefined;
  // A target that echoes the same token forever would otherwise spin here.
  for (let page = 0; page < 20; page += 1) {
    const request = token ? { ...input, NextToken: token } : input;
    const result = await callOperation(endpoint, catalog, operation, request, signal);
    collected.push(...read(result.output));
    const next = readNextToken(result.output);
    if (!next || next === token) break;
    token = next;
  }
  return collected;
}

export function loadGlueCatalog(): Promise<ServiceCatalog> {
  return loadServiceCatalog('glue');
}

export async function fetchDatabases(
  endpoint: EndpointConfig,
  glue: ServiceCatalog,
  signal?: AbortSignal,
): Promise<GlueDatabase[]> {
  return collect(endpoint, glue, 'GetDatabases', {}, readDatabases, signal);
}

export async function fetchTables(
  endpoint: EndpointConfig,
  glue: ServiceCatalog,
  databaseName: string,
  signal?: AbortSignal,
): Promise<GlueTable[]> {
  return collect(endpoint, glue, 'GetTables', { DatabaseName: databaseName }, readTables, signal);
}

export async function fetchPartitions(
  endpoint: EndpointConfig,
  glue: ServiceCatalog,
  databaseName: string,
  tableName: string,
  signal?: AbortSignal,
): Promise<GluePartition[]> {
  return collect(
    endpoint,
    glue,
    'GetPartitions',
    { DatabaseName: databaseName, TableName: tableName },
    readPartitions,
    signal,
  );
}

/** The starter query "Query this table" puts in the Athena editor. */
export function selectStatement(
  databaseName: string,
  table: Pick<GlueTable, 'name' | 'columns'>,
): string {
  const columns = table.columns.filter(column => !column.partitionKey);
  const projection =
    columns.length > 0 && columns.length <= 12
      ? columns.map(column => `"${column.name}"`).join(', ')
      : '*';
  return `SELECT ${projection}\nFROM "${databaseName}"."${table.name}"\nLIMIT 10;`;
}
