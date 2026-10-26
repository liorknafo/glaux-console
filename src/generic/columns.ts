import type { ServiceCatalog, Shape, ShapeRef } from '../catalog/types';
import { mergeRef, resolveShape } from '../catalog/types';

/**
 * Column inference for the Resources tab.
 *
 * An operation's output shape names the collection it returns; the members of
 * that collection's element shape become the table's columns. Scalars come
 * first (they render as themselves); structures and lists are kept but render
 * as compact JSON, so nothing in the response is hidden from the user.
 */

export interface InferredColumn {
  id: string;
  header: string;
  scalar: boolean;
}

export interface ResultShape {
  /** Path into the parsed output object where the collection lives. */
  path: string[];
  columns: InferredColumn[];
}

const MAX_SCALAR_COLUMNS = 8;

/**
 * Prefers the paginator's `resultKey` when the model declares one, and
 * otherwise the first list-typed member of the output shape.
 */
export function inferResultShape(
  catalog: ServiceCatalog,
  outputShapeName: string | undefined,
  resultKey: string | undefined,
  preferred?: string[],
): ResultShape | undefined {
  const outputShape = outputShapeName ? catalog.shapes[outputShapeName] : undefined;
  if (!outputShape?.members) return undefined;

  const path = resultKey ? resultKey.split('.').filter(part => part && part !== '[]') : undefined;
  // Paginator result keys can carry list projections (`Items[].Name`), which no
  // longer address a member once `[]` is stripped. Falling back beats showing
  // raw JSON when the output shape has an obvious list member.
  const candidate = path
    ? (followPath(catalog, outputShape, path) ?? findFirstList(catalog, outputShape))
    : findFirstList(catalog, outputShape);
  if (!candidate) return undefined;

  const elementShape = mergeRef(
    candidate.shape.member ?? {},
    resolveShape(catalog, candidate.shape.member),
  );
  return { path: candidate.path, columns: columnsFor(catalog, elementShape, preferred) };
}

function followPath(
  catalog: ServiceCatalog,
  shape: Shape,
  path: string[],
): { path: string[]; shape: Shape } | undefined {
  let current: Shape | undefined = shape;
  for (const segment of path) {
    const member: ShapeRef | undefined = current?.members?.[segment];
    if (!member) return undefined;
    current = mergeRef(member, resolveShape(catalog, member));
  }
  return current?.type === 'list' ? { path, shape: current } : undefined;
}

function findFirstList(
  catalog: ServiceCatalog,
  shape: Shape,
): { path: string[]; shape: Shape } | undefined {
  for (const [name, ref] of Object.entries(shape.members ?? {})) {
    const memberShape = mergeRef(ref, resolveShape(catalog, ref));
    if (memberShape.type === 'list') return { path: [name], shape: memberShape };
  }
  return undefined;
}

/**
 * `preferred` names the columns a service profile curates for this operation.
 * When it is given, it replaces inference outright: exactly those members, in
 * that order. Members the element shape does not declare are dropped rather
 * than rendered as an always-empty column, so a stale profile shows fewer
 * columns instead of misleading ones — and `profiles.test.ts` fails the gate
 * on one either way.
 */
export function columnsFor(
  catalog: ServiceCatalog,
  elementShape: Shape,
  preferred?: string[],
): InferredColumn[] {
  if (elementShape.type !== 'structure' || !elementShape.members) {
    return [{ id: '$value', header: 'Value', scalar: true }];
  }
  const members = elementShape.members;
  const entries = Object.entries(members).map(([name, ref]) => {
    const shape = mergeRef(ref, resolveShape(catalog, ref));
    return {
      id: name,
      header: humanize(name),
      scalar: !['structure', 'list', 'map'].includes(shape.type),
    };
  });

  if (preferred?.length) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const curated = preferred
      .map(id => byId.get(id))
      .filter((entry): entry is InferredColumn => entry !== undefined);
    if (curated.length > 0) return curated;
  }

  const scalars = entries.filter(entry => entry.scalar).slice(0, MAX_SCALAR_COLUMNS);
  const complex = entries.filter(entry => !entry.scalar);
  return [...scalars, ...complex];
}

/** Reads the collection out of a parsed response using the inferred path. */
export function readCollection(output: unknown, path: string[]): unknown[] {
  let current: unknown = output;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return [];
    current = (current as Record<string, unknown>)[segment];
  }
  if (Array.isArray(current)) return current;
  return current === undefined || current === null ? [] : [current];
}

/** `QueryExecutionId` -> `Query execution id`, matching console column casing. */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function renderCell(value: unknown): string {
  if (value === undefined || value === null) return '–';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
