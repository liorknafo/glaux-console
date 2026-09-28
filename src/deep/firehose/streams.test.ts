import { describe, expect, it } from 'vitest';
import {
  encodeRecord,
  readDestinations,
  readPutResult,
  readStream,
  readStreamNames,
  splitRecords,
  staticPrefixOf,
} from './streams';

/**
 * Fixtures are the shapes the Firehose model declares for
 * `DescribeDeliveryStream`, `ListDeliveryStreams` and the put operations.
 */

const EXTENDED_S3 = {
  DeliveryStreamDescription: {
    DeliveryStreamName: 'orders-to-lake',
    DeliveryStreamARN: 'arn:aws:firehose:us-east-1:000000000000:deliverystream/orders-to-lake',
    DeliveryStreamStatus: 'ACTIVE',
    DeliveryStreamType: 'DirectPut',
    VersionId: '1',
    CreateTimestamp: 1_756_000_000,
    Destinations: [
      {
        DestinationId: 'destinationId-000000000001',
        ExtendedS3DestinationDescription: {
          RoleARN: 'arn:aws:iam::000000000000:role/firehose',
          BucketARN: 'arn:aws:s3:::lake',
          Prefix: 'orders/!{timestamp:yyyy/MM/dd}/',
          ErrorOutputPrefix: 'errors/!{firehose:error-output-type}/',
          BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 60 },
          CompressionFormat: 'GZIP',
          FileExtension: '.json.gz',
          S3BackupMode: 'Disabled',
          CloudWatchLoggingOptions: { Enabled: true, LogGroupName: '/aws/firehose/orders' },
        },
      },
    ],
  },
};

describe('readStream', () => {
  it('reads a stream and its S3 destination', () => {
    const stream = readStream(EXTENDED_S3);
    expect(stream?.name).toBe('orders-to-lake');
    expect(stream?.status).toBe('ACTIVE');
    expect(stream?.type).toBe('DirectPut');
    expect(stream?.destinations).toHaveLength(1);

    const [destination] = stream?.destinations ?? [];
    expect(destination.kind).toBe('ExtendedS3');
    expect(destination.bucketArn).toBe('arn:aws:s3:::lake');
    expect(destination.prefix).toBe('orders/!{timestamp:yyyy/MM/dd}/');
    expect(destination.errorOutputPrefix).toBe('errors/!{firehose:error-output-type}/');
    expect(destination.bufferingHints).toEqual({ sizeInMBs: 5, intervalInSeconds: 60 });
    expect(destination.compressionFormat).toBe('GZIP');
    expect(destination.cloudWatchLogGroup).toBe('/aws/firehose/orders');
    expect(destination.writesToS3).toBe(true);
  });

  it('reads a Kinesis-sourced stream’s source', () => {
    const stream = readStream({
      DeliveryStreamDescription: {
        DeliveryStreamName: 's',
        DeliveryStreamType: 'KinesisStreamAsSource',
        Source: {
          KinesisStreamSourceDescription: {
            KinesisStreamARN: 'arn:aws:kinesis:us-east-1:000000000000:stream/events',
          },
        },
      },
    });
    expect(stream?.sourceKinesisStreamArn).toBe(
      'arn:aws:kinesis:us-east-1:000000000000:stream/events',
    );
  });

  it('reports a failure description the target attached', () => {
    const stream = readStream({
      DeliveryStreamDescription: {
        DeliveryStreamName: 's',
        DeliveryStreamStatus: 'CREATING_FAILED',
        FailureDescription: { Type: 'CREATE_ENI_FAILED', Details: 'no subnet' },
      },
    });
    expect(stream?.failureDescription).toBe('no subnet');
  });

  it('returns nothing for a response that describes no stream', () => {
    expect(readStream({})).toBeUndefined();
    expect(readStream(null)).toBeUndefined();
  });
});

