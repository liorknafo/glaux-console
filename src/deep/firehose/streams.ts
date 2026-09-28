import { callOperation } from '../../api/client';
import type { Operation, ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';

/**
 * The Firehose data layer: delivery streams, their destinations, and putting
 * test records.
 *
 * A `DestinationDescription` carries one member per destination kind and fills
 * in exactly the one the stream uses, so reading it means finding which member
 * is present rather than assuming S3.
 */

export interface BufferingHints {
  sizeInMBs?: number;
  intervalInSeconds?: number;
}

export interface StreamDestination {
  id: string;
  /** `ExtendedS3`, `S3`, `Redshift`, … — the member the description filled in. */
  kind: string;
  bucketArn?: string;
  prefix?: string;
  errorOutputPrefix?: string;
  compressionFormat?: string;
  roleArn?: string;
  fileExtension?: string;
  s3BackupMode?: string;
  bufferingHints: BufferingHints;
  cloudWatchLogGroup?: string;
  encryption?: string;
  /** True when the destination writes to S3 and so has objects to browse. */
  writesToS3: boolean;
}

export interface DeliveryStream {
  name: string;
  arn?: string;
  status?: string;
  type?: string;
  versionId?: string;
  createTimestamp?: unknown;
  lastUpdateTimestamp?: unknown;
  failureDescription?: string;
  sourceKinesisStreamArn?: string;
  destinations: StreamDestination[];
}

export interface PutResult {
  requested: number;
  failed: number;
  /** The first error the target reported, when any record failed. */
  firstError?: string;
  recordIds: string[];
}

/**
 * Destination members, in the order the console reports them. Each entry is a
 * `DestinationDescription` member name in the Firehose model.
 */
const DESTINATION_MEMBERS: { member: string; kind: string; s3: boolean }[] = [
  { member: 'ExtendedS3DestinationDescription', kind: 'ExtendedS3', s3: true },
  { member: 'S3DestinationDescription', kind: 'S3', s3: true },
  { member: 'RedshiftDestinationDescription', kind: 'Redshift', s3: false },
  { member: 'ElasticsearchDestinationDescription', kind: 'Elasticsearch', s3: false },
  {
    member: 'AmazonopensearchserviceDestinationDescription',
    kind: 'OpenSearch',
    s3: false,
  },
  {
    member: 'AmazonOpenSearchServerlessDestinationDescription',
    kind: 'OpenSearch Serverless',
    s3: false,
  },
  { member: 'SplunkDestinationDescription', kind: 'Splunk', s3: false },
  { member: 'HttpEndpointDestinationDescription', kind: 'HTTP endpoint', s3: false },
  { member: 'SnowflakeDestinationDescription', kind: 'Snowflake', s3: false },
  { member: 'IcebergDestinationDescription', kind: 'Iceberg', s3: false },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function readBufferingHints(value: unknown): BufferingHints {
  const hints = asRecord(value);
  return {
    sizeInMBs: asNumber(hints?.SizeInMBs),
    intervalInSeconds: asNumber(hints?.IntervalInSeconds),
  };
}

export function readDestinations(value: unknown): StreamDestination[] {
  return asArray(value).flatMap<StreamDestination>((entry, index) => {
    const description = asRecord(entry);
    if (!description) return [];
    const id = asString(description.DestinationId) ?? `destination-${index + 1}`;
    const found = DESTINATION_MEMBERS.find(candidate => asRecord(description[candidate.member]));
    if (!found) {
      // A destination kind this console does not know is still a destination;
      // reporting it as unknown beats dropping the stream's only output.
      return [{ id, kind: 'Unknown', bufferingHints: {}, writesToS3: false }];
    }
    const config = asRecord(description[found.member]) ?? {};
    const backup = asRecord(config.S3BackupDescription);
    return [
      {
        id,
        kind: found.kind,
        // A non-S3 destination still backs up to S3, and that is where its
        // objects are.
        bucketArn: asString(config.BucketARN) ?? asString(backup?.BucketARN),
        prefix: asString(config.Prefix) ?? asString(backup?.Prefix),
        errorOutputPrefix:
          asString(config.ErrorOutputPrefix) ?? asString(backup?.ErrorOutputPrefix),
        compressionFormat: asString(config.CompressionFormat),
        roleArn: asString(config.RoleARN),
        fileExtension: asString(config.FileExtension),
        s3BackupMode: asString(config.S3BackupMode),
        bufferingHints: readBufferingHints(config.BufferingHints ?? backup?.BufferingHints),
        cloudWatchLogGroup: asString(asRecord(config.CloudWatchLoggingOptions)?.LogGroupName),
        encryption: asString(
          asRecord(asRecord(config.EncryptionConfiguration)?.KMSEncryptionConfig)?.AWSKMSKeyARN,
        ),
        writesToS3: found.s3 || Boolean(backup?.BucketARN),
      },
    ];
  });
}

export function readStream(output: unknown): DeliveryStream | undefined {
  const description = asRecord(asRecord(output)?.DeliveryStreamDescription);
  const name = asString(description?.DeliveryStreamName);
  if (!description || !name) return undefined;
  const source = asRecord(description.Source);
  return {
    name,
    arn: asString(description.DeliveryStreamARN),
    status: asString(description.DeliveryStreamStatus),
    type: asString(description.DeliveryStreamType),
    versionId: asString(description.VersionId),
    createTimestamp: description.CreateTimestamp,
    lastUpdateTimestamp: description.LastUpdateTimestamp,
    failureDescription: asString(asRecord(description.FailureDescription)?.Details),
    sourceKinesisStreamArn: asString(
      asRecord(source?.KinesisStreamSourceDescription)?.KinesisStreamARN,
    ),
    destinations: readDestinations(description.Destinations),
  };
}

export function readStreamNames(output: unknown): {
  names: string[];
  hasMore: boolean;
} {
  const record = asRecord(output);
  return {
    names: asArray(record?.DeliveryStreamNames).filter(
      (entry): entry is string => typeof entry === 'string',
    ),
    hasMore: record?.HasMoreDeliveryStreams === true,
  };
}

export function readPutResult(output: unknown, requested: number): PutResult {
  const record = asRecord(output);
  const responses = asArray(record?.RequestResponses).flatMap(entry => {
    const response = asRecord(entry);
    return response ? [response] : [];
  });
  const failed =
    asNumber(record?.FailedPutCount) ??
    responses.filter(response => asString(response.ErrorCode)).length;
  const firstFailure = responses.find(response => asString(response.ErrorCode));
  const singleRecordId = asString(record?.RecordId);
  return {
    requested,
    failed,
    firstError: firstFailure
      ? `${asString(firstFailure.ErrorCode) ?? 'Error'}: ${asString(firstFailure.ErrorMessage) ?? 'no message'}`
      : undefined,
    recordIds: singleRecordId
      ? [singleRecordId]
      : responses.flatMap(response => {
          const id = asString(response.RecordId);
          return id ? [id] : [];
        }),
  };
}

function operation(catalog: ServiceCatalog, name: string): Operation {
  const found = catalog.operations[name];
  if (!found) throw new Error(`The Firehose model has no ${name} operation`);
  return found;
}

/**
 * Every delivery stream on the target.
 *
 * `ListDeliveryStreams` pages by the last name returned rather than by a token,
 * so the loop continues from `ExclusiveStartDeliveryStreamName`.
 */
export async function fetchStreamNames(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  signal?: AbortSignal,
): Promise<string[]> {
  const list = operation(catalog, 'ListDeliveryStreams');
  const collected: string[] = [];
  let start: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const input = start ? { ExclusiveStartDeliveryStreamName: start } : {};
    const result = await callOperation(endpoint, catalog, list, input, signal);
    const { names, hasMore } = readStreamNames(result.output);
    collected.push(...names);
    const last = names[names.length - 1];
    if (!hasMore || !last || last === start) break;
    start = last;
  }
  return collected;
}

export async function describeStream(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  name: string,
  signal?: AbortSignal,
): Promise<DeliveryStream | undefined> {
  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'DescribeDeliveryStream'),
    { DeliveryStreamName: name },
    signal,
  );
  return readStream(result.output);
}

