#!/usr/bin/env node
/**
 * A stand-in emulator for the end-to-end test.
 *
 * This is NOT a model of how glaux or fakecloud behave. It answers only what the
 * console's own contract depends on: `GET /_fakecloud/health` for capability
 * discovery, the SQS, Glue, Athena and Firehose JSON protocols, and enough of
 * S3's rest-xml protocol to browse a bucket, so a request goes all the way
 * through the console backend and back into the screen. Every response
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

/**
 * Queue URL -> the messages on it.
 *
 * A peek is a `ReceiveMessage` with a zero visibility timeout, so the fixture
 * leaves the message where it is and only counts the receive — which is what
 * makes the "sent it, then peeked it back twice" test meaningful.
 */
const messages = new Map();
let nextMessage = 0;

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

/**
 * An in-memory S3. `${bucket}/${key}` -> the object.
 *
 * Seeded with two objects the Firehose stream has "already delivered", so the
 * delivery monitor has something to read on open.
 */
const objects = new Map([
  [
    'lake/orders/2026/08/24/orders-1.json.gz',
    { body: Buffer.from('{"order_id":"A-1"}\n'), contentType: 'application/json' },
  ],
  [
    'lake/orders/2026/08/24/orders-2.json.gz',
    { body: Buffer.from('{"order_id":"A-2"}\n'), contentType: 'application/json' },
  ],
]);

const DELIVERY_STREAM = {
  DeliveryStreamName: 'orders-to-lake',
  DeliveryStreamARN: 'arn:aws:firehose:us-east-1:000000000000:deliverystream/orders-to-lake',
  DeliveryStreamStatus: 'ACTIVE',
  DeliveryStreamType: 'DirectPut',
  VersionId: '1',
  CreateTimestamp: 1756000000,
  Destinations: [
    {
      DestinationId: 'destinationId-000000000001',
      ExtendedS3DestinationDescription: {
        RoleARN: 'arn:aws:iam::000000000000:role/firehose',
        BucketARN: 'arn:aws:s3:::lake',
        Prefix: 'orders/!{timestamp:yyyy/MM/dd}/',
        ErrorOutputPrefix: 'errors/!{firehose:error-output-type}/',
        BufferingHints: { SizeInMBs: 5, IntervalInSeconds: 60 },
        CompressionFormat: 'UNCOMPRESSED',
      },
    },
  ],
};

let deliveredCount = 2;

/**
 * CloudWatch Logs.
 *
 * The fixture appends one line every time the console polls. That is the
 * fixture's own device, not a claim about any emulator: it lets the end-to-end
 * test watch a *running* tail grow on its own, which is the one thing a
 * refresh button could not do.
 */
const LOG_GROUP = '/glaux/firehose/orders';
const LOG_STREAM = '2026/08/24/[$LATEST]e2e';
const logEvents = [];
let nextLogEvent = 0;

function escapeXml(value) {
  return String(value).replace(
    /[<>&"']/g,
    character =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character],
  );
}

function sendXml(res, status, xml) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/xml');
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
}

function s3Error(res, status, code, message) {
  sendXml(
    res,
    status,
    `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`,
  );
}

function send(res, status, body, contentType = 'application/x-amz-json-1.0') {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.end(payload);
}

const JSON_1_1 = 'application/x-amz-json-1.1';

/**
 * Enough of S3's rest-xml protocol to browse a bucket: ListBuckets,
 * ListObjectsV2 with a delimiter, and the four object operations. Every
 * document below is the shape the published S3 model declares.
 */
