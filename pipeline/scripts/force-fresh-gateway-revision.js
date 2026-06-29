const APIM_HOST = process.env.APIM_HOST || 'https://wso2-apim:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';
const TARGETS = process.argv.slice(2);

const GATEWAY_ENV = process.env.APIM_GATEWAY_ENV || 'Default';
const GATEWAY_VHOST = process.env.APIM_GATEWAY_VHOST || 'localhost';

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[force-fresh-gateway-revision] WARNING: TLS validation disabled for local demo.');
}

function basic(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${options.method || 'GET'} ${url}: ${text}`);
  }

  return payload;
}

async function getToken() {
  const client = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `force-fresh-gateway-revision-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('username', APIM_USERNAME);
  body.set('password', APIM_PASSWORD);
  body.set('scope', 'apim:api_view apim:api_create apim:api_publish');

  const token = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic(client.clientId, client.clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!token.access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(token)}`);
  }

  return token.access_token;
}

function revisionId(rev) {
  return rev.id || rev.revisionUUID || rev.uuid || rev.revisionId;
}

function deploymentsFor(rev) {
  const info = Array.isArray(rev.deploymentInfo) ? rev.deploymentInfo : [];
  if (info.length > 0) {
    return info.map((d) => ({
      name: d.name || d.environment || GATEWAY_ENV,
      vhost: d.vhost || d.virtualHost || GATEWAY_VHOST,
      displayOnDevportal: true
    }));
  }

  return [{
    name: GATEWAY_ENV,
    vhost: GATEWAY_VHOST,
    displayOnDevportal: true
  }];
}

async function findApis(token) {
  const payload = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis?limit=500`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const apis = payload.list || [];
  const names = TARGETS.length ? TARGETS : apis.map((api) => api.name);

  return apis.filter((api) => names.includes(api.name));
}

async function listRevisions(token, apiId) {
  const payload = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${apiId}/revisions`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return payload.list || [];
}

async function tryUndeploy(token, apiId, rev) {
  const id = revisionId(rev);
  if (!id) return;

  try {
    await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${apiId}/undeploy-revision?revisionId=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(deploymentsFor(rev))
    });
    console.log(`[force-fresh-gateway-revision] undeployed revision ${id}`);
  } catch (e) {
    console.warn(`[force-fresh-gateway-revision] undeploy skipped/failed for ${id}: ${e.message}`);
  }
}

async function tryDeleteRevision(token, apiId, rev) {
  const id = revisionId(rev);
  if (!id) return;

  try {
    await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${apiId}/revisions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`[force-fresh-gateway-revision] deleted revision ${id}`);
  } catch (e) {
    console.warn(`[force-fresh-gateway-revision] delete failed for ${id}: ${e.message}`);
  }
}

async function createRevision(token, apiId, apiName) {
  const payload = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${apiId}/revisions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      description: `Fresh gateway revision for ${apiName} at ${new Date().toISOString()}`
    })
  });

  const id = revisionId(payload);
  if (!id) {
    throw new Error(`Could not determine created revision id: ${JSON.stringify(payload)}`);
  }

  return id;
}

async function deployRevision(token, apiId, revisionIdValue, apiName) {
  await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${apiId}/deploy-revision?revisionId=${encodeURIComponent(revisionIdValue)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([{
      name: GATEWAY_ENV,
      vhost: GATEWAY_VHOST,
      displayOnDevportal: true
    }])
  });

  console.log(`[force-fresh-gateway-revision] deployed fresh revision ${revisionIdValue} for ${apiName}`);
}

async function processApi(token, api) {
  console.log(`[force-fresh-gateway-revision] processing ${api.name}:${api.version}`);

  const existing = await listRevisions(token, api.id);
  console.log(`[force-fresh-gateway-revision] existing revisions: ${existing.length}`);

  for (const rev of existing) {
    await tryUndeploy(token, api.id, rev);
  }

  for (const rev of existing) {
    await tryDeleteRevision(token, api.id, rev);
  }

  const remaining = await listRevisions(token, api.id);
  if (remaining.length >= 5) {
    throw new Error(`${api.name} still has ${remaining.length} revisions after cleanup. Delete revisions manually in APIM.`);
  }

  const freshRevisionId = await createRevision(token, api.id, api.name);
  await deployRevision(token, api.id, freshRevisionId, api.name);
}

async function main() {
  const token = await getToken();
  const apis = await findApis(token);

  if (!apis.length) {
    throw new Error(`No matching APIs found. Targets: ${TARGETS.join(', ') || '(all)'}`);
  }

  for (const api of apis) {
    await processApi(token, api);
  }

  console.log('[force-fresh-gateway-revision] done');
}

main().catch((e) => {
  console.error(`[force-fresh-gateway-revision] ERROR: ${e.message}`);
  process.exit(1);
});
