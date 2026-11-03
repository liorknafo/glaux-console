import type { LookupAddress } from 'node:dns';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Types for the console backend, which is plain ESM so the same file can be
 * mounted by the standalone server, the Vite dev server, and the tests.
 */
export declare function createProxyHandler(options?: {
  fetchImpl?: typeof fetch;
  /** Overrides the DNS lookup the local-only destination check runs. Tests only. */
  lookupImpl?: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<LookupAddress[]>;
}): (req: IncomingMessage, res: ServerResponse, next?: () => void) => Promise<void>;
