import { describe, expect, it } from 'vitest';
import {
  cellText,
  columnsFor,
  describeKey,
  fromPlain,
  itemProblems,
  keyOf,
  plainItem,
  readNumber,
  toItem,
  toPlain,
  type Item,
} from './items';

describe('attribute values to plain JSON', () => {
  it('reads each scalar type', () => {
    expect(toPlain({ S: 'a' })).toBe('a');
    expect(toPlain({ N: '19.5' })).toBe(19.5);
    expect(toPlain({ BOOL: true })).toBe(true);
    expect(toPlain({ NULL: true })).toBeNull();
    // Binary stays the base64 the wire carried; the bytes need not be text.
    expect(toPlain({ B: 'aGk=' })).toBe('aGk=');
  });

  it('reads lists and maps recursively', () => {
    expect(toPlain({ L: [{ S: 'a' }, { N: '1' }] })).toEqual(['a', 1]);
    expect(toPlain({ M: { inner: { S: 'x' } } })).toEqual({ inner: 'x' });
  });

  it('reads sets as lists, since JSON has no set', () => {
    expect(toPlain({ SS: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(toPlain({ NS: ['1', '2'] })).toEqual([1, 2]);
    expect(toPlain({ BS: ['aGk='] })).toEqual(['aGk=']);
  });

  it('keeps a number that a double would round as its own digits', () => {
    expect(readNumber('1')).toBe(1);
    expect(readNumber('19.5')).toBe(19.5);
    // 20 significant digits do not survive a double.
    expect(readNumber('12345678901234567890')).toBe('12345678901234567890');
    expect(toPlain({ N: '12345678901234567890' })).toBe('12345678901234567890');
  });

  it('shows an unrecognised tag as it arrived rather than dropping it', () => {
    expect(toPlain({ Z: 'what' })).toEqual({ Z: 'what' });
  });

  it('converts a whole item', () => {
    expect(plainItem({ pk: { S: 'a' }, total: { N: '19.5' } })).toEqual({ pk: 'a', total: 19.5 });
    expect(plainItem(undefined)).toEqual({});
  });
});

describe('plain JSON to attribute values', () => {
  it('tags each scalar type', () => {
    expect(fromPlain('a')).toEqual({ S: 'a' });
    expect(fromPlain(19.5)).toEqual({ N: '19.5' });
    expect(fromPlain(true)).toEqual({ BOOL: true });
    expect(fromPlain(null)).toEqual({ NULL: true });
  });

  it('makes a JSON list an L and never a set', () => {
    // Nothing in ["a","b"] says which was meant, so guessing would write a
    // different item than the one on screen.
    expect(fromPlain(['a', 'b'])).toEqual({ L: [{ S: 'a' }, { S: 'b' }] });
  });

  it('nests maps', () => {
    expect(toItem({ outer: { inner: 1 } })).toEqual({ outer: { M: { inner: { N: '1' } } } });
  });

  it('refuses a value DynamoDB cannot store', () => {
    expect(() => fromPlain(Number.POSITIVE_INFINITY)).toThrow(/not a number/);
    expect(() => fromPlain(() => 1)).toThrow(/not a value/);
  });

  it('round-trips everything except sets and precision', () => {
    const item: Item = { pk: { S: 'a' }, n: { N: '1' }, on: { BOOL: false } };
    expect(toItem(plainItem(item))).toEqual(item);
  });
});

describe('validating an item before it is written', () => {
  it('accepts a well-formed item', () => {
    expect(itemProblems({ pk: { S: 'a' }, total: { N: '1' } })).toEqual([]);
  });

  it('names the attribute that is missing its type tag', () => {
    expect(itemProblems({ pk: 'a' })[0]).toContain('"pk"');
    expect(itemProblems({ pk: 'a' })[0]).toContain('{"S": "..."}');
  });

  it('rejects an attribute with two tags or an unknown one', () => {
    expect(itemProblems({ pk: { S: 'a', N: '1' } })[0]).toContain('exactly one type tag');
    expect(itemProblems({ pk: { Z: 'a' } })[0]).toContain('tagged "Z"');
  });

  it('rejects something that is not an item at all', () => {
    expect(itemProblems([])[0]).toContain('must be a JSON object');
    expect(itemProblems('pk')[0]).toContain('must be a JSON object');
  });

  it('reports every bad attribute, not only the first', () => {
    expect(itemProblems({ a: 'x', b: 'y' })).toHaveLength(2);
  });
});

describe('rendering a page of items', () => {
  const items: Item[] = [
    { pk: { S: 'a' }, total: { N: '19.5' } },
    { pk: { S: 'b' }, note: { S: 'hi' } },
  ];

  it('puts the key attributes first and keeps every attribute seen', () => {
    expect(columnsFor(items, ['pk'])).toEqual(['pk', 'total', 'note']);
  });

  it('keeps a key column even when no item carries it', () => {
    expect(columnsFor([], ['pk', 'sk'])).toEqual(['pk', 'sk']);
  });

  it('renders a cell as text, and a nested value as JSON', () => {
    expect(cellText({ S: 'a' })).toBe('a');
    expect(cellText({ N: '1' })).toBe('1');
    expect(cellText({ NULL: true })).toBe('null');
    expect(cellText({ M: { x: { S: 'y' } } })).toBe('{"x":"y"}');
    expect(cellText(undefined)).toBe('');
  });
});

describe('item keys', () => {
  const item: Item = { pk: { S: 'a' }, sk: { N: '1' }, other: { S: 'x' } };

  it('takes only the key attributes', () => {
    expect(keyOf(item, ['pk', 'sk'])).toEqual({ pk: { S: 'a' }, sk: { N: '1' } });
  });

  it('skips a key attribute the item does not carry', () => {
    expect(keyOf({ pk: { S: 'a' } }, ['pk', 'sk'])).toEqual({ pk: { S: 'a' } });
  });

  it('names an item the way the console does', () => {
    expect(describeKey(item, ['pk', 'sk'])).toBe('pk=a, sk=1');
  });
});
