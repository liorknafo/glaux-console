import { describe, expect, it } from 'vitest';
import {
  envelopeEvent,
  numberSatisfying,
  readBuses,
  readRules,
  readTargets,
  seedEventFromPattern,
} from './buses';

describe('reading buses and rules', () => {
  it('reads a bus listing', () => {
    expect(
      readBuses({
        EventBuses: [
          { Name: 'default', Arn: 'arn:aws:events:us-east-1:0:event-bus/default' },
          { Name: 'orders' },
          { Arn: 'arn-without-a-name' },
        ],
      }),
    ).toEqual([
      { name: 'default', arn: 'arn:aws:events:us-east-1:0:event-bus/default' },
      { name: 'orders' },
    ]);
  });

  it('reads a rule listing, keeping the pattern as the text the target stored', () => {
    const rules = readRules({
      Rules: [
        {
          Name: 'orders-to-queue',
          State: 'ENABLED',
          EventPattern: '{"source":["shop.orders"]}',
          Description: 'Fan orders out',
        },
        { Name: 'nightly', State: 'DISABLED', ScheduleExpression: 'rate(1 day)' },
      ],
    });
    expect(rules[0].eventPattern).toBe('{"source":["shop.orders"]}');
    expect(rules[0].state).toBe('ENABLED');
    expect(rules[1].scheduleExpression).toBe('rate(1 day)');
    expect(rules[1].eventPattern).toBeUndefined();
  });

  it('reads targets, including how each one is given its input', () => {
    const targets = readTargets({
      Targets: [
        { Id: 'queue', Arn: 'arn:aws:sqs:us-east-1:0:orders' },
        { Id: 'constant', Arn: 'arn:x', Input: '{"fixed":true}' },
        { Id: 'transformed', Arn: 'arn:y', InputTransformer: { InputTemplate: '<x>' } },
        {
          Id: 'retried',
          Arn: 'arn:z',
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 60 },
          DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:0:dlq' },
        },
      ],
    });
    expect(targets[0]).toEqual({
      id: 'queue',
      arn: 'arn:aws:sqs:us-east-1:0:orders',
      transformed: false,
    });
    expect(targets[1].input).toBe('{"fixed":true}');
    expect(targets[2].transformed).toBe(true);
    expect(targets[3].retryAttempts).toBe(3);
    expect(targets[3].deadLetterArn).toBe('arn:aws:sqs:us-east-1:0:dlq');
  });

  it('answers empty for a target that returned nothing', () => {
    expect(readBuses({})).toEqual([]);
    expect(readRules(undefined)).toEqual([]);
    expect(readTargets({ Targets: [{ Arn: 'no-id' }] })).toEqual([]);
  });
});

describe('seeding a sample event from a pattern', () => {
  it('starts from a complete event envelope', () => {
    const event = envelopeEvent('eu-west-1');
    expect(event.region).toBe('eu-west-1');
    expect(event).toHaveProperty('detail-type');
    expect(event).toHaveProperty('detail');
  });

  it('fills in the literal values the pattern names', () => {
    const event = seedEventFromPattern(
      '{"source":["shop.orders"],"detail-type":["Order placed"]}',
      'us-east-1',
    );
    expect(event.source).toBe('shop.orders');
    expect(event['detail-type']).toBe('Order placed');
  });

  it('seeds nested members without dropping the rest of the envelope', () => {
    const event = seedEventFromPattern('{"detail":{"state":["PLACED"]}}', 'us-east-1') as {
      detail: Record<string, unknown>;
      source: string;
    };
    expect(event.detail.state).toBe('PLACED');
    expect(event.detail.example).toBe(true);
    expect(event.source).toBe('example.source');
  });

  it('derives a value for the comparison operators it can', () => {
    const event = seedEventFromPattern(
      JSON.stringify({
        detail: {
          a: [{ prefix: 'ord-' }],
          b: [{ suffix: '.json' }],
          c: [{ 'equals-ignore-case': 'Gold' }],
          d: [{ numeric: ['>', 10, '<', 20] }],
          e: [{ cidr: '10.0.0.0/16' }],
          f: [{ wildcard: 'a*b' }],
        },
      }),
      'us-east-1',
    ) as { detail: Record<string, unknown> };

    expect(event.detail.a).toBe('ord-example');
    expect(event.detail.b).toBe('example.json');
    expect(event.detail.c).toBe('Gold');
    expect(event.detail.d).toBe(15);
    expect(event.detail.e).toBe('10.0.0.0');
    expect(event.detail.f).toBe('aexampleb');
  });

  it('removes a member the pattern requires to be absent', () => {
    const event = seedEventFromPattern(
      '{"detail":{"example":[{"exists":false}]}}',
      'us-east-1',
    ) as {
      detail: Record<string, unknown>;
    };
    expect('example' in event.detail).toBe(false);
  });

  it('leaves the envelope alone for an operator it cannot derive', () => {
    const event = seedEventFromPattern('{"source":[{"anything-but":"x"}]}', 'us-east-1');
    expect(event.source).toBe('example.source');
  });

  it('seeds from the first branch of an $or', () => {
    const event = seedEventFromPattern('{"$or":[{"source":["a"]},{"source":["b"]}]}', 'us-east-1');
    expect(event.source).toBe('a');
  });

  it('falls back to the plain envelope for a pattern it cannot parse', () => {
    expect(seedEventFromPattern('{not json', 'us-east-1').source).toBe('example.source');
    expect(seedEventFromPattern(undefined, 'us-east-1').source).toBe('example.source');
  });
});

describe('choosing a number for a numeric matcher', () => {
  it('takes an exact value when one is given', () => {
    expect(numberSatisfying(['=', 7])).toBe(7);
  });

  it('lands inside a two-sided range', () => {
    expect(numberSatisfying(['>', 10, '<', 20])).toBe(15);
    expect(numberSatisfying(['>=', 0, '<=', 100])).toBe(50);
  });

  it('steps past an exclusive bound with only one side', () => {
    expect(numberSatisfying(['>', 10])).toBe(11);
    expect(numberSatisfying(['>=', 10])).toBe(10);
    expect(numberSatisfying(['<', 10])).toBe(9);
    expect(numberSatisfying(['<=', 10])).toBe(10);
  });

  it('declines a malformed matcher rather than guessing', () => {
    expect(numberSatisfying(['>'])).toBeUndefined();
    expect(numberSatisfying(['>', 'ten'])).toBeUndefined();
    expect(numberSatisfying('nope')).toBeUndefined();
  });
});
