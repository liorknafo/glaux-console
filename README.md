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
- **`server/`** — the standalone backend: static assets, `/api/request`, SigV4, and the real-AWS refusal. The embedded deployment (glaux mounting the assets at `/console`) implements the same contract.

## Adding a service

Services are catalogued, not hand-written. Add an entry to `scripts/catalog-services.json`:

```json
{ "id": "sagemaker", "label": "SageMaker", "category": "Compute", "model": "sagemaker/2017-07-24" }
```

where `model` is the path under `botocore/data`. Then `npm run catalog -- sagemaker && npm run catalog` and commit the generated chunk. The service appears in the navigation with working Resources and Actions tabs.

## Development

```bash
npm run typecheck
npm run lint
npm run test         # Vitest: catalog snapshots, protocols, components, backend
npm run e2e          # Playwright against the production build and a fixture emulator
npm run gate         # everything CI runs, except e2e
```

`CHROMIUM_PATH` makes Playwright use a pre-installed Chromium instead of downloading one.

## Status

Structural foundation landed: Cloudscape shell, endpoint switcher with capability discovery, catalog codegen, and the generic Resources/Actions layer — which lights up every catalogued service at once. Hand-built screens (Athena, Glue, Firehose, S3, SQS, EventBridge, DynamoDB) are next.

The design spec is [`docs/specs/2026-08-21-glaux-console-design.md`](docs/specs/2026-08-21-glaux-console-design.md); [`SERVICES.yaml`](SERVICES.yaml) is the work queue a daily agent works through, a few entries at a time, one PR per day.

## License

Apache-2.0.
