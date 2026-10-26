/**
 * EventBridge event-pattern matching, evaluated in the browser.
 *
 * The pattern tester answers here rather than through the target's
 * `TestEventPattern` operation: the answer is then the same whatever the
 * emulator implements, it arrives as you type, and — the point of the screen —
 * a mismatch can say *which* part of the pattern rejected the event instead of
 * just "false".
 *
 * The grammar implemented is AWS's documented content filtering: exact values,
 * nested objects, `$or`, and the comparison operators `prefix`, `suffix`,
 * `anything-but`, `numeric`, `exists`, `cidr`, `equals-ignore-case` and
 * `wildcard`. Anything outside it is reported as unsupported by
 * `validateEventPattern` rather than quietly evaluated as a mismatch — a
 * tester that is silently wrong is worse than one that says it does not know.
 */

export type NumericOperator = '=' | '!=' | '<' | '<=' | '>' | '>=';

const NUMERIC_OPERATORS: NumericOperator[] = ['=', '!=', '<', '<=', '>', '>='];

/** Operators that may appear as the single key of a matcher object. */
export const MATCH_OPERATORS = [
  'prefix',
  'suffix',
  'anything-but',
  'numeric',
  'exists',
  'cidr',
  'equals-ignore-case',
  'wildcard',
] as const;

export type MatchOperator = (typeof MATCH_OPERATORS)[number];

/** Operators whose argument may itself be `{"equals-ignore-case": "..."}`. */
const CASE_INSENSITIVE_ARGUMENT = new Set<MatchOperator>(['prefix', 'suffix']);

export interface PatternProblem {
  /** Dotted path into the pattern, e.g. `detail.state`. */
  path: string;
  message: string;
}

export interface MatchResult {
  matched: boolean;
  /** On a mismatch, the pattern path that rejected the event. */
  path?: string;
  /** On a mismatch, what that path required. */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function show(value: unknown): string {
  if (value === undefined) return 'absent';
  return JSON.stringify(value) ?? String(value);
}

/* ------------------------------------------------------------- validation */

/**
 * Everything wrong with a pattern, as problems rather than an exception, so the
 * editor can show them all at once.
 */
export function validateEventPattern(pattern: unknown): PatternProblem[] {
  if (!isRecord(pattern)) {
    return [{ path: '', message: 'An event pattern must be a JSON object.' }];
  }
  const problems: PatternProblem[] = [];
  validateObject(pattern, '', problems);
  return problems;
}

function validateObject(pattern: Record<string, unknown>, path: string, out: PatternProblem[]) {
  for (const [key, value] of Object.entries(pattern)) {
    const here = join(path, key);
    if (key === '$or') {
      if (!Array.isArray(value) || value.length === 0) {
        out.push({ path: here, message: '$or takes a non-empty array of patterns.' });
        continue;
      }
      value.forEach((branch, index) => {
        if (!isRecord(branch)) {
          out.push({ path: `${here}[${index}]`, message: 'Each $or branch must be an object.' });
        } else {
          validateObject(branch, `${here}[${index}]`, out);
        }
      });
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push({ path: here, message: 'A matcher list must not be empty.' });
      }
      value.forEach(matcher => validateMatcher(matcher, here, out));
      continue;
    }
    if (isRecord(value)) {
      validateObject(value, here, out);
      continue;
    }
    out.push({
      path: here,
      message: 'A pattern value must be an array of matchers or a nested object.',
    });
  }
}

function validateMatcher(matcher: unknown, path: string, out: PatternProblem[]) {
  if (!isRecord(matcher)) {
    if (Array.isArray(matcher)) {
      out.push({ path, message: 'A matcher may not itself be an array.' });
    }
    // A string, number, boolean or null is an exact-value matcher.
    return;
  }
  const keys = Object.keys(matcher);
  if (keys.length !== 1) {
    out.push({ path, message: 'A comparison matcher must have exactly one operator key.' });
    return;
  }
  const [operator] = keys;
  if (!(MATCH_OPERATORS as readonly string[]).includes(operator)) {
    out.push({
      path,
      message: `Unknown operator "${operator}". Supported: ${MATCH_OPERATORS.join(', ')}.`,
    });
    return;
  }
  const argument = matcher[operator];
  switch (operator as MatchOperator) {
    case 'exists':
      if (typeof argument !== 'boolean') {
        out.push({ path, message: 'exists takes true or false.' });
      }
      return;
    case 'numeric':
      validateNumeric(argument, path, out);
      return;
    case 'cidr':
      if (typeof argument !== 'string') {
        out.push({ path, message: 'cidr takes a CIDR block as a string.' });
      } else if (parseCidr(argument) === undefined) {
        out.push({
          path,
          message: argument.includes(':')
            ? 'This tester evaluates IPv4 CIDR blocks only, so it cannot answer for this rule.'
            : `"${argument}" is not a valid IPv4 CIDR block.`,
        });
      }
      return;
    case 'anything-but':
      validateAnythingBut(argument, path, out);
      return;
    case 'prefix':
    case 'suffix':
      if (typeof argument === 'string') return;
      if (isRecord(argument) && typeof argument['equals-ignore-case'] === 'string') return;
      out.push({
        path,
        message: `${operator} takes a string, or {"equals-ignore-case": "..."}.`,
      });
      return;
    case 'equals-ignore-case':
    case 'wildcard':
      if (typeof argument !== 'string') {
        out.push({ path, message: `${operator} takes a string.` });
      }
      return;
  }
}

