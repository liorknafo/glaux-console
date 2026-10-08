import { describe, expect, it } from 'vitest';
import { loadServiceCatalog } from '../catalog/loader';
import { fillUriTemplate, serializeRequest, splitRequestUri } from './serialize';

/**
 * Wire serialization, one test per protocol the catalog covers. Expected
 * requests are derived from the service models themselves (the same models the
 * AWS CLI is generated from), not from any emulator's behaviour.
 */

describe('json protocol', () => {
  it('targets the operation and encodes the input as JSON', async () => {
    const sqs = await loadServiceCatalog('sqs');
    const request = serializeRequest(sqs, sqs.operations.SendMessage, {
      QueueUrl: 'http://localhost:4566/000000000000/orders',
      MessageBody: 'hello',
      DelaySeconds: 5,
    });

    expect(request.method).toBe('POST');
    expect(request.path).toBe('/');
    expect(request.headers['x-amz-target']).toBe('AmazonSQS.SendMessage');
    expect(request.headers['content-type']).toBe('application/x-amz-json-1.0');
    expect(JSON.parse(request.body!)).toEqual({
      QueueUrl: 'http://localhost:4566/000000000000/orders',
      MessageBody: 'hello',
      DelaySeconds: 5,
    });
  });

  it('drops empty members rather than sending nulls', async () => {
    const athena = await loadServiceCatalog('athena');
    const request = serializeRequest(athena, athena.operations.StartQueryExecution, {
      QueryString: 'SELECT 1',
      WorkGroup: '',
      ClientRequestToken: undefined,
    });
    expect(JSON.parse(request.body!)).toEqual({ QueryString: 'SELECT 1' });
  });

  it('serializes nested structures and lists', async () => {
    const firehose = await loadServiceCatalog('firehose');
    const request = serializeRequest(firehose, firehose.operations.PutRecordBatch, {
      DeliveryStreamName: 'events',
      Records: [{ Data: 'aGVsbG8=' }, { Data: 'd29ybGQ=' }],
    });
    expect(JSON.parse(request.body!)).toEqual({
      DeliveryStreamName: 'events',
      Records: [{ Data: 'aGVsbG8=' }, { Data: 'd29ybGQ=' }],
    });
  });
});

describe('rest-json protocol', () => {
  it('fills uri labels, query strings and headers from member locations', async () => {
    const lambda = await loadServiceCatalog('lambda');
    const request = serializeRequest(lambda, lambda.operations.Invoke, {
      FunctionName: 'my-function',
      InvocationType: 'RequestResponse',
      Payload: '{"a":1}',
    });

    expect(request.method).toBe('POST');
    expect(request.path).toBe('/2015-03-31/functions/my-function/invocations');
    expect(request.headers['x-amz-invocation-type']).toBe('RequestResponse');
    // Payload is the operation's payload member, so it is the body verbatim.
    expect(request.body).toBe('{"a":1}');
  });

  it('puts non-located members in a JSON body', async () => {
    const logs = await loadServiceCatalog('logs');
    const request = serializeRequest(logs, logs.operations.CreateLogGroup, {
      logGroupName: '/glaux/test',
    });
    expect(JSON.parse(request.body!)).toEqual({ logGroupName: '/glaux/test' });
  });
});

describe('query protocol', () => {
  it('form-encodes the action, version and flattened members', async () => {
    const sts = await loadServiceCatalog('sts');
    const request = serializeRequest(sts, sts.operations.AssumeRole, {
      RoleArn: 'arn:aws:iam::000000000000:role/test',
      RoleSessionName: 'glaux',
      DurationSeconds: 900,
    });

    const params = new URLSearchParams(request.body!);
    expect(params.get('Action')).toBe('AssumeRole');
    expect(params.get('Version')).toBe('2011-06-15');
    expect(params.get('RoleArn')).toBe('arn:aws:iam::000000000000:role/test');
    expect(params.get('DurationSeconds')).toBe('900');
    expect(request.headers['content-type']).toContain('x-www-form-urlencoded');
  });

  it('indexes list members with the model’s member name', async () => {
    const iam = await loadServiceCatalog('iam');
    const request = serializeRequest(iam, iam.operations.CreateRole, {
      RoleName: 'test',
      AssumeRolePolicyDocument: '{}',
      Tags: [{ Key: 'env', Value: 'local' }],
    });
    const params = new URLSearchParams(request.body!);
    expect(params.get('Tags.member.1.Key')).toBe('env');
    expect(params.get('Tags.member.1.Value')).toBe('local');
  });
});

describe('rest-xml protocol', () => {
  it('routes S3 reads through the uri and querystring', async () => {
    const s3 = await loadServiceCatalog('s3');
    const request = serializeRequest(s3, s3.operations.ListObjectsV2, {
      Bucket: 'my-bucket',
      Prefix: 'raw/',
      MaxKeys: 100,
    });

    expect(request.method).toBe('GET');
    expect(request.path).toBe('/my-bucket');
    expect(request.query['list-type']).toBe('2');
    expect(request.query.prefix).toBe('raw/');
    expect(request.query['max-keys']).toBe('100');
    expect(request.body).toBeUndefined();
  });

  it('escapes object keys as path segments', async () => {
    const s3 = await loadServiceCatalog('s3');
    const request = serializeRequest(s3, s3.operations.GetObject, {
      Bucket: 'my-bucket',
      Key: 'year=2026/month=08/file name.parquet',
    });
    expect(request.path).toBe('/my-bucket/year%3D2026/month%3D08/file%20name.parquet');
  });

  it('builds an XML body for operations that take one', async () => {
    const s3 = await loadServiceCatalog('s3');
    const request = serializeRequest(s3, s3.operations.CreateBucket, {
      Bucket: 'my-bucket',
      CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' },
    });
    expect(request.method).toBe('PUT');
    expect(request.path).toBe('/my-bucket');
    expect(request.body).toContain('<LocationConstraint>eu-west-1</LocationConstraint>');
    expect(request.headers['content-type']).toBe('application/xml');
  });
});

describe('request uri helpers', () => {
  it('splits the static query the model bakes into the uri', () => {
    expect(splitRequestUri('/{Bucket}?list-type=2')).toEqual(['/{Bucket}', { 'list-type': '2' }]);
    expect(splitRequestUri('/2015-03-31/functions')).toEqual(['/2015-03-31/functions', {}]);
  });

  it('treats greedy labels as multi-segment paths', () => {
    expect(fillUriTemplate('/{Bucket}/{Key+}', { Bucket: 'b', Key: 'a/b c' })).toBe('/b/a/b%20c');
    expect(fillUriTemplate('/{Name}', { Name: 'a/b' })).toBe('/a%2Fb');
  });
});
