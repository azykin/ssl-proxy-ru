import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway } from '../src/gateway.mjs';

const key = 'f'.repeat(64);
const bearer = 'Bearer test-invest-token';
const accounts = 'UsersService/GetAccounts';
const positions = 'OperationsService/GetPositions';
const prefix = '/rest/tinkoff.public.invest.api.contract.v1.';
let certs;
let ca;

// The keys and both server identities exist only for the lifetime of this test run.
function openssl(...args) {
  execFileSync('openssl', args, { cwd: certs, stdio: 'pipe' });
}

function issueServerCert(name, subjectAltName) {
  writeFileSync(join(certs, name + '.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=' + subjectAltName,
  ].join('\n'));
  openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-noenc', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + name);
  openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
    '-CAcreateserial', '-days', '1', '-extfile', name + '.ext', '-out', name + '.pem');
}

before(() => {
  certs = mkdtempSync(join(tmpdir(), 'ssl-proxy-test-'));
  for (const root of ['ca', 'other-ca']) {
    openssl('req', '-new', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-noenc', '-keyout', root + '.key', '-out', root + '.pem', '-subj', '/CN=Gateway test ' + root,
      '-days', '1', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  }
  ca = readFileSync(join(certs, 'ca.pem'));
  issueServerCert('bank', 'IP:127.0.0.1');
  issueServerCert('other-bank', 'DNS:other-bank.example');
});

after(() => {
  if (certs) rmSync(certs, { force: true, recursive: true });
});

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return server.address().port;
}

async function setup(t, respond, options = {}, identity = 'bank') {
  const calls = [];
  const bank = createServer({
    cert: readFileSync(join(certs, identity + '.pem')),
    key: readFileSync(join(certs, identity + '.key')),
  }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (respond) respond(req, res);
    else res.end('{}');
  });
  const bankPort = await listen(t, bank);
  const gateway = createGateway({
    upstream: new URL('https://127.0.0.1:' + bankPort),
    ca,
    key,
    allowedMethods: new Set([accounts]),
    ...options,
  });
  const gatewayPort = await listen(t, gateway);
  const base = 'http://127.0.0.1:' + gatewayPort;
  return { calls, base, bankPort };
}

function post(base, method = accounts, options = {}) {
  const { headers, ...other } = options;
  return fetch(base + prefix + method, {
    method: 'POST',
    redirect: 'manual',
    body: '{}',
    ...other,
    headers: {
      authorization: bearer,
      'x-proxy-key': key,
      'content-type': 'application/json',
      ...headers,
    },
  });
}

test('forwards the portfolio request to the configured HTTPS host and preserves the bank response', async t => {
  const result = '{"accounts":[{"id":"test"}]}';
  const { base, calls, bankPort } = await setup(t, (_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': 'bankSession=test',
      'cache-control': 'public',
    });
    res.end(result);
  });
  const body = '{ "status": "ACCOUNT_STATUS_ALL" }';
  const response = await post(base, accounts + '?a=one%20two&a=three', {
    body,
    headers: {
      cookie: 'sheet=test',
      'x-forwarded-host': 'ignored.example',
      'x-client-extra': 'local-only',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), result);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, prefix + accounts + '?a=one%20two&a=three');
  assert.equal(call.body, body);
  assert.equal(call.headers.host, '127.0.0.1:' + bankPort);
  assert.equal(call.headers.authorization, bearer);
  assert.equal(call.headers['content-type'], 'application/json');
  for (const header of ['x-proxy-key', 'cookie', 'x-forwarded-host', 'x-client-extra']) {
    assert.equal(call.headers[header], undefined, header);
  }
});

test('preserves the bank rate-limit status, retry delay and error body', async t => {
  const { base } = await setup(t, (_req, res) => {
    res.writeHead(429, {
      'retry-after': '7', 'content-type': 'application/json',
      'x-ratelimit-remaining': '0', 'x-tracking-id': 'test-request-id',
    });
    res.end('{"message":"quota"}');
  });
  const response = await post(base);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '7');
  assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(response.headers.get('x-tracking-id'), 'test-request-id');
  assert.deepEqual(await response.json(), { message: 'quota' });
});