function validateNumeric(argument: unknown, path: string, out: PatternProblem[]) {
  if (!Array.isArray(argument) || argument.length === 0 || argument.length % 2 !== 0) {
    out.push({
      path,
      message: 'numeric takes operator/value pairs, for example [">=", 1, "<", 10].',
    });
    return;
  }
  for (let index = 0; index < argument.length; index += 2) {
    const operator = argument[index];
    const value = argument[index + 1];
    if (typeof operator !== 'string' || !NUMERIC_OPERATORS.includes(operator as NumericOperator)) {
      out.push({
        path,
        message: `"${String(operator)}" is not a numeric operator. Use ${NUMERIC_OPERATORS.join(', ')}.`,
      });
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      out.push({ path, message: 'Each numeric comparison needs a number to compare against.' });
    }
  }
}

function validateAnythingBut(argument: unknown, path: string, out: PatternProblem[]) {
  if (typeof argument === 'string' || typeof argument === 'number') return;
  if (Array.isArray(argument)) {
    if (argument.length === 0) {
      out.push({ path, message: 'anything-but takes a non-empty list.' });
    }
    return;
  }
  if (isRecord(argument)) {
    const keys = Object.keys(argument);
    const nested = ['prefix', 'suffix', 'wildcard', 'equals-ignore-case'];
    if (keys.length === 1 && nested.includes(keys[0])) return;
    out.push({
      path,
      message: `anything-but nests only ${nested.join(', ')}.`,
    });
    return;
  }
  out.push({ path, message: 'anything-but takes a value, a list, or a nested matcher.' });
}

/* --------------------------------------------------------------- matching */

/**
 * Does the event match the pattern?
 *
 * A mismatch carries the pattern path that rejected it, so the screen can point
 * at the member rather than saying only "no match".
 */
export function matchEventPattern(pattern: unknown, event: unknown): MatchResult {
  if (!isRecord(pattern)) {
    return { matched: false, path: '', reason: 'An event pattern must be a JSON object.' };
  }
  return matchObject(pattern, event, '');
}

function matchObject(pattern: Record<string, unknown>, event: unknown, path: string): MatchResult {
  for (const [key, value] of Object.entries(pattern)) {
    const here = join(path, key);

    if (key === '$or') {
      if (!Array.isArray(value) || value.length === 0) {
        return { matched: false, path: here, reason: '$or takes a non-empty array of patterns.' };
      }
      const matched = value.some(
        branch => isRecord(branch) && matchObject(branch, event, here).matched,
      );
      if (!matched) {
        return { matched: false, path: here, reason: 'No branch of $or matched the event.' };
      }
      continue;
    }

    const present = isRecord(event) && Object.prototype.hasOwnProperty.call(event, key);
    const eventValue = isRecord(event) ? event[key] : undefined;

    if (Array.isArray(value)) {
      if (!value.some(matcher => matchOne(matcher, eventValue, present))) {
        return {
          matched: false,
          path: here,
          reason: `${here} is ${show(eventValue)}; the pattern requires ${describeMatchers(value)}.`,
        };
      }
      continue;
    }

    if (isRecord(value)) {
      // EventBridge matches into an array of objects as well as into a single
      // one, so a member that is a list of structures is walked element by
      // element and matches when any element does.
      const candidates = Array.isArray(eventValue) ? eventValue : [eventValue];
      const results = candidates.map(candidate => matchObject(value, candidate, here));
      const hit = results.find(result => result.matched);
      if (!hit) {
        return (
          results[0] ?? {
            matched: false,
            path: here,
            reason: `${here} is an empty list, so nothing inside it can match.`,
          }
        );
      }
      continue;
    }

    return {
      matched: false,
      path: here,
      reason: 'A pattern value must be an array of matchers or a nested object.',
    };
  }
  return { matched: true };
}

function describeMatchers(matchers: unknown[]): string {
  return matchers.map(matcher => show(matcher)).join(' or ');
}

function matchOne(matcher: unknown, value: unknown, present: boolean): boolean {
  if (isRecord(matcher)) {
    const keys = Object.keys(matcher);
    if (keys.length !== 1) return false;
    const operator = keys[0] as MatchOperator;
    const argument = matcher[operator];

    // `exists` asks about the key, not the value, so it never fans out over an
    // array and it is the one matcher that can succeed on an absent member.
    if (operator === 'exists') {
      return typeof argument === 'boolean' && argument === present;
    }
    if (!present) return false;

    if (operator === 'anything-but') {
      // "Anything but X" over a list holds only when no element is X.
      const values = Array.isArray(value) ? value : [value];
      return values.every(entry => !matchesAnythingButArgument(argument, entry));
    }

    const values = Array.isArray(value) ? value : [value];
    return values.some(entry => applyOperator(operator, argument, entry));
  }

  if (!present) return false;
  if (Array.isArray(value)) return value.some(entry => exactly(matcher, entry));
  return exactly(matcher, value);
}

