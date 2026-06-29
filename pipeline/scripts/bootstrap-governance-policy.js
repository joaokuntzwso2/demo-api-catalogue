const fs = require('fs');

const APIM_HOST = process.env.APIM_HOST || 'https://wso2-apim:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[bootstrap-governance-policy] WARNING: TLS validation disabled for local demo.');
}

const RULESETS = [
  {
    name: 'API Catalogue Category Required',
    file: 'governance/apim-rulesets/api-catalogue-category-required.yaml',
    description: 'Requires every API to have at least one APIM category.',
    ruleType: 'API_METADATA',
    artifactType: 'REST_API'
  },
  {
    name: 'API Catalogue Health Metadata Required',
    file: 'governance/apim-rulesets/api-catalogue-health-metadata-required.yaml',
    description: 'Requires operational health metadata before API deployment or publication.',
    ruleType: 'API_METADATA',
    artifactType: 'REST_API'
  }
];

const DEPLOYMENT_GATE_POLICY_NAME = 'API Catalogue Deployment Gate';

const LEGACY_POLICY_NAMES = [
  'API Catalogue Publish Gate',
  'API Catalogue Category Gate',
  'API Catalogue Health Gate',
  DEPLOYMENT_GATE_POLICY_NAME
];

function basic(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

async function requestText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
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

async function getToken() {
  const client = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `api-catalogue-governance-bootstrap-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('username', APIM_USERNAME);
  body.set('password', APIM_PASSWORD);
  body.set(
    'scope',
    [
      'apim:gov_rule_read',
      'apim:gov_rule_manage',
      'apim:gov_policy_read',
      'apim:gov_policy_manage',
      'apim:gov_result_read'
    ].join(' ')
  );

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
  return Array.isArray(payload) ? payload : payload.list || [];
}

async function listRulesets(token) {
  return listFromPayload(await requestJson(`${APIM_HOST}/api/am/governance/v1/rulesets?limit=500`, {
    headers: { Authorization: `Bearer ${token}` }
  }));
}

async function listPolicies(token) {
  return listFromPayload(await requestJson(`${APIM_HOST}/api/am/governance/v1/policies?limit=500`, {
    headers: { Authorization: `Bearer ${token}` }
  }));
}

function buildRulesetForm(spec) {
  if (!fs.existsSync(spec.file)) {
    throw new Error(`Ruleset file not found: ${spec.file}`);
  }

  const content = fs.readFileSync(spec.file, 'utf8');
  const form = new FormData();

  form.append('name', spec.name);
  form.append('description', spec.description);
  form.append('ruleCategory', 'SPECTRAL');
  form.append('ruleType', spec.ruleType);
  form.append('artifactType', spec.artifactType);
  form.append('provider', 'WSO2 API Catalogue Demo');
  form.append('documentationLink', 'https://github.com/joaokuntzwso2/demo-api-catalogue');
  form.append(
    'rulesetContent',
    new Blob([content], { type: 'text/yaml' }),
    spec.file.split('/').pop()
  );

  return form;
}

async function upsertRuleset(token, spec) {
  const existing = (await listRulesets(token)).find((item) => {
    return item.name === spec.name &&
      item.artifactType === spec.artifactType &&
      item.ruleType === spec.ruleType;
  });

  const form = buildRulesetForm(spec);

  if (existing?.id) {
    const updated = await requestJson(`${APIM_HOST}/api/am/governance/v1/rulesets/${encodeURIComponent(existing.id)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });

    console.log(`[bootstrap-governance-policy] updated ruleset: ${spec.name} (${updated.id || existing.id})`);
    return updated.id || existing.id;
  }

  const created = await requestJson(`${APIM_HOST}/api/am/governance/v1/rulesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });

  if (!created.id) {
    throw new Error(`Ruleset created but no id returned: ${JSON.stringify(created)}`);
  }

  console.log(`[bootstrap-governance-policy] created ruleset: ${spec.name} (${created.id})`);
  return created.id;
}

async function deletePoliciesByName(token, names) {
  const policies = await listPolicies(token);

  for (const policy of policies) {
    if (!names.includes(policy.name) || !policy.id) {
      continue;
    }

    await requestText(`${APIM_HOST}/api/am/governance/v1/policies/${encodeURIComponent(policy.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`[bootstrap-governance-policy] deleted policy: ${policy.name} (${policy.id})`);
  }
}

async function deleteRulesetsByName(token, names) {
  const rulesets = await listRulesets(token);

  for (const ruleset of rulesets) {
    if (!names.includes(ruleset.name) || !ruleset.id) {
      continue;
    }

    await requestText(`${APIM_HOST}/api/am/governance/v1/rulesets/${encodeURIComponent(ruleset.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`[bootstrap-governance-policy] deleted ruleset: ${ruleset.name} (${ruleset.id})`);
  }
}

async function createDeploymentGate(token, rulesetIds) {
  const payload = {
    name: DEPLOYMENT_GATE_POLICY_NAME,
    description: 'Blocks API deployment and publication unless APIM category and required health metadata are present.',
    governableStates: [
      'API_DEPLOY',
      'API_PUBLISH'
    ],
    actions: [
      {
        state: 'API_DEPLOY',
        ruleSeverity: 'ERROR',
        type: 'BLOCK'
      },
      {
        state: 'API_PUBLISH',
        ruleSeverity: 'ERROR',
        type: 'BLOCK'
      }
    ],
    rulesets: rulesetIds,
    labels: ['GLOBAL']
  };

  const created = await requestJson(`${APIM_HOST}/api/am/governance/v1/policies`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!created.id) {
    throw new Error(`Policy created but no id returned: ${JSON.stringify(created)}`);
  }

  console.log(`[bootstrap-governance-policy] created policy: ${DEPLOYMENT_GATE_POLICY_NAME} (${created.id})`);
  console.log(`[bootstrap-governance-policy] policy rulesets: ${rulesetIds.join(', ')}`);
  return created.id;
}

async function main() {
  const token = await getToken();
  console.log('[bootstrap-governance-policy] token acquired');

  await deletePoliciesByName(token, LEGACY_POLICY_NAMES);
  await deleteRulesetsByName(token, RULESETS.map((ruleset) => ruleset.name));

  const rulesetIds = [];

  for (const spec of RULESETS) {
    const id = await upsertRuleset(token, spec);
    rulesetIds.push(id);
  }

  const policyId = await createDeploymentGate(token, rulesetIds);

  console.log('[bootstrap-governance-policy] ready');
  console.log(JSON.stringify({
    policy: DEPLOYMENT_GATE_POLICY_NAME,
    policyId,
    rulesets: rulesetIds,
    enforcement: {
      API_DEPLOY: 'BLOCK',
      API_PUBLISH: 'BLOCK'
    }
  }, null, 2));
}

main().catch((e) => {
  console.error(`[bootstrap-governance-policy] ERROR: ${e.message}`);
  process.exit(1);
});
