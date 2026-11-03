import { sendWireRequest } from '../../api/client';
import { loadServiceCatalog } from '../../catalog/loader';
import type { Operation, ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';
import { parseResponse } from '../../protocol/parse';
import { serializeRequest } from '../../protocol/serialize';
import type { WireResponse } from '../../protocol/types';

/**
 * The S3 data layer: buckets, a delimiter-based prefix listing, and the four
 * object operations the browser screen needs.
 *
 * Everything here goes through the generated S3 catalog and the shared request
 * path, so the screen sends exactly what the S3 model declares — path-style
 * `/{Bucket}/{Key+}` against the target, never a hand-written URL.
 *
 * Two operations bypass `callOperation` and read the wire response directly:
 * `GetObject` and `HeadObject`. A downloaded object's bytes are the response
 * body, and whether those bytes are text or base64 is a property of the
 * transport that `callOperation` does not surface.
 */

export interface BucketSummary {
  name: string;
  creationDate?: string;
}

export interface ObjectSummary {
  key: string;
  size?: number;
  lastModified?: string;
  storageClass?: string;
  etag?: string;
}

export interface Listing {
  /** Sub-"folders": `CommonPrefixes` under the requested prefix. */
  prefixes: string[];
  objects: ObjectSummary[];
  nextToken?: string;
  truncated: boolean;
}

export interface ObjectMetadata {
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  etag?: string;
  storageClass?: string;
  versionId?: string;
  cacheControl?: string;
  contentEncoding?: string;
  serverSideEncryption?: string;
  /** `x-amz-meta-*` entries, which S3 models as a map member. */
  userMetadata: Record<string, string>;
}

export interface DownloadedObject {
  /** The object's bytes, as the backend encoded them. */
  body: string;
  encoding: 'utf8' | 'base64';
  contentType?: string;
}

export const DELIMITER = '/';

/** One page of a listing; the screen pages with the service's own token. */
export const PAGE_SIZE = 100;

export function loadS3Catalog(): Promise<ServiceCatalog> {
  return loadServiceCatalog('s3');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
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

export function readBuckets(output: unknown): BucketSummary[] {
  return asArray(asRecord(output)?.Buckets).flatMap<BucketSummary>(entry => {
    const bucket = asRecord(entry);
    const name = asString(bucket?.Name);
    if (!name) return [];
    return [{ name, creationDate: asString(bucket?.CreationDate) }];
  });
}

export function readListing(output: unknown): Listing {
  const record = asRecord(output);
  const prefixes = asArray(record?.CommonPrefixes).flatMap<string>(entry => {
    const prefix = asString(asRecord(entry)?.Prefix);
    return prefix ? [prefix] : [];
  });
  const objects = asArray(record?.Contents).flatMap<ObjectSummary>(entry => {
    const object = asRecord(entry);
    const key = asString(object?.Key);
    if (!key) return [];
    return [
      {
        key,
        size: asNumber(object?.Size),
        lastModified: asString(object?.LastModified),
        storageClass: asString(object?.StorageClass),
        etag: asString(object?.ETag),
      },
    ];
  });
  return {
    prefixes,
    objects,
    nextToken: asString(record?.NextContinuationToken),
    truncated: record?.IsTruncated === true || record?.IsTruncated === 'true',
  };
}

function operation(catalog: ServiceCatalog, name: string): Operation {
  const found = catalog.operations[name];
  if (!found) throw new Error(`The S3 model has no ${name} operation`);
  return found;
}

/** Send one operation and hand back the wire response as well as the output. */
async function send(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  operationName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ output: unknown; response: WireResponse }> {
  const op = operation(catalog, operationName);
  const request = serializeRequest(catalog, op, input);
  const response = await sendWireRequest(endpoint, request, catalog.metadata.signingName, signal);
  return { output: parseResponse(catalog, op, response), response };
}

/**
 * Every bucket on the target.
 *
 * `ListBuckets` gained a continuation token in 2024, so the listing is followed
 * to the end; a target that does not implement paging simply returns none.
 */
export async function fetchBuckets(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  signal?: AbortSignal,
): Promise<BucketSummary[]> {
  const collected: BucketSummary[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const input = token ? { ContinuationToken: token } : {};
    const { output } = await send(endpoint, catalog, 'ListBuckets', input, signal);
    collected.push(...readBuckets(output));
    const next = asString(asRecord(output)?.ContinuationToken);
    if (!next || next === token) break;
    token = next;
  }
  return collected;
}

/**
 * One page of a prefix listing.
 *
 * The delimiter is what turns a flat key space into a browsable tree: S3
 * returns keys directly under the prefix as `Contents` and everything deeper
 * collapsed into `CommonPrefixes`.
 */
export async function listObjects(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  request: { bucket: string; prefix?: string; token?: string; delimited?: boolean },
  signal?: AbortSignal,
): Promise<Listing> {
  const input: Record<string, unknown> = {
    Bucket: request.bucket,
    MaxKeys: PAGE_SIZE,
  };
  if (request.delimited !== false) input.Delimiter = DELIMITER;
  if (request.prefix) input.Prefix = request.prefix;
  if (request.token) input.ContinuationToken = request.token;
  const { output } = await send(endpoint, catalog, 'ListObjectsV2', input, signal);
  return readListing(output);
}

export async function headObject(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  bucket: string,
  key: string,
  signal?: AbortSignal,
): Promise<ObjectMetadata> {
  const { output, response } = await send(
    endpoint,
    catalog,
    'HeadObject',
    { Bucket: bucket, Key: key },
    signal,
  );
  const record = asRecord(output) ?? {};
  // `HeadObject` answers entirely in headers. The parse layer lifts the
  // modelled ones onto the output; `x-amz-meta-*` is a `headers`-location map,
  // which it does not, so it is read off the response here.
  const userMetadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.startsWith('x-amz-meta-')) userMetadata[name.slice('x-amz-meta-'.length)] = value;
  }
  return {
    contentType: asString(record.ContentType),
    contentLength: asNumber(record.ContentLength),
    lastModified: asString(record.LastModified),
    etag: asString(record.ETag),
    storageClass: asString(record.StorageClass),
    versionId: asString(record.VersionId),
    cacheControl: asString(record.CacheControl),
    contentEncoding: asString(record.ContentEncoding),
    serverSideEncryption: asString(record.ServerSideEncryption),
    userMetadata,
  };
}

