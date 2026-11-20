import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';

const rpcPath = /^\/rest\/tinkoff\.public\.invest\.api\.contract\.v1\.([A-Z][A-Za-z0-9]*Service\/[A-Z][A-Za-z0-9]*)$/;
const bearer = /^Bearer [A-Za-z0-9._~+\/-]+=*$/i;
const httpMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const requestHeaders = [
  'authorization', 'content-type', 'content-encoding', 'content-language', 'accept', 'accept-encoding',
  'accept-language', 'x-app-name', 'range', 'if-range', 'if-match', 'if-none-match',
  'if-modified-since', 'if-unmodified-since', 'idempotency-key',
];
const responseHeaders = [
  'content-type', 'content-encoding', 'content-language', 'content-disposition', 'retry-after', 'www-authenticate',
  'allow', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'vary',
  'x-tracking-id', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
];

function selectedHeaders(headers, names) {
  const hopByHop = new Set((headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()));
  return Object.fromEntries(names.filter(name => headers[name] !== undefined && !hopByHop.has(name))
    .map(name => [name, headers[name]]));
}

class PayloadTooLarge extends Error {}

async function readBody(stream, limit) {
  if (Number(stream.headers['content-length']) > limit) throw new PayloadTooLarge();
  const buffers = [];
  let length = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw new PayloadTooLarge();
    buffers.push(chunk);
  }
  return Buffer.concat(buffers, length);
}

function upstreamCall(origin, options, body, maxResponseBytes, httpMode) {
  return new Promise((resolve, reject) => {
    const request = https.request(origin, options, async response => {
      try {
        const status = response.statusCode;
        if (status >= 300 && status < 400 && !(httpMode && status === 304)) throw new Error('Upstream redirect');
        const headers = selectedHeaders(response.headers, responseHeaders);
        if (options.method === 'HEAD' || status === 204 || status === 304) {
          response.resume();
          // On HEAD and 304 the declared size describes the representation, not this message body.
          if (status !== 204) Object.assign(headers, selectedHeaders(response.headers, ['content-length']));
          resolve({ status, headers });
        } else {
          const payload = await readBody(response, maxResponseBytes);
          headers['content-length'] = String(payload.length);
          resolve({ status, headers, body: payload });
        }
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Unexpected upgrade'));
    });
    request.end(body);
  });
}

function reply(res, status, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: message }));
}

export function createGateway({ upstream, ca, key, allowedMethods, httpMode = false, maxRequestBytes = 1024 * 1024,
  maxResponseBytes = 16 * 1024 * 1024, maxConcurrent = 16, requestsPerMinute = 300,
  upstreamTimeoutMs = 25000 }) {
  const origin = new URL(upstream);
  if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`) throw new Error('Expected an HTTPS origin');
  if (!ca?.length || typeof key !== 'string' || !/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Invalid gateway credentials or CA');
  if (typeof httpMode !== 'boolean') throw new Error('Invalid gateway mode');
  if (!httpMode && allowedMethods !== null && !(allowedMethods instanceof Set)) throw new Error('Expected a set of allowed RPC methods');
  if (![maxRequestBytes, maxResponseBytes, maxConcurrent, requestsPerMinute, upstreamTimeoutMs]
    .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid gateway limit');

  const methods = httpMode || allowedMethods === null ? null : new Set(allowedMethods);
  const verbs = httpMode ? httpMethods : ['POST'];
  const expectedKey = Buffer.from(key, 'ascii');
  const agent = new https.Agent({ ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', keepAlive: true,
    maxSockets: maxConcurrent, maxFreeSockets: Math.min(4, maxConcurrent), proxyEnv: {} });
  let active = 0;
  let tokens = requestsPerMinute;
  let lastRefill = performance.now();

  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: 10000,
    requestTimeout: 30000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    const path = req.url.split('?', 1)[0];
    const rpc = rpcPath.exec(path)?.[1];
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || req.url.includes('#') || (!httpMode && !rpc)) {
      return reply(res, 404, 'Unknown route');
    }
    if (req.headers.upgrade !== undefined || /\bupgrade\b/i.test(req.headers.connection ?? '')) {
      return reply(res, 400, 'Protocol upgrades are disabled');
    }
    if (!verbs.includes(req.method)) return reply(res, 405, 'Method not allowed', { Allow: verbs.join(', ') });
    const suppliedKey = req.headersDistinct['x-proxy-key'];
    if (suppliedKey?.length !== 1 || !/^[a-fA-F0-9]{64}$/.test(suppliedKey[0]) ||
      !timingSafeEqual(expectedKey, Buffer.from(suppliedKey[0], 'ascii'))) {
      return reply(res, 401, 'Invalid proxy key', { 'WWW-Authenticate': 'ProxyKey realm="ssl-proxy-ru"' });
    }
    if (methods && !methods.has(rpc)) return reply(res, 403, 'RPC method denied');
    const headers = selectedHeaders(req.headers, requestHeaders);
    if (req.headersDistinct.authorization?.length > 1) return reply(res, 400, 'Duplicate authorization');
    if (req.headersDistinct['idempotency-key']?.length > 1) return reply(res, 400, 'Duplicate idempotency key');
    headers.via = req.httpVersion + ' ssl-proxy-ru';
    if (!httpMode && !bearer.test(headers.authorization ?? '')) {
      return reply(res, 400, 'Bank bearer token required');
    }
    const now = performance.now();
    tokens = Math.min(requestsPerMinute, tokens + (now - lastRefill) * requestsPerMinute / 60000);
    lastRefill = now;
    if (tokens < 1 || active >= maxConcurrent) {
      const retry = Math.max(1, Math.ceil((1 - tokens) * 60 / requestsPerMinute));
      return reply(res, 429, 'Proxy limit reached', { 'Retry-After': String(retry) });
    }
    tokens--;
    active++;
    const controller = new AbortController();
    function release() {
      res.off('finish', release);
      res.off('close', release);
      if (!res.writableFinished) controller.abort();
      active--;
    }
    res.once('finish', release);
    res.once('close', release);
    let body;
    try {
      body = await readBody(req, maxRequestBytes);
    } catch (error) {
      if (!res.destroyed) {
        const tooLarge = error instanceof PayloadTooLarge;
        reply(res, tooLarge ? 413 : 400, tooLarge ? 'Request too large' : 'Incomplete request', { Connection: 'close' });
      }
      return;
    }
    if (controller.signal.aborted) return;
    if (!httpMode) headers['content-type'] ??= 'application/json';
    if (body.length || req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined) {
      headers['content-length'] = String(body.length);
    }
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    try {
      const options = { agent, method: req.method, path: req.url, headers, signal: controller.signal };
      const result = await upstreamCall(origin, options, body, maxResponseBytes, httpMode);
      if (!res.destroyed) {
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      }
    } catch {
      if (!res.destroyed) {
        const timedOut = controller.signal.aborted;
        reply(res, timedOut ? 504 : 502, timedOut ? 'Upstream timeout' : 'Upstream request failed');
      }
    } finally {
      clearTimeout(timeout);
    }
  });
  // CONNECT bypasses the normal HTTP request handler in Node.
  server.on('connect', (_request, socket) => {
    socket.once('error', () => socket.destroy());
    socket.end(`HTTP/1.1 405 Method Not Allowed\r\nAllow: ${verbs.join(', ')}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, () => socket.destroy());
  });
  server.setTimeout(40000);
  server.maxRequestsPerSocket = 100;
  server.once('close', () => agent.destroy());
  return server;
}
