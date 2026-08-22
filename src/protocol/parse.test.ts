import { describe, expect, it } from 'vitest';
import { loadServiceCatalog } from '../catalog/loader';
import { cleanErrorCode, parseResponse } from './parse';
import { ServiceCallError, type WireResponse } from './types';

function response(partial: Partial<WireResponse>): WireResponse {
  return { status: 200, headers: {}, body: '', bodyEncoding: 'utf8', ...partial };
}

describe('json responses', () => {
  it('parses the body into the modelled output', async () => {
    const sqs = await loadServiceCatalog('sqs');
    const output = parseResponse(
      sqs,
      sqs.operations.ListQueues,
      response({ body: JSON.stringify({ QueueUrls: ['http://localhost:4566/q/a'] }) }),
    );
    expect(output).toEqual({ QueueUrls: ['http://localhost:4566/q/a'] });
  });

  it('raises the target’s own error code and message', async () => {
    const sqs = await loadServiceCatalog('sqs');
    expect(() =>
      parseResponse(
        sqs,
        sqs.operations.GetQueueUrl,
        response({
          status: 400,
          body: JSON.stringify({
            __type: 'com.amazonaws.sqs#QueueDoesNotExist',
            message: 'The specified queue does not exist.',
          }),
        }),
      ),
    ).toThrowError(ServiceCallError);

    try {
      parseResponse(
        sqs,
        sqs.operations.GetQueueUrl,
        response({
          status: 400,
          body: JSON.stringify({ __type: 'QueueDoesNotExist', message: 'nope' }),
        }),
      );
    } catch (error) {
      expect((error as ServiceCallError).code).toBe('QueueDoesNotExist');
      expect((error as ServiceCallError).status).toBe(400);
      expect((error as ServiceCallError).message).toBe('nope');
    }
  });
});

describe('xml responses', () => {
  it('walks the output shape, including flattened lists', async () => {
    const s3 = await loadServiceCatalog('s3');
    const output = parseResponse(
      s3,
      s3.operations.ListObjectsV2,
      response({
        body: `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <Name>my-bucket</Name>
            <KeyCount>2</KeyCount>
            <IsTruncated>false</IsTruncated>
            <Contents><Key>a.parquet</Key><Size>120</Size></Contents>
            <Contents><Key>b.parquet</Key><Size>240</Size></Contents>
          </ListBucketResult>`,
      }),
    ) as Record<string, unknown>;

    expect(output.Name).toBe('my-bucket');
    expect(output.KeyCount).toBe(2);
    expect(output.IsTruncated).toBe(false);
    expect(output.Contents).toEqual([
      { Key: 'a.parquet', Size: 120 },
      { Key: 'b.parquet', Size: 240 },
    ]);
  });

  it('unwraps the query protocol’s result element', async () => {
    const sts = await loadServiceCatalog('sts');
    const output = parseResponse(
      sts,
      sts.operations.GetCallerIdentity,
      response({
        body: `<GetCallerIdentityResponse>
            <GetCallerIdentityResult>
              <Arn>arn:aws:iam::000000000000:root</Arn>
              <Account>000000000000</Account>
              <UserId>AKIAI</UserId>
            </GetCallerIdentityResult>
            <ResponseMetadata><RequestId>1</RequestId></ResponseMetadata>
          </GetCallerIdentityResponse>`,
      }),
    );
    expect(output).toEqual({
      Arn: 'arn:aws:iam::000000000000:root',
      Account: '000000000000',
      UserId: 'AKIAI',
    });
  });

  it('reads non-flattened lists through their member element', async () => {
    const iam = await loadServiceCatalog('iam');
    const output = parseResponse(
      iam,
      iam.operations.ListRoles,
      response({
        body: `<ListRolesResponse><ListRolesResult>
            <IsTruncated>false</IsTruncated>
            <Roles>
              <member><RoleName>alpha</RoleName><Path>/</Path></member>
              <member><RoleName>beta</RoleName><Path>/</Path></member>
            </Roles>
          </ListRolesResult></ListRolesResponse>`,
      }),
    ) as Record<string, unknown>;

    expect((output.Roles as Record<string, unknown>[]).map(role => role.RoleName)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('raises the XML error document', async () => {
    const s3 = await loadServiceCatalog('s3');
    try {
      parseResponse(
        s3,
        s3.operations.GetObject,
        response({
          status: 404,
          body: '<Error><Code>NoSuchKey</Code><Message>The key does not exist.</Message></Error>',
        }),
      );
      expect.unreachable('parseResponse should have thrown');
    } catch (error) {
      expect((error as ServiceCallError).code).toBe('NoSuchKey');
      expect((error as ServiceCallError).message).toBe('The key does not exist.');
    }
  });
});

describe('header-located output members', () => {
  it('merges headers into the parsed output', async () => {
    const s3 = await loadServiceCatalog('s3');
    const output = parseResponse(
      s3,
      s3.operations.HeadObject,
      response({ headers: { 'content-type': 'application/parquet', etag: '"abc"' } }),
    ) as Record<string, unknown>;
    expect(output.ContentType).toBe('application/parquet');
    expect(output.ETag).toBe('"abc"');
  });
});

describe('cleanErrorCode', () => {
  it('strips the Smithy namespace and any trailing detail', () => {
    expect(cleanErrorCode('com.amazonaws.athena#InvalidRequestException')).toBe(
      'InvalidRequestException',
    );
    expect(cleanErrorCode('ResourceNotFoundException:')).toBe('ResourceNotFoundException');
    expect(cleanErrorCode('ThrottlingException')).toBe('ThrottlingException');
  });
});
