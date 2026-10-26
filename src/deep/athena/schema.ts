import { callOperation } from '../../api/client';
import { loadServiceCatalog } from '../../catalog/loader';
import type { ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';

/**
 * The schema tree behind the editor, read from the Glue Data Catalog.
 *
 * Glue rather than Athena's own `ListDatabases`/`ListTableMetadata`: the spec
 * calls for a "Glue-backed schema tree", glaux's Athena is Glue-backed, and
 * glaux v0.1 documents the Athena query APIs without the metadata ones. Going
 * to Glue directly is one hop instead of two, and it is the same data the Glue
 * screen will show.
 */

export interface SchemaColumn {
  name: string;
  type?: string;
  comment?: string;
  partitionKey: boolean;
}

export interface SchemaTable {
  name: string;
  databaseName?: string;
  tableType?: string;
  location?: string;
  columns: SchemaColumn[];
}

export interface SchemaDatabase {
  name: string;
  description?: string;
  locationUri?: string;
}

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

function readColumns(entries: unknown, partitionKey: boolean): SchemaColumn[] {
  return asArray(entries).flatMap<SchemaColumn>(entry => {
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

export function readDatabases(output: unknown): SchemaDatabase[] {
  return asArray(asRecord(output)?.DatabaseList).flatMap<SchemaDatabase>(entry => {
    const database = asRecord(entry);
    const name = asString(database?.Name);
    if (!name) return [];
    return [
      {
        name,
        description: asString(database?.Description),
        locationUri: asString(database?.LocationUri),
      },
    ];
  });
}

export function readTables(output: unknown): SchemaTable[] {
  return asArray(asRecord(output)?.TableList).flatMap<SchemaTable>(entry => {
    const table = asRecord(entry);
    const name = asString(table?.Name);
    if (!name) return [];
    const storage = asRecord(table?.StorageDescriptor);
    return [
      {
        name,
        databaseName: asString(table?.DatabaseName),
        tableType: asString(table?.TableType),
        location: asString(storage?.Location),
        // Partition keys come last, as they read in a DDL statement.
        columns: [
          ...readColumns(storage?.Columns, false),
          ...readColumns(table?.PartitionKeys, true),
        ],
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
): Promise<SchemaDatabase[]> {
  return collect(endpoint, glue, 'GetDatabases', {}, readDatabases, signal);
}

export async function fetchTables(
  endpoint: EndpointConfig,
  glue: ServiceCatalog,
  databaseName: string,
  signal?: AbortSignal,
): Promise<SchemaTable[]> {
  return collect(endpoint, glue, 'GetTables', { DatabaseName: databaseName }, readTables, signal);
}

/** The starter query the tree's "Query this table" action puts in the editor. */
export function selectStatement(databaseName: string, table: SchemaTable): string {
  const columns = table.columns.filter(column => !column.partitionKey);
  const projection =
    columns.length > 0 && columns.length <= 12
      ? columns.map(column => `"${column.name}"`).join(', ')
      : '*';
  return `SELECT ${projection}\nFROM "${databaseName}"."${table.name}"\nLIMIT 10;`;
}
