import type { Operation, ServiceCatalog, Shape, ShapeRef } from '../catalog/types';
import { mergeRef, resolveShape } from '../catalog/types';
import { buildXml, type XmlElement } from './xml';
import type { WireRequest } from './types';

/**
 * Turns an operation plus a plain-JS input object into the HTTP request the
 * target endpoint expects, for each AWS wire protocol the catalog covers.
 *
 * Serialization lives in the browser (it needs the catalog, which the browser
 * already has); signing and the safety check live in the console backend.
 */
export function serializeRequest(
  catalog: ServiceCatalog,
  operation: Operation,
  input: Record<string, unknown>,
): WireRequest {
  switch (catalog.metadata.protocol) {
    case 'json':
      return serializeJson(catalog, operation, input);
    case 'rest-json':
      return serializeRest(catalog, operation, input, 'json');
    case 'rest-xml':
      return serializeRest(catalog, operation, input, 'xml');
    case 'query':
    case 'ec2':
      return serializeQuery(catalog, operation, input, catalog.metadata.protocol === 'ec2');
    default:
      throw new Error(`Unsupported protocol: ${catalog.metadata.protocol}`);
  }
}

/* ------------------------------------------------------------------ json */

function serializeJson(
  catalog: ServiceCatalog,
  operation: Operation,
  input: Record<string, unknown>,
): WireRequest {
  const version = catalog.metadata.jsonVersion ?? '1.1';
  const body = operation.input
    ? JSON.stringify(toJsonValue(catalog, { shape: operation.input }, input, 'unixTimestamp'))
    : '{}';
  return {
    method: 'POST',
    path: '/',
    query: {},
    headers: {
      'content-type': `application/x-amz-json-${version}`,
      'x-amz-target': `${catalog.metadata.targetPrefix ?? catalog.metadata.serviceId}.${operation.name}`,
    },
    body,
    bodyEncoding: 'utf8',
  };
}

/* ------------------------------------------------------- rest-json / xml */

function serializeRest(
  catalog: ServiceCatalog,
  operation: Operation,
  input: Record<string, unknown>,
  bodyFormat: 'json' | 'xml',
): WireRequest {
  const [uriTemplate, staticQuery] = splitRequestUri(operation.http.requestUri);
  const query: Record<string, string | string[]> = { ...staticQuery };
  const headers: Record<string, string> = {};
  const bodyMembers: Record<string, unknown> = {};

  const inputShape = operation.input ? catalog.shapes[operation.input] : undefined;
  const members = inputShape?.members ?? {};
  const uriValues: Record<string, string> = {};
  let rawPayload: { value: unknown; ref: ShapeRef } | undefined;

  for (const [name, ref] of Object.entries(members)) {
    const value = input[name];
    if (value === undefined || value === null || value === '') continue;
    const wireName = ref.locationName ?? name;
    switch (ref.location) {
      case 'uri':
        uriValues[wireName] = String(value);
        break;
      case 'querystring':
        query[wireName] = toQueryValue(catalog, ref, value);
        break;
      case 'header': {
        // Modelled header timestamps default to rfc822; String(Date) would send
        // a locale string the target rejects.
        const headerShape = mergeRef(ref, resolveShape(catalog, ref));
        headers[wireName.toLowerCase()] =
          headerShape.type === 'timestamp'
            ? formatTimestamp(value, ref.timestampFormat ?? headerShape.timestampFormat ?? 'rfc822')
            : String(value);
        break;
      }
      case 'headers':
        for (const [key, headerValue] of Object.entries(value as Record<string, string>)) {
          headers[`${wireName}${key}`.toLowerCase()] = String(headerValue);
        }
        break;
      default:
        if (inputShape?.payload === name) rawPayload = { value, ref };
        else bodyMembers[name] = value;
    }
  }

  const path = fillUriTemplate(uriTemplate, uriValues);
  const request: WireRequest = { method: operation.http.method, path, query, headers };

  if (rawPayload) {
    const payloadShape = resolveShape(catalog, rawPayload.ref);
    if (payloadShape && (payloadShape.type === 'blob' || payloadShape.type === 'string')) {
      request.body = String(rawPayload.value);
      request.bodyEncoding = payloadShape.type === 'blob' ? 'base64' : 'utf8';
    } else if (bodyFormat === 'xml') {
      request.body = renderXmlBody(
        catalog,
        rawPayload.ref,
        rawPayload.value,
        rawPayload.ref.locationName ?? operation.inputLocationName ?? String(rawPayload.ref.shape),
        operation.inputXmlNamespace ?? catalog.metadata.xmlNamespace,
      );
      request.bodyEncoding = 'utf8';
      request.headers['content-type'] = 'application/xml';
    } else {
      request.body = JSON.stringify(
        toJsonValue(catalog, rawPayload.ref, rawPayload.value, 'iso8601'),
      );
      request.bodyEncoding = 'utf8';
      request.headers['content-type'] = 'application/json';
    }
  } else if (Object.keys(bodyMembers).length > 0 && inputShape) {
    if (bodyFormat === 'xml') {
      request.body = renderXmlBody(
        catalog,
        { shape: operation.input },
        bodyMembers,
        operation.inputLocationName ?? `${operation.name}Request`,
        operation.inputXmlNamespace ?? catalog.metadata.xmlNamespace,
      );
      request.headers['content-type'] = 'application/xml';
    } else {
      request.body = JSON.stringify(
        toJsonValue(catalog, { shape: operation.input }, bodyMembers, 'iso8601'),
      );
      request.headers['content-type'] = 'application/json';
    }
    request.bodyEncoding = 'utf8';
  }

  return request;
}

