import { describe, expect, it } from 'vitest';
import {
  inCidr,
  matchEventPattern,
  parseCidr,
  validateEventPattern,
  wildcardToRegExp,
} from './pattern';

const ORDER_EVENT = {
  version: '0',
  id: 'e-1',
  'detail-type': 'Order placed',
  source: 'shop.orders',
  account: '000000000000',
  time: '2026-08-25T09:00:00Z',
  region: 'us-east-1',
  resources: ['arn:aws:sqs:us-east-1:000000000000:orders'],
  detail: {
    state: 'PLACED',
    total: 19.5,
    customer: { tier: 'gold', ip: '10.0.3.17' },
    items: [{ sku: 'A-1' }, { sku: 'B-2' }],
  },
};

function matches(pattern: unknown, event: unknown = ORDER_EVENT): boolean {
  return matchEventPattern(pattern, event).matched;
}

describe('exact values', () => {
  it('matches a top-level member against a list of values', () => {
    expect(matches({ source: ['shop.orders'] })).toBe(true);
    expect(matches({ source: ['shop.returns'] })).toBe(false);
    expect(matches({ source: ['shop.returns', 'shop.orders'] })).toBe(true);
  });

  it('requires every member of the pattern to match', () => {
    expect(matches({ source: ['shop.orders'], 'detail-type': ['Order placed'] })).toBe(true);
    expect(matches({ source: ['shop.orders'], 'detail-type': ['Order shipped'] })).toBe(false);
  });

  it('matches into a nested object', () => {
    expect(matches({ detail: { state: ['PLACED'] } })).toBe(true);
    expect(matches({ detail: { customer: { tier: ['gold'] } } })).toBe(true);
    expect(matches({ detail: { customer: { tier: ['silver'] } } })).toBe(false);
  });

  it('matches a value inside an array member', () => {
    expect(matches({ resources: ['arn:aws:sqs:us-east-1:000000000000:orders'] })).toBe(true);
  });

  it('matches into an array of objects', () => {
    expect(matches({ detail: { items: { sku: ['B-2'] } } })).toBe(true);
    expect(matches({ detail: { items: { sku: ['C-3'] } } })).toBe(false);
  });

  it('does not match an absent member', () => {
    expect(matches({ nothing: ['here'] })).toBe(false);
    expect(matches({ detail: { missing: ['x'] } })).toBe(false);
  });

  it('matches numbers and booleans by value, not by string', () => {
    expect(matches({ detail: { total: [19.5] } })).toBe(true);
    expect(matches({ detail: { total: ['19.5'] } })).toBe(false);
    expect(matches({ flag: [true] }, { flag: true })).toBe(true);
    expect(matches({ flag: [true] }, { flag: 'true' })).toBe(false);
  });

  it('treats an empty pattern as matching every event', () => {
    expect(matches({})).toBe(true);
  });
});