function handleS3(req, res, raw) {
  const url = new URL(req.url ?? '/', 'http://fixture.local');
  const segments = url.pathname.split('/').filter(segment => segment !== '');
  const method = req.method ?? 'GET';

  if (segments.length === 0) {
    if (method !== 'GET') {
      s3Error(res, 405, 'MethodNotAllowed', `${method} is not allowed on the service root.`);
      return;
    }
    sendXml(
      res,
      200,
      '<ListAllMyBucketsResult><Buckets>' +
        '<Bucket><Name>lake</Name><CreationDate>2026-08-01T00:00:00.000Z</CreationDate></Bucket>' +
        '</Buckets></ListAllMyBucketsResult>',
    );
    return;
  }

  const bucket = decodeURIComponent(segments[0]);
  const key = segments
    .slice(1)
    .map(segment => decodeURIComponent(segment))
    .join('/');

  if (bucket !== 'lake') {
    s3Error(res, 404, 'NoSuchBucket', `The bucket "${bucket}" does not exist.`);
    return;
  }

  if (key === '' && method === 'GET') {
    listObjects(res, bucket, url);
    return;
  }

  const stored = objects.get(`${bucket}/${key}`);

  switch (method) {
    case 'PUT':
      objects.set(`${bucket}/${key}`, {
        body: raw,
        contentType: req.headers['content-type'] ?? 'application/octet-stream',
      });
      res.statusCode = 200;
      res.setHeader('etag', `"${raw.length.toString(16)}"`);
      res.end();
      return;
    case 'DELETE':
      objects.delete(`${bucket}/${key}`);
      res.statusCode = 204;
      res.end();
      return;
    case 'HEAD':
      if (!stored) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', stored.contentType);
      res.setHeader('content-length', String(stored.body.length));
      res.setHeader('etag', `"${stored.body.length.toString(16)}"`);
      res.setHeader('last-modified', new Date(0).toUTCString());
      res.setHeader('x-amz-meta-written-by', 'e2e-fixture');
      res.end();
      return;
    case 'GET':
      if (!stored) {
        s3Error(res, 404, 'NoSuchKey', `The key "${key}" does not exist.`);
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', stored.contentType);
      res.end(stored.body);
      return;
    default:
      s3Error(res, 405, 'MethodNotAllowed', `${method} is not allowed on an object.`);
  }
}

function listObjects(res, bucket, url) {
  const prefix = url.searchParams.get('prefix') ?? '';
  const delimiter = url.searchParams.get('delimiter') ?? '';
  const keys = [...objects.keys()]
    .filter(entry => entry.startsWith(`${bucket}/`))
    .map(entry => entry.slice(bucket.length + 1))
    .filter(entry => entry.startsWith(prefix))
    .sort();

  const commonPrefixes = new Set();
  const contents = [];
  for (const entry of keys) {
    const rest = entry.slice(prefix.length);
    const boundary = delimiter ? rest.indexOf(delimiter) : -1;
    if (boundary === -1) contents.push(entry);
    else commonPrefixes.add(`${prefix}${rest.slice(0, boundary + delimiter.length)}`);
  }

  sendXml(
    res,
    200,
    '<ListBucketResult>' +
      `<Name>${escapeXml(bucket)}</Name>` +
      `<Prefix>${escapeXml(prefix)}</Prefix>` +
      '<IsTruncated>false</IsTruncated>' +
      `<KeyCount>${contents.length}</KeyCount>` +
      [...commonPrefixes]
        .map(entry => `<CommonPrefixes><Prefix>${escapeXml(entry)}</Prefix></CommonPrefixes>`)
        .join('') +
      contents
        .map(entry => {
          const stored = objects.get(`${bucket}/${entry}`);
          return (
            '<Contents>' +
            `<Key>${escapeXml(entry)}</Key>` +
            '<LastModified>2026-08-24T09:00:00.000Z</LastModified>' +
            `<ETag>&quot;${stored.body.length.toString(16)}&quot;</ETag>` +
            `<Size>${stored.body.length}</Size>` +
            '<StorageClass>STANDARD</StorageClass>' +
            '</Contents>'
          );
        })
        .join('') +
      '</ListBucketResult>',
  );
}

createServer((req, res) => {
  if (req.url === '/_fakecloud/health') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'ok',
        version: 'e2e-fixture',
        services: ['sqs', 'glue', 'athena', 's3', 'firehose', 'logs'],
      }),
    );
    return;
  }

  // Buffered rather than concatenated as text: an S3 upload is bytes, and
  // string concatenation would corrupt them.
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const target = req.headers['x-amz-target'] ?? '';

    // The console must have signed the request before it reached us.
    if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 ')) {
      send(res, 400, { __type: 'MissingAuthenticationToken', message: 'No SigV4 signature' });
      return;
    }

    // S3 is rest-xml: it routes on method and path, and carries no target header.
    if (!target) {
      handleS3(req, res, raw);
      return;
    }

    const input = raw.length ? JSON.parse(raw.toString('utf8')) : {};

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
      case 'AmazonSQS.GetQueueAttributes': {
        const name = String(input.QueueUrl ?? '').split('/').pop(); // prettier-ignore
        const onQueue = messages.get(input.QueueUrl) ?? [];
        send(res, 200, {
          Attributes: {
            QueueArn: `arn:aws:sqs:us-east-1:000000000000:${name}`,
            ApproximateNumberOfMessages: String(onQueue.length),
            ApproximateNumberOfMessagesNotVisible: '0',
            ApproximateNumberOfMessagesDelayed: '0',
            VisibilityTimeout: '30',
            MessageRetentionPeriod: '345600',
            MaximumMessageSize: '262144',
            DelaySeconds: '0',
            ReceiveMessageWaitTimeSeconds: '0',
            CreatedTimestamp: '1756080000',
            ...(name === 'orders'
              ? {
                  RedrivePolicy: JSON.stringify({
                    deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:events',
                    maxReceiveCount: 5,
                  }),
                }
              : {}),
          },
        });
        return;
      }
      case 'AmazonSQS.SendMessage': {
        nextMessage += 1;
        const id = `fixture-${nextMessage}`;
        const onQueue = messages.get(input.QueueUrl) ?? [];
        onQueue.push({
          MessageId: id,
          ReceiptHandle: `handle-${id}`,
          Body: input.MessageBody ?? '',
          MD5OfBody: 'fixture',
          receives: 0,
        });
        messages.set(input.QueueUrl, onQueue);
        send(res, 200, { MessageId: id, MD5OfMessageBody: 'fixture' });
        return;
      }
      case 'AmazonSQS.ReceiveMessage': {
        const onQueue = messages.get(input.QueueUrl) ?? [];
        const taken = onQueue.slice(0, input.MaxNumberOfMessages ?? 1);
        // VisibilityTimeout 0 is a peek: the message stays on the queue, and
        // only its receive count moves.
        const hides = (input.VisibilityTimeout ?? 30) > 0;
        if (hides) messages.set(input.QueueUrl, onQueue.slice(taken.length));
        send(res, 200, {
          Messages: taken.map(message => {
            message.receives += 1;
            return {
              MessageId: message.MessageId,
              ReceiptHandle: message.ReceiptHandle,
              Body: message.Body,
              MD5OfBody: message.MD5OfBody,
              Attributes: {
                SentTimestamp: '1756080000000',
                ApproximateReceiveCount: String(message.receives),
              },
            };
          }),
        });
        return;
      }
      case 'AmazonSQS.PurgeQueue':
        messages.set(input.QueueUrl, []);
        send(res, 200, {});
        return;
      case 'AmazonSQS.ListDeadLetterSourceQueues':
        send(res, 200, { queueUrls: [] });
        return;
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

      case 'Firehose_20150804.ListDeliveryStreams':
        send(res, 200, { DeliveryStreamNames: ['orders-to-lake'], HasMoreDeliveryStreams: false }, JSON_1_1); // prettier-ignore
        return;
      case 'Firehose_20150804.DescribeDeliveryStream':
        if (input.DeliveryStreamName !== DELIVERY_STREAM.DeliveryStreamName) {
          send(res, 400, { __type: 'ResourceNotFoundException', message: 'No such stream' }, JSON_1_1); // prettier-ignore
          return;
        }
        send(res, 200, { DeliveryStreamDescription: DELIVERY_STREAM }, JSON_1_1);
        return;
      case 'Firehose_20150804.PutRecordBatch': {
        // The fixture's own rule, not an emulator's: a put lands as an object
        // under the stream's prefix straight away, so the end-to-end test can
        // watch a record become a delivered object without waiting on a buffer.
        const records = input.Records ?? [];
        deliveredCount += 1;
        objects.set(`lake/orders/2026/08/24/orders-${deliveredCount}.json.gz`, {
          body: Buffer.concat(records.map(record => Buffer.from(record.Data, 'base64'))),
          contentType: 'application/json',
        });
        send(
          res,
          200,
          {
            FailedPutCount: 0,
            RequestResponses: records.map((_record, index) => ({ RecordId: `r-${index + 1}` })),
          },
          JSON_1_1,
        );
        return;
      }

      case 'Logs_20140328.DescribeLogGroups':
        send(
          res,
          200,
          {
            logGroups: [
              {
                logGroupName: LOG_GROUP,
                arn: `arn:aws:logs:us-east-1:000000000000:log-group:${LOG_GROUP}:*`,
                creationTime: 1756000000000,
                retentionInDays: 7,
                storedBytes: 8192,
                logGroupClass: 'STANDARD',
                metricFilterCount: 0,
              },
            ],
          },
          JSON_1_1,
        );
        return;
      case 'Logs_20140328.DescribeLogStreams':
        send(
          res,
          200,
          {
            logStreams: [
              {
                logStreamName: LOG_STREAM,
                creationTime: 1756000000000,
                firstEventTimestamp: 1756000001000,
                lastEventTimestamp: Date.now(),
                lastIngestionTime: Date.now(),
              },
            ],
          },
          JSON_1_1,
        );
        return;
      case 'Logs_20140328.FilterLogEvents': {
        nextLogEvent += 1;
        logEvents.push({
          eventId: String(nextLogEvent),
          logStreamName: LOG_STREAM,
          timestamp: Date.now(),
          ingestionTime: Date.now(),
          message: `delivery ${nextLogEvent} succeeded`,
        });
        const startTime = Number(input.startTime ?? 0);
        send(
          res,
          200,
          { events: logEvents.filter(event => event.timestamp >= startTime) },
          JSON_1_1,
        );
        return;
      }

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
