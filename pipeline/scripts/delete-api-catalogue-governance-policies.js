const APIM_HOST = process.env.APIM_HOST || 'https://wso2-apim:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

const POLICY_NAMES = [
  'API Catalogue Deployment Gate',
  'API Catalogue Publish Gate',
  'API Catalogue Category Gate',
  'API Catalogue Health Gate'
];

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[delete-api-catalogue-governance-policies] WARNING: TLS validation disabled for local demo.');
}

function basic(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

async function requestText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (response.ok === false) {
    throw new Error(`HTTP ${response.status} ${options.method || 'GET'} ${url}: ${text}`);
  }

  return text;
}

async function requestJson(url, options = {}) {
  const text = await requestText(url, options);

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function listFromPayload(payload) {
  return Array.isArray(payload) ? payload : payload.list || [];
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
      clientName: `api-catalogue-governance-disable-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('username', APIM_USERNAME);
  body.set('password', APIM_PASSWORD);
  body.set('scope', 'apim:gov_policy_read apim:gov_policy_manage');

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

async function main() {
  const token = await getToken();

  const payload = await requestJson(`${APIM_HOST}/api/am/governance/v1/policies?limit=500`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const policies = listFromPayload(payload);
  let deleted = 0;

  for (const policy of policies) {
    if (!policy.id || !POLICY_NAMES.includes(policy.name)) {
      continue;
    }

    await requestText(`${APIM_HOST}/api/am/governance/v1/policies/${encodeURIComponent(policy.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    deleted += 1;
    console.log(`[delete-api-catalogue-governance-policies] deleted policy: ${policy.name} (${policy.id})`);
  }

  if (deleted === 0) {
    console.log('[delete-api-catalogue-governance-policies] no API Catalogue governance policies found.');
  }
}

main().catch((e) => {
  console.error(`[delete-api-catalogue-governance-policies] ERROR: ${e.message}`);
  process.exit(1);
});
