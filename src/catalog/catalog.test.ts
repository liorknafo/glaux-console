import { describe, expect, it } from 'vitest';
import manifest from './generated/manifest.json';
import {
  findService,
  loadServiceCatalog,
  matchReportedService,
  serviceIndex,
  servicesByCategory,
} from './loader';
import type { ServiceCatalog } from './types';

/**
 * Catalog snapshot tests.
 *
 * The generated catalog is committed, so regenerating it produces a reviewable
 * diff. These tests exist so a regeneration cannot *silently* change a
 * generated form: if the wire traits, required fields, enums, pagination or
 * classification of a pinned operation move, a snapshot fails and the change
 * has to be looked at.
 */

describe('service index', () => {
  it('has an entry per generated chunk and no duplicates', () => {
    expect(serviceIndex.length).toBe(Object.keys(manifest.services).length);
    expect(new Set(serviceIndex.map(entry => entry.id)).size).toBe(serviceIndex.length);
  });

  it('records the botocore model each chunk was generated from', () => {
    expect(manifest.source).toMatch(/^botocore@/);
    for (const entry of serviceIndex) {
      const record = (
        manifest.services as Record<string, { sourceSha256: string; operations: number }>
      )[entry.id];
      expect(record, `manifest entry for ${entry.id}`).toBeDefined();
      expect(record.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.operations).toBe(entry.operations);
    }
  });

  it('groups every service into a category', () => {
    const grouped = servicesByCategory().flatMap(group => group.services);
    expect(grouped.length).toBe(serviceIndex.length);
  });

  it('resolves the service identifiers a target may report', () => {
    expect(matchReportedService('s3')).toBe('s3');
    expect(matchReportedService('S3')).toBe('s3');
    expect(matchReportedService('kinesisfirehose')).toBe('firehose');
    expect(matchReportedService('kinesis-firehose')).toBe('firehose');
    expect(matchReportedService('states')).toBe('stepfunctions');
    expect(matchReportedService('monitoring')).toBe('cloudwatch');
    expect(matchReportedService('streams.dynamodb')).toBe('dynamodbstreams');
    expect(matchReportedService('not-a-service')).toBeUndefined();
  });

  it('exposes the queue’s deep-screen services', () => {
    for (const id of ['athena', 'glue', 'firehose', 's3', 'sqs', 'events', 'dynamodb']) {
      expect(findService(id), id).toBeDefined();
    }
  });
});

describe('generated forms are stable', () => {
  const pinned: [string, string][] = [
    ['athena', 'StartQueryExecution'],
    ['s3', 'ListObjectsV2'],
    ['sqs', 'SendMessage'],
    ['dynamodb', 'Query'],
    ['firehose', 'PutRecordBatch'],
    ['iam', 'CreateRole'],
  ];

  it.each(pinned)('%s %s keeps its modelled shape', async (serviceId, operationName) => {
    const catalog = await loadServiceCatalog(serviceId);
    const operation = catalog.operations[operationName];
    expect(operation).toBeDefined();
    expect({
      http: operation.http,
      classification: operation.classification,
      pagination: operation.pagination,
      input: operation.input ? summarizeShape(catalog, operation.input) : undefined,
    }).toMatchSnapshot();
  });

  it('keeps Athena’s enum values, which render as selects', async () => {
    const catalog = await loadServiceCatalog('athena');
    expect(catalog.shapes.EncryptionOption?.enum).toEqual(['SSE_S3', 'SSE_KMS', 'CSE_KMS']);
  });

  it('classifies operations into the tabs they render in', async () => {
    const catalog = await loadServiceCatalog('sqs');
    expect(catalog.operations.ListQueues.classification).toBe('list');
    expect(catalog.operations.GetQueueUrl.classification).toBe('describe');
    expect(catalog.operations.CreateQueue.classification).toBe('create');
    expect(catalog.operations.DeleteQueue.classification).toBe('delete');
    expect(catalog.operations.PurgeQueue.classification).toBe('delete');
  });

  it('carries the wire metadata each protocol needs', async () => {
    const sqs = await loadServiceCatalog('sqs');
    expect(sqs.metadata.protocol).toBe('json');
    expect(sqs.metadata.targetPrefix).toBe('AmazonSQS');
    expect(sqs.metadata.jsonVersion).toBe('1.0');

    const s3 = await loadServiceCatalog('s3');
    expect(s3.metadata.protocol).toBe('rest-xml');

    const sts = await loadServiceCatalog('sts');
    expect(sts.metadata.protocol).toBe('query');
    expect(sts.metadata.apiVersion).toBe('2011-06-15');

    const lambda = await loadServiceCatalog('lambda');
    expect(lambda.metadata.protocol).toBe('rest-json');
    expect(lambda.operations.Invoke.http.requestUri).toContain('{FunctionName}');
  });

  it('keeps documentation short enough to use as form help', async () => {
    const catalog = await loadServiceCatalog('athena');
    for (const operation of Object.values(catalog.operations)) {
      expect(operation.doc?.length ?? 0).toBeLessThanOrEqual(401);
    }
  });
});

/** A form-relevant digest of an input shape: names, types, requiredness, enums. */
function summarizeShape(catalog: ServiceCatalog, shapeName: string) {
  const shape = catalog.shapes[shapeName];
  return {
    required: shape.required ?? [],
    members: Object.fromEntries(
      Object.entries(shape.members ?? {}).map(([name, ref]) => {
        const target = ref.shape ? catalog.shapes[ref.shape] : undefined;
        return [
          name,
          {
            type: target?.type ?? ref.type,
            location: ref.location,
            locationName: ref.locationName,
            enum: target?.enum,
          },
        ];
      }),
    ),
  };
}
