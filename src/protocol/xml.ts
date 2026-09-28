/**
 * Minimal XML helpers for the `query`, `ec2` and `rest-xml` protocols.
 *
 * Parsing is shape-aware (see `parse.ts`) — this module only turns text into a
 * DOM and objects into XML text.
 */

export function parseXmlDocument(text: string): Element | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const doc = new DOMParser().parseFromString(trimmed, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Target returned a body that is not well-formed XML');
  }
  return doc.documentElement ?? undefined;
}

export function childElements(node: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
    if (!name || localName(child) === name) out.push(child);
  }
  return out;
}

export function firstChild(node: Element, name: string): Element | undefined {
  for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
    if (localName(child) === name) return child;
  }
  return undefined;
}

/** Namespace prefixes vary between emulators; compare on the local name only. */
export function localName(node: Element): string {
  const tag = node.tagName;
  const colon = tag.indexOf(':');
  return colon === -1 ? tag : tag.slice(colon + 1);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface XmlElement {
  name: string;
  attributes?: Record<string, string>;
  children?: XmlElement[];
  text?: string;
}

export function buildXml(element: XmlElement): string {
  const attributes = Object.entries(element.attributes ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  const inner = element.children?.length
    ? element.children.map(buildXml).join('')
    : element.text !== undefined
      ? escapeXml(element.text)
      : '';
  if (!inner) return `<${element.name}${attributes}/>`;
  return `<${element.name}${attributes}>${inner}</${element.name}>`;
}
