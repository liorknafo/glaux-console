import { describe, expect, it } from 'vitest';
import { isHeaderRow, readColumns, readResultPage } from './results';

const SELECT_PAGE = {
  ResultSet: {
    ResultSetMetadata: {
      ColumnInfo: [
        { Name: 'order_id', Label: 'order_id', Type: 'varchar' },
        { Name: 'total', Label: 'total', Type: 'double' },
      ],
    },
    Rows: [
      { Data: [{ VarCharValue: 'order_id' }, { VarCharValue: 'total' }] },
      { Data: [{ VarCharValue: 'A-1' }, { VarCharValue: '19.5' }] },
      { Data: [{ VarCharValue: 'A-2' }, {}] },
    ],
  },
  NextToken: 'page-2',
};

describe('readResultPage', () => {
  it('reads columns and their declared types', () => {
    expect(readColumns(SELECT_PAGE)).toEqual([
      { name: 'order_id', label: 'order_id', type: 'varchar' },
      { name: 'total', label: 'total', type: 'double' },
    ]);
  });

  it('drops Athena’s repeated header row on the first page only', () => {
    const first = readResultPage(SELECT_PAGE, true);
    expect(first.rows).toEqual([
      ['A-1', '19.5'],
      ['A-2', undefined],
    ]);
    expect(first.nextToken).toBe('page-2');

    const later = readResultPage(SELECT_PAGE, false);
    expect(later.rows).toHaveLength(3);
    expect(later.rows[0]).toEqual(['order_id', 'total']);
  });

  it('keeps a first row that only looks like a header in part', () => {
    const page = {
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: [{ Name: 'a' }, { Name: 'b' }] },
        Rows: [{ Data: [{ VarCharValue: 'a' }, { VarCharValue: 'not-b' }] }],
      },
    };
    expect(readResultPage(page, true).rows).toEqual([['a', 'not-b']]);
  });

  it('keeps every row of a DDL result, which carries no header row', () => {
    const page = {
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: [{ Name: 'tab_name' }] },
        Rows: [{ Data: [{ VarCharValue: 'orders' }] }, { Data: [{ VarCharValue: 'events' }] }],
      },
    };
    expect(readResultPage(page, true).rows).toEqual([['orders'], ['events']]);
  });

  it('reads the update count of a write statement', () => {
    const page = readResultPage({ UpdateCount: 12, ResultSet: { Rows: [] } }, true);
    expect(page.updateCount).toBe(12);
    expect(page.columns).toEqual([]);
  });

  it('survives a response missing the result set entirely', () => {
    expect(readResultPage({}, true)).toEqual({
      columns: [],
      rows: [],
      nextToken: undefined,
      updateCount: undefined,
    });
  });

  it('identifies a header row by label as well as by name', () => {
    const columns = [{ name: 'a', label: 'Alias A' }];
    expect(isHeaderRow(['Alias A'], columns)).toBe(true);
    expect(isHeaderRow(['a'], columns)).toBe(true);
    expect(isHeaderRow(['value'], columns)).toBe(false);
  });
});
