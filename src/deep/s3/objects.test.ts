import { describe, expect, it } from 'vitest';
import { bucketFromLocation, displayName, prefixCrumbs, readBuckets, readListing } from './objects';

/**
 * The readers work on what the S3 model says those operations return — an XML
 * body already turned into a plain object by the parse layer, so the fixtures
 * here are the shapes `ListBuckets` and `ListObjectsV2` declare.
 */

describe('readBuckets', () => {
  it('reads the bucket list', () => {
    expect(
      readBuckets({
        Buckets: [{ Name: 'lake', CreationDate: '2026-08-01T00:00:00Z' }, { Name: 'staging' }],
      }),
    ).toEqual([
      { name: 'lake', creationDate: '2026-08-01T00:00:00Z' },
      { name: 'staging', creationDate: undefined },
    ]);
  });

  it('skips an entry with no name rather than rendering a nameless row', () => {
    expect(readBuckets({ Buckets: [{ CreationDate: 'x' }] })).toEqual([]);
    expect(readBuckets({})).toEqual([]);
    expect(readBuckets(undefined)).toEqual([]);
  });
});

describe('readListing', () => {
  it('separates common prefixes from objects', () => {
    const listing = readListing({
      CommonPrefixes: [{ Prefix: 'orders/dt=2026-08-01/' }, { Prefix: 'orders/dt=2026-08-02/' }],
      Contents: [
        {
          Key: 'orders/manifest.json',
          Size: 2048,
          LastModified: '2026-08-24T09:00:00Z',
          StorageClass: 'STANDARD',
          ETag: '"abc"',
        },
      ],
      IsTruncated: true,
      NextContinuationToken: 'token-2',
    });

    expect(listing.prefixes).toEqual(['orders/dt=2026-08-01/', 'orders/dt=2026-08-02/']);
    expect(listing.objects).toEqual([
      {
        key: 'orders/manifest.json',
        size: 2048,
        lastModified: '2026-08-24T09:00:00Z',
        storageClass: 'STANDARD',
        etag: '"abc"',
      },
    ]);
    expect(listing.truncated).toBe(true);
    expect(listing.nextToken).toBe('token-2');
  });

  it('reads a size the XML parse left as text', () => {
    expect(readListing({ Contents: [{ Key: 'a', Size: '17' }] }).objects[0].size).toBe(17);
  });

  it('treats a listing with neither member as empty, not as a failure', () => {
    const listing = readListing({ IsTruncated: false });
    expect(listing).toEqual({
      prefixes: [],
      objects: [],
      nextToken: undefined,
      truncated: false,
    });
  });
});

describe('key paths', () => {
  it('shows a key relative to the prefix being browsed', () => {
    expect(displayName('orders/dt=1/part-0.parquet', 'orders/')).toBe('dt=1/part-0.parquet');
    expect(displayName('orders/', 'orders/')).toBe('orders/');
    expect(displayName('top.json', '')).toBe('top.json');
  });

  it('builds a breadcrumb trail rooted at the bucket', () => {
    expect(prefixCrumbs('lake', 'orders/dt=1/')).toEqual([
      { label: 'lake', prefix: '' },
      { label: 'orders', prefix: 'orders/' },
      { label: 'dt=1', prefix: 'orders/dt=1/' },
    ]);
    expect(prefixCrumbs('lake', '')).toEqual([{ label: 'lake', prefix: '' }]);
  });
});

describe('bucketFromLocation', () => {
  it('reads a bucket out of the two forms other services name one by', () => {
    expect(bucketFromLocation('s3://lake/orders/')).toBe('lake');
    expect(bucketFromLocation('arn:aws:s3:::lake')).toBe('lake');
    expect(bucketFromLocation('arn:aws:s3:::lake/prefix')).toBe('lake');
  });

  it('reports nothing rather than guessing at an unrecognised location', () => {
    expect(bucketFromLocation('hdfs://lake/orders')).toBeUndefined();
    expect(bucketFromLocation(undefined)).toBeUndefined();
  });
});
