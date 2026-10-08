import { callOperation } from '../../api/client';
import type { Operation, ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';

/**
 * The SQS data layer: queues, their attributes, a non-consuming peek, sending,
 * purging, and the dead-letter relationships between queues.
 *
 * SQS has no "browse the queue" operation. `ReceiveMessage` is the only way to
 * see a message, and receiving one hides it for the queue's visibility timeout.
 * The closest honest thing to a peek is a receive with `VisibilityTimeout: 0`,
 * which returns the message and leaves it immediately visible again — that is
 * what `peekMessages` does, and the screen says so rather than implying SQS
 * offers a read-only view it does not have.
 */

export interface QueueSummary {
  /** The queue URL, which is what every other SQS operation takes. */
  url: string;
  /** Last path segment of the URL — what the console shows as the name. */
  name: string;
}

export interface RedrivePolicy {
  deadLetterTargetArn?: string;
  maxReceiveCount?: number;
}

export interface QueueAttributes {
  /** Every attribute the target returned, unmodified. */
  raw: Record<string, string>;
  arn?: string;
  visible?: number;
  notVisible?: number;
  delayed?: number;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  maximumMessageSize?: number;
  delaySeconds?: number;
  receiveWaitTime?: number;
  createdTimestamp?: number;
  lastModifiedTimestamp?: number;
  fifo: boolean;
  contentBasedDeduplication: boolean;
  kmsMasterKeyId?: string;
  sqsManagedSseEnabled?: boolean;
  /** Parsed `RedrivePolicy`, when the queue has one. */
  redrive?: RedrivePolicy;
}

export interface PeekedMessage {
  messageId: string;
  receiptHandle?: string;
  body: string;
  md5OfBody?: string;
  /** System attributes (`SentTimestamp`, `ApproximateReceiveCount`, …). */
  attributes: Record<string, string>;
  messageAttributes: { name: string; dataType?: string; value?: string }[];
}

export interface SendResult {
  messageId?: string;
  sequenceNumber?: string;
  md5OfBody?: string;
}

/** Most messages a single `ReceiveMessage` may return, per the SQS model. */
export const MAX_PEEK = 10;

/* ------------------------------------------------------------------ reading */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * The queue's name.
 *
 * A queue URL ends in `/{account}/{name}`; anything else (a target that hands
 * back something shorter) falls back to the URL itself so the row is still
 * identifiable.
 */
export function queueNameFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return segment === '' ? url : segment;
}

/** The queue name in an `arn:aws:sqs:region:account:name`. */
export function queueNameFromArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const match = /^arn:[^:]*:sqs:[^:]*:[^:]*:(.+)$/.exec(arn);
  return match ? match[1] : undefined;
}

export function readQueueUrls(output: unknown, key: 'QueueUrls' | 'queueUrls'): string[] {
  return asArray(asRecord(output)?.[key]).flatMap<string>(entry => {
    const url = asString(entry);
    return url ? [url] : [];
  });
}

/**
 * A `RedrivePolicy` attribute, which SQS carries as a JSON document inside the
 * attribute map. A policy the target wrote by hand may not parse; that is
 * reported as "no policy" rather than throwing the whole attribute read away.
 */
export function parseRedrivePolicy(value: string | undefined): RedrivePolicy | undefined {
  if (!value) return undefined;
  try {
    const parsed = asRecord(JSON.parse(value));
    if (!parsed) return undefined;
    const arn = asString(parsed.deadLetterTargetArn);
    const maxReceiveCount = asNumber(parsed.maxReceiveCount);
    if (!arn && maxReceiveCount === undefined) return undefined;
    return { deadLetterTargetArn: arn, maxReceiveCount };
  } catch {
    return undefined;
  }
}

export function readAttributes(output: unknown): QueueAttributes {
  const map = asRecord(asRecord(output)?.Attributes) ?? {};
  const raw: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    if (typeof value === 'string') raw[name] = value;
    else if (value !== undefined && value !== null) raw[name] = String(value);
  }
  return {
    raw,
    arn: raw.QueueArn,
    visible: asNumber(raw.ApproximateNumberOfMessages),
    notVisible: asNumber(raw.ApproximateNumberOfMessagesNotVisible),
    delayed: asNumber(raw.ApproximateNumberOfMessagesDelayed),
    visibilityTimeout: asNumber(raw.VisibilityTimeout),
    messageRetentionPeriod: asNumber(raw.MessageRetentionPeriod),
    maximumMessageSize: asNumber(raw.MaximumMessageSize),
    delaySeconds: asNumber(raw.DelaySeconds),
    receiveWaitTime: asNumber(raw.ReceiveMessageWaitTimeSeconds),
    createdTimestamp: asNumber(raw.CreatedTimestamp),
    lastModifiedTimestamp: asNumber(raw.LastModifiedTimestamp),
    fifo: raw.FifoQueue === 'true',
    contentBasedDeduplication: raw.ContentBasedDeduplication === 'true',
    kmsMasterKeyId: raw.KmsMasterKeyId,
    sqsManagedSseEnabled: raw.SqsManagedSseEnabled
      ? raw.SqsManagedSseEnabled === 'true'
      : undefined,
    redrive: parseRedrivePolicy(raw.RedrivePolicy),
  };
}

