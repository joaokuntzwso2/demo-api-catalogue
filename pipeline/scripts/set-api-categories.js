const APIM_HOST = process.env.APIM_HOST || 'https://wso2-apim:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

const CATEGORY_BY_API = {
  'accounts-api': 'Accounts',
  'cards-api': 'Cards',
  'customers-api': 'Customers',
  'payments-api': 'Payments',
  'loans-api': 'Loans'
};

const targets = process.argv.slice(2);
const targetNames = targets.length ? new Set(targets) : new Set(Object.keys(CATEGORY_BY_API));

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[set-api-categories] WARNING: TLS validation disabled for local demo.');
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

async function getPublisherToken() {
  const client = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `api-catalogue-set-api-categories-${Date.now()}`,
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
    throw new Error(`No access_token returned: ${JSON.stringify(token)}`);
  }

  return token.access_token;
}

async function listApis(token) {
  const payload = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis?limit=500`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return payload.list || [];
}

async function getApiDetails(token, apiId) {
  return requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(apiId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function updateApi(token, apiId, api) {
  return requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(apiId)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(api)
  });
}

async function main() {
  const token = await getPublisherToken();
  const apis = await listApis(token);

  for (const summary of apis) {
    if (!targetNames.has(summary.name)) {
      continue;
    }

    const category = CATEGORY_BY_API[summary.name];

    if (!category) {
      continue;
    }

    const api = await getApiDetails(token, summary.id);
    const current = Array.isArray(api.categories) ? api.categories : [];

    if (current.includes(category) && current.length === 1) {
      console.log(`[set-api-categories] ${summary.name}:${summary.version} already has category ${category}`);
      continue;
    }

    api.categories = [category];

    await updateApi(token, summary.id, api);

    console.log(`[set-api-categories] updated ${summary.name}:${summary.version} categories=[${category}]`);
  }
}

main().catch((e) => {
  console.error(`[set-api-categories] ERROR: ${e.message}`);
  process.exit(1);
});
