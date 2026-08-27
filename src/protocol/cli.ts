import type { Operation, ServiceCatalog, ShapeRef } from '../catalog/types';
import { mergeRef, resolveShape } from '../catalog/types';

/**
 * Renders the equivalent `aws` CLI command for a generated form, so anything
 * done in the console can be repeated (and scripted) from a terminal.
 */
export function renderCliCommand(
  catalog: ServiceCatalog,
  operation: Operation,
  input: Record<string, unknown>,
  endpointUrl: string,
): string {
  const parts = [
    'aws',
    cliServiceName(catalog),
    kebab(operation.name),
    `--endpoint-url ${shellQuote(endpointUrl)}`,
  ];

  const inputShape = operation.input ? catalog.shapes[operation.input] : undefined;
  for (const [name, ref] of Object.entries(inputShape?.members ?? {})) {
    const value = input[name];
    if (value === undefined || value === null || value === '') continue;
    parts.push(`--${kebab(name)} ${renderValue(catalog, ref, value)}`);
  }

  return parts.join(' \\\n  ');
}

/**
 * Every catalogued service id is currently also its `aws` CLI command name.
 * This stays a function so an exception can be added in one place if a future
 * service needs one.
 */
function cliServiceName(catalog: ServiceCatalog): string {
  return catalog.id;
}

function renderValue(catalog: ServiceCatalog, ref: ShapeRef, value: unknown): string {
  const shape = mergeRef(ref, resolveShape(catalog, ref));
  switch (shape.type) {
    case 'boolean':
      return value === true || value === 'true' ? 'true' : 'false';
    case 'integer':
    case 'long':
    case 'float':
    case 'double':
      return String(value);
    case 'list':
      if (Array.isArray(value) && isScalarShape(catalog, shape.member)) {
        return value.map(item => shellQuote(String(item))).join(' ');
      }
      return shellQuote(JSON.stringify(value));
    case 'structure':
    case 'map':
      return shellQuote(JSON.stringify(value));
    default:
      return shellQuote(String(value));
  }
}

function isScalarShape(catalog: ServiceCatalog, ref: ShapeRef | undefined): boolean {
  if (!ref) return false;
  const shape = mergeRef(ref, resolveShape(catalog, ref));
  return !['structure', 'list', 'map'].includes(shape.type);
}

/** `ListDataCatalogs` -> `list-data-catalogs`, `MaxResults` -> `max-results`. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
