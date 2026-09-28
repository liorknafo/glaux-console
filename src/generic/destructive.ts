import type { Operation, ServiceCatalog } from '../catalog/types';
import { inputMembers } from '../protocol/serialize';

export function destructiveIdentifier(
  catalog: ServiceCatalog,
  operation: Operation,
  input: Record<string, unknown>,
): { field: string; value: string } | undefined {
  const candidates = inputMembers(catalog, operation).filter(
    member => member.shape.type === 'string' && !member.shape.enum,
  );
  const preferred =
    candidates.find(
      member => member.required && /name|id|arn|url|key|bucket|queue/i.test(member.name),
    ) ??
    candidates.find(member => member.required) ??
    candidates.find(member => /name|id|arn|url|key|bucket|queue/i.test(member.name));
  if (!preferred) return undefined;
  const value = input[preferred.name];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return { field: preferred.name, value };
}
