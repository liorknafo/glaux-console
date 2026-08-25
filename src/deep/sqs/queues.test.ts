import { describe, expect, it } from 'vitest';
import {
  parseRedrivePolicy,
  queueNameFromArn,
  queueNameFromUrl,
  readAttributes,
  readMessages,
  readQueueUrls,
  resolveDeadLetterQueue,
} from './queues';

describe('queue naming', () => {
  it('takes the name from the last segment of a queue URL', () => {
    expect(queueNameFromUrl('http://localhost:4566/000000000000/orders')).toBe('orders');
    expect(queueNameFromUrl('http://localhost:4566/000000000000/orders.fifo')).toBe('orders.fifo');
  });

  it('ignores a trailing slash rather than reading an empty name', () => {
    expect(queueNameFromUrl('http://localhost:4566/000000000000/orders/')).toBe('orders');
  });

  it('falls back to the URL when there is no path to read', () => {
    expect(queueNameFromUrl('orders')).toBe('orders');
  });

  it('reads the queue name out of an ARN', () => {
    expect(queueNameFromArn('arn:aws:sqs:us-east-1:000000000000:orders-dlq')).toBe('orders-dlq');
    expect(queueNameFromArn(undefined)).toBeUndefined();
    expect(queueNameFromArn('not-an-arn')).toBeUndefined();
  });
});

describe('reading list output', () => {
  it('reads ListQueues and ListDeadLetterSourceQueues from their own member names', () => {
    expect(readQueueUrls({ QueueUrls: ['a', 'b'] }, 'QueueUrls')).toEqual(['a', 'b']);
    // The dead-letter listing really does spell it in lower camel case.
    expect(readQueueUrls({ queueUrls: ['c'] }, 'queueUrls')).toEqual(['c']);
  });

  it('answers empty for a target that returns no member at all', () => {
    expect(readQueueUrls({}, 'QueueUrls')).toEqual([]);
    expect(readQueueUrls(undefined, 'QueueUrls')).toEqual([]);
  });
});

describe('queue attributes', () => {
  const output = {
    Attributes: {
      QueueArn: 'arn:aws:sqs:us-east-1:000000000000:orders',
      ApproximateNumberOfMessages: '3',
      ApproximateNumberOfMessagesNotVisible: '1',
      ApproximateNumberOfMessagesDelayed: '0',
      VisibilityTimeout: '30',
      MessageRetentionPeriod: '345600',
      MaximumMessageSize: '262144',
      DelaySeconds: '0',
      ReceiveMessageWaitTimeSeconds: '0',
      CreatedTimestamp: '1756080000',
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      SqsManagedSseEnabled: 'true',
      RedrivePolicy:
        '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:000000000000:orders-dlq","maxReceiveCount":5}',
    },
  };

  it('reads the numbers SQS carries as attribute strings', () => {
    const attributes = readAttributes(output);
    expect(attributes.visible).toBe(3);
    expect(attributes.notVisible).toBe(1);
    expect(attributes.visibilityTimeout).toBe(30);
    expect(attributes.maximumMessageSize).toBe(262144);
    expect(attributes.fifo).toBe(true);
    expect(attributes.contentBasedDeduplication).toBe(false);
    expect(attributes.sqsManagedSseEnabled).toBe(true);
  });

  it('keeps every attribute the target returned', () => {
    expect(readAttributes(output).raw.MessageRetentionPeriod).toBe('345600');
  });

  it('parses the redrive policy out of its JSON attribute', () => {
    expect(readAttributes(output).redrive).toEqual({
      deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:orders-dlq',
      maxReceiveCount: 5,
    });
  });

  it('treats an unparseable redrive policy as none rather than throwing', () => {
    expect(parseRedrivePolicy('{not json')).toBeUndefined();
    expect(parseRedrivePolicy('{}')).toBeUndefined();
    expect(parseRedrivePolicy(undefined)).toBeUndefined();
  });

  it('answers a queue with no attributes without inventing values', () => {
    const attributes = readAttributes({});
    expect(attributes.raw).toEqual({});
    expect(attributes.visible).toBeUndefined();
    expect(attributes.fifo).toBe(false);
    expect(attributes.sqsManagedSseEnabled).toBeUndefined();
  });
});

describe('reading messages', () => {
  it('reads bodies, system attributes, and message attributes', () => {
    const messages = readMessages({
      Messages: [
        {
          MessageId: 'm-1',
          ReceiptHandle: 'handle-1',
          Body: '{"order_id":"A-1"}',
          MD5OfBody: 'abc',
          Attributes: { SentTimestamp: '1756080000000', ApproximateReceiveCount: '2' },
          MessageAttributes: {
            source: { DataType: 'String', StringValue: 'console' },
          },
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('{"order_id":"A-1"}');
    expect(messages[0].attributes.ApproximateReceiveCount).toBe('2');
    expect(messages[0].messageAttributes).toEqual([
      { name: 'source', dataType: 'String', value: 'console' },
    ]);
  });

  it('shows a binary attribute as the base64 the wire carried', () => {
    const messages = readMessages({
      Messages: [
        {
          MessageId: 'm-2',
          Body: '',
          MessageAttributes: { blob: { DataType: 'Binary', BinaryValue: 'aGk=' } },
        },
      ],
    });
    expect(messages[0].messageAttributes[0].value).toBe('aGk=');
  });

  it('answers empty when the poll returned no messages', () => {
    expect(readMessages({})).toEqual([]);
  });
});

describe('resolving a dead-letter target', () => {
  const queues = [
    { url: 'http://localhost:4566/000000000000/orders', name: 'orders' },
    { url: 'http://localhost:4566/000000000000/orders-dlq', name: 'orders-dlq' },
  ];

  it('matches the ARN to a listed queue by name', () => {
    expect(
      resolveDeadLetterQueue(
        { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:orders-dlq' },
        queues,
      ),
    ).toEqual(queues[1]);
  });

  it('does not guess when the target is not on this endpoint', () => {
    expect(
      resolveDeadLetterQueue(
        { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:elsewhere' },
        queues,
      ),
    ).toBeUndefined();
    expect(resolveDeadLetterQueue(undefined, queues)).toBeUndefined();
  });
});
