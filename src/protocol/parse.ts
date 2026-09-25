import type { Operation, ServiceCatalog, ShapeRef } from '../catalog/types';
import { mergeRef, resolveShape } from '../catalog/types';
import { ServiceCallError, type WireResponse } from './types';
import { childElements, firstChild, localName, parseXmlDocument } from './xml';

/**
 * Turns a target's HTTP response into a plain JS object shaped by the
 * operation's output model, or throws a `ServiceCallError` carrying whatever
 * the target reported.
 */
export function parseResponse(
  catalog: ServiceCatalog,
  operation: Operation,
  response: WireResponse,
): unknown {
  const text = response.bodyEncoding === 'base64' ? decodeBase64(response.body) : response.body;

  if (response.status >= 400) {
    throw toServiceError(catalog, response, text);
  }

  switch (catalog.metadata.protocol) {
    case 'json':
    case 'rest-json': {
      const raw = text.trim() ? safeJsonParse(text) : {};
      // The wire uses `locationName` where the model declares one, so the keys
      // coming back are not always the modelled member names the UI reads by.
      const parsed = operation.output ? fromJson(catalog, { shape: operation.output }, raw) : raw;
      return mergeHeaderMembers(catalog, operation, response, parsed, text);
    }
    case 'query':
    case 'ec2':
    case 'rest-xml': {
      // An operation whose output payload is a raw string or blob does not
      // return XML at all — S3's GetBucketPolicy returns JSON and GetObject
      // returns the object itself. Parsing those as XML throws.
      if (hasRawPayload(catalog, operation)) {
        return mergeHeaderMembers(catalog, operation, response, {}, text);
      }
      const root = text.trim() ? parseXmlDocument(text) : undefined;
      if (!root) return mergeHeaderMembers(catalog, operation, response, {}, text);
      const payload = unwrapResult(root, operation);
      const outputRef: ShapeRef | undefined = operation.output
        ? { shape: operation.output }
        : undefined;
      const parsed = outputRef ? fromXml(catalog, outputRef, payload) : xmlToPlain(payload);
      return mergeHeaderMembers(
        catalog,
        operation,
        response,
        parsed as Record<string, unknown>,
        text,
      );
    }
    default:
      return safeJsonParse(text);
  }
}

/** True when the operation's output body is the payload member verbatim. */
function hasRawPayload(catalog: ServiceCatalog, operation: Operation): boolean {
  const outputShape = operation.output ? catalog.shapes[operation.output] : undefined;
  const payload = outputShape?.payload;
  if (!payload) return false;
  const ref = outputShape?.members?.[payload];
  const shape = ref?.shape ? catalog.shapes[ref.shape] : undefined;
  return shape?.type === 'blob' || shape?.type === 'string';
}

/** `<OpResponse><OpResult>…</OpResult></OpResponse>` -> the result element. */
function unwrapResult(root: Element, operation: Operation): Element {
  const wrapper = operation.outputResultWrapper ?? `${operation.name}Result`;
  return firstChild(root, wrapper) ?? root;
}

