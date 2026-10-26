import { describe, expect, it } from 'vitest';
import { byNewest, prefixOfKey, totalBytes } from './activity';

describe('byNewest', () => {
  it('puts the most recently written object first', () => {
    const sorted = byNewest([
      { key: 'a', lastModified: '2026-08-24T09:00:00Z' },
      { key: 'b', lastModified: '2026-08-24T10:00:00Z' },
    ]);
    expect(sorted.map(object => object.key)).toEqual(['b', 'a']);
  });

  it('sorts objects with no timestamp to the end, by key', () => {
    const sorted = byNewest([
      { key: 'z' },
      { key: 'dated', lastModified: '2026-08-24T09:00:00Z' },
      { key: 'a' },
    ]);
    expect(sorted.map(object => object.key)).toEqual(['dated', 'a', 'z']);
  });

  it('does not mutate the listing it was given', () => {
    const objects = [
      { key: 'a', lastModified: '2026-08-24T09:00:00Z' },
      { key: 'b', lastModified: '2026-08-24T10:00:00Z' },
    ];
    byNewest(objects);
    expect(objects.map(object => object.key)).toEqual(['a', 'b']);
  });
});

describe('totalBytes', () => {
  it('adds up the sizes, treating an unsized object as zero', () => {
    expect(totalBytes([{ key: 'a', size: 100 }, { key: 'b', size: 24 }, { key: 'c' }])).toBe(124);
    expect(totalBytes([])).toBe(0);
  });
});

describe('prefixOfKey', () => {
  it('names the prefix a key sits in', () => {
    expect(prefixOfKey('orders/2026/08/24/part-0.json.gz')).toBe('orders/2026/08/24/');
    expect(prefixOfKey('top.json')).toBe('');
  });
});
