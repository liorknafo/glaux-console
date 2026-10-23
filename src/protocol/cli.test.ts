import { describe, expect, it } from 'vitest';
import { loadServiceCatalog } from '../catalog/loader';
import { kebab, renderCliCommand, shellQuote } from './cli';

describe('View as CLI', () => {
  it('renders a runnable aws command for a generated form', async () => {
    const athena = await loadServiceCatalog('athena');
    const command = renderCliCommand(
      athena,
      athena.operations.StartQueryExecution,
      {
        QueryString: 'SELECT count(*) FROM events',
        WorkGroup: 'primary',
      },
      'http://localhost:4566',
    );

    expect(command).toContain('aws \\\n  athena \\\n  start-query-execution');
    expect(command).toContain('--endpoint-url http://localhost:4566');
    expect(command).toContain("--query-string 'SELECT count(*) FROM events'");
    expect(command).toContain('--work-group primary');
  });

  it('passes structures as JSON and scalar lists as repeated words', async () => {
    const sqs = await loadServiceCatalog('sqs');
    const command = renderCliCommand(
      sqs,
      sqs.operations.GetQueueAttributes,
      { QueueUrl: 'http://localhost:4566/q/a', AttributeNames: ['All'] },
      'http://localhost:4566',
    );
    expect(command).toContain('--attribute-names All');

    const dynamodb = await loadServiceCatalog('dynamodb');
    const putItem = renderCliCommand(
      dynamodb,
      dynamodb.operations.PutItem,
      { TableName: 'events', Item: { id: { S: '1' } } },
      'http://localhost:4566',
    );
    expect(putItem).toContain(`--item '{"id":{"S":"1"}}'`);
  });

  it('omits members the form left empty', async () => {
    const sqs = await loadServiceCatalog('sqs');
    const command = renderCliCommand(
      sqs,
      sqs.operations.CreateQueue,
      { QueueName: 'orders', Attributes: undefined, tags: {} },
      'http://localhost:4566',
    );
    expect(command).toContain('--queue-name orders');
    expect(command).not.toContain('--attributes');
  });
});

describe('naming helpers', () => {
  it('converts operation and member names the way the CLI does', () => {
    expect(kebab('StartQueryExecution')).toBe('start-query-execution');
    expect(kebab('MaxResults')).toBe('max-results');
    expect(kebab('QueryExecutionId')).toBe('query-execution-id');
    expect(kebab('ListObjectsV2')).toBe('list-objects-v2');
  });

  it('quotes only what a shell would mangle', () => {
    expect(shellQuote('primary')).toBe('primary');
    expect(shellQuote('http://localhost:4566')).toBe('http://localhost:4566');
    expect(shellQuote('SELECT 1')).toBe("'SELECT 1'");
    // POSIX single-quote escaping: close, escaped quote, reopen.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
