import { describe, expect, it } from 'vitest';
import { readPartitionProjection } from './projection';

describe('readPartitionProjection', () => {
  it('reads a projected table’s columns and their settings', () => {
    const projection = readPartitionProjection({
      classification: 'parquet',
      'projection.enabled': 'true',
      'projection.dt.type': 'date',
      'projection.dt.range': '2026-01-01,NOW',
      'projection.dt.format': 'yyyy-MM-dd',
      'projection.dt.interval': '1',
      'projection.dt.interval.unit': 'DAYS',
      'projection.region.type': 'enum',
      'projection.region.values': 'eu,us',
      'storage.location.template': 's3://lake/orders/${dt}/${region}/',
    });

    expect(projection.enabled).toBe(true);
    expect(projection.configured).toBe(true);
    expect(projection.storageLocationTemplate).toBe('s3://lake/orders/${dt}/${region}/');
    expect(projection.columns).toEqual([
      {
        column: 'dt',
        type: 'date',
        settings: {
          range: '2026-01-01,NOW',
          format: 'yyyy-MM-dd',
          interval: '1',
          'interval.unit': 'DAYS',
        },
      },
      { column: 'region', type: 'enum', settings: { values: 'eu,us' } },
    ]);
  });

  it('reports a configuration that is switched off as configured but not enabled', () => {
    const projection = readPartitionProjection({
      'projection.enabled': 'false',
      'projection.dt.type': 'date',
    });
    expect(projection.enabled).toBe(false);
    expect(projection.configured).toBe(true);
  });

  it('treats a table with no projection parameters as unconfigured', () => {
    const projection = readPartitionProjection({ classification: 'json' });
    expect(projection).toEqual({
      enabled: false,
      configured: false,
      storageLocationTemplate: undefined,
      columns: [],
    });
  });

  it('keeps a setting it does not recognise instead of hiding it', () => {
    const projection = readPartitionProjection({
      'projection.enabled': 'true',
      'projection.dt.type': 'integer',
      'projection.dt.some-future-setting': 'x',
    });
    expect(projection.columns[0].settings).toEqual({ 'some-future-setting': 'x' });
  });

  it('ignores a projection key that names no setting', () => {
    expect(readPartitionProjection({ 'projection.dt': 'x' }).columns).toEqual([]);
  });
});
