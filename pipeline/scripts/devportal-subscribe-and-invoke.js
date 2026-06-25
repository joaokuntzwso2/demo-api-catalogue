#!/usr/bin/env node
/*
 * Creates/reuses a Developer Portal application, subscribes it to a published API,
 * creates/reuses production keys, obtains a client-credentials token, and invokes
 * the API through the APIM Gateway.
 *
 * Usage:
 *   node pipeline/scripts/devportal-subscribe-and-invoke.js accounts-api /accounts/v1/health
 *
 * Optional:
 *   DEMO_APP_NAME="My Demo App" node pipeline/scripts/devportal-subscribe-and-invoke.js accounts-api /accounts/v1/health
 */

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const GATEWAY_HTTPS = process.env.GATEWAY_HTTPS || 'https://localhost:8243';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';
const APP_NAME = process.env.DEMO_APP_NAME || 'Bank Catalogue Demo Application';
const API_NAME = process.argv[2] || process.env.DEMO_API_NAME || 'accounts-api';
const INVOKE_PATH = process.argv[3] || process.env.DEMO_INVOKE_PATH || '/accounts/v1/health';

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function requestJsonRaw(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
    text
  };
}

async function requestJson(url, options = {}) {
  const result = await requestJsonRaw(url, options);

  if (!result.ok) {
    const body = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
    throw new Error(`HTTP ${result.status} ${options.method || 'GET'} ${url}: ${body}`);
  }

  return result.payload;
}

async function requestText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    text
  };
}

async function registerClient(scopes) {
  const client = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `devportal-demo-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const params = new URLSearchParams();
  params.set('grant_type', 'password');
  params.set('username', APIM_USERNAME);
  params.set('password', APIM_PASSWORD);
  params.set('scope', scopes.join(' '));

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

async function listAll(path, token) {
  const response = await requestJson(`${APIM_HOST}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return response.list || [];
}

async function findApi(token, name) {
  const apis = await listAll(`/api/am/devportal/v3/apis?limit=100&query=name:${encodeURIComponent(name)}`, token);
  return apis.find((api) => api.name === name) || apis[0];
}

async function findOrCreateApplication(token) {
  const apps = await listAll('/api/am/devportal/v3/applications?limit=100', token);
  const existing = apps.find((app) => app.name === APP_NAME);

  if (existing) {
    return existing;
  }

  return requestJson(`${APIM_HOST}/api/am/devportal/v3/applications`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: APP_NAME,
      throttlingPolicy: 'Unlimited',
      description: 'Application created by the APIM + Integrator catalogue demo.',
      tokenType: 'JWT'
    })
  });
}

async function ensureSubscription(token, api, app) {
  const appId = app.applicationId || app.id;

  const subs = await listAll(
    `/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(appId)}&apiId=${encodeURIComponent(api.id)}`,
    token
  );

  const existing = subs.find((sub) => {
    return (
      sub.apiId === api.id ||
      sub.apiInfo?.id === api.id ||
      sub.applicationId === appId
    );
  });

  if (existing) {
    return existing;
  }

  const result = await requestJsonRaw(`${APIM_HOST}/api/am/devportal/v3/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      apiId: api.id,
      applicationId: appId,
      throttlingPolicy: 'Unlimited'
    })
  });

  if (result.ok) {
    return result.payload;
  }

  if (result.status === 409) {
    const refreshed = await listAll(
      `/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(appId)}&apiId=${encodeURIComponent(api.id)}`,
      token
    );

    const existingAfterConflict = refreshed.find((sub) => {
      return (
        sub.apiId === api.id ||
        sub.apiInfo?.id === api.id ||
        sub.applicationId === appId
      );
    });

    if (existingAfterConflict) {
      return existingAfterConflict;
    }
  }

  const body = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  throw new Error(`HTTP ${result.status} POST subscription: ${body}`);
}

function findCredentials(node, seen = new Set()) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (seen.has(node)) {
    return null;
  }

  seen.add(node);

  if (node.consumerKey && node.consumerSecret) {
    return {
      consumerKey: node.consumerKey,
      consumerSecret: node.consumerSecret
    };
  }

  if (node.keyMapping && node.keyMapping.consumerKey && node.keyMapping.consumerSecret) {
    return {
      consumerKey: node.keyMapping.consumerKey,
      consumerSecret: node.keyMapping.consumerSecret
    };
  }

  for (const value of Object.values(node)) {
    const found = findCredentials(value, seen);
    if (found) {
      return found;
    }
  }

  return null;
}

async function getExistingProductionKeys(token, app) {
  const appId = app.applicationId || app.id;

  const candidatePaths = [
    `/api/am/devportal/v3/applications/${encodeURIComponent(appId)}/keys/PRODUCTION`,
    `/api/am/devportal/v3/applications/${encodeURIComponent(appId)}/keys?keyType=PRODUCTION`,
    `/api/am/devportal/v3/applications/${encodeURIComponent(appId)}`
  ];

  for (const candidatePath of candidatePaths) {
    const result = await requestJsonRaw(`${APIM_HOST}${candidatePath}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!result.ok) {
      continue;
    }

    const credentials = findCredentials(result.payload);

    if (credentials) {
      return {
        ...result.payload,
        consumerKey: credentials.consumerKey,
        consumerSecret: credentials.consumerSecret,
        reusedExistingKeys: true
      };
    }
  }

  return null;
}

