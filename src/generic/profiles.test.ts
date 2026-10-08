import { describe, expect, it } from 'vitest';
import { loadServiceCatalog, findService } from '../catalog/loader';
import type { ServiceCatalog, Shape } from '../catalog/types';
import { mergeRef, resolveShape } from '../catalog/types';
import { columnsFor, inferResultShape } from './columns';
import { preferredColumns, rendersRawResult, serviceProfiles } from './profiles';

/**
 * Profiles name operations and members by string, so nothing but a test stands
 * between a typo — or a botocore model that renamed a member — and a screen
 * that silently opens on nothing, or a column that is always “–”.
 *
 * Every assertion here runs against the committed catalog chunks, which is the
 * same data the app loads.
 */

const profileIds = Object.keys(serviceProfiles);

const catalogs = new Map<string, ServiceCatalog>(
  await Promise.all(
    profileIds.map(async id => [id, await loadServiceCatalog(id)] as [string, ServiceCatalog]),
  ),
);

/** The element shape of the collection a read operation returns, if any. */
function elementShapeOf(catalog: ServiceCatalog, operationName: string): Shape | undefined {
  const operation = catalog.operations[operationName];
  const shape = inferResultShape(catalog, operation.output, operation.pagination?.resultKey);
  if (!shape) return undefined;
  const outputShape = operation.output ? catalog.shapes[operation.output] : undefined;
  if (!outputShape) return undefined;
  let current: Shape | undefined = outputShape;
  for (const segment of shape.path) {
    const member = current?.members?.[segment];
    if (!member) return undefined;
    current = mergeRef(member, resolveShape(catalog, member));
  }
  return current
    ? mergeRef(current.member ?? {}, resolveShape(catalog, current.member))
    : undefined;
}