describe('readDestinations', () => {
  it('finds whichever destination member the description filled in', () => {
    const [destination] = readDestinations([
      {
        DestinationId: 'd-1',
        RedshiftDestinationDescription: {
          RoleARN: 'arn:aws:iam::000000000000:role/redshift',
          S3BackupDescription: {
            BucketARN: 'arn:aws:s3:::backup',
            Prefix: 'redshift-backup/',
            BufferingHints: { SizeInMBs: 1, IntervalInSeconds: 60 },
          },
        },
      },
    ]);
    expect(destination.kind).toBe('Redshift');
    // A non-S3 destination still writes its backup to S3, and that is where
    // its objects are.
    expect(destination.bucketArn).toBe('arn:aws:s3:::backup');
    expect(destination.writesToS3).toBe(true);
  });

  it('reports a destination kind it does not recognise rather than dropping it', () => {
    const [destination] = readDestinations([
      { DestinationId: 'd-1', SomeFutureDestinationDescription: { Endpoint: 'x' } },
    ]);
    expect(destination.kind).toBe('Unknown');
    expect(destination.writesToS3).toBe(false);
  });

  it('names a destination that reports no id', () => {
    const [destination] = readDestinations([{ S3DestinationDescription: {} }]);
    expect(destination.id).toBe('destination-1');
  });
});

describe('readStreamNames', () => {
  it('reads the names and whether more remain', () => {
    expect(
      readStreamNames({ DeliveryStreamNames: ['a', 'b'], HasMoreDeliveryStreams: true }),
    ).toEqual({ names: ['a', 'b'], hasMore: true });
    expect(readStreamNames({})).toEqual({ names: [], hasMore: false });
  });
});

describe('readPutResult', () => {
  it('reads a single PutRecord response', () => {
    expect(readPutResult({ RecordId: 'r-1', Encrypted: false }, 1)).toEqual({
      requested: 1,
      failed: 0,
      firstError: undefined,
      recordIds: ['r-1'],
    });
  });

  it('reports the first failure in a batch', () => {
    const result = readPutResult(
      {
        FailedPutCount: 1,
        RequestResponses: [
          { RecordId: 'r-1' },
          { ErrorCode: 'ServiceUnavailableException', ErrorMessage: 'slow down' },
        ],
      },
      2,
    );
    expect(result.failed).toBe(1);
    expect(result.firstError).toBe('ServiceUnavailableException: slow down');
    expect(result.recordIds).toEqual(['r-1']);
  });

  it('counts failures itself when the target reports no count', () => {
    const result = readPutResult({ RequestResponses: [{ ErrorCode: 'Throttled' }] }, 1);
    expect(result.failed).toBe(1);
  });
});

describe('splitRecords', () => {
  it('makes one record per line and terminates each with a newline', () => {
    expect(splitRecords('{"a":1}\n\n  {"a":2}  \n')).toEqual(['{"a":1}\n', '{"a":2}\n']);
  });

  it('leaves records unterminated when asked', () => {
    expect(splitRecords('a\nb', false)).toEqual(['a', 'b']);
  });

  it('makes no records out of blank input', () => {
    expect(splitRecords('   \n\n')).toEqual([]);
  });
});

describe('encodeRecord', () => {
  it('base64-encodes the record’s UTF-8 bytes', () => {
    expect(encodeRecord('hello')).toBe(btoa('hello'));
    // A multi-byte character must not go through btoa directly, which throws.
    expect(encodeRecord('héllo')).toBe(
      btoa(String.fromCharCode(...new TextEncoder().encode('héllo'))),
    );
  });
});

describe('staticPrefixOf', () => {
  it('keeps only the literal part of a prefix, cut at the last delimiter', () => {
    expect(staticPrefixOf('orders/!{timestamp:yyyy/MM/dd}/')).toBe('orders/');
    expect(staticPrefixOf('errors/!{firehose:error-output-type}/')).toBe('errors/');
    // A partial segment before the expression would match keys the stream
    // never wrote, so it is cut back to the delimiter.
    expect(staticPrefixOf('data/raw-!{timestamp:yyyy}/')).toBe('data/');
    expect(staticPrefixOf('!{timestamp:yyyy}/')).toBe('');
  });

  it('passes a prefix with no expression through unchanged', () => {
    expect(staticPrefixOf('orders/')).toBe('orders/');
    expect(staticPrefixOf(undefined)).toBe('');
  });
});
