// Add this file to the Apps Script project that runs the portfolio trigger.
// Use the project settings UI to set TINVEST_PROXY_ORIGIN and TINVEST_PROXY_KEY.
function tInvestProxyFetch_(token, method, body) {
  const settings = PropertiesService.getScriptProperties();
  const origin = (settings.getProperty('TINVEST_PROXY_ORIGIN') || '').trim();
  const key = (settings.getProperty('TINVEST_PROXY_KEY') || '').trim();
  if (!/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(origin)) {
    throw new Error('TINVEST_PROXY_ORIGIN must be an HTTPS origin without a trailing slash');
  }
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid TINVEST_PROXY_KEY');
  if (!/^[A-Z][A-Za-z0-9]*Service\/[A-Z][A-Za-z0-9]*$/.test(method)) throw new Error('Invalid RPC method');

  return UrlFetchApp.fetch(origin + '/rest/tinkoff.public.invest.api.contract.v1.' + method, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'X-Proxy-Key': key },
    payload: JSON.stringify(body),
    validateHttpsCertificates: true,
    followRedirects: false,
    muteHttpExceptions: true,
  });
}

// A manual smoke test. Logs only an HTTP status, never account IDs or the response body.
function checkTInvestProxy() {
  const token = PropertiesService.getScriptProperties().getProperty('TINVEST_TOKEN');
  if (!token) throw new Error('Set TINVEST_TOKEN to a read-only bank token');
  const response = tInvestProxyFetch_(token, 'UsersService/GetAccounts', {});
  const status = response.getResponseCode();
  if (status !== 200) throw new Error('GetAccounts HTTP ' + status);
  if (!Array.isArray(JSON.parse(response.getContentText()).accounts)) throw new Error('Unexpected GetAccounts response');
  console.log('GetAccounts HTTP 200');
}
