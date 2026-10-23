/**
 * Types for the generated service catalog.
 *
 * These mirror the compact subset of botocore's model that
 * `scripts/generate-catalog.mjs` emits. Shape references are by name into
 * `ServiceCatalog.shapes`; nested members carry the wire traits that matter
 * for serialization (`location`, `locationName`, `flattened`, ...).
 */

export type ShapeType =
  | 'structure'
  | 'list'
  | 'map'
  | 'string'
  | 'integer'
  | 'long'
  | 'float'
  | 'double'
  | 'boolean'
  | 'timestamp'
  | 'blob';

export type MemberLocation = 'uri' | 'querystring' | 'header' | 'headers' | 'statusCode';

export interface ShapeRef {
  /** Name of the target shape in `ServiceCatalog.shapes`. Absent on inline scalars. */
  shape?: string;
  type?: ShapeType;
  location?: MemberLocation;
  locationName?: string;
  queryName?: string;
  flattened?: boolean;
  streaming?: boolean;
  idempotencyToken?: boolean;
  timestampFormat?: 'iso8601' | 'unixTimestamp' | 'rfc822';
  xmlNamespace?: string;
  xmlAttribute?: boolean;
  resultWrapper?: string;
  deprecated?: boolean;
  sensitive?: boolean;
  jsonvalue?: boolean;
  doc?: string;
}

export interface Shape extends ShapeRef {
  type: ShapeType;
  members?: Record<string, ShapeRef>;
  required?: string[];
  member?: ShapeRef;
  key?: ShapeRef;
  value?: ShapeRef;
  enum?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  payload?: string;
  union?: boolean;
  document?: boolean;
}

export type OperationClassification =
  'list' | 'describe' | 'create' | 'update' | 'delete' | 'other';

export interface Pagination {
  inputToken?: string;
  outputToken?: string;
  limitKey?: string;
  resultKey?: string;
}

export interface Operation {
  name: string;
  http: { method: string; requestUri: string };
  input?: string;
  output?: string;
  inputLocationName?: string;
  inputXmlNamespace?: string;
  outputResultWrapper?: string;
  classification: OperationClassification;
  deprecated?: boolean;
  doc?: string;
  pagination?: Pagination;
}

export type Protocol = 'json' | 'rest-json' | 'query' | 'ec2' | 'rest-xml';

export interface ServiceMetadata {
  apiVersion: string;
  protocol: Protocol;
  jsonVersion?: string;
  targetPrefix?: string;
  endpointPrefix: string;
  signingName: string;
  signatureVersion: string;
  serviceFullName: string;
  serviceId: string;
  xmlNamespace?: string;
  globalEndpoint?: string;
  uid: string;
}

export interface ServiceCatalog {
  id: string;
  label: string;
  category: string;
  aliases: string[];
  metadata: ServiceMetadata;
  operations: Record<string, Operation>;
  shapes: Record<string, Shape>;
}

export interface ServiceIndexEntry {
  id: string;
  label: string;
  category: string;
  aliases: string[];
  protocol: Protocol;
  endpointPrefix: string;
  operations: number;
}

/** Resolve a member reference to its shape definition. */
export function resolveShape(
  catalog: Pick<ServiceCatalog, 'shapes'>,
  ref: ShapeRef | undefined,
): Shape | undefined {
  if (!ref) return undefined;
  if (ref.shape) return catalog.shapes[ref.shape];
  if (ref.type) return ref as Shape;
  return undefined;
}

/** Traits declared on the member override traits on the target shape. */
export function mergeRef(ref: ShapeRef, shape: Shape | undefined): Shape {
  if (!shape) return { type: (ref.type ?? 'string') as ShapeType, ...ref };
  return { ...shape, ...ref, type: shape.type };
}