async function generateKeys(token, app) {
  const appId = app.applicationId || app.id;

  const existing = await getExistingProductionKeys(token, app);
  if (existing) {
    return existing;
  }

  const body = {
    keyType: 'PRODUCTION',
    grantTypesToBeSupported: ['client_credentials'],
    callbackUrl: 'https://localhost/callback',
    validityTime: 3600
  };

  const result = await requestJsonRaw(
    `${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(appId)}/generate-keys`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (result.ok) {
    return result.payload;
  }

  if (result.status === 409) {
    const existingAfterConflict = await getExistingProductionKeys(token, app);

    if (existingAfterConflict) {
      return existingAfterConflict;
    }

    throw new Error(
      [
        'APIM says production key mappings already exist, but the script could not read the existing consumer key/secret.',
        'Fast workaround:',
        `  DEMO_APP_NAME="Bank Catalogue Demo Application $(date +%s)" npm run platform:subscribe:accounts`,
        'Or delete the existing demo application in Developer Portal and run again.'
      ].join('\n')
    );
  }

  const bodyText = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  throw new Error(`HTTP ${result.status} POST generate-keys: ${bodyText}`);
}

async function getClientCredentialsToken(keyInfo) {
  const credentials = findCredentials(keyInfo) || keyInfo;
  const key = credentials.consumerKey;
  const secret = credentials.consumerSecret;

  if (!key || !secret) {
    throw new Error(`Could not find consumerKey/consumerSecret in key response: ${JSON.stringify(keyInfo)}`);
  }

  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');

  const token = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(key, secret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  return token.access_token;
}

async function main() {
  const scopes = [
    'apim:subscribe',
    'apim:api_view',
    'apim:app_manage',
    'apim:sub_manage'
  ];

  const devportalToken = await registerClient(scopes);

  const api = await findApi(devportalToken, API_NAME);
  if (!api) {
    throw new Error(`API not found in Developer Portal: ${API_NAME}. Make sure it is published first.`);
  }

  const app = await findOrCreateApplication(devportalToken);
  const subscription = await ensureSubscription(devportalToken, api, app);
  const keys = await generateKeys(devportalToken, app);
  const accessToken = await getClientCredentialsToken(keys);

  const invokeUrl = `${GATEWAY_HTTPS}${INVOKE_PATH}`;
  const invocation = await requestText(invokeUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  console.log(JSON.stringify({
    status: invocation.ok ? 'PASS' : 'FAIL',
    api: {
      id: api.id,
      name: api.name,
      version: api.version,
      context: api.context
    },
    application: {
      id: app.applicationId || app.id,
      name: app.name
    },
    subscription: {
      id: subscription.subscriptionId || subscription.id,
      throttlingPolicy: subscription.throttlingPolicy
    },
    keys: {
      reusedExistingKeys: Boolean(keys.reusedExistingKeys)
    },
    invocation: {
      url: invokeUrl,
      httpStatus: invocation.status,
      body: invocation.text
    },
    generatedAt: new Date().toISOString()
  }, null, 2));

  if (!invocation.ok) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    error: e.message
  }, null, 2));
  process.exit(1);
});
