import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadConfig } from '../src/main.mjs';

const key = 'a'.repeat(64);

test('defaults to the six portfolio operations on the production TLS endpoint', () => {
  const config = loadConfig({ PROXY_KEY: key });
  assert.equal(config.upstream, 'https://invest-public-api.tbank.ru');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.allowedMethods.size, 6);
  assert.ok(config.allowedMethods.has('OperationsService/GetPortfolio'));
  assert.ok(!config.allowedMethods.has('OrdersService/PostOrder'));
  assert.ok(!config.httpMode);
});

test('accepts a secret file, sandbox and an explicit RPC extension', t => {
  const directory = mkdtempSync(join(tmpdir(), 'config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'key');
  writeFileSync(file, key + '\n', { mode: 0o600 });
  const env = { PROXY_KEY_FILE: file, UPSTREAM_ENV: 'sandbox', EXTRA_RPC_METHODS: 'MarketDataService/GetCandles' };
  const config = loadConfig(env);
  assert.equal(config.key, key);
  assert.equal(config.upstream, 'https://sandbox-invest-public-api.tbank.ru');
  assert.ok(config.allowedMethods.has('MarketDataService/GetCandles'));
  assert.throws(() => loadConfig({ ...env, PROXY_KEY: key }));
});

test('requires explicit selection for generic HTTP and all bank RPCs', () => {
  assert.equal(loadConfig({ PROXY_KEY: key, RPC_MODE: 'all' }).allowedMethods, null);
  const config = loadConfig({ PROXY_KEY: key, PROXY_MODE: 'upstream', UPSTREAM_ORIGIN: 'https://api.example.org:8443' });
  assert.ok(config.httpMode);
  assert.equal(config.upstream, 'https://api.example.org:8443');
  for (const bad of [
    { PROXY_KEY: '' }, { PROXY_KEY: '12345' }, { PROXY_MODE: 'dynamic' }, { PORT: '65536' },
    { UPSTREAM_ENV: 'development' }, { EXTRA_RPC_METHODS: '*' }, { RPC_MODE: 'readwrite' },
    { UPSTREAM_ORIGIN: 'https://api.example.org' }, { PROXY_MODE: 'upstream' },
    { PROXY_MODE: 'upstream', UPSTREAM_ORIGIN: 'http://api.example.org' },
    { PROXY_MODE: 'upstream', UPSTREAM_ORIGIN: 'https://user:pass@api.example.org' },
    { PROXY_MODE: 'upstream', UPSTREAM_ORIGIN: 'https://api.example.org/path' },
  ]) assert.throws(() => loadConfig({ PROXY_KEY: key, ...bad }));
});

test('Apps Script sends a read-only request to the TLS gateway and logs only status', () => {
  const settings = { TINVEST_PROXY_ORIGIN: 'https://proxy.example.org', TINVEST_PROXY_KEY: key, TINVEST_TOKEN: 'unit-test' };
  const calls = [];
  const logs = [];
  const script = readFileSync(new URL('../examples/TInvestProxy.gs', import.meta.url), 'utf8');
  const scope = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => settings[name] }) },
    UrlFetchApp: { fetch: (url, options) => {
      calls.push({ url, options });
      return { getResponseCode: () => 200, getContentText: () => '{"accounts":[]}' };
    } },
    console: { log: message => logs.push(message) },
  };
  runInNewContext(script, scope);
  scope.checkTInvestProxy();
  const [{ url, options }] = calls;
  assert.equal(url, 'https://proxy.example.org/rest/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts');
  assert.equal(options.headers.Authorization, 'Bearer unit-test');
  assert.equal(options.headers['X-Proxy-Key'], key);
  assert.equal(options.validateHttpsCertificates, true);
  assert.equal(options.followRedirects, false);
  assert.deepEqual(logs, ['GetAccounts HTTP 200']);
  settings.TINVEST_PROXY_ORIGIN = 'http://proxy.example.org';
  assert.throws(scope.checkTInvestProxy);
  assert.equal(calls.length, 1);
});
