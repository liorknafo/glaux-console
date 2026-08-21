# glaux-console — Design Spec

*2026-08-21. Status: approved design, pre-implementation.*

## Problem

Local AWS emulators have no console that looks or feels like the AWS Management Console. The two open-source browsers that exist — [StackPort](https://github.com/DaviReisVieira/stackport) (8 dedicated service UIs) and [LocalStack Explorer](https://github.com/fgiova/localstack-explorer) (7) — are both built on shadcn/Radix/Tailwind: competent generic dashboards, not the console. Neither covers analytics: no Athena query editor, no Glue catalog browser, no Firehose monitoring. [fakecloud](https://github.com/faiscadev/fakecloud), the emulator glaux embeds, ships no UI at all.

## Product

**glaux-console** — a web console for local AWS emulators that is built from AWS's own open-source design system, so it genuinely looks like the console instead of merely doing the same jobs.

Three differentiators:

1. **Real console look.** Built on [Cloudscape](https://cloudscape.design/) (Apache-2.0, the component set AWS builds its console with): `AppLayout` shell with collapsible service navigation and breadcrumbs, `TopNavigation`, console-accurate tables, `Flashbar` notifications, Ace-based `CodeEditor`. glaux's own name and owl mark in the top bar — no AWS logos, wordmarks, or any implication of affiliation.
2. **Full coverage, model-driven.** Every service and operation the target emulator implements gets a UI, generated from AWS's public Smithy/botocore service models rather than hand-written.
3. **The analytics screens nobody has.** A real Athena query editor, Glue catalog browser, and Firehose delivery monitor.

## Scope decisions (approved)

| Decision | Choice |
|---|---|
| Services covered | Everything the target emulator serves (fakecloud's ~105 + glaux's Athena/Firehose) |
| Capabilities | Full CRUD across all operations, via generated forms; hand-built screens for priority services |
| Targets | Any **local** emulator endpoint (glaux, fakecloud, MiniStack, LocalStack, MinIO). Real AWS is refused by design |
| Delivery | Separate repo; a daily scheduled agent implements 3–5 queue entries per run, one PR per day |

## Architecture

### Serving and process shape

A React SPA built with Vite, published two ways:

- **Embedded** — a Rust crate (`glaux-console-embed`) ships the built assets via `rust-embed`; the glaux binaries mount them at `/console` on the API port. `localhost:4566/console` with zero setup, no Node at runtime, single-binary story intact. glaux depends on this crate; this repo never depends on glaux.
- **Standalone** — the same assets served by any static host or `npx glaux-console`, for pointing at a non-glaux emulator.

### Request path

**Browser → console backend → target endpoint.** Never browser → emulator directly. This removes CORS handling, keeps SigV4 out of the browser (the backend attaches dummy credentials — local emulators do not verify signatures), and gives one place for capability discovery and safety checks. In the embedded deployment the backend is the mounting glaux binary; in standalone it is a thin Node/Rust proxy shipped with the package.

**Safety:** the backend refuses target hosts matching `*.amazonaws.com` (and other real-AWS endpoints) with an explicit message. Full CRUD plus production credentials is designed out, not warned about.

### Capability discovery

On connect, the console reads `GET /_fakecloud/health` (`{"status","version","services":[...]}`) to learn which services the target actually runs, and probes glaux's own endpoints to detect a real Athena/Firehose data plane behind the same port. Services the target does not implement render greyed out rather than failing mysteriously. Discovery results are cached per endpoint.

### The model layer (how ~105 services and ~7,400 operations become a UI)

Build-time codegen turns AWS's public Smithy/botocore models into a compact **service catalog**: per service, every operation with its input shape (types, required fields, enums, documentation), output shape, pagination fields, and a classification (list / describe / create / update / delete). Catalog chunks load lazily per service so the initial bundle stays small. Regenerating the catalog is a committed, reviewable diff; snapshot tests fail when a regeneration would silently change a form.

Generic UI derived from the catalog:

- **Resources tab** — list/describe operations as Cloudscape tables; columns inferred from the output shape; pagination wired to the operation's own token fields.
- **Actions tab** — every other operation as a generated form: typed inputs, enums as selects, nested structures as expandable sections, blobs as file pickers, plus a raw-JSON escape hatch.
- **View as CLI** — every form renders the equivalent `aws ...` command, copyable.
- **Destructive-action guard** — delete/reset operations require typing the resource name, matching console convention.

Generated forms are the floor for every service; priority services get hand-built screens on top.

### Hand-built screens (priority order)

1. **Athena** — Ace `CodeEditor`, Glue-backed schema tree, run/cancel, results table with pagination, bytes-scanned and timing, query history, saved queries. glaux's explicit "unsupported construct" errors render as first-class explanations linking to the SQL coverage table — the "never silently wrong" rule made visible.
2. **Glue** — database/table browser: columns, partitions, SerDe, partition projection; "Query this table" prefills the Athena editor.
3. **Firehose** — delivery streams, buffering config, live delivery activity (objects written, error-prefix records), "put test records", links to the S3 objects produced.
4. **S3 / SQS / EventBridge** — object browser (Parquet preview later), queue peek/send/purge, rule list with event-pattern tester. With the above, the flagship pipeline (EventBridge → SQS → Firehose → S3 → Athena) is watchable end to end in one UI.
5. **Long tail** — DynamoDB, Lambda, Step Functions, Kinesis, Secrets Manager, IAM, CloudWatch Logs, and onward through the queue.

## Testing

- **Vitest** component tests for the shell, generic table/form renderers, and each hand-built screen.
- **Catalog snapshot tests** so model regeneration cannot silently alter generated forms.
- **Playwright end-to-end** in CI against a real all-in-one glaux binary: create a Glue table over fixture data → run a query in the editor → assert results, bytes scanned, and an unsupported-construct error rendering.
- CI gate per PR: typecheck, lint, unit tests, E2E, production build.

## Delivery: the daily loop

`SERVICES.yaml` at the repo root is the queue and the source of truth: every service in priority order with `status` (pending / in_progress / done), `tier` (generic / deep), and notes. A **scheduled cloud agent** runs daily, picks the next 3–5 pending entries, implements them (nav entry, icon, list-column overrides, deep screen where flagged), writes tests, runs the full gate, opens **one PR per day** titled with the services covered, and updates the queue in the same PR. Nothing merges itself; the human reviews at their pace.

Run 1 is structural rather than per-service: repo scaffolding, Cloudscape shell, endpoint switcher, catalog codegen, generic Resources/Actions layer, and CI — which lights up every discovered service at once. Later runs deepen them.

Every run is idempotent: the queue file records what is done, so an interrupted or duplicated run cannot lose or repeat work.

## Out of scope (v1)

Real-AWS targets; authentication/multi-user; persisted server-side state (endpoint list lives in browser storage); mobile layouts; CloudFormation/CDK visualization; cost or billing views.
