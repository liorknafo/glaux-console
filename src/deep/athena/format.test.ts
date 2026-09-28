import { describe, expect, it } from 'vitest';
import { formatRanAt, summarize } from './format';

describe('summarize', () => {
  it('collapses a multi-line statement onto one line', () => {
    expect(summarize('SELECT *\n  FROM  orders\nLIMIT 10;')).toBe('SELECT * FROM orders LIMIT 10;');
  });

  it('truncates past the limit and marks the truncation', () => {
    const summary = summarize('SELECT ' + 'x'.repeat(200), 20);
    expect(summary).toHaveLength(20);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('leaves a short statement alone', () => {
    expect(summarize('SELECT 1;')).toBe('SELECT 1;');
  });
});

describe('formatRanAt', () => {
  it('renders a timestamp the reader can read', () => {
    expect(formatRanAt('2026-08-23T10:30:00.000Z')).toBe(
      new Date('2026-08-23T10:30:00.000Z').toLocaleString(),
    );
  });

  it('passes through a value it cannot parse rather than showing "Invalid Date"', () => {
    expect(formatRanAt('whenever')).toBe('whenever');
    expect(formatRanAt(undefined)).toBe('—');
  });
});