describe('comparison operators', () => {
  it('prefix and suffix, with an optional case-insensitive argument', () => {
    expect(matches({ source: [{ prefix: 'shop.' }] })).toBe(true);
    expect(matches({ source: [{ prefix: 'store.' }] })).toBe(false);
    expect(matches({ source: [{ suffix: '.orders' }] })).toBe(true);
    expect(matches({ source: [{ prefix: { 'equals-ignore-case': 'SHOP.' } }] })).toBe(true);
    expect(matches({ source: [{ suffix: { 'equals-ignore-case': '.ORDERS' } }] })).toBe(true);
  });

  it('equals-ignore-case', () => {
    expect(matches({ detail: { state: [{ 'equals-ignore-case': 'placed' }] } })).toBe(true);
    expect(matches({ detail: { state: [{ 'equals-ignore-case': 'shipped' }] } })).toBe(false);
  });

  it('wildcard, anchored at both ends', () => {
    expect(matches({ 'detail-type': [{ wildcard: 'Order *' }] })).toBe(true);
    expect(matches({ 'detail-type': [{ wildcard: '*placed' }] })).toBe(true);
    expect(matches({ 'detail-type': [{ wildcard: 'Order' }] })).toBe(false);
  });

  it('numeric, including a two-sided range', () => {
    expect(matches({ detail: { total: [{ numeric: ['>', 10] }] } })).toBe(true);
    expect(matches({ detail: { total: [{ numeric: ['>', 10, '<', 15] }] } })).toBe(false);
    expect(matches({ detail: { total: [{ numeric: ['>=', 19.5, '<=', 19.5] }] } })).toBe(true);
    expect(matches({ detail: { total: [{ numeric: ['!=', 19.5] }] } })).toBe(false);
    // A string that looks like a number is not a number.
    expect(matches({ detail: { state: [{ numeric: ['>', 0] }] } })).toBe(false);
  });

  it('exists, which asks about the key rather than the value', () => {
    expect(matches({ detail: { state: [{ exists: true }] } })).toBe(true);
    expect(matches({ detail: { missing: [{ exists: false }] } })).toBe(true);
    expect(matches({ detail: { state: [{ exists: false }] } })).toBe(false);
    // A member that is present but null still exists.
    expect(matches({ note: [{ exists: true }] }, { note: null })).toBe(true);
  });

  it('cidr', () => {
    expect(matches({ detail: { customer: { ip: [{ cidr: '10.0.0.0/16' }] } } })).toBe(true);
    expect(matches({ detail: { customer: { ip: [{ cidr: '10.0.4.0/24' }] } } })).toBe(false);
    expect(matches({ detail: { customer: { ip: [{ cidr: '0.0.0.0/0' }] } } })).toBe(true);
  });

  it('anything-but, over values, lists, and a nested matcher', () => {
    expect(matches({ detail: { state: [{ 'anything-but': 'CANCELLED' }] } })).toBe(true);
    expect(matches({ detail: { state: [{ 'anything-but': 'PLACED' }] } })).toBe(false);
    expect(matches({ detail: { state: [{ 'anything-but': ['PLACED', 'SHIPPED'] }] } })).toBe(false);
    expect(matches({ detail: { state: [{ 'anything-but': { prefix: 'CANC' } }] } })).toBe(true);
    expect(matches({ detail: { state: [{ 'anything-but': { prefix: 'PLA' } }] } })).toBe(false);
  });

  it('anything-but over an array holds only when no element is excluded', () => {
    const event = { tags: ['red', 'blue'] };
    expect(matches({ tags: [{ 'anything-but': 'green' }] }, event)).toBe(true);
    expect(matches({ tags: [{ 'anything-but': 'red' }] }, event)).toBe(false);
  });

  it('matches when any matcher in the list matches', () => {
    expect(matches({ detail: { state: ['SHIPPED', { prefix: 'PLA' }] } })).toBe(true);
  });
});

describe('$or', () => {
  it('matches when any branch matches', () => {
    expect(matches({ $or: [{ source: ['shop.returns'] }, { source: ['shop.orders'] }] })).toBe(
      true,
    );
  });

  it('does not match when no branch does', () => {
    expect(matches({ $or: [{ source: ['a'] }, { source: ['b'] }] })).toBe(false);
  });

  it('is combined with the members alongside it', () => {
    expect(
      matches({
        source: ['shop.orders'],
        $or: [{ 'detail-type': ['Order shipped'] }, { detail: { state: ['PLACED'] } }],
      }),
    ).toBe(true);
    expect(
      matches({
        source: ['shop.returns'],
        $or: [{ detail: { state: ['PLACED'] } }],
      }),
    ).toBe(false);
  });
});

describe('explaining a mismatch', () => {
  it('names the pattern path that rejected the event', () => {
    const result = matchEventPattern({ detail: { state: ['SHIPPED'] } }, ORDER_EVENT);
    expect(result.matched).toBe(false);
    expect(result.path).toBe('detail.state');
    expect(result.reason).toContain('"PLACED"');
    expect(result.reason).toContain('"SHIPPED"');
  });

  it('reports an absent member as absent rather than as a wrong value', () => {
    const result = matchEventPattern({ source: ['shop.orders'], missing: ['x'] }, ORDER_EVENT);
    expect(result.path).toBe('missing');
    expect(result.reason).toContain('absent');
  });

  it('names $or when no branch matched', () => {
    const result = matchEventPattern({ $or: [{ source: ['a'] }] }, ORDER_EVENT);
    expect(result.path).toBe('$or');
  });

  it('says nothing about a path when the event matched', () => {
    expect(matchEventPattern({ source: ['shop.orders'] }, ORDER_EVENT)).toEqual({ matched: true });
  });
});

