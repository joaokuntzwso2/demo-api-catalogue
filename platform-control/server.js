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

function contractValidationOverrideFor(apiName, overrides) {
  if (Object.prototype.hasOwnProperty.call(overrides, apiName)) {
    return overrides[apiName];
  }

  const versionedKey = `${apiName}:1.0.0`;
  if (Object.prototype.hasOwnProperty.call(overrides, versionedKey)) {
    return overrides[versionedKey];
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
  const requestOverrides = contractValidationReadJson(REQUEST_OVERRIDES_FILE, {});
  const payloadOverrides = contractValidationReadJson(PAYLOAD_OVERRIDES_FILE, {});

  const apis = Object.keys(defaults).sort().map((apiName) => {
    const defaultConfig = defaults[apiName] || {};
    const requestOverride = contractValidationOverrideFor(apiName, requestOverrides);
    const payloadOverride = contractValidationOverrideFor(apiName, payloadOverrides);

    return {
      name: apiName,
      defaultRequest: defaultConfig.request || {},
      effectiveRequest: requestOverride || defaultConfig.request || {},
      hasRequestOverride: requestOverride !== undefined,
      defaultPayload: defaultConfig.expectedPayload || {},
      effectivePayload: payloadOverride || defaultConfig.expectedPayload || {},
      hasPayloadOverride: payloadOverride !== undefined,
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
      contractValidationSendJson(res, 500, {
        status: 'ERROR',
        message: e.message
      });
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
          contractValidationSendJson(res, 400, {
            status: 'ERROR',
            message: 'apiName is required'
          });
          return;
        }

        if (!request || typeof request !== 'object') {
          contractValidationSendJson(res, 400, {
            status: 'ERROR',
            message: 'request must be a JSON object'
          });
          return;
        }

        if (!payload || typeof payload !== 'object') {
          contractValidationSendJson(res, 400, {
            status: 'ERROR',
            message: 'payload must be a JSON object'
          });
          return;
        }

        const requestOverrides = contractValidationReadJson(REQUEST_OVERRIDES_FILE, {});
        const payloadOverrides = contractValidationReadJson(PAYLOAD_OVERRIDES_FILE, {});

        requestOverrides[apiName] = request;
        payloadOverrides[apiName] = payload;

        contractValidationWriteJson(REQUEST_OVERRIDES_FILE, requestOverrides);
        contractValidationWriteJson(PAYLOAD_OVERRIDES_FILE, payloadOverrides);

        const syncArtifacts = await contractValidationRun('docker-compose', [
          '--profile',
          'platform',
          'run',
          '--rm',
          '-e',
          'APIM_ALLOW_INSECURE_TLS=true',
          'apictl',
          'node pipeline/scripts/sync-mi-health-from-apim.js'
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
            reconcile
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
          probe = {
            status: 'ERROR',
            message: `Probe trigger failed: ${e.message}`
          };
        }

        contractValidationSendJson(res, 200, {
          status: 'COMPLETED',
          message: 'Contract validation overrides saved, MI artifacts reconciled, and validation triggered',
          apiName,
          reconcile,
          probe
        });
      })
      .catch((e) => {
        contractValidationSendJson(res, 500, {
          status: 'ERROR',
          message: e.message
        });
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
    {
      method: 'POST'
    },
    12000
  );
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
      apiRuntimeControlSendJson(res, 500, {
        status: 'ERROR',
        message: e.message
      });
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
          action === 'stop' ? 15000 : 30000
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

        const forcedStatus = action === 'stop'
          ? await apiRuntimeControlWriteStoppedResult(apiName, serviceName, after)
          : {
              status: 'SKIPPED',
              reason: 'Start action relies on MI probe to restore GREEN status.'
            };

        const probe = action === 'start'
          ? await apiRuntimeControlTriggerProbe()
          : {
              status: 'SKIPPED',
              reason: 'Stop action already wrote RED status after Docker stop.'
            };

        apiRuntimeControlSendJson(res, 200, {
          status: 'COMPLETED',
          message: `${serviceName} ${action === 'stop' ? 'stopped and marked RED' : 'started and MI probe requested'}`,
          apiName,
          serviceName,
          action,
          before,
          after,
          runtime,
          forcedStatus,
          probe
        });
      })
      .catch((e) => {
        apiRuntimeControlSendJson(res, 500, {
          status: 'ERROR',
          message: e.message
        });
      });

    return true;
  }

  return false;
}
/* API_RUNTIME_CONTROL_ROUTES_END */





const server = http.createServer(async (req, res) => {
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
