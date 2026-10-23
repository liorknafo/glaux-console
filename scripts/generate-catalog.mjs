#!/usr/bin/env node
/**
 * Build-time generation of the glaux-console service catalog.
 *
 * Source: AWS's public botocore service models (`service-2.json`), the same
 * models the AWS SDKs and CLI are generated from. Output is one compact JSON
 * chunk per service under src/catalog/generated/, loaded lazily by the app,
 * plus an index and a manifest recording the exact source bytes each chunk was
 * built from.
 *
 * The generated files are committed: regenerating the catalog is a reviewable
 * diff, and the snapshot tests fail when a regeneration would silently change
 * a generated form.
 *
 *   npm run catalog                 # refresh every service in catalog-services.json
 *   npm run catalog -- s3 sqs       # refresh only these
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'src', 'catalog', 'generated');
const CACHE_DIR = join(HERE, '.model-cache');

/**
 * Pinned to an immutable commit: a branch name would let two regenerations of
 * the "same" catalog read different bytes, and the manifest could not say which.
 * Bump this deliberately, and review the resulting catalog diff.
 */
const BOTOCORE_REF = '2fd71ea25993e2167f5a530e80cd898960fcdf67';
const BOTOCORE_BASE = `https://raw.githubusercontent.com/boto/botocore/${BOTOCORE_REF}/botocore/data`;

/** Documentation is kept as plain text and truncated — it is form help, not a manual. */
const DOC_LIMIT = 400;

/** Traits that affect wire serialization or form rendering. Everything else is dropped. */
const SHAPE_TRAITS = [
  'type',
  'shape',
  'required',
  'members',
  'member',
  'key',
  'value',
  'enum',
  'min',
  'max',
  'pattern',
  'flattened',
  'locationName',
  'location',
  'payload',
  'streaming',
  'timestampFormat',
  'xmlNamespace',
  'xmlAttribute',
  'resultWrapper',
  'idempotencyToken',
  'sensitive',
  'deprecated',
  'jsonvalue',
  'union',
  'document',
  'hostLabel',
  'queryName',
];

const CLASSIFIERS = [
  [
    /^(Delete|Remove|Terminate|Deregister|Purge|Revoke|Detach|Disassociate|Untag|Reset|Destroy|Abort|Discard)/,
    'delete',
  ],
  [
    /^(Create|Put|Add|Register|Import|Start|Run|Send|Publish|Submit|Upload|Copy|Restore|Allocate|Provision|Request|Issue|Batch(Write|Put))/,
    'create',
  ],
  [
    /^(Update|Modify|Set|Tag|Enable|Disable|Attach|Associate|Replace|Configure|Change|Move|Promote|Rotate|Cancel|Stop|Suspend|Resume|Activate|Deactivate)/,
    'update',
  ],
  [/^(List|Search|Scan|Query|BatchGet|Select)/, 'list'],
  [
    /^(Describe|Get|Head|Lookup|Retrieve|Check|Test|Validate|Verify|Estimate|Preview|Detect|Decode|Simulate)/,
    'describe',
  ],
];

function classify(name, shapes, opShape) {
  for (const [pattern, kind] of CLASSIFIERS) {
    if (pattern.test(name)) {
      // Describe* that returns a collection is really a list operation.
      if (kind === 'describe' && returnsCollection(shapes, opShape)) return 'list';
      return kind;
    }
  }
  return 'other';
}

function returnsCollection(shapes, outputShapeName) {
  const shape = outputShapeName && shapes[outputShapeName];
  if (!shape || shape.type !== 'structure' || !shape.members) return false;
  return Object.values(shape.members).some(member => {
    const target = shapes[member.shape];
    return target && target.type === 'list';
  });
}

