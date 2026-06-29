#!/usr/bin/env node
/*
 * Local demo control plane.
 *
 * Exposes a small HTTP API for the browser UI to:
 * - list API onboarding options that are not yet onboarded;
 * - show/edit safe local expected contract response payload overrides;
 * - run whitelisted npm onboarding scripts;
 * - stream real-time logs through Server-Sent Events;
 * - wait until MI and the UI catalogue route are ready before reporting success.
 *
 * This is intended for local demo usage only.
 */

const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PLATFORM_CONTROL_PORT || 6400);
const REPO_ROOT = path.resolve(__dirname, '..');

const RUNTIME_DIR = path.join(REPO_ROOT, '.runtime');

const REQUEST_OVERRIDES_FILE =
  process.env.CONTRACT_REQUEST_OVERRIDES_FILE ||
  path.join(RUNTIME_DIR, 'contract-request-overrides.json');

const PAYLOAD_OVERRIDES_FILE =
  process.env.CONTRACT_PAYLOAD_OVERRIDES_FILE ||
  path.join(RUNTIME_DIR, 'contract-payload-overrides.json');

const CONTRACT_DEFAULTS_FILE =
  process.env.CONTRACT_DEFAULTS_FILE ||
  path.join(REPO_ROOT, 'pipeline', 'config', 'contract-defaults.json');

const HEALTH_REGISTRY_URL =
  process.env.HEALTH_REGISTRY_URL || 'http://localhost:8290/health-registry/v1/apis';

const CATALOGUE_STATUS_URL =
  process.env.CATALOGUE_STATUS_URL || 'http://localhost:8290/catalogue-status/v1/apis';

const UI_CATALOGUE_STATUS_URL =
  process.env.UI_CATALOGUE_STATUS_URL || 'http://localhost:5174/catalogue-status/v1/apis';

const READINESS_TIMEOUT_MS = Number(process.env.ONBOARDING_READINESS_TIMEOUT_MS || 420000);
const READINESS_INTERVAL_MS = Number(process.env.ONBOARDING_READINESS_INTERVAL_MS || 5000);

const ACTIONS = [
  {
    id: 'initial3',
    label: 'Initial API set',
    description: 'Onboards accounts-api, payments-api and customers-api.',
    apis: ['accounts-api', 'payments-api', 'customers-api'],
    command: ['npm', ['run', 'platform:onboard:initial3']]
  },
  {
    id: 'cards-api',
    label: 'cards-api',
    description: 'Onboards cards-api.',
    apis: ['cards-api'],
    command: ['npm', ['run', 'platform:onboard:cards']]
  },
  {
    id: 'loans-api',
    label: 'loans-api',
    description: 'Onboards loans-api.',
    apis: ['loans-api'],
    command: ['npm', ['run', 'platform:onboard:loans']]
  }
];

const jobs = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });

    req.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
  });
}

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function readPayloadOverrideStore() {
  ensureRuntimeDir();

  if (!fs.existsSync(PAYLOAD_OVERRIDES_FILE)) {
    return {
      version: 1,
      updatedAt: null,
      overrides: {}
    };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(PAYLOAD_OVERRIDES_FILE, 'utf8'));
    return {
      version: payload.version || 1,
      updatedAt: payload.updatedAt || null,
      overrides: payload.overrides || {}
    };
  } catch (e) {
    throw new Error(`Invalid payload override file ${PAYLOAD_OVERRIDES_FILE}: ${e.message}`);
  }
}

function writePayloadOverrideStore(store) {
  ensureRuntimeDir();

  const nextStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    overrides: store.overrides || {}
  };

  fs.writeFileSync(PAYLOAD_OVERRIDES_FILE, JSON.stringify(nextStore, null, 2) + '\n');
  return nextStore;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripYamlQuotes(value) {
  let next = String(value || '').trim();

  if (
    (next.startsWith("'") && next.endsWith("'")) ||
    (next.startsWith('"') && next.endsWith('"'))
  ) {
    next = next.slice(1, -1);
  }

  return next.trim();
}

function readApiYamlProperty(apiName, propertyName) {
  const file = path.join(REPO_ROOT, 'apictl', 'apis', apiName, 'api.yaml');

  if (!fs.existsSync(file)) {
    return null;
  }

  const yaml = fs.readFileSync(file, 'utf8');
  const escapedProperty = String(propertyName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /*
   * APICTL exports this demo YAML in a compact single-line format.
   * So instead of depending on strict YAML indentation, find the property name
   * and then read the first value: token after it.
   */
  const propertyMatch = yaml.match(new RegExp(`name:\\s*['"]?${escapedProperty}['"]?`, 'i'));

  if (!propertyMatch || propertyMatch.index === undefined) {
    return null;
  }

  const tail = yaml.slice(propertyMatch.index, propertyMatch.index + 2000);
  const nextPropertyOffset = tail.slice(1).search(/\s+-\s+name:\s*/);
  const section = nextPropertyOffset === -1
    ? tail
    : tail.slice(0, nextPropertyOffset + 1);

  const singleQuoted = section.match(/\bvalue:\s*'([^']*)'/s);
  if (singleQuoted) {
    return singleQuoted[1].trim();
  }

  const doubleQuoted = section.match(/\bvalue:\s*"([^"]*)"/s);
  if (doubleQuoted) {
    return doubleQuoted[1].trim();
  }

  const plain = section.match(/\bvalue:\s*([^\r\n]+?)(?:\s+display:|\s+-\s+name:|$)/s);
  if (plain) {
    return String(plain[1] || '').trim();
  }

  return null;
}

function getDefaultExpectedPayloadForApi(apiName) {
  const config = getContractDefaultConfig(apiName);

  if (Object.prototype.hasOwnProperty.call(config, 'expectedPayload')) {
    return config.expectedPayload;
  }

  const raw = readApiYamlProperty(apiName, 'contract_expected_payload_json');

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(
      `[platform-control] Could not parse contract_expected_payload_json for ${apiName}: ${e.message}`
    );
    return {};
  }
}

function getPayloadStateForApi(apiName) {
  const store = readPayloadOverrideStore();
  const entry = store.overrides[apiName];
  const defaultPayload = getDefaultExpectedPayloadForApi(apiName);
  const overridePayload = entry?.expectedPayload;

  return {
    api: apiName,
    defaultPayload,
    overridePayload: overridePayload ?? null,
    effectivePayload: overridePayload ?? defaultPayload,
    hasOverride: overridePayload !== undefined,
    overrideFile: PAYLOAD_OVERRIDES_FILE
  };
}

function getPayloadStatesForApis(apiNames) {
  return Object.fromEntries(
    apiNames.map((apiName) => [apiName, getPayloadStateForApi(apiName)])
  );
}

function parsePayloadOverrideValue(apiName, value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  const raw = String(value || '').trim();

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON expected payload for ${apiName}: ${e.message}`);
  }
}

function writePayloadOverridesForApis(apiNames, payloadOverrides = {}) {
  const store = readPayloadOverrideStore();
  const changed = [];
  const cleared = [];

  for (const apiName of apiNames) {
    if (!Object.prototype.hasOwnProperty.call(payloadOverrides, apiName)) {
      continue;
    }

    const parsed = parsePayloadOverrideValue(apiName, payloadOverrides[apiName]);

    if (parsed === undefined) {
      continue;
    }

    if (parsed === null) {
      if (store.overrides[apiName]) {
        delete store.overrides[apiName];
        cleared.push(apiName);
      }
      continue;
    }

    const defaultPayload = getDefaultExpectedPayloadForApi(apiName);

    if (stableJson(parsed) === stableJson(defaultPayload)) {
      if (store.overrides[apiName]) {
        delete store.overrides[apiName];
        cleared.push(apiName);
      }
      continue;
    }

    store.overrides[apiName] = {
      expectedPayload: parsed,
      updatedAt: new Date().toISOString(),
      source: 'ui-onboarding-modal'
    };

    changed.push(apiName);
  }

  writePayloadOverrideStore(store);

  return {
    file: PAYLOAD_OVERRIDES_FILE,
    changed,
    cleared
  };
}



function readContractDefaults() {
  if (!fs.existsSync(CONTRACT_DEFAULTS_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(CONTRACT_DEFAULTS_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid contract defaults file ${CONTRACT_DEFAULTS_FILE}: ${e.message}`);
  }
}

const CONTRACT_DEFAULTS = readContractDefaults();

function getContractDefaultConfig(apiName) {
  return CONTRACT_DEFAULTS[apiName] || {};
}

function normalizeContractRequest(value) {
  const source = value && typeof value === 'object' ? value : {};

  return {
    method: String(source.method || 'GET').toUpperCase(),
    path: String(source.path || '/'),
    headers: source.headers && typeof source.headers === 'object' && !Array.isArray(source.headers)
      ? source.headers
      : {},
    query: source.query && typeof source.query === 'object' && !Array.isArray(source.query)
      ? source.query
      : {},
    body: Object.prototype.hasOwnProperty.call(source, 'body') ? source.body : null
  };
}

function readRequestOverrideStore() {
  ensureRuntimeDir();

  if (!fs.existsSync(REQUEST_OVERRIDES_FILE)) {
    return {
      version: 1,
      updatedAt: null,
      overrides: {}
    };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(REQUEST_OVERRIDES_FILE, 'utf8'));
    return {
      version: payload.version || 1,
      updatedAt: payload.updatedAt || null,
      overrides: payload.overrides || {}
    };
  } catch (e) {
    throw new Error(`Invalid request override file ${REQUEST_OVERRIDES_FILE}: ${e.message}`);
  }
}

function writeRequestOverrideStore(store) {
  ensureRuntimeDir();

  const nextStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    overrides: store.overrides || {}
  };

  fs.writeFileSync(REQUEST_OVERRIDES_FILE, JSON.stringify(nextStore, null, 2) + '\n');
  return nextStore;
}

