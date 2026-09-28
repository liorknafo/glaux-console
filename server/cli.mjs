#!/usr/bin/env node
/**
 * Standalone deployment: serves the built console and the backend proxy from
 * one Node process, for pointing at an emulator that does not embed the
 * console itself.
 *
 *   npx glaux-console --port 4599
 *
 * The embedded deployment (glaux mounting the assets at /console) implements
 * the same /api/request contract in Rust; this is the Node equivalent.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyHandler } from './proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const args = { port: Number(process.env.PORT ?? 4599), host: process.env.HOST ?? '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' || argv[i] === '-p') args.port = Number(argv[++i]);
    else if (argv[i] === '--host') args.host = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'glaux-console — a web console for local AWS emulators\n\n' +
      'Usage: glaux-console [--port 4599] [--host 127.0.0.1]\n',
  );
  process.exit(0);
}

const proxy = createProxyHandler();

const server = createServer((req, res) => {
  proxy(req, res, () => serveStatic(req, res)).catch(error => {
    process.stderr.write(`request failed: ${error?.stack ?? error}\n`);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal error.');
    }
  });
});

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://console.local');
  let requested;
  try {
    // decodeURIComponent throws on a malformed escape such as "/%". This runs
    // in an ignored promise, so an uncaught throw answers nothing at all.
    requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  } catch {
    res.statusCode = 400;
    res.end('Malformed request path.');
    return;
  }
  let filePath = join(DIST, requested);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // Hash routing means every non-asset path is the app shell.
    filePath = join(DIST, 'index.html');
  }

  try {
    await stat(filePath);
  } catch {
    res.statusCode = 404;
    res.end('Not found. Run `npm run build` first.');
    return;
  }

  res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
  createReadStream(filePath).pipe(res);
}

server.listen(args.port, args.host, () => {
  process.stdout.write(`glaux-console on http://${args.host}:${args.port}\n`);
});
