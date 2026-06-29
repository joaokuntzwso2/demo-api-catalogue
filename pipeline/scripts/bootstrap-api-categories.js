const APIM_HOST = process.env.APIM_HOST || 'https://wso2-apim:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

const CATEGORIES = [
  { name: 'Accounts', description: 'Account management APIs' },
  { name: 'Cards', description: 'Card management APIs' },
  { name: 'Customers', description: 'Customer data APIs' },
  { name: 'Payments', description: 'Payment processing APIs' },
  { name: 'Loans', description: 'Loan management APIs' }
];

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[bootstrap-api-categories] WARNING: TLS validation disabled for local demo.');
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
      clientName: `api-catalogue-category-bootstrap-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('username', APIM_USERNAME);
  body.set('password', APIM_PASSWORD);

  // Include all likely admin/category scopes used across APIM versions.
  body.set('scope', 'apim:admin apim:api_category_manage admin_operations');

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

function listFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.apiCategories)) return payload.apiCategories;
  if (Array.isArray(payload.categories)) return payload.categories;
  return [];
}

async function listCategories(token, basePath) {
  const payload = await requestJson(`${APIM_HOST}${basePath}/api-categories`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return listFromPayload(payload);
}

async function createCategory(token, basePath, category) {
  await requestJson(`${APIM_HOST}${basePath}/api-categories`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(category)
  });
}

async function ensureWithBasePath(token, basePath) {
  console.log(`[bootstrap-api-categories] using ${basePath}`);

  let existing = await listCategories(token, basePath);
  let existingNames = new Set(existing.map((item) => item.name || item.displayName).filter(Boolean));

  for (const category of CATEGORIES) {
    if (existingNames.has(category.name)) {
      console.log(`[bootstrap-api-categories] exists: ${category.name}`);
      continue;
    }

    await createCategory(token, basePath, category);
    console.log(`[bootstrap-api-categories] created: ${category.name}`);
  }

  existing = await listCategories(token, basePath);
  existingNames = new Set(existing.map((item) => item.name || item.displayName).filter(Boolean));

  const missing = CATEGORIES.map((item) => item.name).filter((name) => !existingNames.has(name));

  if (missing.length > 0) {
    throw new Error(`Category bootstrap incomplete. Missing: ${missing.join(', ')}`);
  }

  console.log(`[bootstrap-api-categories] available categories: ${[...existingNames].join(', ')}`);
}

async function main() {
  const token = await getToken();

  const basePaths = [
    '/api/am/admin/v4',
    '/api/am/admin/v3',
    '/api/am/admin/v2'
  ];

  let lastError = null;

  for (const basePath of basePaths) {
    try {
      await ensureWithBasePath(token, basePath);
      console.log('[bootstrap-api-categories] done');
      return;
    } catch (e) {
      lastError = e;
      console.warn(`[bootstrap-api-categories] ${basePath} failed: ${e.message}`);
    }
  }

  throw lastError || new Error('Could not bootstrap API categories.');
}

main().catch((e) => {
  console.error(`[bootstrap-api-categories] ERROR: ${e.message}`);
  process.exit(1);
});
