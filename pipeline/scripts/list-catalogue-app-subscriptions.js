#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';
const APP_NAME = process.env.API_CATALOGUE_APP_NAME || 'API Catalogue Application';

function basicAuth(u, p) {
  return Buffer.from(`${u}:${p}`).toString('base64');
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text}`);
  }

  return json;
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
      clientName: `api-catalogue-app-check-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const body = new URLSearchParams({
    grant_type: 'password',
    username: APIM_USERNAME,
    password: APIM_PASSWORD,
    scope: 'apim:api_view apim:subscribe apim:app_manage apim:sub_manage'
  });

  const token = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(client.clientId, client.clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  return token.access_token;
}

async function main() {
  const accessToken = await getToken();

  const apps = await requestJson(`${APIM_HOST}/api/am/devportal/v3/applications?limit=200`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const app = (apps.list || []).find((a) => a.name === APP_NAME);

  if (!app) {
    console.log(JSON.stringify({
      status: 'NOT_FOUND',
      message: `Application not found: ${APP_NAME}`,
      availableApplications: (apps.list || []).map((a) => ({
        name: a.name,
        id: a.applicationId || a.id
      }))
    }, null, 2));
    process.exit(1);
  }

  const appId = app.applicationId || app.id;

  const subs = await requestJson(
    `${APIM_HOST}/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(appId)}&limit=200`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  console.log(JSON.stringify({
    status: 'OK',
    application: {
      name: app.name,
      id: appId
    },
    subscriptions: (subs.list || []).map((s) => ({
      apiName: s.apiInfo?.name || s.apiName || s.name,
      apiVersion: s.apiInfo?.version || s.apiVersion || s.version,
      throttlingPolicy: s.throttlingPolicy,
      status: s.status
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
