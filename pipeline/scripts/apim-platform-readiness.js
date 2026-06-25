#!/usr/bin/env node
/*
 * Platform readiness checker for the local APIM + MI catalogue demo.
 * It intentionally distinguishes platform readiness from API/backend/contract health.
 */

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const GATEWAY_HTTPS = process.env.GATEWAY_HTTPS || 'https://localhost:8243';
const MI_BASE_URL = process.env.MI_BASE_URL || 'http://localhost:8290';
const STATUS_CACHE_BASE_URL = process.env.STATUS_CACHE_BASE_URL || 'http://localhost:6300';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function call(name, url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, options);
    const latencyMs = Date.now() - started;
    return {
      name,
      url,
      status: response.ok ? 'UP' : 'DEGRADED',
      httpStatus: response.status,
      latencyMs
    };
  } catch (e) {
    return { name, url, status: 'DOWN', error: e.message };
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function getPublisherToken() {
  const dcrBody = {
    callbackUrl: 'www.google.com',
    clientName: `platform-readiness-${Date.now()}`,
    owner: APIM_USERNAME,
    grantType: 'password refresh_token client_credentials',
    saasApp: true
  };
  const client = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(dcrBody)
  });

  const params = new URLSearchParams();
  params.set('grant_type', 'password');
  params.set('username', APIM_USERNAME);
  params.set('password', APIM_PASSWORD);
  params.set('scope', 'apim:api_view');

  const token = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(client.clientId, client.clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  return token.access_token;
}

async function main() {
  const checks = [];
  checks.push(await call('APIM Carbon Console', `${APIM_HOST}/carbon`));
  checks.push(await call('APIM Publisher Portal', `${APIM_HOST}/publisher`));
  checks.push(await call('APIM Developer Portal', `${APIM_HOST}/devportal`));
  checks.push(await call('APIM Gateway HTTPS listener', `${GATEWAY_HTTPS}`));
  checks.push(await call('WSO2 Integrator health registry', `${MI_BASE_URL}/health-registry/v1/apis`));
  checks.push(await call('WSO2 Integrator catalogue status', `${MI_BASE_URL}/catalogue-status/v1/apis`));
  checks.push(await call('Health Status Cache', `${STATUS_CACHE_BASE_URL}/health`));

  try {
    const token = await getPublisherToken();
    const apis = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis?limit=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    checks.push({ name: 'APIM Publisher REST API', url: `${APIM_HOST}/api/am/publisher/v4/apis`, status: 'UP', apiCountVisible: apis.count ?? (apis.list || []).length });
  } catch (e) {
    checks.push({ name: 'APIM Publisher REST API', url: `${APIM_HOST}/api/am/publisher/v4/apis`, status: 'DOWN', error: e.message });
  }

  const status = checks.some((c) => c.status === 'DOWN') ? 'DEGRADED' : 'READY';
  const payload = {
    status,
    generatedAt: new Date().toISOString(),
    semantics: 'platform-readiness-not-api-contract-health',
    checks
  };
  console.log(JSON.stringify(payload, null, 2));
  if (status !== 'READY') process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ status: 'DOWN', error: e.message }, null, 2));
  process.exit(1);
});