function parseJsonProperty(raw, fallback) {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getDefaultContractRequestForApi(apiName) {
  const config = getContractDefaultConfig(apiName);

  if (config.request) {
    return normalizeContractRequest(config.request);
  }

  const raw = readApiYamlProperty(apiName, 'contract_request_json');

  if (raw) {
    return normalizeContractRequest(parseJsonProperty(raw, {}));
  }

  return normalizeContractRequest({
    method: readApiYamlProperty(apiName, 'contract_method') || 'GET',
    path: readApiYamlProperty(apiName, 'contract_path') || '/',
    headers: parseJsonProperty(readApiYamlProperty(apiName, 'contract_request_headers_json'), {}),
    query: parseJsonProperty(readApiYamlProperty(apiName, 'contract_request_query_json'), {}),
    body: parseJsonProperty(readApiYamlProperty(apiName, 'contract_request_body_json'), null)
  });
}

function getRequestStateForApi(apiName) {
  const store = readRequestOverrideStore();
  const entry = store.overrides[apiName];
  const defaultRequest = getDefaultContractRequestForApi(apiName);
  const overrideRequest = entry?.request ? normalizeContractRequest(entry.request) : undefined;

  return {
    api: apiName,
    defaultRequest,
    overrideRequest: overrideRequest ?? null,
    effectiveRequest: overrideRequest ?? defaultRequest,
    hasOverride: overrideRequest !== undefined,
    overrideFile: REQUEST_OVERRIDES_FILE
  };
}

function getRequestStatesForApis(apiNames) {
  return Object.fromEntries(
    apiNames.map((apiName) => [apiName, getRequestStateForApi(apiName)])
  );
}

function parseRequestOverrideValue(apiName, value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  let parsed = value;

  if (typeof value === 'string') {
    const raw = value.trim();

    if (!raw) {
      return null;
    }

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON contract request for ${apiName}: ${e.message}`);
    }
  }

  return normalizeContractRequest(parsed);
}

function writeRequestOverridesForApis(apiNames, requestOverrides = {}) {
  const store = readRequestOverrideStore();
  const changed = [];
  const cleared = [];

  for (const apiName of apiNames) {
    if (!Object.prototype.hasOwnProperty.call(requestOverrides, apiName)) {
      continue;
    }

    const parsed = parseRequestOverrideValue(apiName, requestOverrides[apiName]);

    if (parsed === undefined) {
      continue;
    }

    if (parsed === null) {
      if (store.overrides[apiName]) {
        delete store.overrides[apiName];
        cleared.push(apiName);
      }
      continue;
    }

    const defaultRequest = getDefaultContractRequestForApi(apiName);

    if (stableJson(parsed) === stableJson(defaultRequest)) {
      if (store.overrides[apiName]) {
        delete store.overrides[apiName];
        cleared.push(apiName);
      }
      continue;
    }

    store.overrides[apiName] = {
      request: parsed,
      updatedAt: new Date().toISOString(),
      source: 'ui-onboarding-modal'
    };

    changed.push(apiName);
  }

  writeRequestOverrideStore(store);

  return {
    file: REQUEST_OVERRIDES_FILE,
    changed,
    cleared
  };
}


async function getOnboardedApis() {
  try {
    const response = await fetch(HEALTH_REGISTRY_URL);
    if (!response.ok) {
      return {
        available: false,
        error: `Health Registry returned HTTP ${response.status}`,
        onboarded: []
      };
    }

    const payload = await response.json();
    const onboarded = Array.isArray(payload)
      ? payload.map((item) => item.name).filter(Boolean)
      : [];

    return {
      available: true,
      error: null,
      onboarded
    };
  } catch (e) {
    return {
      available: false,
      error: e.message,
      onboarded: []
    };
  }
}

async function getOptions() {
  const registry = await getOnboardedApis();
  const onboardedSet = new Set(registry.onboarded);

  const actions = ACTIONS.map((action) => {
    const alreadyOnboardedApis = action.apis.filter((api) => onboardedSet.has(api));
    const missingApis = action.apis.filter((api) => !onboardedSet.has(api));

    return {
      id: action.id,
      label: action.label,
      description: action.description,
      apis: action.apis,
      alreadyOnboardedApis,
      missingApis,
      enabled: missingApis.length > 0
    };
  });

  const actionsWithPayloads = actions.map((action) => ({
    ...action,
    requests: getRequestStatesForApis(action.missingApis),
    payloads: getPayloadStatesForApis(action.missingApis)
  }));

  return {
    registry,
    onboardedApis: registry.onboarded,
    actions: actionsWithPayloads,
    availableActions: actionsWithPayloads.filter((action) => action.enabled)
  };
}

function appendLog(job, stream, chunk) {
  const text = chunk.toString();
  const entry = {
    type: stream,
    text,
    at: new Date().toISOString()
  };

  job.logs.push(entry);

  for (const subscriber of job.subscribers) {
    subscriber.write(`event: log\n`);
    subscriber.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

function finishJob(job, exitCode, signal) {
  if (job._finished) {
    return;
  }

  job._finished = true;
  job.status = exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
  job.finishedAt = new Date().toISOString();
  job.exitCode = exitCode;
  job.signal = signal;

  const event = {
    status: job.status,
    exitCode,
    signal,
    finishedAt: job.finishedAt
  };

  for (const subscriber of job.subscribers) {
    subscriber.write(`event: done\n`);
    subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
    subscriber.end();
  }

  job.subscribers.clear();
}

async function fetchJsonArray(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.list)) {
    return payload.list;
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  return [];
}

function getApiName(item) {
  return item?.name || item?.apiName || item?.apiInfo?.name || '';
}

function hasFreshStatus(item) {
  return Boolean(item?.checkedAt || item?.cachedAt || item?.consumerStatus);
}

async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApisInEndpoint(job, label, url, expectedApis, options = {}) {
  const requireFreshStatus = Boolean(options.requireFreshStatus);
  const timeoutMs = options.timeoutMs || READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs || READINESS_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  appendLog(job, 'system', `Waiting for ${label}: ${expectedApis.join(', ')}\n`);

  let lastSeen = [];

  while (Date.now() < deadline) {
    try {
      const rows = await fetchJsonArray(url);
      lastSeen = rows.map(getApiName).filter(Boolean).sort();

      const readyApis = expectedApis.filter((apiName) => {
        return rows.some((item) => {
          if (getApiName(item) !== apiName) {
            return false;
          }

          if (!requireFreshStatus) {
            return true;
          }

          return hasFreshStatus(item);
        });
      });

      const missingApis = expectedApis.filter((apiName) => !readyApis.includes(apiName));

      if (missingApis.length === 0) {
        appendLog(job, 'system', `${label} is ready for: ${expectedApis.join(', ')}\n`);
        return;
      }

      appendLog(
        job,
        'system',
        `${label} not ready yet. Missing: ${missingApis.join(', ')}. Seen: ${lastSeen.join(', ') || 'none'}\n`
      );
    } catch (e) {
      appendLog(job, 'system', `${label} check failed: ${e.message}\n`);
    }

    await sleepMs(intervalMs);
  }

  throw new Error(
    `${label} did not become ready within ${Math.round(timeoutMs / 1000)}s. ` +
    `Expected: ${expectedApis.join(', ')}. Last seen: ${lastSeen.join(', ') || 'none'}`
  );
}

async function waitForOnboardingReadiness(job, expectedApis) {
  if (!expectedApis || expectedApis.length === 0) {
    appendLog(job, 'system', 'No missing APIs were detected for readiness validation.\n');
    return;
  }

  appendLog(job, 'system', '\nOnboarding command completed. Waiting for MI readiness before closing the UI...\n');

  await waitForApisInEndpoint(
    job,
    'MI Health Registry',
    HEALTH_REGISTRY_URL,
    expectedApis,
    {
      requireFreshStatus: false,
      timeoutMs: 180000,
      intervalMs: READINESS_INTERVAL_MS
    }
  );

  await waitForApisInEndpoint(
    job,
    'Catalogue Status through MI',
    CATALOGUE_STATUS_URL,
    expectedApis,
    {
      requireFreshStatus: true,
      timeoutMs: READINESS_TIMEOUT_MS,
      intervalMs: READINESS_INTERVAL_MS
    }
  );

  await waitForApisInEndpoint(
    job,
    'Catalogue Status through UI route',
    UI_CATALOGUE_STATUS_URL,
    expectedApis,
    {
      requireFreshStatus: true,
      timeoutMs: 180000,
      intervalMs: READINESS_INTERVAL_MS
    }
  );

  appendLog(job, 'system', 'UI route is ready. Waiting a few seconds for the browser view to stabilize...\n');
  await sleepMs(5000);

  await waitForApisInEndpoint(
    job,
    'Catalogue Status through UI route final confirmation',
    UI_CATALOGUE_STATUS_URL,
    expectedApis,
    {
      requireFreshStatus: true,
      timeoutMs: 60000,
      intervalMs: READINESS_INTERVAL_MS
    }
  );

  appendLog(job, 'system', '\nMI, Catalogue Status, and the UI route are fully ready.\n');
}


function validateApictlMetadataBeforeImport(apiNames) {
  for (const apiName of apiNames) {
    const file = path.join(REPO_ROOT, 'apictl', 'apis', apiName, 'api.yaml');

    if (!fs.existsSync(file)) {
      throw new Error(`Missing APICTL metadata file: ${file}`);
    }

    const yaml = fs.readFileSync(file, 'utf8');

    const malformedCompactContractProperty = yaml
      .split(/\r?\n/)
      .find((line) =>
        /^\s*-\s+name:\s+contract_[A-Za-z0-9_:-]+[ \t]+value:/.test(line)
      );

    if (malformedCompactContractProperty) {
      throw new Error(
        `Malformed compact contract metadata in ${file}: ${malformedCompactContractProperty.trim()}. ` +
        `Contract properties must be valid multiline YAML under additionalProperties.`
      );
    }

    if (!yaml.includes('additionalProperties:')) {
      throw new Error(`Missing additionalProperties section in ${file}`);
    }
  }
}


async function startJob(actionId, payloadOverrides = {}, requestOverrides = {}) {
  const action = ACTIONS.find((item) => item.id === actionId);
  if (!action) {
    throw new Error(`Unknown onboarding action: ${actionId}`);
  }

  const options = await getOptions();
  const option = options.actions.find((item) => item.id === actionId);

  if (!option || !option.enabled) {
    throw new Error(`Nothing to onboard for action: ${actionId}`);
  }

  validateApictlMetadataBeforeImport(option.missingApis);

  const payloadOverrideResult = writePayloadOverridesForApis(option.missingApis, payloadOverrides);
  const requestOverrideResult = writeRequestOverridesForApis(option.missingApis, requestOverrides);

  const id = crypto.randomUUID();
  const [command, args] = action.command;

  const job = {
    id,
    actionId,
    label: action.label,
    description: action.description,
    apis: action.apis,
    missingApis: option.missingApis,
    command: [command, ...args].join(' '),
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    logs: [],
    subscribers: new Set()
  };

  jobs.set(id, job);

  appendLog(job, 'system', `Starting ${job.command}\n`);
  appendLog(job, 'system', `Repository: ${REPO_ROOT}\n`);
  appendLog(job, 'system', `Target APIs: ${option.missingApis.join(', ')}\n`);
  appendLog(job, 'system', `Expected payload override file: ${payloadOverrideResult.file}\n`);
  appendLog(job, 'system', `Contract request override file: ${requestOverrideResult.file}\n`);

  if (requestOverrideResult.changed.length > 0) {
    appendLog(job, 'system', `Using UI-edited contract request for: ${requestOverrideResult.changed.join(', ')}\n`);
  }

  if (requestOverrideResult.cleared.length > 0) {
    appendLog(job, 'system', `Cleared local contract request override for: ${requestOverrideResult.cleared.join(', ')}\n`);
  }

  if (payloadOverrideResult.changed.length > 0) {
    appendLog(job, 'system', `Using UI-edited expected payload for: ${payloadOverrideResult.changed.join(', ')}\n`);
  }

  if (payloadOverrideResult.cleared.length > 0) {
    appendLog(job, 'system', `Cleared local expected payload override for: ${payloadOverrideResult.cleared.join(', ')}\n`);
  }

  appendLog(job, 'system', '\n');

  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FORCE_COLOR: '0'
    },
    shell: false
  });

  job.pid = child.pid;

  child.stdout.on('data', (chunk) => appendLog(job, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendLog(job, 'stderr', chunk));

  child.on('error', (error) => {
    appendLog(job, 'stderr', `${error.message}\n`);
    finishJob(job, 1, null);
  });

  child.on('close', async (exitCode, signal) => {
    appendLog(job, 'system', `\nOnboarding process finished with exit code ${exitCode}\n`);

    if (exitCode !== 0) {
      finishJob(job, exitCode, signal);
      return;
    }

    try {
      await waitForOnboardingReadiness(job, option.missingApis);
      finishJob(job, 0, signal);
    } catch (e) {
      appendLog(job, 'stderr', `\nReadiness validation failed: ${e.message}\n`);
      finishJob(job, 1, signal);
    }
  });

  return job;
}

function streamJob(req, res, jobId) {
  const job = jobs.get(jobId);

  if (!job) {
    sendJson(res, 404, {
      error: `Job not found: ${jobId}`
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(`event: hello\n`);
  res.write(`data: ${JSON.stringify({ jobId, status: job.status })}\n\n`);

  for (const entry of job.logs) {
    res.write(`event: log\n`);
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  if (job.status === 'RUNNING') {
    job.subscribers.add(res);
    req.on('close', () => {
      job.subscribers.delete(res);
    });
  } else {
    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      finishedAt: job.finishedAt
    })}\n\n`);
    res.end();
  }
}

