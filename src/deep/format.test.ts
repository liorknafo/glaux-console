import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatEpochMillis,
  formatEpochMillisPrecise,
} from './format';

describe('formatBytes', () => {
  it('formats byte counts the way the console does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.00 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15.0 MB');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('does not invent a number for a non-finite value', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats durations', () => {
    expect(formatDuration(320)).toBe('320 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(90_000)).toBe('1 min 30.0 s');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('reads an ISO string, the way an XML protocol returns one', () => {
    expect(formatDateTime('2026-08-24T10:00:00Z')).toBe(
      new Date('2026-08-24T10:00:00Z').toLocaleString(),
    );
  });

  it('reads epoch seconds, the way a JSON protocol returns one', () => {
    expect(formatDateTime(1_756_029_600)).toBe(new Date(1_756_029_600_000).toLocaleString());
  });

  it('shows an unparseable value as itself rather than as Invalid Date', () => {
    expect(formatDateTime('not a date')).toBe('not a date');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
  });
});

describe('formatEpochMillis', () => {
  it('reads a CloudWatch Logs timestamp as milliseconds, not seconds', () => {
    expect(formatEpochMillis(1_756_029_600_000)).toBe(new Date(1_756_029_600_000).toLocaleString());
    // The same number through formatDateTime would be read as seconds and land
    // fifty thousand years out — which is exactly why this function exists.
    expect(formatEpochMillis(1_756_029_600_000)).not.toBe(formatDateTime(1_756_029_600_000));
  });

  it('has nothing to show for a missing or non-finite timestamp', () => {
    expect(formatEpochMillis(undefined)).toBe('—');
    expect(formatEpochMillis(Number.NaN)).toBe('—');
    expect(formatEpochMillis(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatEpochMillisPrecise', () => {
  it('keeps the milliseconds, which is what separates two log lines', () => {
    const at = Date.UTC(2026, 7, 27, 10, 0, 0, 42);
    expect(formatEpochMillisPrecise(at)).toBe(`${new Date(at).toLocaleTimeString()}.042`);
  });

  it('has nothing to show for a missing timestamp', () => {
    expect(formatEpochMillisPrecise(undefined)).toBe('—');
  });
});
