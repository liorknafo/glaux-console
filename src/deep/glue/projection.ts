/**
 * Partition projection, read out of a table's Glue parameters.
 *
 * Projection is not a modelled Glue structure — Athena configures it through
 * free-form table parameters (`projection.enabled`, `projection.<column>.type`
 * and friends, plus `storage.location.template`). So this reads the convention
 * rather than a shape, and it reports every projection parameter it finds,
 * including ones it does not recognise, rather than showing only the settings
 * it knows the names of.
 */

export interface ProjectedColumn {
  column: string;
  /** `enum`, `integer`, `date` or `injected` — whatever the table declared. */
  type?: string;
  /** Every other `projection.<column>.*` setting, keyed by its suffix. */
  settings: Record<string, string>;
}

export interface PartitionProjection {
  /** True only when the table says `projection.enabled = true`. */
  enabled: boolean;
  /** Present whenever the parameter is, even if projection is switched off. */
  configured: boolean;
  storageLocationTemplate?: string;
  columns: ProjectedColumn[];
}

const PREFIX = 'projection.';
const ENABLED = 'projection.enabled';
const TEMPLATE = 'storage.location.template';

export function readPartitionProjection(parameters: Record<string, string>): PartitionProjection {
  const columns = new Map<string, ProjectedColumn>();

  for (const [key, value] of Object.entries(parameters)) {
    if (!key.startsWith(PREFIX) || key === ENABLED) continue;
    const rest = key.slice(PREFIX.length);
    const dot = rest.indexOf('.');
    // `projection.<column>` with no setting names no setting; skip it rather
    // than inventing a column with an empty suffix.
    if (dot <= 0) continue;
    const column = rest.slice(0, dot);
    const setting = rest.slice(dot + 1);
    const existing = columns.get(column) ?? { column, settings: {} };
    if (setting === 'type') existing.type = value;
    else existing.settings[setting] = value;
    columns.set(column, existing);
  }

  const enabledValue = parameters[ENABLED];
  return {
    enabled: enabledValue?.trim().toLowerCase() === 'true',
    configured: enabledValue !== undefined || columns.size > 0,
    storageLocationTemplate: parameters[TEMPLATE],
    columns: [...columns.values()].sort((a, b) => a.column.localeCompare(b.column)),
  };
}