describe('service profiles', () => {
  it('covers this run’s queue entries', () => {
    expect(profileIds.sort()).toEqual(
      ['kinesis', 'lambda', 'secretsmanager', 'ssm', 'stepfunctions'].sort(),
    );
  });

  it.each(profileIds)('%s is a catalogued service in the navigation index', id => {
    expect(findService(id)).toBeDefined();
  });

  it.each(profileIds)('%s promotes only operations the model declares', id => {
    const catalog = catalogs.get(id) as ServiceCatalog;
    const missing = [
      ...serviceProfiles[id].resources.map(view => view.operation),
      ...serviceProfiles[id].actions,
    ].filter(name => !catalog.operations[name]);
    expect(missing).toEqual([]);
  });

  it.each(profileIds)('%s promotes only reads on the Resources tab', id => {
    const catalog = catalogs.get(id) as ServiceCatalog;
    const notReads = serviceProfiles[id].resources
      .map(view => catalog.operations[view.operation])
      .filter(operation => !['list', 'describe'].includes(operation.classification))
      .map(operation => operation.name);
    // The Resources picker is built from list/describe operations; an action
    // promoted here would be preselected but absent from its own options.
    expect(notReads).toEqual([]);
  });

  it.each(profileIds)('%s curates columns that exist in the element shape', id => {
    const catalog = catalogs.get(id) as ServiceCatalog;
    const problems: string[] = [];
    for (const view of serviceProfiles[id].resources) {
      if (!view.columns) continue;
      const element = elementShapeOf(catalog, view.operation);
      if (!element?.members) {
        problems.push(`${view.operation}: curated columns but no structure collection`);
        continue;
      }
      for (const column of view.columns) {
        if (!element.members[column]) problems.push(`${view.operation}.${column}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(profileIds)('%s declares no duplicate promotions', id => {
    const profile = serviceProfiles[id];
    const resources = profile.resources.map(view => view.operation);
    expect(new Set(resources).size).toBe(resources.length);
    expect(new Set(profile.actions).size).toBe(profile.actions.length);
    for (const view of profile.resources) {
      if (view.columns) expect(new Set(view.columns).size).toBe(view.columns.length);
    }
  });

  it.each(profileIds)('%s leaves an operation with no curated columns to inference', id => {
    const catalog = catalogs.get(id) as ServiceCatalog;
    for (const view of serviceProfiles[id].resources) {
      if (view.columns) continue;
      expect(preferredColumns(catalog.id, view.operation)).toBeUndefined();
    }
  });

  it.each(profileIds)('%s never curates columns for a raw view', id => {
    for (const view of serviceProfiles[id].resources) {
      if (view.raw) expect(view.columns).toBeUndefined();
    }
  });

  it.each(profileIds)('%s tables nothing inference guessed at', id => {
    const catalog = catalogs.get(id) as ServiceCatalog;
    const guessed = serviceProfiles[id].resources
      .filter(view => !view.raw && !view.columns)
      .filter(view => {
        const operation = catalog.operations[view.operation];
        if (operation.pagination?.resultKey) return false; // a declared collection
        return elementShapeOf(catalog, view.operation) !== undefined;
      })
      .map(view => view.operation);
    // Without a paginator, inference falls back to the first list member of the
    // output shape — a guess. A promoted view must not rest on it: curate the
    // columns if it really lists things, or mark it `raw` if it does not.
    expect(guessed).toEqual([]);
  });
});

describe('raw views', () => {
  it('suppresses the table inference would have built from a detail list', () => {
    const secrets = catalogs.get('secretsmanager') as ServiceCatalog;
    // Left to itself, inference finds VersionStages and tables the stages
    // instead of showing the secret.
    const operation = secrets.operations.GetSecretValue;
    expect(
      inferResultShape(secrets, operation.output, operation.pagination?.resultKey)?.path,
    ).toEqual(['VersionStages']);
    expect(rendersRawResult('secretsmanager', 'GetSecretValue')).toBe(true);
  });

  it('leaves a genuine list operation alone', () => {
    expect(rendersRawResult('secretsmanager', 'ListSecrets')).toBe(false);
    expect(rendersRawResult('kinesis', 'ListStreams')).toBe(false);
    expect(rendersRawResult('lambda', 'ListFunctions')).toBe(false);
  });

  it('is false for a service with no profile', () => {
    expect(rendersRawResult('s3', 'ListBuckets')).toBe(false);
  });
});

describe('curated columns replace inference', () => {
  it('shows exactly the profile’s columns, in the profile’s order', async () => {
    const lambda = catalogs.get('lambda') as ServiceCatalog;
    const operation = lambda.operations.ListFunctions;
    const curated = inferResultShape(
      lambda,
      operation.output,
      operation.pagination?.resultKey,
      preferredColumns('lambda', 'ListFunctions'),
    );

    expect(curated?.columns.map(column => column.id)).toEqual([
      'FunctionName',
      'Runtime',
      'PackageType',
      'MemorySize',
      'Timeout',
      'State',
      'LastModified',
      'Version',
      'FunctionArn',
    ]);
  });

  it('is a genuine change from what inference would have shown', () => {
    const lambda = catalogs.get('lambda') as ServiceCatalog;
    const operation = lambda.operations.ListFunctions;
    const inferred = inferResultShape(lambda, operation.output, operation.pagination?.resultKey);
    // Inference keeps the first eight scalars of FunctionConfiguration, which
    // leads with Role, Handler and CodeSize and never reaches State.
    expect(inferred?.columns.map(column => column.id)).toContain('Role');
    expect(inferred?.columns.map(column => column.id)).not.toContain('State');
  });

  it('drops a curated member the shape does not declare rather than showing an empty column', () => {
    const lambda = catalogs.get('lambda') as ServiceCatalog;
    const element = elementShapeOf(lambda, 'ListFunctions') as Shape;
    const columns = columnsFor(lambda, element, ['FunctionName', 'NotAMember']);
    expect(columns.map(column => column.id)).toEqual(['FunctionName']);
  });

  it('falls back to inference when every curated member is unknown', () => {
    const lambda = catalogs.get('lambda') as ServiceCatalog;
    const element = elementShapeOf(lambda, 'ListFunctions') as Shape;
    const columns = columnsFor(lambda, element, ['NotAMember']);
    expect(columns.map(column => column.id)).toContain('FunctionName');
    expect(columns.length).toBeGreaterThan(1);
  });

  it('leaves a service with no profile exactly as it was', () => {
    const lambda = catalogs.get('lambda') as ServiceCatalog;
    const element = elementShapeOf(lambda, 'ListFunctions') as Shape;
    expect(columnsFor(lambda, element)).toEqual(columnsFor(lambda, element, []));
  });
});