function mergeHeaderMembers(
  catalog: ServiceCatalog,
  operation: Operation,
  response: WireResponse,
  parsed: unknown,
  text: string,
): unknown {
  const outputShape = operation.output ? catalog.shapes[operation.output] : undefined;
  if (!outputShape?.members || typeof parsed !== 'object' || parsed === null) return parsed;
  const out = parsed as Record<string, unknown>;
  for (const [name, ref] of Object.entries(outputShape.members)) {
    if (ref.location === 'header') {
      const value = response.headers[(ref.locationName ?? name).toLowerCase()];
      if (value !== undefined) out[name] = value;
    } else if (ref.location === 'statusCode') {
      out[name] = response.status;
    } else if (outputShape.payload === name && ref.shape) {
      const payloadShape = catalog.shapes[ref.shape];
      if (payloadShape && (payloadShape.type === 'blob' || payloadShape.type === 'string')) {
        // A blob payload stays as the backend encoded it; a string payload is
        // the decoded text, never the base64 the transport happened to use.
        out[name] = payloadShape.type === 'blob' ? response.body : text;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ json */

/**
 * Walks a JSON body against the output shape, mapping wire keys back to their
 * modelled member names. `rest-json` services such as API Gateway and Amazon MQ
 * declare `locationName` on output members, so returning the raw keys would
 * leave those fields reading as undefined everywhere in the UI.
 */
function fromJson(catalog: ServiceCatalog, ref: ShapeRef, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const shape = mergeRef(ref, resolveShape(catalog, ref));

  switch (shape.type) {
    case 'structure': {
      if (shape.document || typeof value !== 'object' || Array.isArray(value)) return value;
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const claimed = new Set<string>();
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        if (member.location === 'header' || member.location === 'statusCode') continue;
        const wireName = member.locationName ?? name;
        if (!(wireName in source)) continue;
        claimed.add(wireName);
        out[name] = fromJson(catalog, member, source[wireName]);
      }
      // Anything the model does not describe is still shown rather than dropped.
      for (const [key, entry] of Object.entries(source)) {
        if (!claimed.has(key) && !(key in out)) out[key] = entry;
      }
      return out;
    }
    case 'list':
      return Array.isArray(value)
        ? value.map(item => fromJson(catalog, shape.member ?? {}, item))
        : value;
    case 'map': {
      if (typeof value !== 'object' || Array.isArray(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = fromJson(catalog, shape.value ?? {}, entry);
      }
      return out;
    }
    default:
      return value;
  }
}

/* ------------------------------------------------------------------- xml */

function fromXml(catalog: ServiceCatalog, ref: ShapeRef, node: Element): unknown {
  const shape = mergeRef(ref, resolveShape(catalog, ref));

  switch (shape.type) {
    case 'structure': {
      const out: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        if (member.location === 'header' || member.location === 'statusCode') continue;
        const wireName = member.locationName ?? name;
        const memberShape = mergeRef(member, resolveShape(catalog, member));

        if (member.xmlAttribute) {
          const attribute = node.getAttribute(wireName);
          if (attribute !== null) out[name] = attribute;
          continue;
        }

        if (memberShape.type === 'list' && (member.flattened || memberShape.flattened)) {
          const items = childElements(node, wireName);
          if (items.length) {
            out[name] = items.map(item => fromXml(catalog, memberShape.member ?? {}, item));
          }
          continue;
        }

        const child = firstChild(node, wireName);
        if (child) out[name] = fromXml(catalog, member, child);
      }
      return out;
    }
    case 'list': {
      const memberName = shape.member?.locationName ?? 'member';
      return childElements(node, memberName).map(item =>
        fromXml(catalog, shape.member ?? {}, item),
      );
    }
    case 'map': {
      const keyName = shape.key?.locationName ?? 'key';
      const valueName = shape.value?.locationName ?? 'value';
      const entries =
        shape.flattened || ref.flattened ? childElements(node) : childElements(node, 'entry');
      const out: Record<string, unknown> = {};
      for (const entry of entries) {
        const key = firstChild(entry, keyName)?.textContent ?? '';
        const valueNode = firstChild(entry, valueName);
        out[key] = valueNode ? fromXml(catalog, shape.value ?? {}, valueNode) : null;
      }
      return out;
    }
    case 'integer':
    case 'long':
    case 'float':
    case 'double': {
      const text = node.textContent ?? '';
      const numeric = Number(text);
      return text.trim() === '' || Number.isNaN(numeric) ? text : numeric;
    }
    case 'boolean':
      return (node.textContent ?? '').trim() === 'true';
    default:
      return node.textContent ?? '';
  }
}

/** Fallback for responses with no modelled output shape. */
function xmlToPlain(node: Element): unknown {
  const children = childElements(node);
  if (!children.length) return node.textContent ?? '';
  const out: Record<string, unknown> = {};
  for (const child of children) {
    const key = localName(child);
    const value = xmlToPlain(child);
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/* ----------------------------------------------------------------- error */

function toServiceError(
  catalog: ServiceCatalog,
  response: WireResponse,
  text: string,
): ServiceCallError {
  const jsonProtocol =
    catalog.metadata.protocol === 'json' || catalog.metadata.protocol === 'rest-json';

  if (jsonProtocol) {
    const parsed = text.trim() ? tryJsonParse(text) : undefined;
    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>;
      const rawCode =
        (body.__type as string) ??
        (body.code as string) ??
        response.headers['x-amzn-errortype'] ??
        'UnknownError';
      const message =
        (body.message as string) ??
        (body.Message as string) ??
        (body.errorMessage as string) ??
        text;
      return new ServiceCallError(message, cleanErrorCode(rawCode), response.status, parsed);
    }
    return new ServiceCallError(text || `HTTP ${response.status}`, 'UnknownError', response.status);
  }

  try {
    const root = text.trim() ? parseXmlDocument(text) : undefined;
    if (root) {
      const errorNode = firstChild(root, 'Error') ?? root;
      const code = firstChild(errorNode, 'Code')?.textContent ?? 'UnknownError';
      const message = firstChild(errorNode, 'Message')?.textContent ?? text;
      return new ServiceCallError(message, code, response.status, xmlToPlain(root));
    }
  } catch {
    // fall through to the raw body
  }
  return new ServiceCallError(text || `HTTP ${response.status}`, 'UnknownError', response.status);
}

/** `com.amazonaws.athena#InvalidRequestException` -> `InvalidRequestException`. */
export function cleanErrorCode(code: string): string {
  const hash = code.lastIndexOf('#');
  const trimmed = hash === -1 ? code : code.slice(hash + 1);
  const colon = trimmed.indexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function tryJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string): string {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}