/** `/{Bucket}?list-type=2` -> template plus the query pairs baked into the model. */
export function splitRequestUri(requestUri: string): [string, Record<string, string>] {
  const index = requestUri.indexOf('?');
  if (index === -1) return [requestUri, {}];
  const query: Record<string, string> = {};
  for (const pair of requestUri.slice(index + 1).split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=');
    query[key] = value;
  }
  return [requestUri.slice(0, index), query];
}

export function fillUriTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, label: string) => {
    const greedy = label.endsWith('+');
    const key = greedy ? label.slice(0, -1) : label;
    const value = values[key] ?? '';
    // Greedy labels are path segments (S3 keys); normal labels are single segments.
    return greedy ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);
  });
}

function toQueryValue(catalog: ServiceCatalog, ref: ShapeRef, value: unknown): string | string[] {
  const shape = mergeRef(ref, resolveShape(catalog, ref));
  if (shape.type === 'list' && Array.isArray(value)) return value.map(String);
  if (shape.type === 'timestamp') return formatTimestamp(value, ref.timestampFormat ?? 'iso8601');
  return String(value);
}

/* ----------------------------------------------------------------- query */

function serializeQuery(
  catalog: ServiceCatalog,
  operation: Operation,
  input: Record<string, unknown>,
  ec2: boolean,
): WireRequest {
  const pairs: [string, string][] = [
    ['Action', operation.name],
    ['Version', catalog.metadata.apiVersion],
  ];
  if (operation.input) {
    flattenQuery(catalog, { shape: operation.input }, input, '', pairs, ec2);
  }
  const body = pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return {
    method: 'POST',
    path: '/',
    query: {},
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
    bodyEncoding: 'utf8',
  };
}

function flattenQuery(
  catalog: ServiceCatalog,
  ref: ShapeRef,
  value: unknown,
  prefix: string,
  pairs: [string, string][],
  ec2: boolean,
): void {
  if (value === undefined || value === null || value === '') return;
  const shape = mergeRef(ref, resolveShape(catalog, ref));

  switch (shape.type) {
    case 'structure': {
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        const wireName = ec2
          ? (member.queryName ?? capitalize(member.locationName ?? name))
          : (member.queryName ?? member.locationName ?? name);
        flattenQuery(
          catalog,
          member,
          (value as Record<string, unknown>)[name],
          prefix ? `${prefix}.${wireName}` : wireName,
          pairs,
          ec2,
        );
      }
      return;
    }
    case 'list': {
      const items = Array.isArray(value) ? value : [value];
      const flattened = ec2 || ref.flattened || shape.flattened;
      const memberName = shape.member?.locationName ?? 'member';
      items.forEach((item, index) => {
        const itemPrefix = flattened
          ? `${prefix}.${index + 1}`
          : `${prefix}.${memberName}.${index + 1}`;
        flattenQuery(catalog, shape.member ?? {}, item, itemPrefix, pairs, ec2);
      });
      return;
    }
    case 'map': {
      const flattened = ref.flattened || shape.flattened;
      const keyName = shape.key?.locationName ?? 'key';
      const valueName = shape.value?.locationName ?? 'value';
      Object.entries(value as Record<string, unknown>).forEach(([key, entryValue], index) => {
        const entryPrefix = flattened ? `${prefix}.${index + 1}` : `${prefix}.entry.${index + 1}`;
        pairs.push([`${entryPrefix}.${keyName}`, key]);
        flattenQuery(
          catalog,
          shape.value ?? {},
          entryValue,
          `${entryPrefix}.${valueName}`,
          pairs,
          ec2,
        );
      });
      return;
    }
    case 'timestamp':
      pairs.push([prefix, formatTimestamp(value, ref.timestampFormat ?? 'iso8601')]);
      return;
    case 'blob':
      pairs.push([prefix, String(value)]);
      return;
    default:
      pairs.push([prefix, String(value)]);
  }
}

