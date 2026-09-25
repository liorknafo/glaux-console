#!/usr/bin/env node
/**
 * A stand-in emulator for the end-to-end test.
 *
 * This is NOT a model of how glaux or fakecloud behave beyond the two things
 * the console's contract depends on: `GET /_fakecloud/health` for capability
 * discovery, and the SQS JSON protocol for a request that goes all the way
 * through the console backend and back into a table. The spec's real
 * end-to-end target — an all-in-one glaux binary — is not available in this
 * repo's CI yet; see the PR body.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.FIXTURE_PORT ?? 4610);

const queues = new Map([
  ['orders', 'http://127.0.0.1:4610/000000000000/orders'],
  ['events', 'http://127.0.0.1:4610/000000000000/events'],
]);

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/x-amz-json-1.0');
  res.end(payload);
}

createServer((req, res) => {
  if (req.url === '/_fakecloud/health') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', version: 'e2e-fixture', services: ['sqs'] }));
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
