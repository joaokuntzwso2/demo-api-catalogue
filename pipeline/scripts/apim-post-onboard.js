#!/usr/bin/env node
/*
 * Post-onboarding automation for the demo.
 *
 * It performs:
 * 1. Ensure imported APIs are deployed to the Default gateway using an API revision.
 * 2. Ensure imported APIs are published.
 * 3. Ensure DevPortal application "API Catalogue Application" exists.
 * 4. Subscribe the onboarded APIs to that application.
 *
 * Usage:
 *   node pipeline/scripts/apim-post-onboard.js accounts-api payments-api customers-api
 *   node pipeline/scripts/apim-post-onboard.js --all-demo
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

const APP_NAME = process.env.API_CATALOGUE_APP_NAME || 'API Catalogue Application';
const DEFAULT_GATEWAY_NAME = process.env.APIM_GATEWAY_NAME || 'Default';
const DEFAULT_GATEWAY_VHOST = process.env.APIM_GATEWAY_VHOST || 'localhost';

const ALL_DEMO_APIS = [
  'accounts-api',
  'payments-api',
  'customers-api',
  'cards-api',
  'loans-api'
];

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function requestRaw(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    payload
  };
}

async function requestJson(url, options = {}) {
  const result = await requestRaw(url, options);
  if (!result.ok) {
    const body = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
    throw new Error(`HTTP ${result.status} ${options.method || 'GET'} ${url}: ${body}`);
  }
  return result.payload;
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
      clientName: `api-catalogue-post-onboard-${Date.now()}`,
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

async function getPublisherToken() {
  return registerClient([
    'apim:api_view',
    'apim:api_create',
    'apim:api_manage',
    'apim:api_publish',
    'apim:api_deploy',
    'apim:api_deploy_view',
    'apim:api_lifecycle_manage',
    'apim:api_revision_create',
    'apim:api_import_export'
  ]);
}

async function getDevPortalToken() {
  return registerClient([
    'apim:api_view',
    'apim:subscribe',
    'apim:app_manage',
    'apim:sub_manage'
  ]);
}

async function findPublisherApiByName(token, apiName) {
  const response = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis?limit=100&query=name:${encodeURIComponent(apiName)}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const api = (response.list || []).find((item) => item.name === apiName) || (response.list || [])[0];
  if (!api) {
    throw new Error(`API not found in Publisher: ${apiName}`);
  }

  const fullApi = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(api.id)}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return fullApi;
}

async function listDeployments(token, apiId) {
  const response = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(apiId)}/deployments`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return response.list || [];
}

async function listRevisions(token, apiId) {
  const response = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(apiId)}/revisions`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return response.list || [];
}

async function createRevision(token, apiId) {
  const result = await requestRaw(`${APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(apiId)}/revisions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      description: `Automated deployment revision created by API catalogue demo at ${new Date().toISOString()}`
    })
  });

  if (result.ok) {
    return result.payload;
  }

  const revisions = await listRevisions(token, apiId);
  if (revisions.length > 0) {
    return revisions[0];
  }

  const body = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  throw new Error(`Could not create or reuse revision for API ${apiId}: HTTP ${result.status}: ${body}`);
}

async function deployRevision(token, apiId, revisionId) {
  const body = [
    {
      name: DEFAULT_GATEWAY_NAME,
      vhost: DEFAULT_GATEWAY_VHOST,
      displayOnDevportal: true
    }
  ];

  const result = await requestRaw(
    `${APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(apiId)}/deploy-revision?revisionId=${encodeURIComponent(revisionId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (result.ok || result.status === 409) {
    return result.payload;
  }

  const payload = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  throw new Error(`Failed to deploy revision ${revisionId} for API ${apiId}: HTTP ${result.status}: ${payload}`);
}

async function ensureApiDeployed(token, api) {
  const deployments = await listDeployments(token, api.id);

  const alreadyDeployed = deployments.some((deployment) => {
    return deployment.name === DEFAULT_GATEWAY_NAME && deployment.vhost === DEFAULT_GATEWAY_VHOST;
  });

  if (alreadyDeployed) {
    return {
      deployed: false,
      reason: 'already deployed'
    };
  }

  const revision = await createRevision(token, api.id);
  const revisionId = revision.id || revision.revisionUuid || revision.uuid;

  if (!revisionId) {
    throw new Error(`Could not determine revision ID from response: ${JSON.stringify(revision)}`);
  }

  await deployRevision(token, api.id, revisionId);

  return {
    deployed: true,
    revisionId
  };
}

async function ensureApiPublished(token, api) {
  const state = String(api.lifeCycleStatus || api.lifecycleStatus || '').toUpperCase();

  if (state === 'PUBLISHED') {
    return {
      published: false,
      reason: 'already published'
    };
  }

  const result = await requestRaw(
    `${APIM_HOST}/api/am/publisher/v4/apis/change-lifecycle?apiId=${encodeURIComponent(api.id)}&action=Publish`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (result.ok || result.status === 409) {
    return {
      published: result.ok,
      status: result.status
    };
  }

  const payload = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  throw new Error(`Failed to publish API ${api.name}: HTTP ${result.status}: ${payload}`);
}

async function findDevPortalApiByName(token, apiName) {
  const response = await requestJson(`${APIM_HOST}/api/am/devportal/v3/apis?limit=100&query=name:${encodeURIComponent(apiName)}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const api = (response.list || []).find((item) => item.name === apiName) || (response.list || [])[0];
  if (!api) {
    throw new Error(`API not found in DevPortal: ${apiName}. Confirm it is published and visible.`);
  }

  return api;
}

async function findOrCreateApplication(token) {
  const apps = await requestJson(`${APIM_HOST}/api/am/devportal/v3/applications?limit=100`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const existing = (apps.list || []).find((app) => app.name === APP_NAME);
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
      description: 'Application automatically created by the WSO2 API Catalogue demo.',
      tokenType: 'JWT'
    })
  });
}

async function ensureSubscription(token, app, api) {
  const appId = app.applicationId || app.id;

  const existing = await requestJson(
    `${APIM_HOST}/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(appId)}&apiId=${encodeURIComponent(api.id)}&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  const found = (existing.list || []).find((sub) => {
    return sub.apiId === api.id || sub.apiInfo?.id === api.id;
  });

  if (found) {
    return {
      subscribed: false,
      subscription: found,
      reason: 'already subscribed'
    };
  }

  const result = await requestRaw(`${APIM_HOST}/api/am/devportal/v3/subscriptions`, {
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
    return {
      subscribed: true,
      subscription: result.payload
    };
  }

  if (result.status === 409) {
    return {
      subscribed: false,
      reason: 'already subscribed or subscription conflict'
    };
  }

  const payload = typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload);
  throw new Error(`Failed to subscribe ${APP_NAME} to ${api.name}: HTTP ${result.status}: ${payload}`);
}

function resolveApiNames() {
  const args = process.argv.slice(2).filter((arg) => arg.trim());

  if (args.includes('--all-demo')) {
    return ALL_DEMO_APIS;
  }

  if (args.length > 0) {
    return args;
  }

  return ALL_DEMO_APIS;
}

async function main() {
  const apiNames = resolveApiNames();

  console.log(`Post-onboarding APIs: ${apiNames.join(', ')}`);
  console.log(`DevPortal application: ${APP_NAME}`);
  console.log(`Gateway deployment: ${DEFAULT_GATEWAY_NAME} / ${DEFAULT_GATEWAY_VHOST}`);

  const publisherToken = await getPublisherToken();
  const devportalToken = await getDevPortalToken();

  const app = await findOrCreateApplication(devportalToken);

  const results = [];

  for (const apiName of apiNames) {
    const publisherApi = await findPublisherApiByName(publisherToken, apiName);

    const deployment = await ensureApiDeployed(publisherToken, publisherApi);
    const publishing = await ensureApiPublished(publisherToken, publisherApi);

    // Give APIM a short moment to make the API visible in DevPortal after publishing.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const devportalApi = await findDevPortalApiByName(devportalToken, apiName);
    const subscription = await ensureSubscription(devportalToken, app, devportalApi);

    results.push({
      api: apiName,
      apiId: publisherApi.id,
      lifecycleBefore: publisherApi.lifeCycleStatus || publisherApi.lifecycleStatus,
      deployment,
      publishing,
      subscription
    });
  }

  console.log(JSON.stringify({
    status: 'PASS',
    application: {
      name: app.name,
      id: app.applicationId || app.id
    },
    results
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    error: e.message
  }, null, 2));
  process.exit(1);
});