describe('validation', () => {
  it('accepts a well-formed pattern', () => {
    expect(
      validateEventPattern({
        source: ['shop.orders'],
        detail: { total: [{ numeric: ['>', 0] }], state: [{ exists: true }] },
        $or: [{ region: ['us-east-1'] }],
      }),
    ).toEqual([]);
  });

  it('rejects a pattern that is not an object', () => {
    expect(validateEventPattern(['shop.orders'])).toEqual([
      { path: '', message: 'An event pattern must be a JSON object.' },
    ]);
  });

  it('rejects a bare value where a matcher list belongs', () => {
    const problems = validateEventPattern({ source: 'shop.orders' });
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe('source');
    expect(problems[0].message).toContain('array of matchers');
  });

  it('names an unknown operator instead of evaluating it as a mismatch', () => {
    const problems = validateEventPattern({ source: [{ 'starts-with': 'shop' }] });
    expect(problems[0].message).toContain('Unknown operator "starts-with"');
    expect(problems[0].path).toBe('source');
  });

  it('rejects a matcher with more than one operator key', () => {
    const problems = validateEventPattern({ source: [{ prefix: 'a', suffix: 'b' }] });
    expect(problems[0].message).toContain('exactly one operator key');
  });

  it('checks the shape of numeric, exists, and anything-but arguments', () => {
    expect(validateEventPattern({ a: [{ numeric: ['>'] }] })[0].message).toContain(
      'operator/value pairs',
    );
    expect(validateEventPattern({ a: [{ numeric: ['~', 1] }] })[0].message).toContain(
      'not a numeric operator',
    );
    expect(validateEventPattern({ a: [{ exists: 'yes' }] })[0].message).toContain('true or false');
    expect(
      validateEventPattern({ a: [{ 'anything-but': { numeric: ['>', 1] } }] })[0].message,
    ).toContain('anything-but nests only');
  });

  it('says plainly that it cannot evaluate an IPv6 CIDR block', () => {
    const problems = validateEventPattern({ ip: [{ cidr: '2001:db8::/32' }] });
    expect(problems[0].message).toContain('IPv4 CIDR blocks only');
  });

  it('rejects an empty matcher list and an empty $or', () => {
    expect(validateEventPattern({ source: [] })[0].message).toContain('must not be empty');
    expect(validateEventPattern({ $or: [] })[0].message).toContain('non-empty array');
  });

  it('reports every problem at once', () => {
    expect(validateEventPattern({ a: 'x', b: [{ nope: 1 }] })).toHaveLength(2);
  });
});

describe('wildcard compilation', () => {
  it('treats regex punctuation in the pattern literally', () => {
    expect(wildcardToRegExp('a.b').test('a.b')).toBe(true);
    expect(wildcardToRegExp('a.b').test('axb')).toBe(false);
  });

  it('honours an escaped asterisk', () => {
    expect(wildcardToRegExp('a\\*b').test('a*b')).toBe(true);
    expect(wildcardToRegExp('a\\*b').test('axxb')).toBe(false);
  });

  it('lets a wildcard span a newline', () => {
    expect(wildcardToRegExp('a*b').test('a\nb')).toBe(true);
  });
});

describe('cidr arithmetic', () => {
  it('parses only valid IPv4 blocks', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ base: 167772160, bits: 8 });
    expect(parseCidr('10.0.0.0')).toBeUndefined();
    expect(parseCidr('10.0.0.256/8')).toBeUndefined();
    expect(parseCidr('10.0.0.0/33')).toBeUndefined();
    expect(parseCidr('2001:db8::/32')).toBeUndefined();
  });

  it('compares addresses above the signed 32-bit boundary', () => {
    expect(inCidr('192.168.0.0/16', '192.168.99.1')).toBe(true);
    expect(inCidr('255.255.255.0/24', '255.255.255.7')).toBe(true);
    expect(inCidr('255.255.255.0/24', '255.255.254.7')).toBe(false);
  });

  it('answers false for something that is not an address', () => {
    expect(inCidr('10.0.0.0/8', 'not-an-ip')).toBe(false);
  });
});