/** botocore documentation is HTML. Forms want a sentence, not markup. */
function plainDoc(html) {
  if (!html) return undefined;
  const text = html
    .replace(/<\/?(p|br|li|ul|ol|div)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  if (text.length <= DOC_LIMIT) return text;
  const cut = text.slice(0, DOC_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > DOC_LIMIT * 0.6 ? lastSpace : DOC_LIMIT).trimEnd()}…`;
}

function compactShape(shape) {
  const out = {};
  for (const trait of SHAPE_TRAITS) {
    if (shape[trait] === undefined) continue;
    if (trait === 'members') {
      out.members = {};
      for (const [name, member] of Object.entries(shape.members)) {
        out.members[name] = compactShape(member);
      }
    } else if (trait === 'member' || trait === 'key' || trait === 'value') {
      out[trait] = compactShape(shape[trait]);
    } else if (trait === 'deprecated') {
      out.deprecated = true;
    } else if (trait === 'xmlNamespace') {
      out.xmlNamespace =
        typeof shape.xmlNamespace === 'string' ? shape.xmlNamespace : shape.xmlNamespace.uri;
    } else {
      out[trait] = shape[trait];
    }
  }
  const doc = plainDoc(shape.documentation);
  if (doc) out.doc = doc;
  return out;
}

/** Every shape transitively reachable from the service's operations. */
function reachable(shapes, roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (!name || seen.has(name) || !shapes[name]) continue;
    seen.add(name);
    const shape = shapes[name];
    if (shape.members) for (const m of Object.values(shape.members)) queue.push(m.shape);
    if (shape.member) queue.push(shape.member.shape);
    if (shape.key) queue.push(shape.key.shape);
    if (shape.value) queue.push(shape.value.shape);
  }
  return seen;
}

async function fetchModel(modelPath) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, `${BOTOCORE_REF}_${modelPath.replace(/\//g, '_')}.json`);
  try {
    return await readFile(cacheFile, 'utf8');
  } catch {
    // not cached yet
  }
  const url = `${BOTOCORE_BASE}/${modelPath}/service-2.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  const body = await response.text();
  await writeFile(cacheFile, body);
  return body;
}

function buildService(entry, model, paginators) {
  const meta = model.metadata;
  const operations = {};
  const roots = [];

  for (const [name, op] of Object.entries(model.operations)) {
    if (op.input?.shape) roots.push(op.input.shape);
    if (op.output?.shape) roots.push(op.output.shape);
    const pagination = paginators?.pagination?.[name];
    operations[name] = {
      name,
      http: { method: op.http?.method ?? 'POST', requestUri: op.http?.requestUri ?? '/' },
      ...(op.input?.shape ? { input: op.input.shape } : {}),
      ...(op.output?.shape ? { output: op.output.shape } : {}),
      ...(op.input?.locationName ? { inputLocationName: op.input.locationName } : {}),
      ...(op.output?.resultWrapper ? { outputResultWrapper: op.output.resultWrapper } : {}),
      ...(op.input?.xmlNamespace
        ? { inputXmlNamespace: op.input.xmlNamespace.uri ?? op.input.xmlNamespace }
        : {}),
      classification: classify(name, model.shapes, op.output?.shape),
      ...(op.deprecated ? { deprecated: true } : {}),
      ...(op.documentation ? { doc: plainDoc(op.documentation) } : {}),
      ...(pagination
        ? {
            pagination: {
              ...(pagination.input_token ? { inputToken: asOne(pagination.input_token) } : {}),
              ...(pagination.output_token ? { outputToken: asOne(pagination.output_token) } : {}),
              ...(pagination.limit_key ? { limitKey: pagination.limit_key } : {}),
              ...(pagination.result_key ? { resultKey: asOne(pagination.result_key) } : {}),
            },
          }
        : {}),
    };
  }

  const keep = reachable(model.shapes, roots);
  const shapes = {};
  for (const name of [...keep].sort()) {
    shapes[name] = compactShape(model.shapes[name]);
  }

  return {
    id: entry.id,
    label: entry.label,
    category: entry.category,
    aliases: entry.aliases ?? [],
    metadata: {
      apiVersion: meta.apiVersion,
      protocol: meta.protocol,
      ...(meta.jsonVersion ? { jsonVersion: meta.jsonVersion } : {}),
      ...(meta.targetPrefix ? { targetPrefix: meta.targetPrefix } : {}),
      endpointPrefix: meta.endpointPrefix,
      signingName: meta.signingName ?? meta.endpointPrefix,
      signatureVersion: meta.signatureVersion ?? 'v4',
      serviceFullName: meta.serviceFullName,
      serviceId: meta.serviceId,
      ...(meta.xmlNamespace ? { xmlNamespace: meta.xmlNamespace } : {}),
      ...(meta.globalEndpoint ? { globalEndpoint: meta.globalEndpoint } : {}),
      uid: meta.uid,
    },
    operations: Object.fromEntries(
      Object.entries(operations).sort(([a], [b]) => a.localeCompare(b)),
    ),
    shapes,
  };
}

function asOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Stable key order so regeneration produces a minimal diff. */
function stableStringify(value) {
  return JSON.stringify(value, null, 0);
}

async function main() {
  const only = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
  const registry = JSON.parse(await readFile(join(HERE, 'catalog-services.json'), 'utf8'));
  const entries = only.length
    ? registry.services.filter(service => only.includes(service.id))
    : registry.services;

  if (!entries.length) {
    throw new Error(`No services matched: ${only.join(', ')}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  if (!only.length) {
    for (const file of await readdir(OUT_DIR).catch(() => [])) {
      if (file.endsWith('.json')) await rm(join(OUT_DIR, file));
    }
  }

  const manifest = { source: `botocore@${BOTOCORE_REF}`, services: {} };
  let index = [];
  let totalBytes = 0;

  for (const entry of entries) {
    const raw = await fetchModel(entry.model);
    const model = JSON.parse(raw);
    let paginators = null;
    let paginatorsRaw = null;
    try {
      paginatorsRaw = await fetchPaginators(entry.model);
      paginators = JSON.parse(paginatorsRaw);
    } catch {
      paginators = null;
      paginatorsRaw = null;
    }

    const service = buildService(entry, model, paginators);
    const json = stableStringify(service);
    await writeFile(join(OUT_DIR, `${entry.id}.json`), `${json}\n`);
    totalBytes += json.length;

    manifest.services[entry.id] = {
      model: entry.model,
      sourceSha256: createHash('sha256').update(raw).digest('hex'),
      // Paginator data decides the pagination fields on every operation, so it
      // is part of the provenance, not an incidental extra fetch.
      paginatorsSha256: paginatorsRaw
        ? createHash('sha256').update(paginatorsRaw).digest('hex')
        : null,
      operations: Object.keys(service.operations).length,
      shapes: Object.keys(service.shapes).length,
    };
    index.push({
      id: entry.id,
      label: entry.label,
      category: entry.category,
      aliases: entry.aliases ?? [],
      protocol: service.metadata.protocol,
      endpointPrefix: service.metadata.endpointPrefix,
      operations: Object.keys(service.operations).length,
    });
    process.stdout.write(
      `${entry.id.padEnd(26)} ${String(Object.keys(service.operations).length).padStart(4)} ops  ` +
        `${String(Object.keys(service.shapes).length).padStart(5)} shapes  ${(json.length / 1024).toFixed(0)} KiB\n`,
    );
  }

  // A partial run must still leave index.json and manifest.json describing what
  // is on disk: the app reads operation counts, protocols and endpoint prefixes
  // from the eager index, and stale entries there are silently wrong.
  if (only.length) {
    const existingIndex = await readJson(join(OUT_DIR, 'index.json'), []);
    const existingManifest = await readJson(join(OUT_DIR, 'manifest.json'), {
      source: manifest.source,
      services: {},
    });
    const merged = new Map(existingIndex.map(entry => [entry.id, entry]));
    for (const entry of index) merged.set(entry.id, entry);
    index = [...merged.values()];
    manifest.services = { ...existingManifest.services, ...manifest.services };
  }

  index.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(join(OUT_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `\n${entries.length} services, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB of catalog\n`,
  );
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchPaginators(modelPath) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cacheFile = join(
    CACHE_DIR,
    `${BOTOCORE_REF}_${modelPath.replace(/\//g, '_')}.paginators.json`,
  );
  try {
    return await readFile(cacheFile, 'utf8');
  } catch {
    // not cached yet
  }
  const response = await fetch(`${BOTOCORE_BASE}/${modelPath}/paginators-1.json`);
  if (!response.ok) throw new Error(`no paginators for ${modelPath}`);
  const body = await response.text();
  await writeFile(cacheFile, body);
  return body;
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
