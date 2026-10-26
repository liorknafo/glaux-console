#!/usr/bin/env node
/**
 * A stand-in emulator for the end-to-end test.
 *
 * This is NOT a model of how glaux or fakecloud behave. It answers only what the
 * console's own contract depends on: `GET /_fakecloud/health` for capability
 * discovery, and the SQS, Glue and Athena JSON protocols, so a request goes all
 * the way through the console backend and back into the screen. Every response
 * shape below comes from the published AWS service model, and the one piece of
 * behaviour that is invented — which query "fails" — is invented here in the
 * fixture, not assumed of any emulator. The spec's real end-to-end target, an
 * all-in-one glaux binary, is not available in this repo's CI yet; see the PR
 * body.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.FIXTURE_PORT ?? 4610);

const queues = new Map([
  ['orders', 'http://127.0.0.1:4610/000000000000/orders'],
  ['events', 'http://127.0.0.1:4610/000000000000/events'],
]);

/** QueryExecutionId -> the statement the console submitted. */
const executions = new Map();
let nextExecution = 0;

const GLUE_TABLE = {
  Name: 'orders',
  DatabaseName: 'analytics',
  TableType: 'EXTERNAL_TABLE',
  StorageDescriptor: {
    Location: 's3://lake/orders/',
    Columns: [
      { Name: 'order_id', Type: 'string' },
      { Name: 'total', Type: 'double' },
    ],
  },
  PartitionKeys: [{ Name: 'dt', Type: 'string' }],
};

function send(res, status, body, contentType = 'application/x-amz-json-1.0') {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.end(payload);
}

const JSON_1_1 = 'application/x-amz-json-1.1';

createServer((req, res) => {
  if (req.url === '/_fakecloud/health') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'ok',
        version: 'e2e-fixture',
        services: ['sqs', 'glue', 'athena'],
      }),
    );
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    const target = req.headers['x-amz-target'] ?? '';
    const input = body ? JSON.parse(body) : {};

    // The console must have signed the request before it reached us.
    if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 ')) {
      send(res, 400, { __type: 'MissingAuthenticationToken', message: 'No SigV4 signature' });
      return;
    }

    switch (target) {
      case 'AmazonSQS.ListQueues':
        send(res, 200, { QueueUrls: [...queues.values()] });
        return;
      case 'AmazonSQS.CreateQueue': {
        const url = `http://127.0.0.1:${PORT}/000000000000/${input.QueueName}`;
        queues.set(input.QueueName, url);
        send(res, 200, { QueueUrl: url });
        return;
      }
      case 'AmazonSQS.GetQueueUrl': {
        const url = queues.get(input.QueueName);
        if (!url) {
          send(res, 400, {
            __type: 'com.amazonaws.sqs#QueueDoesNotExist',
            message: 'The specified queue does not exist.',
          });
          return;
        }
        send(res, 200, { QueueUrl: url });
        return;
      }
      case 'AWSGlue.GetDatabases':
        send(res, 200, { DatabaseList: [{ Name: 'analytics', Description: 'fixture' }] }, JSON_1_1);
        return;
      case 'AWSGlue.GetTables':
        send(res, 200, { TableList: input.DatabaseName === 'analytics' ? [GLUE_TABLE] : [] }, JSON_1_1); // prettier-ignore
        return;

      case 'AmazonAthena.StartQueryExecution': {
        nextExecution += 1;
        const id = `e2e-${nextExecution}`;
        executions.set(id, input.QueryString ?? '');
        send(res, 200, { QueryExecutionId: id }, JSON_1_1);
        return;
      }
      case 'AmazonAthena.GetQueryExecution': {
        const sql = executions.get(input.QueryExecutionId) ?? '';
        // The fixture's own rule, not an emulator's: this is how the test
        // reaches the coverage-gap path deliberately.
        const unsupported = /GROUPING SETS/i.test(sql);
        send(
          res,
          200,
          {
            QueryExecution: {
              QueryExecutionId: input.QueryExecutionId,
              Query: sql,
              StatementType: 'DML',
              Status: unsupported
                ? {
                    State: 'FAILED',
                    StateChangeReason: 'Query failed',
                    AthenaError: {
                      ErrorCategory: 2,
                      ErrorType: 1001,
                      Retryable: false,
                      ErrorMessage: 'Unsupported SQL construct: GROUPING SETS',
                    },
                  }
                : { State: 'SUCCEEDED' },
              Statistics: {
                DataScannedInBytes: unsupported ? 0 : 4096,
                EngineExecutionTimeInMillis: 42,
                TotalExecutionTimeInMillis: 61,
              },
            },
          },
          JSON_1_1,
        );
        return;
      }
      case 'AmazonAthena.GetQueryResults':
        send(
          res,
          200,
          {
            ResultSet: {
              ResultSetMetadata: {
                ColumnInfo: [
                  { Name: 'order_id', Label: 'order_id', Type: 'varchar' },
                  { Name: 'total', Label: 'total', Type: 'double' },
                ],
              },
              // Athena repeats the column labels as the first row of page one.
              Rows: [
                { Data: [{ VarCharValue: 'order_id' }, { VarCharValue: 'total' }] },
                { Data: [{ VarCharValue: 'A-1' }, { VarCharValue: '19.5' }] },
                { Data: [{ VarCharValue: 'A-2' }, { VarCharValue: '7.25' }] },
              ],
            },
          },
          JSON_1_1,
        );
        return;
      case 'AmazonAthena.StopQueryExecution':
        send(res, 200, {}, JSON_1_1);
        return;

      default:
        send(res, 400, {
          __type: 'InvalidAction',
          message: `Fixture does not implement ${target}`,
        });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`emulator fixture on http://127.0.0.1:${PORT}\n`);
});
