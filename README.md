# glaux-console 🦉

**A web console for local AWS emulators that actually looks like the AWS console.**

Local emulators ([glaux](https://github.com/liorknafo/glaux), fakecloud, MiniStack, LocalStack, MinIO) give you the APIs; the existing open-source browsers give you a generic dashboard on top. glaux-console is built from [Cloudscape](https://cloudscape.design/) — the Apache-2.0 design system AWS builds its own console with — so the shell, navigation, tables, and editors are the real thing.

- **Every service, every operation.** UIs are generated from AWS's public service models, so whatever your emulator implements gets a browsable resource list and a working form — with the equivalent `aws` CLI command shown next to it.
- **The analytics screens nobody else has.** A real Athena query editor (schema tree, results, bytes scanned, query history), a Glue catalog browser, and Firehose delivery monitoring.
- **Local only, by design.** The backend refuses real-AWS endpoints — full CRUD against production is designed out, not warned about.

Not affiliated with, or endorsed by, Amazon Web Services. No AWS logos or trademarks are used.

## Status

Pre-implementation. The design spec is [`docs/specs/2026-08-21-glaux-console-design.md`](docs/specs/2026-08-21-glaux-console-design.md); [`SERVICES.yaml`](SERVICES.yaml) is the work queue a daily agent works through, a few entries at a time, one PR per day.

## License

Apache-2.0.
