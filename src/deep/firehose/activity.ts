import type { ObjectSummary } from '../s3/objects';

/**
 * Reading the delivery evidence out of an S3 listing.
 *
 * Firehose reports no delivery metrics of its own without CloudWatch, so the
 * activity panel reads the destination bucket instead. These are the pure parts
 * of that: what one listing returned, and how to present it.
 */

export interface ObjectListing {
  objects: ObjectSummary[];
  truncated: boolean;
}

/** Newest first within the page fetched — S3 lists keys in key order. */
export function byNewest(objects: ObjectSummary[]): ObjectSummary[] {
  return [...objects].sort((a, b) => {
    const left = a.lastModified ? Date.parse(a.lastModified) : Number.NaN;
    const right = b.lastModified ? Date.parse(b.lastModified) : Number.NaN;
    if (Number.isNaN(left) && Number.isNaN(right)) return a.key.localeCompare(b.key);
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
}

export function totalBytes(objects: ObjectSummary[]): number {
  return objects.reduce((sum, object) => sum + (object.size ?? 0), 0);
}

/** The prefix a key sits in, which is where the browser should open. */
export function prefixOfKey(key: string): string {
  const index = key.lastIndexOf('/');
  return index === -1 ? '' : key.slice(0, index + 1);
}