function exactly(matcher: unknown, value: unknown): boolean {
  // Strings, numbers, booleans and null compare by value; a pattern never
  // carries an object as an exact-value matcher.
  return matcher === value;
}

function applyOperator(operator: MatchOperator, argument: unknown, value: unknown): boolean {
  switch (operator) {
    case 'prefix':
    case 'suffix': {
      if (typeof value !== 'string') return false;
      const insensitive =
        CASE_INSENSITIVE_ARGUMENT.has(operator) &&
        isRecord(argument) &&
        typeof argument['equals-ignore-case'] === 'string';
      const needle = insensitive
        ? (argument as Record<string, string>)['equals-ignore-case']
        : argument;
      if (typeof needle !== 'string') return false;
      const haystack = insensitive ? value.toLowerCase() : value;
      const target = insensitive ? needle.toLowerCase() : needle;
      return operator === 'prefix' ? haystack.startsWith(target) : haystack.endsWith(target);
    }
    case 'equals-ignore-case':
      return (
        typeof value === 'string' &&
        typeof argument === 'string' &&
        value.toLowerCase() === argument.toLowerCase()
      );
    case 'wildcard':
      return (
        typeof value === 'string' &&
        typeof argument === 'string' &&
        wildcardToRegExp(argument).test(value)
      );
    case 'numeric':
      return typeof value === 'number' && numericHolds(argument, value);
    case 'cidr':
      return typeof value === 'string' && typeof argument === 'string' && inCidr(argument, value);
    // `exists` and `anything-but` are handled by the caller: one asks about
    // presence, the other negates over a whole list.
    case 'exists':
    case 'anything-but':
      return false;
  }
}

function matchesAnythingButArgument(argument: unknown, value: unknown): boolean {
  if (typeof argument === 'string' || typeof argument === 'number') return value === argument;
  if (Array.isArray(argument)) return argument.some(entry => entry === value);
  if (isRecord(argument)) {
    const keys = Object.keys(argument);
    if (keys.length !== 1) return false;
    const operator = keys[0] as MatchOperator;
    if (!(MATCH_OPERATORS as readonly string[]).includes(operator)) return false;
    return applyOperator(operator, argument[operator], value);
  }
  return false;
}

function numericHolds(argument: unknown, value: number): boolean {
  if (!Array.isArray(argument) || argument.length % 2 !== 0 || argument.length === 0) return false;
  for (let index = 0; index < argument.length; index += 2) {
    const operator = argument[index] as NumericOperator;
    const against = argument[index + 1];
    if (typeof against !== 'number') return false;
    const holds =
      operator === '='
        ? value === against
        : operator === '!='
          ? value !== against
          : operator === '<'
            ? value < against
            : operator === '<='
              ? value <= against
              : operator === '>'
                ? value > against
                : operator === '>='
                  ? value >= against
                  : false;
    if (!holds) return false;
  }
  return true;
}

/**
 * `*` stands for any run of characters; `\*` is a literal asterisk. Everything
 * else in the pattern is matched literally, so a wildcard containing regex
 * punctuation cannot turn into a different expression.
 */
export function wildcardToRegExp(pattern: string): RegExp {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\' && pattern[index + 1] === '*') {
      expression += '\\*';
      index += 1;
      continue;
    }
    expression += character === '*' ? '.*' : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`, 's');
}

/* ------------------------------------------------------------------- cidr */

interface Cidr {
  base: number;
  bits: number;
}

/** An IPv4 CIDR block, or undefined when it is not one this tester can read. */
export function parseCidr(cidr: string): Cidr | undefined {
  const [address, length] = cidr.split('/');
  if (length === undefined) return undefined;
  const base = ipv4ToInt(address);
  const bits = Number(length);
  if (base === undefined) return undefined;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  return { base, bits };
}

export function ipv4ToInt(address: string): number | undefined {
  const octets = address.split('.');
  if (octets.length !== 4) return undefined;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return undefined;
    const number = Number(octet);
    if (number > 255) return undefined;
    value = value * 256 + number;
  }
  return value;
}

export function inCidr(cidr: string, address: string): boolean {
  const parsed = parseCidr(cidr);
  const value = ipv4ToInt(address);
  if (!parsed || value === undefined) return false;
  if (parsed.bits === 0) return true;
  // Shifting by 32 is a no-op in JS, so /0 is handled above; the mask is built
  // with division to stay clear of signed 32-bit overflow.
  const size = 2 ** (32 - parsed.bits);
  return Math.floor(value / size) === Math.floor(parsed.base / size);
}