export function readMessages(output: unknown): PeekedMessage[] {
  return asArray(asRecord(output)?.Messages).flatMap<PeekedMessage>(entry => {
    const message = asRecord(entry);
    if (!message) return [];
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(asRecord(message.Attributes) ?? {})) {
      attributes[name] = typeof value === 'string' ? value : String(value);
    }
    const messageAttributes = Object.entries(asRecord(message.MessageAttributes) ?? {}).map(
      ([name, value]) => {
        const attribute = asRecord(value);
        return {
          name,
          dataType: asString(attribute?.DataType),
          // A binary attribute travels base64 in `BinaryValue`; it is shown as
          // that rather than decoded, since it is not necessarily text.
          value: asString(attribute?.StringValue) ?? asString(attribute?.BinaryValue),
        };
      },
    );
    return [
      {
        messageId: asString(message.MessageId) ?? '(no id)',
        receiptHandle: asString(message.ReceiptHandle),
        body: typeof message.Body === 'string' ? message.Body : '',
        md5OfBody: asString(message.MD5OfBody),
        attributes,
        messageAttributes,
      },
    ];
  });
}

/* ------------------------------------------------------------------ calling */

function operation(catalog: ServiceCatalog, name: string): Operation {
  const found = catalog.operations[name];
  if (!found) throw new Error(`The SQS model has no ${name} operation`);
  return found;
}

/** Follow a listing's own `NextToken` to the end. */
async function collectUrls(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  operationName: string,
  input: Record<string, unknown>,
  key: 'QueueUrls' | 'queueUrls',
  signal?: AbortSignal,
): Promise<string[]> {
  const op = operation(catalog, operationName);
  const collected: string[] = [];
  let token: string | undefined;
  // A target that echoes the same token forever would otherwise spin here.
  for (let page = 0; page < 20; page += 1) {
    const request = token ? { ...input, NextToken: token } : input;
    const result = await callOperation(endpoint, catalog, op, request, signal);
    collected.push(...readQueueUrls(result.output, key));
    const next = asString(asRecord(result.output)?.NextToken);
    if (!next || next === token) break;
    token = next;
  }
  return collected;
}

export async function fetchQueues(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  signal?: AbortSignal,
): Promise<QueueSummary[]> {
  const urls = await collectUrls(endpoint, catalog, 'ListQueues', {}, 'QueueUrls', signal);
  return urls.map(url => ({ url, name: queueNameFromUrl(url) }));
}

export async function fetchQueueAttributes(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  queueUrl: string,
  signal?: AbortSignal,
): Promise<QueueAttributes> {
  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'GetQueueAttributes'),
    { QueueUrl: queueUrl, AttributeNames: ['All'] },
    signal,
  );
  return readAttributes(result.output);
}

/**
 * Read messages without consuming them.
 *
 * `VisibilityTimeout: 0` is what makes this a peek: the messages come back and
 * stay visible to real consumers instead of disappearing for the queue's
 * timeout. `WaitTimeSeconds: 0` keeps it a short poll, so the screen answers
 * immediately when the queue is empty.
 *
 * Only `MessageSystemAttributeNames` is sent: SQS rejects a request that
 * carries both it and the deprecated `AttributeNames`.
 */
export async function peekMessages(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  queueUrl: string,
  count = MAX_PEEK,
  signal?: AbortSignal,
): Promise<PeekedMessage[]> {
  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'ReceiveMessage'),
    {
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(Math.max(count, 1), MAX_PEEK),
      VisibilityTimeout: 0,
      WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    },
    signal,
  );
  return readMessages(result.output);
}

export interface SendRequest {
  queueUrl: string;
  body: string;
  delaySeconds?: number;
  messageGroupId?: string;
  messageDeduplicationId?: string;
}

export async function sendMessage(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  request: SendRequest,
  signal?: AbortSignal,
): Promise<SendResult> {
  const input: Record<string, unknown> = {
    QueueUrl: request.queueUrl,
    MessageBody: request.body,
  };
  if (request.delaySeconds !== undefined) input.DelaySeconds = request.delaySeconds;
  if (request.messageGroupId) input.MessageGroupId = request.messageGroupId;
  if (request.messageDeduplicationId) {
    input.MessageDeduplicationId = request.messageDeduplicationId;
  }
  const result = await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'SendMessage'),
    input,
    signal,
  );
  const record = asRecord(result.output) ?? {};
  return {
    messageId: asString(record.MessageId),
    sequenceNumber: asString(record.SequenceNumber),
    md5OfBody: asString(record.MD5OfMessageBody),
  };
}

export async function purgeQueue(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  queueUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'PurgeQueue'),
    { QueueUrl: queueUrl },
    signal,
  );
}

export async function deleteMessage(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  queueUrl: string,
  receiptHandle: string,
  signal?: AbortSignal,
): Promise<void> {
  await callOperation(
    endpoint,
    catalog,
    operation(catalog, 'DeleteMessage'),
    { QueueUrl: queueUrl, ReceiptHandle: receiptHandle },
    signal,
  );
}

/** Queues that name this one as their dead-letter target. */
export async function fetchDeadLetterSourceQueues(
  endpoint: EndpointConfig,
  catalog: ServiceCatalog,
  queueUrl: string,
  signal?: AbortSignal,
): Promise<QueueSummary[]> {
  const urls = await collectUrls(
    endpoint,
    catalog,
    'ListDeadLetterSourceQueues',
    { QueueUrl: queueUrl },
    // The model spells this output member in lower camel case, unlike
    // `ListQueues` — the wire really does differ between the two.
    'queueUrls',
    signal,
  );
  return urls.map(url => ({ url, name: queueNameFromUrl(url) }));
}

/**
 * The queue a redrive policy points at, resolved against the queues actually
 * listed on the target. Matching is by name: the ARN's account and region come
 * from whatever the emulator stamps on it, which need not match the URL host.
 */
export function resolveDeadLetterQueue(
  redrive: RedrivePolicy | undefined,
  queues: QueueSummary[],
): QueueSummary | undefined {
  const name = queueNameFromArn(redrive?.deadLetterTargetArn);
  if (!name) return undefined;
  return queues.find(queue => queue.name === name);
}