test('rejects unauthorized calls, unsupported paths and disallowed methods before contacting the bank', async t => {
  const { base, calls } = await setup(t);
  const blocked = [
    [401, () => post(base, accounts, { headers: { 'x-proxy-key': '' } })],
    [401, () => post(base, accounts, { headers: { 'x-proxy-key': 'e'.repeat(64) } })],
    [400, () => post(base, accounts, { headers: { authorization: '' } })],
    [403, () => post(base, positions)],
    [404, () => post(base, 'UsersService/')],
    [404, () => fetch(base + '/unconfigured', { headers: { 'x-proxy-key': key, authorization: bearer } })],
    [405, () => fetch(base + prefix + accounts, { headers: { 'x-proxy-key': key, authorization: bearer } })],
  ];
  for (const [status, request] of blocked) {
    const res = await request();
    assert.equal(res.status, status);
  }
  assert.equal(calls.length, 0);
});

test('full RPC mode forwards another canonical method of the configured bank', async t => {
  const { base, calls } = await setup(t, null, { allowedMethods: null });
  const res = await post(base, positions);
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, prefix + positions);
});

test('upstream redirect stays inside the gateway and never reaches the client or a second HTTP call', async t => {
  const { base, calls } = await setup(t, (_req, res) => {
    res.writeHead(307, { location: '/elsewhere', 'content-type': 'application/json' });
    res.end('{"private":"redirect body"}');
  });
  const response = await post(base);
  assert.equal(response.status, 502);
  assert.equal(response.headers.has('location'), false);
  assert.doesNotMatch(await response.text(), /private|elsewhere/);
  assert.equal(calls.length, 1);
});

test('TLS handshake rejects an untrusted chain', async t => {
  // Use an independently generated CA in the gateway trust store.
  const { base, calls } = await setup(t, null, { ca: readFileSync(join(certs, 'other-ca.pem')) });
  assert.equal((await post(base)).status, 502);
  assert.equal(calls.length, 0);
});

test('TLS handshake rejects a trusted certificate issued for a different host', async t => {
  const { base, calls } = await setup(t, null, {}, 'other-bank');
  assert.equal((await post(base)).status, 502);
  assert.equal(calls.length, 0);
});

test('local health check requires no credentials and performs no bank request', async t => {
  const { base, calls } = await setup(t);
  const response = await fetch(base + '/healthz');
  assert.ok(response.ok);
  assert.equal(calls.length, 0);
});

test('rejects oversized requests before forwarding any bytes to the bank', async t => {
  const { base, calls } = await setup(t, null, { maxRequestBytes: 16 });
  const result = await post(base, accounts, { body: 'x'.repeat(17) });
  assert.equal(result.status, 413);
  assert.equal(calls.length, 0);
});

test('enforces the request limit when the client streams without a Content-Length', async t => {
  const { base, calls } = await setup(t, null, { maxRequestBytes: 16 });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(12));
      controller.enqueue(Buffer.alloc(6));
      controller.close();
    },
  });
  const response = await post(base, accounts, { body, duplex: 'half' });
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('rejects oversized upstream responses without returning partial bank data', async t => {
  const { base } = await setup(t, (_req, res) => {
    res.write('unpublished-bank-');
    res.end('response');
  }, { maxResponseBytes: 16 });
  const result = await post(base);
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /unpublished-bank/);
});

test('limits authenticated requests and keeps rejected credentials out of the quota', async t => {
  const { base, calls } = await setup(t, null, { requestsPerMinute: 1 });
  assert.equal((await post(base, accounts, { headers: { 'x-proxy-key': '' } })).status, 401);
  assert.equal((await post(base)).status, 200);
  assert.equal((await post(base)).status, 429);
  assert.equal(calls.length, 1);
});

