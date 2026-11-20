import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rootCertificates } from 'node:tls';
import { createGateway } from './gateway.mjs';

const portfolioMethods = [
  'UsersService/GetAccounts',
  'OperationsService/GetPortfolio',
  'OperationsService/GetPositions',
  'OperationsService/GetOperationsByCursor',
  'InstrumentsService/GetInstrumentBy',
  'InstrumentsService/GetBondEvents',
];

export function loadConfig(env = process.env) {
  const proxyMode = env.PROXY_MODE ?? 'invest';
  if (!['invest', 'upstream'].includes(proxyMode)) throw new Error('Invalid PROXY_MODE');
  const httpMode = proxyMode === 'upstream';
  const environment = env.UPSTREAM_ENV ?? 'production';
  if (!['production', 'sandbox'].includes(environment)) throw new Error('Invalid UPSTREAM_ENV');
  let upstream = environment === 'production'
    ? 'https://invest-public-api.tbank.ru'
    : 'https://sandbox-invest-public-api.tbank.ru';
  if (httpMode) {
    let url;
    try { url = new URL(env.UPSTREAM_ORIGIN); } catch { throw new Error('Set a valid HTTPS UPSTREAM_ORIGIN'); }
    if (url.protocol !== 'https:' || ![url.origin, url.origin + '/'].includes(env.UPSTREAM_ORIGIN)) {
      throw new Error('UPSTREAM_ORIGIN must be a canonical HTTPS origin without a path or credentials');
    }
    upstream = url.origin;
  } else if (env.UPSTREAM_ORIGIN) {
    throw new Error('Use UPSTREAM_ORIGIN only with PROXY_MODE=upstream');
  }

  const mode = env.RPC_MODE ?? 'portfolio';
  if (!['portfolio', 'all'].includes(mode)) throw new Error('Invalid RPC_MODE');
  const extras = env.EXTRA_RPC_METHODS?.trim() ? env.EXTRA_RPC_METHODS.split(',').map(s => s.trim()) : [];
  if (httpMode && (mode !== 'portfolio' || extras.length || environment !== 'production')) {
    throw new Error('Invest-specific settings conflict with PROXY_MODE=upstream');
  }
  if (extras.some(name => !/^[A-Z][A-Za-z0-9]*Service\/[A-Z][A-Za-z0-9]*$/.test(name))) {
    throw new Error('Invalid EXTRA_RPC_METHODS');
  }
  if (mode === 'all' && extras.length) throw new Error('Use EXTRA_RPC_METHODS only with RPC_MODE=portfolio');

  if (Boolean(env.PROXY_KEY) === Boolean(env.PROXY_KEY_FILE)) {
    throw new Error('Set exactly one of PROXY_KEY or PROXY_KEY_FILE');
  }
  let key = env.PROXY_KEY;
  if (env.PROXY_KEY_FILE) {
    try {
      key = readFileSync(env.PROXY_KEY_FILE, 'utf8').trim();
    } catch {
      throw new Error('Cannot read PROXY_KEY_FILE');
    }
  }
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Proxy key must be 64 hex characters');
  const port = env.PORT ?? '8080';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PORT');

  const bankCa = readFileSync(new URL('../certs/tbank-ca.pem', import.meta.url), 'utf8');
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(port),
    upstream,
    key,
    ca: [...rootCertificates, bankCa],
    httpMode,
    allowedMethods: !httpMode && mode === 'portfolio' ? new Set([...portfolioMethods, ...extras]) : null,
  };
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Operating system errors can include a local path. Keep it out of hosted logs.
    console.error(error.code ? 'Cannot load gateway configuration' : error.message);
    process.exitCode = 1;
    return;
  }
  const server = createGateway(config);
  server.on('error', () => {
    console.error('Gateway listener failed');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.info('Gateway ready'));
  function stop() {
    server.close();
    setTimeout(() => server.closeAllConnections(), 35000).unref();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
