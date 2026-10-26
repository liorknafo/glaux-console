/**
 * Cross-screen handoffs.
 *
 * One hand-built screen sometimes has to open another with something already
 * prepared: Glue's "Query this table" opens the Athena editor with a statement
 * in it, and Firehose's delivery activity opens the S3 browser at the prefix
 * the stream writes to. Routing carries the service, not the payload, so the
 * payload is parked here and picked up by the screen that mounts next.
 *
 * Reading is deliberately split into `peek` and `clear`: a screen reads the
 * pending value while rendering and clears it once mounted, so React calling a
 * state initialiser more than once (as StrictMode does) cannot lose it.
 */

export interface AthenaHandoff {
  sql: string;
  database?: string;
  catalog?: string;
}

export interface S3Handoff {
  bucket: string;
  prefix?: string;
}

let pendingAthenaQuery: AthenaHandoff | undefined;
let pendingS3Location: S3Handoff | undefined;

export function stashAthenaQuery(handoff: AthenaHandoff): void {
  pendingAthenaQuery = handoff;
}

export function peekAthenaQuery(): AthenaHandoff | undefined {
  return pendingAthenaQuery;
}

export function clearAthenaQuery(): void {
  pendingAthenaQuery = undefined;
}

export function stashS3Location(handoff: S3Handoff): void {
  pendingS3Location = handoff;
}

export function peekS3Location(): S3Handoff | undefined {
  return pendingS3Location;
}

export function clearS3Location(): void {
  pendingS3Location = undefined;
}
