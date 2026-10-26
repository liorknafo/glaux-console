/** Display helpers for the query library tables. */

/** One line of SQL for a table cell — the editor shows the rest. */
export function summarize(sql: string, limit = 90): string {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** An ISO timestamp in the reader's own locale, or the raw value if unparseable. */
export function formatRanAt(iso: string | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}