function getJobPayload(job) {
  return {
    id: job.id,
    actionId: job.actionId,
    label: job.label,
    description: job.description,
    apis: job.apis,
    missingApis: job.missingApis,
    command: job.command,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    logLines: job.logs.length
  };
}


/* CONTRACT_VALIDATION_ROUTES_START */
/*
 * Contract validation editor endpoints for the native platform-control HTTP server.
 */
function contractValidationSendJson(res, statusCode, body) {
  const json = JSON.stringify(body);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json)
  });

  res.end(json);
}

function contractValidationReadJson(file, fallback = {}) {
  if (!fs.existsSync(file)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON file ${file}: ${e.message}`);
  }
}

function contractValidationWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function contractValidationOverrideFor(apiName, overrides, valueField = null) {
  const maps = [];

  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    if (overrides.overrides && typeof overrides.overrides === 'object' && !Array.isArray(overrides.overrides)) {
      maps.push(overrides.overrides);
    }

    maps.push(overrides);
  }

  const keys = [apiName, `${apiName}:1.0.0`];

  for (const map of maps) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) {
        continue;
      }

      const value = map[key];

      if (
        valueField &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, valueField)
      ) {
        return value[valueField];
      }

      return value;
    }
  }

  return undefined;
}

function contractValidationRun(command, args = []) {
  return new Promise((resolve) => {
    const child = require('child_process').spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      shell: false
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function contractValidationSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function contractValidationWaitForMi() {
  const startedAt = Date.now();
  const timeoutMs = 90000;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch('http://localhost:8290/customer-360/v1/health');

      if (response.ok) {
        return {
          status: 'READY',
          waitedMs: Date.now() - startedAt
        };
      }
    } catch (e) {
      // MI is still restarting.
    }

    await contractValidationSleep(3000);
  }

  return {
    status: 'TIMEOUT',
    waitedMs: Date.now() - startedAt
  };
}


function contractValidationReadBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();

      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function contractValidationBuildOptions() {
  const defaults = contractValidationReadJson(CONTRACT_DEFAULTS_FILE, {});

  const apis = Object.keys(defaults).sort().map((apiName) => {
    const defaultConfig = defaults[apiName] || {};
    const requestState = getRequestStateForApi(apiName);
    const payloadState = getPayloadStateForApi(apiName);

    return {
      name: apiName,
      defaultRequest: defaultConfig.request || {},
      effectiveRequest: requestState.effectiveRequest || defaultConfig.request || {},
      hasRequestOverride: Boolean(requestState.hasOverride),
      defaultPayload: defaultConfig.expectedPayload || {},
      effectivePayload: payloadState.effectivePayload || defaultConfig.expectedPayload || {},
      hasPayloadOverride: Boolean(payloadState.hasOverride),
      expectedHttpStatus: defaultConfig.expectedHttpStatus || 200,
      requiredFields: defaultConfig.requiredFields || []
    };
  });

  return {
    status: 'OK',
    source: 'platform-control',
    defaultsFile: CONTRACT_DEFAULTS_FILE,
    requestOverridesFile: REQUEST_OVERRIDES_FILE,
    payloadOverridesFile: PAYLOAD_OVERRIDES_FILE,
    apis
  };
}

function handleContractValidationRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname === '/api/contract-validation/options' && req.method === 'GET') {
    try {
      contractValidationSendJson(res, 200, contractValidationBuildOptions());
    } catch (e) {
      contractValidationSendJson(res, 500, { status: 'ERROR', message: e.message });
    }
    return true;
  }

  if (requestUrl.pathname === '/api/contract-validation/jobs' && req.method === 'POST') {
    contractValidationReadBody(req)
      .then(async (rawBody) => {
        let body = {};

        try {
          body = rawBody ? JSON.parse(rawBody) : {};
        } catch (e) {
          contractValidationSendJson(res, 400, {
            status: 'ERROR',
            message: `Invalid JSON request body: ${e.message}`
          });
          return;
        }

        const apiName = body.apiName;
        const request = body.request;
        const payload = body.payload;

        if (!apiName) {
          contractValidationSendJson(res, 400, { status: 'ERROR', message: 'apiName is required' });
          return;
        }

        if (!request || typeof request !== 'object') {
          contractValidationSendJson(res, 400, { status: 'ERROR', message: 'request must be a JSON object' });
          return;
        }

        if (!payload || typeof payload !== 'object') {
          contractValidationSendJson(res, 400, { status: 'ERROR', message: 'payload must be a JSON object' });
          return;
        }

        const requestOverrideResult = writeRequestOverridesForApis([apiName], { [apiName]: request });
        const payloadOverrideResult = writePayloadOverridesForApis([apiName], { [apiName]: payload });

        const syncArtifacts = await contractValidationRun('docker-compose', [
          '--profile',
          'platform',
          'run',
          '--rm',
          '-e',
          'APIM_ALLOW_INSECURE_TLS=true',
          'apictl',
          'npm run platform:reconcile:container'
        ]);

        const restartMi = syncArtifacts.code === 0
          ? await contractValidationRun('docker-compose', [
              '--profile',
              'platform',
              'up',
              '-d',
              '--force-recreate',
              'wso2-integrator'
            ])
          : {
              code: 1,
              stdout: '',
              stderr: 'Skipped MI restart because sync-mi-health-from-apim.js failed.'
            };

        const reconcile = {
          code: syncArtifacts.code === 0 && restartMi.code === 0 ? 0 : 1,
          syncArtifacts,
          restartMi
        };

        if (reconcile.code !== 0) {
          contractValidationSendJson(res, 500, {
            status: 'ERROR',
            message: 'MI-only reconcile failed',
            apiName,
            reconcile,
            requestOverrideResult,
            payloadOverrideResult
          });
          return;
        }

        const miReadiness = await contractValidationWaitForMi();

        let probe = null;
        try {
          const probeResponse = await fetch('http://localhost:8290/health-registry/v1/probes/run', {
            method: 'POST'
          });
          probe = await probeResponse.json();
        } catch (e) {
          probe = { status: 'ERROR', message: `Probe trigger failed: ${e.message}` };
        }

        contractValidationSendJson(res, 200, {
          status: 'COMPLETED',
          message: 'Contract validation overrides saved, MI artifacts reconciled, and validation triggered',
          apiName,
          requestOverrideResult,
          payloadOverrideResult,
          reconcile,
          miReadiness,
          probe
        });
      })
      .catch((e) => {
        contractValidationSendJson(res, 500, { status: 'ERROR', message: e.message });
      });

    return true;
  }

  return false;
}
/* CONTRACT_VALIDATION_ROUTES_END */






/* API_RUNTIME_CONTROL_ROUTES_START */
/*
 * Runtime controls for demo backend APIs.
 *
 * Stop:
 * - stops the Docker Compose API service
 * - preserves the deployed API row
 * - writes RED directly to health-status-cache using the previous full metadata
 *
 * Start:
 * - starts the Docker Compose API service
 * - triggers MI probe so the API becomes GREEN again
 */
function apiRuntimeControlSendJson(res, statusCode, body) {
  const json = JSON.stringify(body, null, 2);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json)
  });

  res.end(json);
}

function apiRuntimeControlReadJson(file, fallback = {}) {
  if (!fs.existsSync(file)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON file ${file}: ${e.message}`);
  }
}

function apiRuntimeControlReadBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();

      if (body.length > 512 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function apiRuntimeControlRun(command, args = [], timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = require('child_process').spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      shell: false
    });

    let stdout = '';
    let stderr = '';
    let completed = false;

    const timeout = setTimeout(() => {
      if (completed) {
        return;
      }

      completed = true;

      try {
        child.kill('SIGKILL');
      } catch (e) {
        // ignore
      }

      resolve({
        code: 124,
        stdout,
        stderr: stderr + `\nTimed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timeout);

      resolve({
        code: 1,
        stdout,
        stderr: stderr + `\n${error.message}`
      });
    });

    child.on('close', (code) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timeout);

      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}

function apiRuntimeControlKnownApis() {
  const defaults = apiRuntimeControlReadJson(CONTRACT_DEFAULTS_FILE, {});
  return Object.keys(defaults).sort();
}

function apiRuntimeControlServiceName(apiName) {
  if (!apiName || typeof apiName !== 'string') {
    return null;
  }

  if (!/^[a-z0-9-]+-api$/.test(apiName)) {
    return null;
  }

  const knownApis = apiRuntimeControlKnownApis();

  if (!knownApis.includes(apiName)) {
    return null;
  }

  return apiName;
}

async function apiRuntimeControlDockerState(serviceName) {
  const ps = await apiRuntimeControlRun('docker-compose', [
    '--profile',
    'platform',
    'ps',
    '-q',
    serviceName
  ], 8000);

  const containerId = String(ps.stdout || '').trim();

  if (!containerId) {
    return {
      serviceName,
      containerId: null,
      state: 'missing',
      ps
    };
  }

  const inspect = await apiRuntimeControlRun('docker', [
    'inspect',
    '-f',
    '{{.State.Status}}',
    containerId
  ], 8000);

  return {
    serviceName,
    containerId,
    state: String(inspect.stdout || '').trim() || 'unknown',
    ps,
    inspect
  };
}

async function apiRuntimeControlFetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    let body = null;

    try {
      body = await response.json();
    } catch (e) {
      body = await response.text();
    }

    return {
      status: response.ok ? 'OK' : 'ERROR',
      httpStatus: response.status,
      body
    };
  } catch (e) {
    return {
      status: 'ERROR',
      message: e.name === 'AbortError'
        ? `Timed out after ${timeoutMs}ms`
        : e.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function apiRuntimeControlGetCachedResults() {
  const response = await apiRuntimeControlFetchWithTimeout(
    'http://localhost:6300/cache/results',
    {
      method: 'GET'
    },
    5000
  );

  if (response.status !== 'OK' || !Array.isArray(response.body)) {
    return [];
  }

  return response.body;
}

async function apiRuntimeControlPostCacheRecord(record) {
  return apiRuntimeControlFetchWithTimeout(
    'http://localhost:6300/cache/results',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(record)
    },
    5000
  );
}

async function apiRuntimeControlTriggerProbe() {
  return apiRuntimeControlFetchWithTimeout(
    'http://localhost:8290/health-registry/v1/probes/run',
    { method: 'POST' },
    20000
  );
}

function apiRuntimeControlNormalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

async function apiRuntimeControlFindCachedResult(apiName) {
  const results = await apiRuntimeControlGetCachedResults();
  return results.find((record) =>
    record &&
    record.name === apiName &&
    String(record.version || '1.0.0') === '1.0.0'
  ) || null;
}

function apiRuntimeControlLivenessRecovered(record) {
  if (!record) {
    return false;
  }

  const livenessStatus = apiRuntimeControlNormalizeStatus(record.liveness?.status);
  const consumerStatus = apiRuntimeControlNormalizeStatus(record.consumerStatus);
  const httpStatus = Number(record.liveness?.httpStatus ?? record.httpStatus ?? 0);

  if (['OK', 'UP', 'GREEN', 'PASSED', 'SUCCESS', 'AVAILABLE'].includes(livenessStatus)) {
    return true;
  }

  if (httpStatus >= 200 && httpStatus < 300 && consumerStatus !== 'UNKNOWN') {
    return true;
  }

  return false;
}

async function apiRuntimeControlWaitForDockerRunning(serviceName, timeoutMs = 90000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await apiRuntimeControlDockerState(serviceName);

    if (lastState.state === 'running') {
      return {
        status: 'OK',
        serviceName,
        state: lastState
      };
    }

    await sleepMs(intervalMs);
  }

  return {
    status: 'TIMEOUT',
    serviceName,
    state: lastState,
    message: `${serviceName} did not reach Docker running state within ${Math.round(timeoutMs / 1000)}s`
  };
}

async function apiRuntimeControlWaitForRecoveredStatus(apiName, timeoutMs = 150000, intervalMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastProbe = null;
  let lastRecord = null;

  while (Date.now() < deadline) {
    attempts += 1;

    lastProbe = await apiRuntimeControlTriggerProbe();

    // Give MI/cache a moment to persist the probe result.
    await sleepMs(2500);

    lastRecord = await apiRuntimeControlFindCachedResult(apiName);

    if (apiRuntimeControlLivenessRecovered(lastRecord)) {
      return {
        status: 'OK',
        attempts,
        probe: lastProbe,
        record: lastRecord,
        message: `${apiName} liveness recovered`
      };
    }

    await sleepMs(intervalMs);
  }

  return {
    status: 'TIMEOUT',
    attempts,
    probe: lastProbe,
    record: lastRecord,
    message: `${apiName} did not recover within ${Math.round(timeoutMs / 1000)}s`
  };
}

async function apiRuntimeControlWriteStoppedResult(apiName, serviceName, dockerState) {
  const results = await apiRuntimeControlGetCachedResults();

  const previous = results.find((record) =>
    record &&
    record.name === apiName &&
    String(record.version || '1.0.0') === '1.0.0'
  );

  const now = new Date().toISOString();

  const targetMs =
    previous && previous.slaTargetMs
      ? previous.slaTargetMs
      : previous && previous.sla && previous.sla.targetMs
        ? previous.sla.targetMs
        : 300;

  const stoppedRecord = {
    ...(previous || {}),
    name: apiName,
    version: previous && previous.version ? previous.version : '1.0.0',
    consumerStatus: 'RED',
    checkedAt: now,
    source: 'platform-control',
    liveness: {
      ...(previous && previous.liveness ? previous.liveness : {}),
      status: 'FAILED',
      httpStatus: 0,
      responseTimeMs: 0,
      checkedAt: now,
      reasons: [
        `Docker Compose service ${serviceName} is stopped.`,
        `Docker state: ${dockerState && dockerState.state ? dockerState.state : 'unknown'}`
      ]
    },
    contract: {
      ...(previous && previous.contract ? previous.contract : {}),
      status: 'SKIPPED',
      checkedAt: now,
      reasons: [
        'Contract validation skipped because liveness check failed.'
      ]
    },
    sla: {
      ...(previous && previous.sla ? previous.sla : {}),
      status: 'BREACHED',
      checkedAt: now,
      targetMs,
      actualMs: 0
    }
  };

  return apiRuntimeControlPostCacheRecord(stoppedRecord);
}

function handleApiRuntimeControlRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname === '/api/runtime-control/options' && req.method === 'GET') {
    try {
      const apis = apiRuntimeControlKnownApis().map((apiName) => ({
        name: apiName,
        serviceName: apiRuntimeControlServiceName(apiName)
      }));

      apiRuntimeControlSendJson(res, 200, {
        status: 'OK',
        source: 'platform-control',
        apis
      });
    } catch (e) {
      apiRuntimeControlSendJson(res, 500, { status: 'ERROR', message: e.message });
    }

    return true;
  }

  if (requestUrl.pathname === '/api/runtime-control/services' && req.method === 'POST') {
    apiRuntimeControlReadBody(req)
      .then(async (rawBody) => {
        let body = {};

        try {
          body = rawBody ? JSON.parse(rawBody) : {};
        } catch (e) {
          apiRuntimeControlSendJson(res, 400, {
            status: 'ERROR',
            message: `Invalid JSON request body: ${e.message}`
          });
          return;
        }

        const apiName = body.apiName;
        const action = body.action;
        const serviceName = apiRuntimeControlServiceName(apiName);

        if (!serviceName) {
          apiRuntimeControlSendJson(res, 400, {
            status: 'ERROR',
            message: `Unknown or unsupported API service: ${apiName}`
          });
          return;
        }

        if (action !== 'stop' && action !== 'start') {
          apiRuntimeControlSendJson(res, 400, {
            status: 'ERROR',
            message: "action must be 'stop' or 'start'"
          });
          return;
        }

        const before = await apiRuntimeControlDockerState(serviceName);

        const commandArgs = action === 'stop'
          ? ['--profile', 'platform', 'stop', serviceName]
          : ['--profile', 'platform', 'up', '-d', serviceName];

        const runtime = await apiRuntimeControlRun(
          'docker-compose',
          commandArgs,
          action === 'stop' ? 15000 : 45000
        );

        const after = await apiRuntimeControlDockerState(serviceName);

        if (runtime.code !== 0) {
          apiRuntimeControlSendJson(res, 500, {
            status: 'ERROR',
            message: `Failed to ${action} ${serviceName}`,
            apiName,
            serviceName,
            action,
            before,
            after,
            runtime
          });
          return;
        }

        if (action === 'stop') {
          const forcedStatus = await apiRuntimeControlWriteStoppedResult(apiName, serviceName, after);

          apiRuntimeControlSendJson(res, 200, {
            status: 'COMPLETED',
            message: `${serviceName} stopped and marked RED`,
            apiName,
            serviceName,
            action,
            before,
            after,
            runtime,
            forcedStatus,
            probe: {
              status: 'SKIPPED',
              reason: 'Stop action already wrote RED status after Docker stop.'
            }
          });
          return;
        }

        const dockerReadiness = await apiRuntimeControlWaitForDockerRunning(serviceName);
        const recovery = await apiRuntimeControlWaitForRecoveredStatus(apiName);

        apiRuntimeControlSendJson(res, 200, {
          status: recovery.status === 'OK' ? 'COMPLETED' : 'RECOVERY_PENDING',
          message: recovery.status === 'OK'
            ? `${serviceName} started and liveness recovered`
            : `${serviceName} started, but liveness recovery is still pending`,
          apiName,
          serviceName,
          action,
          before,
          after,
          runtime,
          dockerReadiness,
          forcedStatus: {
            status: 'SKIPPED',
            reason: 'Start action waits for MI/cache recovery instead of writing synthetic GREEN.'
          },
          probe: recovery
        });
      })
      .catch((e) => {
        apiRuntimeControlSendJson(res, 500, { status: 'ERROR', message: e.message });
      });

    return true;
  }

  return false;
}
/* API_RUNTIME_CONTROL_ROUTES_END */






/* DEVPORTAL_CATALOGUE_STATUS_ROUTES_START */
let devPortalLastSubscriptionFingerprint = null;
let devPortalReconcileInFlight = false;

function devPortalBasicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function devPortalRequestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let payload = {};
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

async function devPortalRegisterClient(scopes) {
  const client = await devPortalRequestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${devPortalBasicAuth(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `api-catalogue-ui-devportal-${Date.now()}`,
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

  const token = await devPortalRequestJson(`${APIM_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${devPortalBasicAuth(client.clientId, client.clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!token.access_token) {
    throw new Error(`DevPortal token response did not include access_token: ${JSON.stringify(token)}`);
  }

  return token.access_token;
}

async function devPortalGetToken() {
  return devPortalRegisterClient([
    'apim:api_view',
    'apim:subscribe',
    'apim:app_manage',
    'apim:sub_manage'
  ]);
}

async function devPortalFindCatalogueApplication(token) {
  const apps = await devPortalRequestJson(`${APIM_HOST}/api/am/devportal/v3/applications?limit=200`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const app = (apps.list || []).find((item) => item.name === DEVPORTAL_CATALOGUE_APP_NAME);

  if (!app) {
    throw new Error(`Developer Portal application not found: ${DEVPORTAL_CATALOGUE_APP_NAME}`);
  }

  return app;
}

async function devPortalListApplicationSubscriptions(token, applicationId) {
  const subscriptions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const payload = await devPortalRequestJson(
      `${APIM_HOST}/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(applicationId)}&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const page = payload.list || [];
    subscriptions.push(...page);

    if (page.length < limit) {
      break;
    }

    offset += limit;
  }

  return subscriptions;
}

function devPortalSubscriptionKeys(subscription) {
  const info = subscription.apiInfo || subscription.api || {};
  const apiId = subscription.apiId || info.id || info.apiId;
  const name = info.name || subscription.apiName || subscription.name;
  const version = info.version || subscription.apiVersion || subscription.version;
  const keys = [];

  if (apiId) {
    keys.push(String(apiId));
  }

  if (name && version) {
    keys.push(`${name}:${version}`);
  }

  return keys;
}

function devPortalRecordKeys(record) {
  return [
    record?.apiId ? String(record.apiId) : null,
    record?.name && record?.version ? `${record.name}:${record.version}` : null
  ].filter(Boolean);
}

function devPortalFindMatchingCacheRecord(cacheRows, subscription) {
  const keys = new Set(devPortalSubscriptionKeys(subscription));

  return cacheRows.find((row) => {
    return devPortalRecordKeys(row).some((key) => keys.has(key));
  });
}

async function devPortalReadCachedResults() {
  const response = await fetch('http://localhost:6300/cache/results');
  if (!response.ok) {
    throw new Error(`health-status-cache returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

function devPortalPlaceholderFromSubscription(subscription) {
  const info = subscription.apiInfo || subscription.api || {};
  const now = new Date().toISOString();

  return {
    apiId: subscription.apiId || info.id || info.apiId || null,
    name: info.name || subscription.apiName || subscription.name || 'unknown-api',
    displayName: info.displayName || info.name || subscription.apiName || subscription.name || 'unknown-api',
    version: info.version || subscription.apiVersion || subscription.version || '1.0.0',
    context: info.context || null,
    domain: 'Unclassified',
    owner: {
      team: 'Unknown',
      email: 'unknown@example.com'
    },
    runtime: 'Unknown',
    criticality: 'Unclassified',
    slaTarget: '99.50%',
    lifecycle: info.lifeCycleStatus || info.lifecycleStatus || 'PUBLISHED',
    checkFrequency: 'none',
    checkedAt: null,
    healthUrl: null,
    liveness: {
      status: 'PENDING',
      httpStatus: null,
      latencyMs: null
    },
    contract: {
      status: 'PENDING',
      reasons: ['Subscribed in API Catalogue Application; waiting for APIM-to-MI reconciliation or health metadata.']
    },
    sla: {
      status: 'PENDING',
      target: '99.50%',
      window: 'demo'
    },
    probePolicy: {
      active: false,
      frequency: 'none',
      reason: 'Subscribed in Developer Portal but no MI status is available yet.'
    },
    consumerStatus: 'UNKNOWN',
    reason: 'Subscribed in API Catalogue Application; waiting for MI health status.',
    source: 'wso2-api-manager-devportal',
    sourceOfTruth: 'wso2-api-manager',
    subscriptionApplication: DEVPORTAL_CATALOGUE_APP_NAME,
    subscriptionStatus: subscription.status,
    subscriptionSyncedAt: now
  };
}

function devPortalSubscriptionFingerprint(subscriptions) {
  return subscriptions
    .map((subscription) => devPortalSubscriptionKeys(subscription).sort().join('|'))
    .sort()
    .join('||');
}

function devPortalMaybeTriggerReconcile(subscriptions) {
  const fingerprint = devPortalSubscriptionFingerprint(subscriptions);

  if (fingerprint === devPortalLastSubscriptionFingerprint) {
    return;
  }

  devPortalLastSubscriptionFingerprint = fingerprint;

  if (devPortalReconcileInFlight) {
    return;
  }

  devPortalReconcileInFlight = true;

  const child = spawn('npm', ['run', 'platform:reconcile-once'], {
    cwd: REPO_ROOT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[devportal-catalogue-reconcile] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[devportal-catalogue-reconcile] ${chunk}`);
  });

  child.on('close', (code) => {
    devPortalReconcileInFlight = false;
    console.log(`[devportal-catalogue-reconcile] finished with code ${code}`);
  });
}

async function devPortalBuildCatalogueRows() {
  const token = await devPortalGetToken();
  const app = await devPortalFindCatalogueApplication(token);
  const appId = app.applicationId || app.id;
  const subscriptions = await devPortalListApplicationSubscriptions(token, appId);
  const cacheRows = await devPortalReadCachedResults();

  devPortalMaybeTriggerReconcile(subscriptions);

  const rows = subscriptions.map((subscription) => {
    const cached = devPortalFindMatchingCacheRecord(cacheRows, subscription);
    const placeholder = devPortalPlaceholderFromSubscription(subscription);

    return {
      ...placeholder,
      ...(cached || {}),
      subscriptionApplication: DEVPORTAL_CATALOGUE_APP_NAME,
      subscriptionStatus: subscription.status,
      sourceOfTruth: 'wso2-api-manager-devportal'
    };
  });

  return rows;
}

function devPortalNormalizeStatus(value) {
  return String(value || 'UNKNOWN').toUpperCase();
}

function devPortalBuildSummary(rows) {
  const summary = {
    total: rows.length,
    registered: rows.length,
    healthy: 0,
    attention: 0,
    green: 0,
    red: 0,
    grey: 0,
    unknown: 0,
    consumerStatusCounts: {},
    livenessCounts: {},
    contractCounts: {},
    sourceOfTruth: 'wso2-api-manager-devportal',
    subscriptionApplication: DEVPORTAL_CATALOGUE_APP_NAME,
    generatedAt: new Date().toISOString()
  };

  for (const row of rows) {
    const consumerStatus = devPortalNormalizeStatus(row.consumerStatus);
    const livenessStatus = devPortalNormalizeStatus(row.liveness && row.liveness.status);
    const contractStatus = devPortalNormalizeStatus(row.contract && row.contract.status);

    summary.consumerStatusCounts[consumerStatus] = (summary.consumerStatusCounts[consumerStatus] || 0) + 1;
    summary.livenessCounts[livenessStatus] = (summary.livenessCounts[livenessStatus] || 0) + 1;
    summary.contractCounts[contractStatus] = (summary.contractCounts[contractStatus] || 0) + 1;

    if (consumerStatus === 'GREEN') {
      summary.green += 1;
      summary.healthy += 1;
    } else if (consumerStatus === 'RED') {
      summary.red += 1;
      summary.attention += 1;
    } else if (consumerStatus === 'GREY' || consumerStatus === 'GRAY') {
      summary.grey += 1;
    } else {
      summary.unknown += 1;
    }
  }

  return summary;
}

function handleDevPortalCatalogueStatusRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname === '/api/catalogue-status/apis' && req.method === 'GET') {
    devPortalBuildCatalogueRows()
      .then((rows) => sendJson(res, 200, rows))
      .catch((e) => sendJson(res, 500, {
        status: 'ERROR',
        message: e.message,
        source: 'platform-control-devportal-catalogue'
      }));
    return true;
  }

  if (requestUrl.pathname === '/api/catalogue-status/summary' && req.method === 'GET') {
    devPortalBuildCatalogueRows()
      .then((rows) => sendJson(res, 200, devPortalBuildSummary(rows)))
      .catch((e) => sendJson(res, 500, {
        status: 'ERROR',
        message: e.message,
        source: 'platform-control-devportal-catalogue'
      }));
    return true;
  }

  return false;
}
/* DEVPORTAL_CATALOGUE_STATUS_ROUTES_END */



/* DEVPORTAL_CATALOGUE_STATUS_FINAL_PATCH_START */
const CATALOGUE_APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const CATALOGUE_APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const CATALOGUE_APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';
const CATALOGUE_APP_NAME = process.env.API_CATALOGUE_APP_NAME || 'API Catalogue Application';
const CATALOGUE_CACHE_RESULTS_URL = process.env.CATALOGUE_CACHE_RESULTS_URL || 'http://localhost:6300/cache/results';

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function catalogueSendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function catalogueBasicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function catalogueRequestJson(url, options = {}) {
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

async function catalogueGetDevPortalToken() {
  const client = await catalogueRequestJson(`${CATALOGUE_APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${catalogueBasicAuth(CATALOGUE_APIM_USERNAME, CATALOGUE_APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `api-catalogue-ui-${Date.now()}`,
      owner: CATALOGUE_APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const tokenBody = new URLSearchParams();
  tokenBody.set('grant_type', 'password');
  tokenBody.set('username', CATALOGUE_APIM_USERNAME);
  tokenBody.set('password', CATALOGUE_APIM_PASSWORD);
  tokenBody.set('scope', 'apim:api_view apim:subscribe apim:app_manage apim:sub_manage');

  const token = await catalogueRequestJson(`${CATALOGUE_APIM_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${catalogueBasicAuth(client.clientId, client.clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: tokenBody.toString()
  });

  if (!token.access_token) {
    throw new Error(`DevPortal token response did not include access_token: ${JSON.stringify(token)}`);
  }

  return token.access_token;
}

async function catalogueFindApplication(token) {
  const applications = await catalogueRequestJson(`${CATALOGUE_APIM_HOST}/api/am/devportal/v3/applications?limit=200`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const app = (applications.list || []).find((item) => item.name === CATALOGUE_APP_NAME);

  if (!app) {
    throw new Error(`Developer Portal application not found: ${CATALOGUE_APP_NAME}`);
  }

  return app;
}

async function catalogueListApplicationSubscriptions(token, applicationId) {
  const subscriptions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const payload = await catalogueRequestJson(
      `${CATALOGUE_APIM_HOST}/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(applicationId)}&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const page = payload.list || [];
    subscriptions.push(...page);

    if (page.length < limit) {
      break;
    }

    offset += limit;
  }

  return subscriptions;
}

async function catalogueReadCachedRows() {
  const response = await fetch(CATALOGUE_CACHE_RESULTS_URL);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`health-status-cache returned HTTP ${response.status}: ${text}`);
  }

  const payload = text ? JSON.parse(text) : [];
  return Array.isArray(payload) ? payload : [];
}

function catalogueSubscriptionApiInfo(subscription) {
  return subscription.apiInfo || subscription.api || {};
}

function catalogueSubscriptionKeys(subscription) {
  const info = catalogueSubscriptionApiInfo(subscription);
  const keys = [];

  const apiId = subscription.apiId || info.id || info.apiId;
  const name = info.name || subscription.apiName || subscription.name;
  const version = info.version || subscription.apiVersion || subscription.version;

  if (apiId) {
    keys.push(String(apiId));
  }

  if (name && version) {
    keys.push(`${name}:${version}`);
  }

  return keys;
}

function catalogueRowKeys(row) {
  return [
    row && row.apiId ? String(row.apiId) : null,
    row && row.name && row.version ? `${row.name}:${row.version}` : null
  ].filter(Boolean);
}

function catalogueFindCachedRow(cacheRows, subscription) {
  const subscriptionKeys = new Set(catalogueSubscriptionKeys(subscription));

  return cacheRows.find((row) => {
    return catalogueRowKeys(row).some((key) => subscriptionKeys.has(key));
  });
}

function cataloguePlaceholderRow(subscription) {
  const info = catalogueSubscriptionApiInfo(subscription);
  const now = new Date().toISOString();

  return {
    apiId: subscription.apiId || info.id || info.apiId || null,
    name: info.name || subscription.apiName || subscription.name || 'unknown-api',
    version: info.version || subscription.apiVersion || subscription.version || '1.0.0',
    context: info.context || null,
    domain: 'Unclassified',
    owner: {
      team: 'Unknown',
      email: 'unknown@example.com'
    },
    runtime: 'Unknown',
    criticality: 'Unclassified',
    slaTarget: '99.50%',
    lifecycle: info.lifeCycleStatus || info.lifecycleStatus || 'PUBLISHED',
    checkFrequency: 'none',
    checkedAt: null,
    healthUrl: null,
    liveness: {
      status: 'PENDING',
      httpStatus: null,
      latencyMs: null
    },
    contract: {
      status: 'PENDING',
      reasons: ['Subscribed in API Catalogue Application; waiting for MI health status.']
    },
    sla: {
      status: 'PENDING',
      target: '99.50%',
      window: 'demo'
    },
    probePolicy: {
      active: false,
      frequency: 'none',
      reason: 'Subscribed in Developer Portal but no MI status is available yet.'
    },
    consumerStatus: 'UNKNOWN',
    reason: 'Subscribed in API Catalogue Application; waiting for MI health status.',
    source: 'wso2-api-manager-devportal',
    sourceOfTruth: 'wso2-api-manager-devportal',
    subscriptionApplication: CATALOGUE_APP_NAME,
    subscriptionStatus: subscription.status,
    subscriptionSyncedAt: now
  };
}

async function catalogueBuildSubscribedRows() {
  const token = await catalogueGetDevPortalToken();
  const app = await catalogueFindApplication(token);
  const applicationId = app.applicationId || app.id;
  const subscriptions = await catalogueListApplicationSubscriptions(token, applicationId);
  const cacheRows = await catalogueReadCachedRows();

  return subscriptions.map((subscription) => {
    const placeholder = cataloguePlaceholderRow(subscription);
    const cached = catalogueFindCachedRow(cacheRows, subscription);

    return {
      ...placeholder,
      ...(cached || {}),
      sourceOfTruth: 'wso2-api-manager-devportal',
      subscriptionApplication: CATALOGUE_APP_NAME,
      subscriptionStatus: subscription.status
    };
  });
}

function catalogueNormalizeStatus(value) {
  return String(value || 'UNKNOWN').toUpperCase();
}

function catalogueBuildSummary(rows) {
  const summary = {
    total: rows.length,
    registered: rows.length,
    healthy: 0,
    attention: 0,
    green: 0,
    red: 0,
    grey: 0,
    unknown: 0,
    consumerStatusCounts: {},
    livenessCounts: {},
    contractCounts: {},
    sourceOfTruth: 'wso2-api-manager-devportal',
    subscriptionApplication: CATALOGUE_APP_NAME,
    generatedAt: new Date().toISOString()
  };

  for (const row of rows) {
    const consumerStatus = catalogueNormalizeStatus(row.consumerStatus);
    const livenessStatus = catalogueNormalizeStatus(row.liveness && row.liveness.status);
    const contractStatus = catalogueNormalizeStatus(row.contract && row.contract.status);

    summary.consumerStatusCounts[consumerStatus] = (summary.consumerStatusCounts[consumerStatus] || 0) + 1;
    summary.livenessCounts[livenessStatus] = (summary.livenessCounts[livenessStatus] || 0) + 1;
    summary.contractCounts[contractStatus] = (summary.contractCounts[contractStatus] || 0) + 1;

    if (consumerStatus === 'GREEN') {
      summary.green += 1;
      summary.healthy += 1;
    } else if (consumerStatus === 'RED') {
      summary.red += 1;
      summary.attention += 1;
    } else if (consumerStatus === 'GREY' || consumerStatus === 'GRAY') {
      summary.grey += 1;
    } else {
      summary.unknown += 1;
    }
  }

  return summary;
}

async function handleCatalogueSubscribedStatusRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname === '/api/catalogue-status/apis' && req.method === 'GET') {
    try {
      const rows = await catalogueBuildSubscribedRows();
      catalogueSendJson(res, 200, rows);
    } catch (e) {
      catalogueSendJson(res, 500, {
        status: 'ERROR',
        message: e.message,
        source: 'platform-control-devportal-catalogue'
      });
    }
    return true;
  }

  if (requestUrl.pathname === '/api/catalogue-status/summary' && req.method === 'GET') {
    try {
      const rows = await catalogueBuildSubscribedRows();
      catalogueSendJson(res, 200, catalogueBuildSummary(rows));
    } catch (e) {
      catalogueSendJson(res, 500, {
        status: 'ERROR',
        message: e.message,
        source: 'platform-control-devportal-catalogue'
      });
    }
    return true;
  }

  return false;
}
/* DEVPORTAL_CATALOGUE_STATUS_FINAL_PATCH_END */



/* DEVPORTAL_CATALOGUE_V2_START */
const DP2_APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const DP2_APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const DP2_APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';
const DP2_APP_NAME = process.env.API_CATALOGUE_APP_NAME || 'API Catalogue Application';
const DP2_CACHE_RESULTS_URL = process.env.CATALOGUE_CACHE_RESULTS_URL || 'http://localhost:6300/cache/results';


let dp2CachedOAuthClient = null;
let dp2CachedAccessToken = null;
let dp2CachedAccessTokenExpiresAt = 0;
let dp2LastSuccessfulCatalogueRows = null;

if (String(process.env.APIM_ALLOW_INSECURE_TLS || 'true').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function dp2SendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function dp2BasicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function dp2RequestJson(url, options = {}) {
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

async function dp2GetDevPortalToken() {
  const now = Date.now();

  if (dp2CachedAccessToken && now < dp2CachedAccessTokenExpiresAt - 30000) {
    return dp2CachedAccessToken;
  }

  if (!dp2CachedOAuthClient) {
    dp2CachedOAuthClient = await dp2RequestJson(`${DP2_APIM_HOST}/client-registration/v0.17/register`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${dp2BasicAuth(DP2_APIM_USERNAME, DP2_APIM_PASSWORD)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        callbackUrl: 'www.google.com',
        clientName: 'api-catalogue-ui-devportal-client',
        owner: DP2_APIM_USERNAME,
        grantType: 'password refresh_token client_credentials',
        saasApp: true
      })
    });
  }

  const tokenBody = new URLSearchParams();
  tokenBody.set('grant_type', 'password');
  tokenBody.set('username', DP2_APIM_USERNAME);
  tokenBody.set('password', DP2_APIM_PASSWORD);
  tokenBody.set('scope', 'apim:api_view apim:subscribe apim:app_manage apim:sub_manage');

  const token = await dp2RequestJson(`${DP2_APIM_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${dp2BasicAuth(dp2CachedOAuthClient.clientId, dp2CachedOAuthClient.clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: tokenBody.toString()
  });

  if (!token.access_token) {
    throw new Error(`DevPortal token response did not include access_token: ${JSON.stringify(token)}`);
  }

  dp2CachedAccessToken = token.access_token;
  dp2CachedAccessTokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;

  return dp2CachedAccessToken;
}

async function dp2FindCatalogueApplication(token) {
  const apps = await dp2RequestJson(`${DP2_APIM_HOST}/api/am/devportal/v3/applications?limit=200`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const app = (apps.list || []).find((item) => item.name === DP2_APP_NAME);

  if (!app) {
    throw new Error(`Developer Portal application not found: ${DP2_APP_NAME}`);
  }

  return app;
}

async function dp2ListApplicationSubscriptions(token, applicationId) {
  const subscriptions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const payload = await dp2RequestJson(
      `${DP2_APIM_HOST}/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(applicationId)}&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const page = payload.list || [];
    subscriptions.push(...page);

    if (page.length < limit) {
      break;
    }

    offset += limit;
  }

  return subscriptions;
}

async function dp2ReadCachedRows() {
  const response = await fetch(DP2_CACHE_RESULTS_URL);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`health-status-cache returned HTTP ${response.status}: ${text}`);
  }

  const payload = text ? JSON.parse(text) : [];
  return Array.isArray(payload) ? payload : [];
}

function dp2SubscriptionInfo(subscription) {
  return subscription.apiInfo || subscription.api || {};
}


function dp2ApiIdFromSubscription(subscription) {
  const info = dp2SubscriptionInfo(subscription);
  return subscription.apiId || info.id || info.apiId || null;
}

function dp2ToPropertyMap(api) {
  const map = {};

  function put(name, value) {
    if (!name || value === undefined || value === null || value === "") {
      return;
    }
    map[String(name)] = String(value);
  }

  const collections = [
    api?.additionalProperties,
    api?.properties,
    api?.additionalPropertiesMap
  ];

  for (const collection of collections) {
    if (Array.isArray(collection)) {
      for (const item of collection) {
        put(item.name || item.key, item.value);
      }
    } else if (collection && typeof collection === 'object') {
      for (const [key, value] of Object.entries(collection)) {
        if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
          put(key, value.value);
        } else {
          put(key, value);
        }
      }
    }
  }

  return map;
}

async function dp2FetchPublisherApiDetails(token, subscription) {
  const apiId = dp2ApiIdFromSubscription(subscription);

  if (!apiId) {
    return null;
  }

  try {
    return await dp2RequestJson(`${DP2_APIM_HOST}/api/am/publisher/v4/apis/${encodeURIComponent(apiId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) {
    console.warn(`[devportal-catalogue] Could not fetch Publisher API details for ${apiId}: ${e.message}`);
    return null;
  }
}

function dp2OwnerFromApiDetails(api, fallbackOwner = {}) {
  const props = dp2ToPropertyMap(api);
  const business = api?.businessInformation || {};

  // UI owner should follow APIM/DevPortal first.
  // Demo health_owner_* properties are kept as fallback metadata only.
  const team =
    business.technicalOwner ||
    business.businessOwner ||
    api?.provider ||
    api?.createdBy ||
    props.health_owner_team ||
    props.owner_team ||
    fallbackOwner.team ||
    'Unknown';

  const email =
    business.technicalOwnerEmail ||
    business.businessOwnerEmail ||
    props.health_owner_email ||
    props.owner_email ||
    fallbackOwner.email ||
    'unknown@example.com';

  return {
    team,
    email
  };
}


function dp2JoinUrl(base, pathValue) {
  if (!base) {
    return null;
  }

  const normalizedPath = pathValue || "/health";
  return `${String(base).replace(/\/+$/, "")}/${String(normalizedPath).replace(/^\/+/, "")}`;
}

function dp2ToBrowserReachableUrl(urlValue) {
  if (!urlValue) {
    return null;
  }

  try {
    const parsed = new URL(urlValue);

    // Docker service DNS names such as accounts-api are valid inside containers,
    // but not from the user's browser. Keep the port and path, expose localhost.
    if (
      parsed.hostname &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      !parsed.hostname.includes(".")
    ) {
      parsed.hostname = "localhost";
    }

    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function dp2BuildHealthUrlsFromApiDetails(api, fallback = {}) {
  const props = dp2ToPropertyMap(api);

  const healthPath = props.health_path || fallback.healthPath || "/health";
  const internalBase = props.health_backend_url || props.backend_url || null;
  const browserBase =
    props.health_browser_base_url ||
    props.health_public_base_url ||
    props.health_display_base_url ||
    props.health_gateway_url ||
    internalBase;

  const internalHealthUrl = dp2JoinUrl(internalBase, healthPath);
  const browserHealthUrl = dp2ToBrowserReachableUrl(dp2JoinUrl(browserBase, healthPath));

  return {
    healthPath,
    healthInternalUrl: internalHealthUrl || fallback.healthInternalUrl || fallback.healthUrl || null,
    healthUrl: browserHealthUrl || fallback.healthUrl || null,
    healthBrowserUrl: browserHealthUrl || fallback.healthBrowserUrl || fallback.healthUrl || null
  };
}


function dp2MetadataFromApiDetails(api, fallback = {}) {
  if (!api) {
    return {};
  }

  const props = dp2ToPropertyMap(api);
  const owner = dp2OwnerFromApiDetails(api, fallback.owner || {});
  const healthUrls = dp2BuildHealthUrlsFromApiDetails(api, fallback);

  return {
    ...healthUrls,
    apiId: api.id || fallback.apiId || null,
    name: api.name || fallback.name,
    displayName: api.displayName || api.name || fallback.displayName || fallback.name,
    version: api.version || fallback.version,
    context: api.context || fallback.context || null,
    lifecycle: api.lifeCycleStatus || api.lifecycleStatus || api.status || fallback.lifecycle,
    domain: props.health_domain || props.domain || fallback.domain || 'Unclassified',
    owner,
    runtime: props.health_runtime || props.runtime || fallback.runtime || 'Unknown',
    criticality: props.health_criticality || props.criticality || fallback.criticality || 'Unclassified',
    slaTarget: props.health_sla_target || props.slaTarget || fallback.slaTarget || '99.50%'
  };
}


function dp2SubscriptionKeys(subscription) {
  const info = dp2SubscriptionInfo(subscription);
  const keys = [];

  const apiId = subscription.apiId || info.id || info.apiId;
  const name = info.name || subscription.apiName || subscription.name;
  const version = info.version || subscription.apiVersion || subscription.version;

  if (apiId) {
    keys.push(String(apiId));
  }

  if (name && version) {
    keys.push(`${name}:${version}`);
  }

  return keys;
}

function dp2RowKeys(row) {
  return [
    row?.apiId ? String(row.apiId) : null,
    row?.name && row?.version ? `${row.name}:${row.version}` : null
  ].filter(Boolean);
}

function dp2FindCachedRow(cacheRows, subscription) {
  const keys = new Set(dp2SubscriptionKeys(subscription));
  return cacheRows.find((row) => dp2RowKeys(row).some((key) => keys.has(key)));
}

function dp2PlaceholderRow(subscription) {
  const info = dp2SubscriptionInfo(subscription);
  const now = new Date().toISOString();

  return {
    apiId: subscription.apiId || info.id || info.apiId || null,
    name: info.name || subscription.apiName || subscription.name || 'unknown-api',
    version: info.version || subscription.apiVersion || subscription.version || '1.0.0',
    context: info.context || null,
    domain: 'Unclassified',
    owner: {
      team: 'Unknown',
      email: 'unknown@example.com'
    },
    runtime: 'Unknown',
    criticality: 'Unclassified',
    slaTarget: '99.50%',
    lifecycle: info.lifeCycleStatus || info.lifecycleStatus || 'PUBLISHED',
    checkFrequency: 'none',
    checkedAt: null,
    healthUrl: null,
    liveness: {
      status: 'PENDING',
      httpStatus: null,
      latencyMs: null
    },
    contract: {
      status: 'PENDING',
      reasons: ['Subscribed in API Catalogue Application; waiting for MI health status.']
    },
    sla: {
      status: 'PENDING',
      target: '99.50%',
      window: 'demo'
    },
    probePolicy: {
      active: false,
      frequency: 'none',
      reason: 'Subscribed in Developer Portal but no MI status is available yet.'
    },
    consumerStatus: 'UNKNOWN',
    reason: 'Subscribed in API Catalogue Application; waiting for MI health status.',
    source: 'wso2-api-manager-devportal',
    sourceOfTruth: 'wso2-api-manager-devportal',
    subscriptionApplication: DP2_APP_NAME,
    subscriptionStatus: subscription.status,
    subscriptionSyncedAt: now
  };
}

async function dp2BuildCatalogueRows() {
  const token = await dp2GetDevPortalToken();
  const app = await dp2FindCatalogueApplication(token);
  const applicationId = app.applicationId || app.id;
  const subscriptions = await dp2ListApplicationSubscriptions(token, applicationId);
  const cacheRows = await dp2ReadCachedRows();

  const apiDetailsBySubscription = await Promise.all(
    subscriptions.map((subscription) => dp2FetchPublisherApiDetails(token, subscription))
  );

  return subscriptions.map((subscription, index) => {
    const placeholder = dp2PlaceholderRow(subscription);
    const cached = dp2FindCachedRow(cacheRows, subscription);
    const publisherMetadata = dp2MetadataFromApiDetails(apiDetailsBySubscription[index], {
      ...placeholder,
      ...(cached || {})
    });

    return {
      ...placeholder,
      ...(cached || {}),
      ...publisherMetadata,
      sourceOfTruth: 'wso2-api-manager-devportal',
      metadataSource: publisherMetadata.owner ? 'wso2-api-manager-publisher' : 'health-status-cache',
      subscriptionApplication: DP2_APP_NAME,
      subscriptionStatus: subscription.status
    };
  });
}

function dp2NormalizeStatus(value) {
  return String(value || 'UNKNOWN').toUpperCase();
}

function dp2BuildSummary(rows) {
  const summary = {
    total: rows.length,
    registered: rows.length,
    healthy: 0,
    attention: 0,
    green: 0,
    red: 0,
    grey: 0,
    unknown: 0,
    consumerStatusCounts: {},
    livenessCounts: {},
    contractCounts: {},
    sourceOfTruth: 'wso2-api-manager-devportal',
    subscriptionApplication: DP2_APP_NAME,
    generatedAt: new Date().toISOString()
  };

  for (const row of rows) {
    const consumerStatus = dp2NormalizeStatus(row.consumerStatus);
    const livenessStatus = dp2NormalizeStatus(row.liveness?.status);
    const contractStatus = dp2NormalizeStatus(row.contract?.status);

    summary.consumerStatusCounts[consumerStatus] = (summary.consumerStatusCounts[consumerStatus] || 0) + 1;
    summary.livenessCounts[livenessStatus] = (summary.livenessCounts[livenessStatus] || 0) + 1;
    summary.contractCounts[contractStatus] = (summary.contractCounts[contractStatus] || 0) + 1;

    if (consumerStatus === 'GREEN') {
      summary.green += 1;
      summary.healthy += 1;
    } else if (consumerStatus === 'RED') {
      summary.red += 1;
      summary.attention += 1;
    } else if (consumerStatus === 'GREY' || consumerStatus === 'GRAY') {
      summary.grey += 1;
    } else {
      summary.unknown += 1;
    }
  }

  return summary;
}








function dp2IsFreshApimBootstrapError(error) {
  const message = String(error?.message || error || "");

  return (
    message.includes("Dynamic Client Registration Service not available") ||
    message.includes("OAuth app 'api-catalogue-ui-devportal-client' creation or updating failed") ||
    message.includes("Developer Portal application not found") ||
    message.includes("API Catalogue Application") ||
    message.includes("Unauthenticated request") ||
    message.includes("/client-registration/v0.17/register") ||
    message.includes("/api/am/devportal/v3/applications") ||
    message.includes("HTTP 401") ||
    message.includes("HTTP 500 POST")
  );
}

function dp2EmptyCatalogueResponse(req, warning) {
  if (String(req.url || "").includes("/summary")) {
    return {
      status: "OK",
      source: "platform-control-devportal-catalogue",
      warning,
      total: 0,
      green: 0,
      red: 0,
      yellow: 0,
      grey: 0,
      unknown: 0,
      apis: []
    };
  }

  return [];
}



/* APIM_GATEWAY_SECURE_INVOKE_START */
const APIM_GATEWAY_INTERNAL_HTTP_BASE_URL =
  process.env.PLATFORM_CONTROL_APIM_GATEWAY_BASE_URL || 'https://localhost:8243';

const APIM_GATEWAY_BROWSER_HTTP_BASE_URL =
  process.env.PLATFORM_CONTROL_APIM_GATEWAY_BROWSER_BASE_URL || 'https://localhost:8243';

const APIM_GATEWAY_TOKEN_CACHE_FILE =
  process.env.API_CATALOGUE_GATEWAY_TOKEN_FILE || '.runtime/api-catalogue-gateway-token.json';

function gatewayPublishedPathForApi(api, target = 'health') {
  const context = String(api?.context || '').replace(/\/+$/, '');
  const version = String(api?.version || '').replace(/^\/+|\/+$/g, '');

  if (!context || !version) {
    return null;
  }

  if (target === 'health') {
    return `${context}/${version}/health`;
  }

  return `${context}/${version}`;
}

function withApimGatewayHealthUrls(api) {
  const path = gatewayPublishedPathForApi(api, 'health');

  if (!path) {
    return api;
  }

  const internalUrl = `${APIM_GATEWAY_INTERNAL_HTTP_BASE_URL.replace(/\/+$/, '')}${path}`;
  const browserUrl = `${APIM_GATEWAY_BROWSER_HTTP_BASE_URL.replace(/\/+$/, '')}${path}`;

  return {
    ...api,

    // Keep explicit APIM Gateway fields for the UI side panel.
    gatewayHealthInternalUrl: internalUrl,
    gatewayHealthBrowserUrl: browserUrl,

    // The side panel should show the APIM-published URL, not the raw backend URL.
    healthUrl: browserUrl,
    healthInternalUrl: internalUrl,
    healthBrowserUrl: browserUrl,

    // Browser click goes through platform-control because browser links cannot add OAuth headers.
    secureHealthInvokeUrl:
      `http://localhost:6400/api/gateway/invoke?apiName=${encodeURIComponent(api.name)}&target=health`
  };
}

function readGatewayTokenFromCache() {
  const fsLocal = require('fs');

  if (!fsLocal.existsSync(APIM_GATEWAY_TOKEN_CACHE_FILE)) {
    throw new Error(
      `Gateway token cache not found: ${APIM_GATEWAY_TOKEN_CACHE_FILE}. Run post-onboard/reconcile first.`
    );
  }

  const cache = JSON.parse(fsLocal.readFileSync(APIM_GATEWAY_TOKEN_CACHE_FILE, 'utf8'));
  const token = cache.accessToken || cache.access_token;

  if (!token || String(token).length < 40) {
    throw new Error(`Gateway token cache does not contain a usable access token.`);
  }

  return token;
}

async function getCatalogueRowsForGatewayInvoke() {
  const response = await fetch('http://localhost:6300/cache/results');
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Could not read health-status-cache results: HTTP ${response.status}: ${text}`);
  }

  const rows = text ? JSON.parse(text) : [];
  return Array.isArray(rows) ? rows : [];
}

async function handleGatewayInvokeRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname !== '/api/gateway/invoke' || req.method !== 'GET') {
    return false;
  }

  try {
    const apiName = requestUrl.searchParams.get('apiName');
    const target = requestUrl.searchParams.get('target') || 'health';

    if (!apiName) {
      throw new Error('Missing apiName query parameter.');
    }

    const rows = await getCatalogueRowsForGatewayInvoke();
    const api = rows.find((row) => row.name === apiName);

    if (!api) {
      throw new Error(`API not found in current catalogue cache: ${apiName}`);
    }

    const path = gatewayPublishedPathForApi(api, target);

    if (!path) {
      throw new Error(`Could not build APIM Gateway path for ${apiName}. Missing context/version.`);
    }

    const gatewayUrl = `${APIM_GATEWAY_INTERNAL_HTTP_BASE_URL.replace(/\/+$/, '')}${path}`;
    const token = readGatewayTokenFromCache();

    const gatewayResponse = await fetch(gatewayUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    const body = await gatewayResponse.text();
    const contentType = gatewayResponse.headers.get('content-type') || 'application/json; charset=utf-8';

    res.writeHead(gatewayResponse.status, {
      'Content-Type': contentType,
      'X-Invoked-Through': 'platform-control-apim-gateway-proxy',
      'X-APIM-Gateway-URL': gatewayUrl.replace('wso2-apim', 'localhost').replace(':8280', ':8280')
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ERROR',
      message: e.message,
      source: 'platform-control-apim-gateway-proxy'
    }));
  }

  return true;
}
/* APIM_GATEWAY_SECURE_INVOKE_END */


async function dp2HandleCatalogueStatusRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname === '/api/catalogue-status/apis' && req.method === 'GET') {
    try {
      const rows = (await dp2BuildCatalogueRows()).map(withApimGatewayHealthUrls);
      dp2LastSuccessfulCatalogueRows = rows;
      dp2SendJson(res, 200, rows);
    } catch (e) {
      if (dp2IsFreshApimBootstrapError(e)) {
        const warning = `No APIs have been manually onboarded yet, or APIM/DevPortal is still warming up: ${e.message}`;
        console.warn(`[platform-control-devportal-catalogue] ${warning}`);

        // After a fresh APIM reset, never show stale rows from a previous APIM database.
        dp2LastSuccessfulCatalogueRows = null;

        dp2SendJson(res, 200, dp2EmptyCatalogueResponse(req, warning));
        return true;
      }

      if (dp2LastSuccessfulCatalogueRows) {
        dp2SendJson(res, 200, dp2LastSuccessfulCatalogueRows.map((row) => ({
          ...row,
          catalogueWarning: e.message
        })));
      } else {
        dp2SendJson(res, 500, {
          status: 'ERROR',
          message: e.message,
          source: 'platform-control-devportal-catalogue'
        });
      }
    }
    return true;
  }

  if (requestUrl.pathname === '/api/catalogue-status/summary' && req.method === 'GET') {
    try {
      const rows = (await dp2BuildCatalogueRows()).map(withApimGatewayHealthUrls);
      dp2SendJson(res, 200, dp2BuildSummary(rows));
    } catch (e) {
      if (dp2IsFreshApimBootstrapError(e)) {
        const warning = `No APIs have been manually onboarded yet, or APIM/DevPortal is still warming up: ${e.message}`;
        console.warn(`[platform-control-devportal-catalogue] ${warning}`);

        dp2LastSuccessfulCatalogueRows = null;

        dp2SendJson(res, 200, dp2EmptyCatalogueResponse(req, warning));
        return true;
      }

      dp2SendJson(res, 500, {
        status: 'ERROR',
        message: e.message,
        source: 'platform-control-devportal-catalogue'
      });
    }
    return true;
  }

  return false;
}
/* DEVPORTAL_CATALOGUE_V2_END */



/* CATALOGUE_SYNC_RUN_ROUTE_START */

let catalogueSyncJobState = {
  status: 'IDLE',
  message: 'No catalogue sync has been started yet.',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null
};

function catalogueSyncSendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function catalogueSyncRun(command, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        code,
        signal,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr
      });
    });
  });
}

async function catalogueSyncSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function catalogueSyncWaitForMi(timeoutMs = 180000, intervalMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://localhost:8290/health-registry/v1/apis');

      if (response.ok) {
        return {
          status: 'OK',
          httpStatus: response.status,
          message: 'MI health registry is reachable'
        };
      }

      lastError = `HTTP ${response.status}`;
    } catch (e) {
      lastError = e.message;
    }

    await catalogueSyncSleep(intervalMs);
  }

  return {
    status: 'TIMEOUT',
    message: `MI health registry did not become reachable within ${Math.round(timeoutMs / 1000)}s`,
    lastError
  };
}

async function catalogueSyncTriggerProbe() {
  try {
    const response = await fetch('http://localhost:8290/health-registry/v1/probes/run', {
      method: 'POST'
    });

    const text = await response.text();

    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    return {
      status: response.ok ? 'OK' : 'ERROR',
      httpStatus: response.status,
      payload
    };
  } catch (e) {
    return {
      status: 'ERROR',
      message: e.message
    };
  }
}

function catalogueSyncRun(command, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const displayCommand = `${command} ${args.join(' ')}`;

    console.log(`[catalogue-sync] running: ${displayCommand}`);

    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    function finish(payload) {
      if (resolved) {
        return;
      }

      resolved = true;
      clearTimeout(timer);
      resolve(payload);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[catalogue-sync] ${text}`);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[catalogue-sync] ${text}`);
    });

    child.on('error', (error) => {
      finish({
        command,
        args,
        displayCommand,
        code: 127,
        signal: null,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
        error: error.message
      });
    });

    child.on('close', (code, signal) => {
      finish({
        command,
        args,
        displayCommand,
        code,
        signal,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr
      });
    });
  });
}

async function handleCatalogueSyncRunRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (requestUrl.pathname === '/api/catalogue-sync/status' && req.method === 'GET') {
    catalogueSyncSendJson(res, 200, catalogueSyncJobState);
    return true;
  }

  if (requestUrl.pathname === '/api/catalogue-sync/run' && req.method === 'POST') {
    if (catalogueSyncJobState.status === 'RUNNING') {
      catalogueSyncSendJson(res, 202, catalogueSyncJobState);
      return true;
    }

    catalogueSyncJobState = {
      status: 'RUNNING',
      message: 'Synchronizing DevPortal subscriptions, regenerating MI artifacts, restarting MI, and triggering evaluation.',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      error: null
    };

    catalogueSyncRunNow()
      .then((result) => {
        catalogueSyncJobState = {
          status: result.status === 'COMPLETED' ? 'COMPLETED' : 'ERROR',
          message: result.message || 'Catalogue sync finished.',
          startedAt: catalogueSyncJobState.startedAt,
          finishedAt: new Date().toISOString(),
          result,
          error: result.status === 'COMPLETED' ? null : result.message
        };
      })
      .catch((error) => {
        catalogueSyncJobState = {
          status: 'ERROR',
          message: error.message,
          startedAt: catalogueSyncJobState.startedAt,
          finishedAt: new Date().toISOString(),
          result: null,
          error: error.message
        };
      });

    catalogueSyncSendJson(res, 202, catalogueSyncJobState);
    return true;
  }

  return false;
}
/* CATALOGUE_SYNC_RUN_ROUTE_END */



/* SAFE_CATALOGUE_SYNC_ROUTE_START */
let safeCatalogueSyncState = {
  status: 'IDLE',
  message: 'No catalogue sync has been started yet.',
  startedAt: null,
  finishedAt: null,
  error: null,
  result: null
};

function safeCatalogueSyncJson(res, statusCode, payload) {
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
  }

  res.end(JSON.stringify(payload, null, 2));
}

function safeCatalogueSyncExec(command, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();

    console.log(`[catalogue-sync-safe] running: ${command}`);

    const child = spawn(command, {
      cwd: REPO_ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let timedOut = false;

    function finish(payload) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(payload);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[catalogue-sync-safe] ${text}`);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[catalogue-sync-safe] ${text}`);
    });

    child.on('error', (error) => {
      finish({
        command,
        code: 127,
        signal: null,
        timedOut,
        stdout,
        stderr,
        error: error.message,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    });

    child.on('close', (code, signal) => {
      finish({
        command,
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    });
  });
}

async function safeCatalogueSyncSleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeCatalogueSyncWaitForMi(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://localhost:8290/health-registry/v1/apis');
      if (response.ok) {
        return {
          status: 'OK',
          httpStatus: response.status,
          message: 'MI health registry is reachable'
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (e) {
      lastError = e.message;
    }

    await safeCatalogueSyncSleep(5000);
  }

  return {
    status: 'TIMEOUT',
    message: 'MI health registry did not become reachable in time',
    lastError
  };
}

async function safeCatalogueSyncProbe() {
  try {
    const response = await fetch('http://localhost:8290/health-registry/v1/probes/run', {
      method: 'POST'
    });

    const text = await response.text();

    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    return {
      status: response.ok ? 'OK' : 'ERROR',
      httpStatus: response.status,
      payload
    };
  } catch (e) {
    return {
      status: 'ERROR',
      message: e.message
    };
  }
}

async function safeCatalogueSyncRunJob() {
  const startedAt = new Date().toISOString();

  const reconcile = await safeCatalogueSyncExec('npm run platform:post-onboard', 300000);

  if (reconcile.code !== 0) {
    return {
      status: 'ERROR',
      message: 'APIM subscription reconciliation failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      reconcile
    };
  }

  const restartMi = await safeCatalogueSyncExec(
    'docker-compose --profile platform up -d --force-recreate wso2-integrator',
    180000
  );

  if (restartMi.code !== 0) {
    return {
      status: 'ERROR',
      message: 'MI restart failed after reconciliation',
      startedAt,
      finishedAt: new Date().toISOString(),
      reconcile,
      restartMi
    };
  }

  const miReadiness = await safeCatalogueSyncWaitForMi();

  if (miReadiness.status !== 'OK') {
    return {
      status: 'ERROR',
      message: 'MI did not become ready after reconciliation',
      startedAt,
      finishedAt: new Date().toISOString(),
      reconcile,
      restartMi,
      miReadiness
    };
  }

  const probe = await safeCatalogueSyncProbe();

  return {
    status: probe.status === 'OK' ? 'COMPLETED' : 'PROBE_FAILED',
    message: probe.status === 'OK'
      ? 'Subscriptions reconciled, MI restarted, and evaluation triggered'
      : 'Subscriptions reconciled and MI restarted, but probe trigger failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    reconcile,
    restartMi,
    miReadiness,
    probe
  };
}

async function safeHandleCatalogueSyncRoute(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (!requestUrl.pathname.startsWith('/api/catalogue-sync')) {
    return false;
  }

  try {
    if (req.method === 'OPTIONS') {
      safeCatalogueSyncJson(res, 204, {});
      return true;
    }

    if (requestUrl.pathname === '/api/catalogue-sync/status' && req.method === 'GET') {
      safeCatalogueSyncJson(res, 200, safeCatalogueSyncState);
      return true;
    }

    if (requestUrl.pathname === '/api/catalogue-sync/run' && req.method === 'POST') {
      if (safeCatalogueSyncState.status === 'RUNNING') {
        safeCatalogueSyncJson(res, 202, safeCatalogueSyncState);
        return true;
      }

      safeCatalogueSyncState = {
        status: 'RUNNING',
        message: 'Synchronizing DevPortal subscriptions, regenerating MI artifacts, restarting MI, and triggering evaluation.',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        result: null
      };

      safeCatalogueSyncRunJob()
        .then((result) => {
          safeCatalogueSyncState = {
            status: result.status === 'COMPLETED' ? 'COMPLETED' : 'ERROR',
            message: result.message || 'Catalogue sync finished.',
            startedAt: safeCatalogueSyncState.startedAt,
            finishedAt: new Date().toISOString(),
            error: result.status === 'COMPLETED' ? null : result.message,
            result
          };
        })
        .catch((error) => {
          safeCatalogueSyncState = {
            status: 'ERROR',
            message: error.message,
            startedAt: safeCatalogueSyncState.startedAt,
            finishedAt: new Date().toISOString(),
            error: error.message,
            result: null
          };
        });

      safeCatalogueSyncJson(res, 202, safeCatalogueSyncState);
      return true;
    }

    safeCatalogueSyncJson(res, 404, {
      status: 'ERROR',
      message: `Unknown catalogue sync route: ${req.method} ${requestUrl.pathname}`
    });
    return true;
  } catch (e) {
    safeCatalogueSyncJson(res, 500, {
      status: 'ERROR',
      message: e.message,
      source: 'safe-catalogue-sync-route'
    });
    return true;
  }
}
/* SAFE_CATALOGUE_SYNC_ROUTE_END */


const server = http.createServer(async (req, res) => {
  if (await safeHandleCatalogueSyncRoute(req, res)) {
    return;
  }


  if (await handleCatalogueSyncRunRoute(req, res)) {
    return;
  }


  if (await handleGatewayInvokeRoute(req, res)) {
    return;
  }

  if (await dp2HandleCatalogueStatusRoute(req, res)) {
    return;
  }


  if (handleContractValidationRoute(req, res)) {
    return;
  }
  if (handleApiRuntimeControlRoute(req, res)) {
    return;
  }


  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
      sendText(res, 204, '');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'UP',
        service: 'platform-control',
        port: PORT,
        payloadOverridesFile: PAYLOAD_OVERRIDES_FILE, requestOverridesFile: REQUEST_OVERRIDES_FILE, requestOverridesFile: REQUEST_OVERRIDES_FILE
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/onboarding/options') {
      sendJson(res, 200, await getOptions());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/payload-overrides') {
      sendJson(res, 200, readPayloadOverrideStore());
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/payload-overrides') {
      if (fs.existsSync(PAYLOAD_OVERRIDES_FILE)) {
        fs.rmSync(PAYLOAD_OVERRIDES_FILE, { force: true });
      }

      sendJson(res, 200, {
        status: 'CLEARED',
        file: PAYLOAD_OVERRIDES_FILE
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/onboarding/jobs') {
      const body = await readBody(req);
      const actionId = body.actionId;

      if (!actionId) {
        sendJson(res, 400, {
          error: 'Missing required field: actionId'
        });
        return;
      }

      const job = await startJob(actionId, body.payloadOverrides || {}, body.requestOverrides || {});
      sendJson(res, 201, getJobPayload(job));
      return;
    }

    const jobEventsMatch = url.pathname.match(/^\/api\/onboarding\/jobs\/([^/]+)\/events$/);
    if (req.method === 'GET' && jobEventsMatch) {
      streamJob(req, res, jobEventsMatch[1]);
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/onboarding\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(res, 404, {
          error: `Job not found: ${jobMatch[1]}`
        });
        return;
      }

      sendJson(res, 200, getJobPayload(job));
      return;
    }

    sendJson(res, 404, {
      error: 'Not found'
    });
  } catch (e) {
    sendJson(res, 500, {
      error: e.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`Platform control server listening on http://localhost:${PORT}`);
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Health Registry URL: ${HEALTH_REGISTRY_URL}`);
  console.log(`Catalogue Status URL: ${CATALOGUE_STATUS_URL}`);
  console.log(`UI Catalogue Status URL: ${UI_CATALOGUE_STATUS_URL}`);
  console.log(`Payload overrides file: ${PAYLOAD_OVERRIDES_FILE}`);
});
