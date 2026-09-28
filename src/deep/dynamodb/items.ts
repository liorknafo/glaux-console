/**
 * DynamoDB's attribute-value encoding, in both directions.
 *
 * Every value DynamoDB carries is tagged with its type — `{"S": "a"}`,
 * `{"N": "1"}`, `{"L": [...]}`. That form is exact, so the item editor edits it
 * directly; the plain form is what the table columns and the read-only preview
 * show, because `{"total": 19.5}` is what the item means.
 *
 * The plain form is lossy in three places, and the screen says so rather than
 * pretending otherwise:
 *
 *  - a set (`SS`/`NS`/`BS`) becomes a list, since JSON has no set;
 *  - binary (`B`) stays the base64 the wire carried, because the bytes need not
 *    be text;
 *  - a number too large for a JS double keeps its digits as a string rather
 *    than being rounded to something that is not the stored value.
 */

export type AttributeValue = Record<string, unknown>;
export type Item = Record<string, AttributeValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A DynamoDB number as a JS value: a number when the digits survive the round
 * trip through a double, and the original string when they do not.
 */
export function readNumber(digits: unknown): number | string {
  if (typeof digits !== 'string') return typeof digits === 'number' ? digits : String(digits);
  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) return digits;
  return String(parsed) === digits.trim() ? parsed : digits;
}

/** One attribute value in plain JSON. */
export function toPlain(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const [tag] = keys;
  const inner = value[tag];
  switch (tag) {
    case 'S':
      return inner;
    case 'N':
      return readNumber(inner);
    case 'B':
      return inner;
    case 'BOOL':
      return Boolean(inner);
    case 'NULL':
      return null;
    case 'L':
      return Array.isArray(inner) ? inner.map(toPlain) : [];
    case 'M':
      return isRecord(inner) ? plainItem(inner as Item) : {};
    case 'SS':
    case 'BS':
      return Array.isArray(inner) ? inner : [];
    case 'NS':
      return Array.isArray(inner) ? inner.map(readNumber) : [];
    default:
      // Not an attribute value the model declares; shown as it arrived rather
      // than silently dropped.
      return value;
  }
}

/** A whole item in plain JSON. */
export function plainItem(item: Item | undefined): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(item ?? {})) plain[name] = toPlain(value);
  return plain;
}

/**
 * Plain JSON back to attribute values.
 *
 * A list is always `L` and never a set: nothing in `["a","b"]` says which was
 * meant, and guessing would write a different item than the one on screen.
 */
export function fromPlain(value: unknown): AttributeValue {
  if (value === null) return { NULL: true };
  switch (typeof value) {
    case 'string':
      return { S: value };
    case 'boolean':
      return { BOOL: value };
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`${value} is not a number DynamoDB can store`);
      return { N: String(value) };
    case 'object':
      if (Array.isArray(value)) return { L: value.map(fromPlain) };
      return { M: toItem(value as Record<string, unknown>) };
    default:
      throw new Error(`A ${typeof value} is not a value DynamoDB can store`);
  }
}

export function toItem(plain: Record<string, unknown>): Item {
  const item: Item = {};
  for (const [name, value] of Object.entries(plain)) {
    if (value === undefined) continue;
    item[name] = fromPlain(value);
  }
  return item;
}

/**
 * Is this a well-formed item — a map of attribute names to tagged values?
 *
 * The editor writes what the user typed straight to `PutItem`, so a typo like
 * `{"pk": "a"}` has to be caught here rather than becoming a service error that
 * does not say which attribute was wrong.
 */
export function itemProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['An item must be a JSON object of attribute names to values.'];
  const problems: string[] = [];
  for (const [name, attribute] of Object.entries(value)) {
    if (!isRecord(attribute)) {
      problems.push(`"${name}" must be a tagged value such as {"S": "..."} or {"N": "1"}.`);
      continue;
    }
    const keys = Object.keys(attribute);
    if (keys.length !== 1) {
      problems.push(`"${name}" must carry exactly one type tag, not ${keys.length}.`);
      continue;
    }
    if (!ATTRIBUTE_TAGS.has(keys[0])) {
      problems.push(
        `"${name}" is tagged "${keys[0]}"; DynamoDB types are ${[...ATTRIBUTE_TAGS].join(', ')}.`,
      );
    }
  }
  return problems;
}

const ATTRIBUTE_TAGS = new Set(['S', 'N', 'B', 'SS', 'NS', 'BS', 'M', 'L', 'NULL', 'BOOL']);

/**
 * The columns a page of items should show.
 *
 * The key attributes come first and always, then every other attribute in the
 * order the items introduce it — so a table with a ragged schema still shows
 * every attribute that is actually present, and the key never scrolls off.
 */
export function columnsFor(items: Item[], keyAttributes: string[]): string[] {
  const columns = [...keyAttributes];
  for (const item of items) {
    for (const name of Object.keys(item)) {
      if (!columns.includes(name)) columns.push(name);
    }
  }
  return columns;
}

/** One cell, as short display text. */
export function cellText(value: unknown): string {
  if (value === undefined) return '';
  const plain = toPlain(value);
  if (plain === null) return 'null';
  if (typeof plain === 'string') return plain;
  if (typeof plain === 'number' || typeof plain === 'boolean') return String(plain);
  return JSON.stringify(plain) ?? '';
}

/** The key of an item, for `DeleteItem` and for naming it in a confirmation. */
export function keyOf(item: Item, keyAttributes: string[]): Item {
  const key: Item = {};
  for (const name of keyAttributes) {
    if (item[name] !== undefined) key[name] = item[name];
  }
  return key;
}

/** A key rendered the way the console names an item: `pk=a, sk=1`. */
export function describeKey(item: Item, keyAttributes: string[]): string {
  return keyAttributes.map(name => `${name}=${cellText(item[name])}`).join(', ');
}