/* ------------------------------------------------------------- json body */

function toJsonValue(
  catalog: ServiceCatalog,
  ref: ShapeRef,
  value: unknown,
  timestampDefault: 'iso8601' | 'unixTimestamp',
): unknown {
  if (value === undefined || value === null) return value;
  const shape = mergeRef(ref, resolveShape(catalog, ref));

  switch (shape.type) {
    case 'structure': {
      if (shape.document) return value;
      const out: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        const memberValue = (value as Record<string, unknown>)[name];
        if (memberValue === undefined || memberValue === null || memberValue === '') continue;
        out[member.locationName ?? name] = toJsonValue(
          catalog,
          member,
          memberValue,
          timestampDefault,
        );
      }
      return out;
    }
    case 'list':
      return (Array.isArray(value) ? value : [value]).map(item =>
        toJsonValue(catalog, shape.member ?? {}, item, timestampDefault),
      );
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = toJsonValue(catalog, shape.value ?? {}, entry, timestampDefault);
      }
      return out;
    }
    case 'timestamp': {
      const format = ref.timestampFormat ?? shape.timestampFormat ?? timestampDefault;
      const formatted = formatTimestamp(value, format);
      return format === 'unixTimestamp' ? Number(formatted) : formatted;
    }
    case 'integer':
    case 'long':
    case 'float':
    case 'double':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true';
    default:
      return value;
  }
}

/* -------------------------------------------------------------- xml body */

function renderXmlBody(
  catalog: ServiceCatalog,
  ref: ShapeRef,
  value: unknown,
  rootName: string,
  namespace: string | undefined,
): string {
  const element = toXmlElement(catalog, ref, value, rootName);
  if (namespace) element.attributes = { ...element.attributes, xmlns: namespace };
  return `<?xml version="1.0" encoding="UTF-8"?>${buildXml(element)}`;
}

function toXmlElement(
  catalog: ServiceCatalog,
  ref: ShapeRef,
  value: unknown,
  name: string,
): XmlElement {
  const shape = mergeRef(ref, resolveShape(catalog, ref));
  switch (shape.type) {
    case 'structure': {
      const children: XmlElement[] = [];
      const attributes: Record<string, string> = {};
      for (const [memberName, member] of Object.entries(shape.members ?? {})) {
        const memberValue = (value as Record<string, unknown>)[memberName];
        if (memberValue === undefined || memberValue === null || memberValue === '') continue;
        if (member.location) continue;
        const wireName = member.locationName ?? memberName;
        if (member.xmlAttribute) {
          attributes[wireName] = String(memberValue);
          continue;
        }
        const memberShape = mergeRef(member, resolveShape(catalog, member));
        if (memberShape.type === 'list' && (member.flattened || memberShape.flattened)) {
          for (const item of memberValue as unknown[]) {
            children.push(toXmlElement(catalog, memberShape.member ?? {}, item, wireName));
          }
        } else {
          children.push(toXmlElement(catalog, member, memberValue, wireName));
        }
      }
      return { name, attributes, children };
    }
    case 'list': {
      const memberName = shape.member?.locationName ?? 'member';
      return {
        name,
        children: (value as unknown[]).map(item =>
          toXmlElement(catalog, shape.member ?? {}, item, memberName),
        ),
      };
    }
    case 'map': {
      const keyName = shape.key?.locationName ?? 'key';
      const valueName = shape.value?.locationName ?? 'value';
      return {
        name,
        children: Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({
          name: 'entry',
          children: [
            { name: keyName, text: key },
            toXmlElement(catalog, shape.value ?? {}, entry, valueName),
          ],
        })),
      };
    }
    case 'timestamp':
      return { name, text: formatTimestamp(value, ref.timestampFormat ?? 'iso8601') };
    default:
      return { name, text: String(value) };
  }
}

/* ---------------------------------------------------------------- shared */

export function formatTimestamp(
  value: unknown,
  format: 'iso8601' | 'unixTimestamp' | 'rfc822',
): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value * 1000)
        : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  switch (format) {
    case 'unixTimestamp':
      return String(Math.floor(date.getTime() / 1000));
    case 'rfc822':
      return date.toUTCString();
    default:
      return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Members of an operation's input shape, in model order, with traits merged. */
export function inputMembers(
  catalog: ServiceCatalog,
  operation: Operation,
): { name: string; ref: ShapeRef; shape: Shape; required: boolean }[] {
  const inputShape = operation.input ? catalog.shapes[operation.input] : undefined;
  if (!inputShape?.members) return [];
  const required = new Set(inputShape.required ?? []);
  return Object.entries(inputShape.members).map(([name, ref]) => ({
    name,
    ref,
    shape: mergeRef(ref, resolveShape(catalog, ref)),
    required: required.has(name),
  }));
}
