#!/usr/bin/env node

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`HTTP ${response.status} ${options.method || 'GET'} ${url}: ${body}`);
  }

  return payload;
}

async function getToken() {
  const client = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `service-catalog-list-client-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const params = new URLSearchParams();
  params.set('grant_type', 'password');
  params.set('username', APIM_USERNAME);
  params.set('password', APIM_PASSWORD);
  params.set(
    'scope',
    [
      'service_catalog:service_view',
      'service_catalog:service_write',
      'apim:api_view',
      'apim:api_create',
      'apim:api_publish',
      'apim:admin'
    ].join(' ')
  );

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
  const token = await getToken();

  const response = await requestJson(`${APIM_HOST}/api/am/service-catalog/v1/services?limit=100`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const services = response.list || [];

  console.log(JSON.stringify({
    count: services.length,
    services: services.map((service) => ({
      name: service.name,
      version: service.version,
      key: service.key,
      serviceUrl: service.serviceUrl,
      definitionType: service.definitionType
    }))
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    error: e.message
  }, null, 2));
  process.exit(1);
});