test('limits concurrent requests and releases capacity when a call completes', { timeout: 5000 }, async t => {
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let firstResponse;
  const { base, calls } = await setup(t, (_req, res) => {
    if (!firstResponse) {
      firstResponse = res;
      signalStarted();
    } else res.end('{}');
  }, { maxConcurrent: 1 });
  const inFlight = post(base);
  await started;
  try {
    assert.equal((await post(base)).status, 429);
  } finally {
    firstResponse.end('{}');
  }
  assert.equal((await inFlight).status, 200);
  assert.equal((await post(base)).status, 200);
  assert.equal(calls.length, 2);
});

test('times out a bank response that stalls after sending its headers', async t => {
  const { base, calls } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"incomplete":');
  }, { upstreamTimeoutMs: 200 });
  const response = await post(base);
  assert.equal(response.status, 504);
  assert.doesNotMatch(await response.text(), /incomplete/);
  assert.equal(calls.length, 1);
});

test('HTTP mode preserves method, query and optional origin authorization on a fixed host', async t => {
  const { base, calls, bankPort } = await setup(t, null, { httpMode: true });
  const put = await fetch(base + '/reports/report-1?format=short&format=full', {
    method: 'PUT',
    body: 'report body',
    headers: {
      authorization: 'Basic dGVzdDp0ZXN0',
      'idempotency-key': 'test-operation-1',
      'content-type': 'text/plain',
      'x-proxy-key': key,
      'x-forwarded-host': 'ignored.example',
      cookie: 'sheet=test',
    },
  });
  assert.equal(put.status, 200);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, '/reports/report-1?format=short&format=full');
  assert.equal(calls[0].body, 'report body');
  assert.equal(calls[0].headers.authorization, 'Basic dGVzdDp0ZXN0');
  assert.equal(calls[0].headers['idempotency-key'], 'test-operation-1');
  assert.equal(calls[0].headers.via, '1.1 ssl-proxy-ru');
  assert.equal(calls[0].headers.host, '127.0.0.1:' + bankPort);
  assert.equal(calls[0].headers['x-proxy-key'], undefined);
  assert.equal(calls[0].headers['x-forwarded-host'], undefined);
  assert.equal(calls[0].headers.cookie, undefined);

  const get = await fetch(base + '/market?day=1', { headers: { 'x-proxy-key': key } });
  assert.equal(get.status, 200);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, '/market?day=1');
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal((await fetch(base + '/market')).status, 401);
  assert.equal(calls.length, 2);
});

test('HTTP mode supports HEAD, byte ranges and conditional requests', async t => {
  const { base, calls } = await setup(t, (req, res) => {
    res.setHeader('etag', '"v1"');
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '8' });
      res.end();
    } else if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304);
      res.end();
    } else if (req.headers.range === 'bytes=0-3') {
      res.writeHead(206, { 'content-range': 'bytes 0-3/8', 'accept-ranges': 'bytes' });
      res.end('abcd');
    } else {
      res.end('abcdefgh');
    }
  }, { httpMode: true });
  const headers = { 'x-proxy-key': key };
  const head = await fetch(base + '/item', { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '8');
  assert.equal(await head.text(), '');
  const range = await fetch(base + '/item', { headers: { ...headers, range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-3/8');
  assert.equal(await range.text(), 'abcd');
  const same = await fetch(base + '/item', { headers: { ...headers, 'if-none-match': '"v1"' } });
  assert.equal(same.status, 304);
  assert.equal(same.headers.get('etag'), '"v1"');
  assert.equal(await same.text(), '');
  assert.equal(calls.length, 3);
});

function rawStatus(base, method, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { method, path, headers: { 'x-proxy-key': key } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.end();
  });
}

test('HTTP mode rejects alternate request targets and tunnels before reaching the configured upstream', async t => {
  const { base, calls } = await setup(t, null, { httpMode: true });
  assert.equal(await rawStatus(base, 'GET', 'https://other.example/item'), 404);
  assert.equal(await rawStatus(base, 'GET', '//other.example/item'), 404);
  assert.equal(await rawStatus(base, 'CONNECT', 'other.example:443'), 405);
  assert.equal(await rawStatus(base, 'TRACE', '/item'), 405);
  assert.equal(calls.length, 0);
});