/** Firehose record data is a blob member, so it travels base64. */
export function encodeRecord(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Splits a test payload into records, one per line.
 *
 * Firehose does not add a record separator, so a JSON-lines destination needs
 * each record to end in a newline; that is what the caller asks for with
 * `appendNewline`, and it is on by default because it is what a Firehose ->
 * S3 -> Athena pipeline needs to be readable.
 */
export function splitRecords(text: string, appendNewline = true): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => (appendNewline ? `${line}\n` : line));
}

export async function putRecords(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  name: string,
  records: string[],
  signal?: AbortSignal,
): Promise<PutResult> {
  if (records.length === 0) return { requested: 0, failed: 0, recordIds: [] };

  if (records.length === 1) {
    const result = await callOperation(
      endpoint,
      catalog,
      operation(catalog, 'PutRecord'),
      { DeliveryStreamName: name, Record: { Data: encodeRecord(records[0]) } },
      signal,
    );
    return readPutResult(result.output, 1);
  }

  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'PutRecordBatch'),
    {
      DeliveryStreamName: name,
      Records: records.map(record => ({ Data: encodeRecord(record) })),
    },
    signal,
  );
  return readPutResult(result.output, records.length);
}

/**
 * The part of a Firehose prefix that is a literal S3 prefix.
 *
 * Prefixes carry expressions — `!{timestamp:yyyy/MM/dd}`,
 * `!{firehose:error-output-type}` — that Firehose expands per object. Only the
 * text before the first expression can be listed, so that is what is used, cut
 * back to the last delimiter so a partial path segment does not match keys the
 * stream never wrote.
 */
export function staticPrefixOf(prefix: string | undefined): string {
  if (!prefix) return '';
  const marker = prefix.indexOf('!{');
  if (marker === -1) return prefix;
  const literal = prefix.slice(0, marker);
  const lastSlash = literal.lastIndexOf('/');
  return lastSlash === -1 ? '' : literal.slice(0, lastSlash + 1);
}
