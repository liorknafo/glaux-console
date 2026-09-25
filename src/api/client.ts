import type { Operation, ServiceCatalog } from '../catalog/types';
import { parseResponse } from '../protocol/parse';
import { serializeRequest } from '../protocol/serialize';
import { ServiceCallError, type WireRequest, type WireResponse } from '../protocol/types';
import type { EndpointConfig } from '../endpoints/store';

/**
 * The browser half of the request path. It builds the wire request from the
 * catalog and hands it to the console backend, which signs and forwards it.
 * The browser never talks to the target endpoint directly.
 */

export interface BackendResult extends WireResponse {
  durationMs: number;
}

export interface BackendRefusal {
  message: string;
  refused?: boolean;
  unreachable?: boolean;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly refused: boolean,
    readonly unreachable: boolean,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export async function sendWireRequest(
  endpoint: EndpointConfig,
  request: WireRequest,
  signingName: string,
  signal?: AbortSignal,
): Promise<BackendResult> {
  const response = await fetch('api/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      endpoint: endpoint.url,
      region: endpoint.region,
      signingName,
      method: request.method,
      path: request.path,
      query: request.query,
      headers: request.headers,
      body: request.body,
      bodyEncoding: request.bodyEncoding,
    }),
  });

  const payload = (await response.json()) as BackendResult & BackendRefusal;
  if (!response.ok) {
    throw new BackendError(
      payload.message ?? `Console backend returned HTTP ${response.status}`,
      Boolean(payload.refused),
      Boolean(payload.unreachable),
    );
  }
  return payload;
}

export interface CallResult {
  output: unknown;
  durationMs: number;
  status: number;
  request: WireRequest;
}

export async function callOperation(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  operation: Operation,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallResult> {
  const request = serializeRequest(catalog, operation, input);
  const response = await sendWireRequest(endpoint, request, catalog.metadata.signingName, signal);
  const output = parseResponse(catalog, operation, response);
  return { output, durationMs: response.durationMs, status: response.status, request };
}

export function describeError(error: unknown): { header: string; detail: string } {
  if (error instanceof ServiceCallError) {
    return { header: `${error.code} (HTTP ${error.status})`, detail: error.message };
  }
  if (error instanceof BackendError) {
    if (error.refused) return { header: 'Endpoint refused', detail: error.message };
    if (error.unreachable) return { header: 'Target unreachable', detail: error.message };
    return { header: 'Console backend error', detail: error.message };
  }
  if (error instanceof Error) return { header: error.name, detail: error.message };
  return { header: 'Error', detail: String(error) };
}