export async function getObject(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  bucket: string,
  key: string,
  signal?: AbortSignal,
): Promise<DownloadedObject> {
  const { response } = await send(
    endpoint,
    catalog,
    'GetObject',
    { Bucket: bucket, Key: key },
    signal,
  );
  return {
    body: response.body,
    encoding: response.bodyEncoding,
    contentType: response.headers['content-type'],
  };
}

export async function putObject(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  request: { bucket: string; key: string; body: string; contentType?: string },
  signal?: AbortSignal,
): Promise<void> {
  await send(
    endpoint,
    catalog,
    'PutObject',
    {
      Bucket: request.bucket,
      Key: request.key,
      // `Body` is the modelled blob payload, so it travels base64.
      Body: request.body,
      ContentType: request.contentType,
    },
    signal,
  );
}

export async function deleteObject(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  bucket: string,
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  await send(endpoint, catalog, 'DeleteObject', { Bucket: bucket, Key: key }, signal);
}

/* -------------------------------------------------------------- key paths */

/** The name a key or prefix shows under the prefix currently being browsed. */
export function displayName(keyOrPrefix: string, prefix: string): string {
  const relative = keyOrPrefix.startsWith(prefix) ? keyOrPrefix.slice(prefix.length) : keyOrPrefix;
  return relative === '' ? keyOrPrefix : relative;
}

export interface Crumb {
  label: string;
  prefix: string;
}

/** Breadcrumb trail for a prefix, rooted at the bucket. */
export function prefixCrumbs(bucket: string, prefix: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: bucket, prefix: '' }];
  let walked = '';
  for (const segment of prefix.split(DELIMITER).filter(part => part !== '')) {
    walked = `${walked}${segment}${DELIMITER}`;
    crumbs.push({ label: segment, prefix: walked });
  }
  return crumbs;
}

/** `s3://bucket/prefix` and `arn:aws:s3:::bucket` both name a bucket. */
export function bucketFromLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const uri = /^s3:\/\/([^/]+)/i.exec(location);
  if (uri) return uri[1];
  const arn = /^arn:[^:]*:s3:[^:]*:[^:]*:([^/]+)/i.exec(location);
  if (arn) return arn[1];
  return undefined;
}
