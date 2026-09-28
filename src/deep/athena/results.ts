import type { ResultColumn, ResultPage } from './types';

/**
 * `GetQueryResults` -> table columns and rows.
 *
 * Athena returns the column labels as the **first row of the first page** for
 * SELECT results, and omits that row for DDL statements and for every page after
 * the first. Rather than always dropping row 0 (which would eat a real row of a
 * DDL result, or a data row whose values happen to be absent), the header row is
 * only dropped when every one of its cells actually equals the column's name or
 * label — the condition that identifies it.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readColumns(output: unknown): ResultColumn[] {
  const metadata = asRecord(asRecord(asRecord(output)?.ResultSet)?.ResultSetMetadata);
  return asArray(metadata?.ColumnInfo).flatMap<ResultColumn>(entry => {
    const column = asRecord(entry);
    const name = asString(column?.Name);
    if (!name) return [];
    return [{ name, label: asString(column?.Label) ?? name, type: asString(column?.Type) }];
  });
}

function readRows(output: unknown): (string | undefined)[][] {
  return asArray(asRecord(asRecord(output)?.ResultSet)?.Rows).map(entry =>
    asArray(asRecord(entry)?.Data).map(datum => asString(asRecord(datum)?.VarCharValue)),
  );
}

/** True when the row is Athena's repeated header rather than data. */
export function isHeaderRow(row: (string | undefined)[], columns: ResultColumn[]): boolean {
  if (columns.length === 0 || row.length !== columns.length) return false;
  return columns.every(
    (column, index) => row[index] === column.name || row[index] === column.label,
  );
}

export function readResultPage(output: unknown, firstPage: boolean): ResultPage {
  const columns = readColumns(output);
  const rows = readRows(output);
  const body = firstPage && rows.length > 0 && isHeaderRow(rows[0], columns) ? rows.slice(1) : rows;
  const record = asRecord(output);
  const updateCount = typeof record?.UpdateCount === 'number' ? record.UpdateCount : undefined;
  return { columns, rows: body, nextToken: asString(record?.NextToken) || undefined, updateCount };
}
