/**
 * Display helpers shared by the hand-built screens.
 *
 * Byte counts and durations read the same whether they came from Athena's
 * query statistics, an S3 object listing, or a Firehose buffering hint — so
 * they are formatted in one place rather than once per screen.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Bytes scanned, object sizes, buffer sizes — in the console's own units. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${UNITS[unit]}`;
}

export function formatDuration(millis: number | undefined): string {
  if (millis === undefined || !Number.isFinite(millis)) return '—';
  if (millis < 1000) return `${Math.round(millis)} ms`;
  const seconds = millis / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${(seconds - minutes * 60).toFixed(1)} s`;
}

/**
 * A modelled timestamp in the reader's own locale.
 *
 * The parse layer hands timestamps back as the wire carried them, which for a
 * JSON protocol is a number of epoch seconds and for XML an ISO string. Both
 * arrive here; an unrecognisable value is shown as itself rather than as
 * "Invalid Date".
 */
/**
 * A CloudWatch Logs timestamp, which the model declares in **milliseconds**.
 *
 * `formatDateTime` reads a bare number as epoch seconds, because that is what
 * every other JSON-protocol service on this console returns. Logs is the
 * exception: `timestamp`, `ingestionTime`, `firstEventTimestamp` and the rest
 * are epoch milliseconds, and passing one through `formatDateTime` would date
 * it fifty thousand years out.
 */
export function formatEpochMillis(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** The same instant as `formatEpochMillis`, to the millisecond. */
export function formatEpochMillisPrecise(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleTimeString()}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function formatDateTime(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '—' : value.toLocaleString();
  if (typeof value === 'number') {
    const fromSeconds = new Date(value * 1000);
    return Number.isNaN(fromSeconds.getTime()) ? String(value) : fromSeconds.toLocaleString();
  }
  if (typeof value !== 'string') return String(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
