/** The HTTP envelope the console backend forwards to the target endpoint. */
export interface WireRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body?: string;
  /** How `body` is encoded. Blobs and streaming payloads travel base64. */
  bodyEncoding?: 'utf8' | 'base64';
}

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
}

export class ServiceCallError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ServiceCallError';
  }
}
