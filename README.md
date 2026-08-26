# glaux-console 🦉

**A web console for local AWS emulators that actually looks like the AWS console.**

Local emulators ([glaux](https://github.com/liorknafo/glaux), fakecloud, MiniStack, LocalStack, MinIO) give you the APIs; the existing open-source browsers give you a generic dashboard on top. glaux-console is built from [Cloudscape](https://cloudscape.design/) — the Apache-2.0 design system AWS builds its own console with — so the shell, navigation, tables, and editors are the real thing.

- **Every service, every operation.** UIs are generated from AWS's public service models, so whatever your emulator implements gets a browsable resource list and a working form — with the equivalent `aws` CLI command shown next to it.
- **The analytics screens nobody else has.** A real Athena query editor (schema tree, results, bytes scanned, query history), a Glue catalog browser, and Firehose delivery monitoring.
- **Local only, by design.** The backend refuses real-AWS endpoints — full CRUD against production is designed out, not warned about.

Not affiliated with, or endorsed by, Amazon Web Services. No AWS logos or trademarks are used.

## Quick start

```bash
npm install
npm run dev          # console + backend proxy on http://localhost:5173
```

Point it at an emulator from the endpoint menu in the top bar (default target is the origin serving the console). To serve the production build standalone:

```bash
npm run build
npm run serve -- --port 4599
```

## How it works

```text
browser  ──▶  console backend  ──▶  target emulator
             (/api/request)         (http://localhost:4566)
```

The browser never talks to the target directly. It builds the wire request from the service catalog and posts a request envelope to the console backend, which attaches a dummy SigV4 signature and forwards it. That removes CORS from the picture, keeps credentials out of the page, and gives one place to refuse real-AWS hosts.

- **`src/catalog/`** — the generated service catalog: 56 services, ~4,700 operations, one lazily-loaded chunk per service. Generated from [botocore](https://github.com/boto/botocore)'s public service models by `npm run catalog`, committed so regeneration is a reviewable diff, and pinned by snapshot tests.
- **`src/protocol/`** — request serialization and response parsing for the `json`, `rest-json`, `query`, `ec2`, and `rest-xml` wire protocols, plus the "View as CLI" renderer.
- **`src/generic/`** — the Resources tab (list/describe → Cloudscape tables with the service's own pagination) and Actions tab (generated forms, raw-JSON escape hatch, destructive-action guard).
- **`src/deep/`** — hand-built screens, mounted in front of the generated tabs by `src/deep/registry.tsx`. Today: the Athena query editor, the Glue catalog browser, the Firehose delivery monitor, and the S3 object browser.
- **`src/generic/profiles.ts`** — per-service presentation overrides for services with no hand-built screen. See [Service profiles](#service-profiles).
- **`server/`** — the standalone backend: static assets, `/api/request`, SigV4, and the real-AWS refusal. The embedded deployment (glaux mounting the assets at `/console`) implements the same contract.

## Adding a service

Services are catalogued, not hand-written. Add an entry to `scripts/catalog-services.json`:

```json
{ "id": "sagemaker", "label": "SageMaker", "category": "Compute", "model": "sagemaker/2017-07-24" }
```

where `model` is the path under `botocore/data`. Then `npm run catalog -- sagemaker && npm run catalog` and commit the generated chunk. The service appears in the navigation with working Resources and Actions tabs.

## Service profiles

The generated tabs work for every catalogued service without any further configuration. What they cannot know is which of a service's operations you opened the screen to run: Systems Manager models 152 of them, Lambda 88, and an alphabetical picker over all of them is complete and unusable. A **profile** in [`src/generic/profiles.ts`](src/generic/profiles.ts) is a handful of lines that says which ones matter.

```ts
lambda: {
  summary: 'Functions, their configuration, and their event source mappings. …',
  resources: [
    { operation: 'ListFunctions', columns: ['FunctionName', 'Runtime', 'MemorySize', …] },
    { operation: 'GetFunctionConfiguration', raw: true },
  ],
  actions: ['Invoke', 'CreateFunction', 'UpdateFunctionCode', …],
},
```

- **`resources`** are promoted to a "Common" group at the top of the Resources picker, and the first one is preselected so the tab opens on something rather than on a placeholder. Nothing is requested until you run it.
- **`columns`** replaces column inference for that view. Inference keeps the first eight scalar members of the element shape, which for `ListFunctions` leads with `Role`, `Handler` and `CodeSize` and never reaches `State`. The raw response is still one expander away, so nothing is hidden.
- **`raw`** says this read describes one thing rather than listing many — a distinction the service model does not record. Without it, inference falls back to the first list member of the output shape, so `GetSecretValue` renders a table of its `VersionStages` and `GetFunctionConfiguration` one of its `Layers`: a table of a detail in place of the answer.
- **`actions`** are promoted to a "Common" group on the Actions tab, _and_ keep their place in their classification group, so promoting an operation never makes it harder to find.

Every operation and column name is checked against the generated catalog by `src/generic/profiles.test.ts`, so a typo — or a botocore model that renamed a member — fails the gate instead of quietly rendering an always-empty column. Services with no profile are unchanged.

Today: Lambda, Step Functions, Kinesis, Secrets Manager and Systems Manager.

## Development

```bash
npm run typecheck
npm run lint
npm run test         # Vitest: catalog snapshots, protocols, components, backend
npm run e2e          # Playwright against the production build and a fixture emulator
npm run gate         # everything CI runs, except e2e
```

`CHROMIUM_PATH` makes Playwright use a pre-installed Chromium instead of downloading one.

## The Athena screen

Athena opens on a hand-built query editor rather than the generated tabs (which are still there, behind it).

- **Editor** — Cloudscape's Ace-based `CodeEditor` with SQL highlighting. Ace loads lazily, so it costs nothing on any other screen. `Ctrl`/`Cmd`+`Enter` runs the query.
- **Schema tree** — databases and tables from the target's **Glue** Data Catalog, with each table's columns and partition keys. "Query this table" writes a `SELECT` into the editor and sets the database as the query context.
- **Lifecycle** — `StartQueryExecution`, then `GetQueryExecution` polled with a backoff to a terminal state, then `GetQueryResults` paged by the service's own `NextToken`. "Cancel" is a real `StopQueryExecution`.
- **Cost and timing** — data scanned, engine time, total run time, queue and planning time, straight from `QueryExecutionStatistics`.
- **Coverage gaps are explained, not just reported.** A failure whose message says a construct is unsupported renders as an explanation naming the construct and linking to glaux's SQL coverage docs — glaux's "never silently wrong" rule, made visible. Any other failure renders as the error it is, in full.
- **History and saved queries** live in browser storage, per endpoint, so they work against a target that implements neither `ListQueryExecutions` nor the named-query APIs.

## The Glue, Firehose and S3 screens

- **Glue** opens on a catalog browser: databases, their tables, and one table in full — columns with partition keys badged, the partitions the catalog holds, the storage descriptor and SerDe, and partition projection read out of the table's parameters. "Query this table" writes the `SELECT` into the Athena editor and opens it.
- **Firehose** opens on a delivery monitor: streams, their buffering and destination configuration, and what each has actually delivered. Firehose reports no delivery metrics of its own without CloudWatch, so activity is read out of the destination bucket — the objects written under the stream's prefix, and the records parked under its error output prefix. Every object links into the S3 browser at the prefix it sits in. "Put test records" sends through `PutRecord`/`PutRecordBatch`.
- **S3** opens on a bucket list and a prefix browser: upload, download, delete, and an object's metadata from `HeadObject`. A "folder" is a `CommonPrefix` the service returned, not a client-side grouping. Deleting requires typing the key, as the console does. Parquet preview is deliberately not here.

## Status

Structural foundation landed: Cloudscape shell, endpoint switcher with capability discovery, catalog codegen, and the generic Resources/Actions layer — which lights up every catalogued service at once. Seven hand-built screens sit on top of it: Athena, Glue, Firehose, S3, SQS, EventBridge and DynamoDB. Five more services — Lambda, Step Functions, Kinesis, Secrets Manager and Systems Manager — are curated through [service profiles](#service-profiles). IAM, SNS, CloudWatch Logs and KMS are next.

The design spec is [`docs/specs/2026-08-21-glaux-console-design.md`](docs/specs/2026-08-21-glaux-console-design.md); [`SERVICES.yaml`](SERVICES.yaml) is the work queue a daily agent works through, a few entries at a time, one PR per day.

## License

Apache-2.0.
