const fs = require("fs");
const path = require("path");

const STATUS_CACHE_BASE_URL =
  process.env.STATUS_CACHE_BASE_URL ||
  "http://health-status-cache:6300";

if (String(process.env.APIM_ALLOW_INSECURE_TLS || "false").toLowerCase() === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn(
    "[sync-mi-health-from-apim] WARNING: APIM_ALLOW_INSECURE_TLS=true. Self-signed APIM certificate validation is disabled for this local demo."
  );
}

const APIM_HOST = process.env.APIM_HOST || "https://wso2-apim:9443";
const APIM_USERNAME = process.env.APIM_USERNAME || "admin";
const APIM_PASSWORD = process.env.APIM_PASSWORD || "admin"; const API_CATALOGUE_APP_NAME = process.env.API_CATALOGUE_APP_NAME || "API Catalogue Application";
const API_CATALOGUE_RUNTIME_APP_NAME = process.env.API_CATALOGUE_RUNTIME_APP_NAME || "API Catalogue Runtime Application";
const API_CATALOGUE_USE_GATEWAY = String(process.env.API_CATALOGUE_USE_GATEWAY || "true").toLowerCase() === "true";
const APIM_GATEWAY_INTERNAL_BASE_URL = process.env.APIM_GATEWAY_INTERNAL_BASE_URL || "http://wso2-apim:8280";
const APIM_GATEWAY_BROWSER_BASE_URL = process.env.APIM_GATEWAY_BROWSER_BASE_URL || "http://localhost:8280";
const API_CATALOGUE_GATEWAY_TOKEN_FILE = process.env.API_CATALOGUE_GATEWAY_TOKEN_FILE || path.join(process.cwd(), ".runtime", "api-catalogue-gateway-token.json");
const API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS = Number(process.env.API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS || 86400);

const ARTIFACTS_ROOT =
  process.env.MI_ARTIFACTS_ROOT ||
  "/workspace/wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts";

const API_DIR = path.join(ARTIFACTS_ROOT, "apis");
const SEQUENCE_DIR = path.join(ARTIFACTS_ROOT, "sequences");
const TASK_DIR = path.join(ARTIFACTS_ROOT, "tasks");

const TIER_CONFIG = {
  "Tier 0": {
    key: "tier0",
    sequenceName: "run_tier0_health_checks",
    taskName: "ScheduledTier0HealthCheck",
    taskFileName: "scheduled_tier0_health_check.xml",
    intervalSeconds: 60,
    frequencyLabel: "1 min"
  },
  "Tier 1": {
    key: "tier1",
    sequenceName: "run_tier1_health_checks",
    taskName: "ScheduledTier1HealthCheck",
    taskFileName: "scheduled_tier1_health_check.xml",
    intervalSeconds: 180,
    frequencyLabel: "3 min"
  },
  "Tier 2": {
    key: "tier2",
    sequenceName: "run_tier2_health_checks",
    taskName: "ScheduledTier2HealthCheck",
    taskFileName: "scheduled_tier2_health_check.xml",
    intervalSeconds: 600,
    frequencyLabel: "10 min"
  },
  "Tier 3": {
    key: "tier3",
    sequenceName: "run_tier3_health_checks",
    taskName: "ScheduledTier3HealthCheck",
    taskFileName: "scheduled_tier3_health_check.xml",
    intervalSeconds: 1800,
    frequencyLabel: "30 min"
  }
};


function resolvePayloadOverridesFile() {
  if (process.env.HEALTH_PAYLOAD_OVERRIDES_FILE) {
    return process.env.HEALTH_PAYLOAD_OVERRIDES_FILE;
  }

  const dockerPath = "/workspace/.runtime/health-payload-overrides.json";
  if (fs.existsSync(dockerPath)) {
    return dockerPath;
  }

  return path.resolve(process.cwd(), ".runtime/health-payload-overrides.json");
}

function loadExpectedPayloadOverrides() {
  const file = resolvePayloadOverridesFile();

  if (!fs.existsSync(file)) {
    return {};
  }

  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return payload.overrides || {};
  } catch (e) {
    throw new Error(`Invalid health payload overrides file: ${file}. ${e.message}`);
  }
}

const HEALTH_PAYLOAD_OVERRIDES = loadExpectedPayloadOverrides();



function getExpectedPayloadRaw(api, properties) {
  const override = getPayloadOverride(api);

  if (override !== undefined) {
    console.log(
      `[sync-mi-health-from-apim] using local expected payload override for ${api.name}:${api.version}`
    );
    return JSON.stringify(override);
  }

  const defaults = getContractDefaultConfig(api.name);

  if (Object.prototype.hasOwnProperty.call(defaults, "expectedPayload")) {
    return JSON.stringify(defaults.expectedPayload);
  }

  if (properties.contract_expected_payload_json) {
    return properties.contract_expected_payload_json;
  }

  return getFallbackExpectedPayloadRaw(api);
}




function resolveContractDefaultsFile() {
  if (process.env.CONTRACT_DEFAULTS_FILE) {
    return process.env.CONTRACT_DEFAULTS_FILE;
  }

  const dockerPath = "/workspace/pipeline/config/contract-defaults.json";
  if (fs.existsSync(dockerPath)) {
    return dockerPath;
  }

  return path.resolve(process.cwd(), "pipeline/config/contract-defaults.json");
}

function loadContractDefaults() {
  const file = resolveContractDefaultsFile();

  if (!fs.existsSync(file)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Invalid contract defaults file: ${file}. ${e.message}`);
  }
}

const CONTRACT_DEFAULTS = loadContractDefaults();

function getContractDefaultConfig(apiName) {
  return CONTRACT_DEFAULTS[apiName] || {};
}

function resolveContractRequestOverridesFile() {
  if (process.env.CONTRACT_REQUEST_OVERRIDES_FILE) {
    return process.env.CONTRACT_REQUEST_OVERRIDES_FILE;
  }

  const dockerPath = "/workspace/.runtime/contract-request-overrides.json";
  if (fs.existsSync(dockerPath)) {
    return dockerPath;
  }

  return path.resolve(process.cwd(), ".runtime/contract-request-overrides.json");
}

function loadContractRequestOverrides() {
  const file = resolveContractRequestOverridesFile();

  if (!fs.existsSync(file)) {
    return {};
  }

  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return payload.overrides || {};
  } catch (e) {
    throw new Error(`Invalid contract request overrides file: ${file}. ${e.message}`);
  }
}

const CONTRACT_REQUEST_OVERRIDES = loadContractRequestOverrides();

function parseJsonWithFallback(raw, fallback) {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeContractRequest(value) {
  const source = value && typeof value === "object" ? value : {};

  return {
    method: String(source.method || "GET").toUpperCase(),
    path: String(source.path || "/"),
    headers: source.headers && typeof source.headers === "object" && !Array.isArray(source.headers)
      ? source.headers
      : {},
    query: source.query && typeof source.query === "object" && !Array.isArray(source.query)
      ? source.query
      : {},
    body: Object.prototype.hasOwnProperty.call(source, "body") ? source.body : null
  };
}

function appendQueryToUrl(url, query = {}) {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null);

  if (entries.length === 0) {
    return url;
  }

  const separator = url.includes("?") ? "&" : "?";
  const queryString = entries
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return value.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }

      return [`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`];
    })
    .join("&");

  return `${url}${separator}${queryString}`;
}


function resolveRuntimeJsonFile(filename, envVarName) {
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }

  const dockerPath = path.join("/workspace", ".runtime", filename);
  if (fs.existsSync(dockerPath)) {
    return dockerPath;
  }

  return path.resolve(process.cwd(), ".runtime", filename);
}

function readRuntimeJsonObject(filename, envVarName) {
  const file = resolveRuntimeJsonFile(filename, envVarName);

  if (!fs.existsSync(file)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Invalid runtime override file ${file}: ${e.message}`);
  }
}

const LOCAL_CONTRACT_REQUEST_OVERRIDES = readRuntimeJsonObject(
  "contract-request-overrides.json",
  "CONTRACT_REQUEST_OVERRIDES_FILE"
);

const LOCAL_CONTRACT_PAYLOAD_OVERRIDES = readRuntimeJsonObject(
  "contract-payload-overrides.json",
  "CONTRACT_PAYLOAD_OVERRIDES_FILE"
);











function resolveRuntimeOverrideFile(filename, envVarName) {
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }

  const dockerPath = path.join("/workspace", ".runtime", filename);
  if (fs.existsSync(dockerPath)) {
    return dockerPath;
  }

  return path.resolve(process.cwd(), ".runtime", filename);
}

function readRuntimeOverrideMap(filename, envVarName, valueField = null) {
  const file = resolveRuntimeOverrideFile(filename, envVarName);

  if (!fs.existsSync(file)) {
    return {};
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const normalized = {};

    function put(key, value) {
      if (!key || key === "version" || key === "updatedAt" || key === "overrides") {
        return;
      }

      if (
        valueField &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, valueField)
      ) {
        normalized[key] = value[valueField];
      } else {
        normalized[key] = value;
      }
    }

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)) {
        for (const [key, value] of Object.entries(raw.overrides)) {
          put(key, value);
        }
      }

      // Direct row-level keys win over stale wrapped onboarding entries.
      for (const [key, value] of Object.entries(raw)) {
        put(key, value);
      }
    }

    return normalized;
  } catch (e) {
    throw new Error(`Invalid runtime override file ${file}: ${e.message}`);
  }
}

function contractOverrideKeys(api) {
  return [
    `${api.name}:${api.version}`,
    api.name
  ];
}

function getContractRequestOverride(api) {
  const overrides = readRuntimeOverrideMap(
    "contract-request-overrides.json",
    "CONTRACT_REQUEST_OVERRIDES_FILE",
    "request"
  );

  for (const key of contractOverrideKeys(api)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      return normalizeContractRequest(overrides[key]);
    }
  }

  return undefined;
}

function getPayloadOverride(api) {
  const overrides = readRuntimeOverrideMap(
    "contract-payload-overrides.json",
    "CONTRACT_PAYLOAD_OVERRIDES_FILE",
    "expectedPayload"
  );

  for (const key of contractOverrideKeys(api)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      return overrides[key];
    }
  }

  return undefined;
}

function getContractRequest(api, properties) {
  const override = getContractRequestOverride(api);

  if (override !== undefined) {
    console.log(
      `[sync-mi-health-from-apim] using local contract request override for ${api.name}:${api.version}: ${override.path}`
    );
    return normalizeContractRequest(override);
  }

  const defaults = getContractDefaultConfig(api.name);

  if (defaults.request) {
    console.log(
      `[sync-mi-health-from-apim] using contract-defaults.json request for ${api.name}:${api.version}: ${defaults.request.path}`
    );
    return normalizeContractRequest(defaults.request);
  }

  if (properties.contract_request_json) {
    return normalizeContractRequest(parseJsonWithFallback(properties.contract_request_json, {}));
  }

  return normalizeContractRequest({
    method: properties.contract_method || properties.health_method || "GET",
    path: properties.contract_path || properties.health_path || "/",
    headers: parseJsonWithFallback(properties.contract_request_headers_json, {}),
    query: parseJsonWithFallback(properties.contract_request_query_json, {}),
    body: parseJsonWithFallback(properties.contract_request_body_json, null)
  });
}



function getContractRequest(api, properties) {
  const override = getContractRequestOverride(api);

  if (override !== undefined) {
    console.log(
      `[sync-mi-health-from-apim] using local contract request override for ${api.name}:${api.version}: ${override.path}`
    );
    return normalizeContractRequest(override);
  }

  const defaults = getContractDefaultConfig(api.name);

  if (defaults.request) {
    console.log(
      `[sync-mi-health-from-apim] using contract-defaults.json request for ${api.name}:${api.version}: ${defaults.request.path}`
    );
    return normalizeContractRequest(defaults.request);
  }

  if (properties.contract_request_json) {
    return normalizeContractRequest(parseJsonWithFallback(properties.contract_request_json, {}));
  }

  return normalizeContractRequest({
    method: properties.contract_method || properties.health_method || "GET",
    path: properties.contract_path || properties.health_path || "/",
    headers: parseJsonWithFallback(properties.contract_request_headers_json, {}),
    query: parseJsonWithFallback(properties.contract_request_query_json, {}),
    body: parseJsonWithFallback(properties.contract_request_body_json, null)
  });
}



function getContractRequest(api, properties) {
  const override = getContractRequestOverride(api);

  if (override !== undefined) {
    console.log(
      `[sync-mi-health-from-apim] using local contract request override for ${api.name}:${api.version}: ${override.path}`
    );
    return normalizeContractRequest(override);
  }

  const defaults = getContractDefaultConfig(api.name);

  if (defaults.request) {
    console.log(
      `[sync-mi-health-from-apim] using contract-defaults.json request for ${api.name}:${api.version}: ${defaults.request.path}`
    );
    return normalizeContractRequest(defaults.request);
  }

  if (properties.contract_request_json) {
    return normalizeContractRequest(parseJsonWithFallback(properties.contract_request_json, {}));
  }

  return normalizeContractRequest({
    method: properties.contract_method || properties.health_method || "GET",
    path: properties.contract_path || properties.health_path || "/",
    headers: parseJsonWithFallback(properties.contract_request_headers_json, {}),
    query: parseJsonWithFallback(properties.contract_request_query_json, {}),
    body: parseJsonWithFallback(properties.contract_request_body_json, null)
  });
}

function getContractRequest(api, properties) {
  const override = getContractRequestOverride(api);

  if (override !== undefined) {
    console.log(
      `[sync-mi-health-from-apim] using local contract request override for ${api.name}:${api.version}: ${override.path}`
    );
    return normalizeContractRequest(override);
  }

  const defaults = getContractDefaultConfig(api.name);

  if (defaults.request) {
    console.log(
      `[sync-mi-health-from-apim] using contract-defaults.json request for ${api.name}:${api.version}: ${defaults.request.path}`
    );
    return normalizeContractRequest(defaults.request);
  }

  if (properties.contract_request_json) {
    return normalizeContractRequest(parseJsonWithFallback(properties.contract_request_json, {}));
  }

  return normalizeContractRequest({
    method: properties.contract_method || properties.health_method || "GET",
    path: properties.contract_path || properties.health_path || "/",
    headers: parseJsonWithFallback(properties.contract_request_headers_json, {}),
    query: parseJsonWithFallback(properties.contract_request_query_json, {}),
    body: parseJsonWithFallback(properties.contract_request_body_json, null)
  });
}

function renderRequestHeaderProperties(headers = {}) {
  return Object.entries(headers || {})
    .map(([name, value]) => `      <property name="${xmlEscape(name)}" value="${xmlEscape(value)}" scope="transport"/>`)
    .join("\n");
}

function renderRequestPayloadFactory(body) {
  if (body === undefined || body === null) {
    return "";
  }

  return `      <payloadFactory media-type="json">
        <format>${xmlEscape(JSON.stringify(body))}</format>
        <args/>
      </payloadFactory>`;
}


function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slug(value) {
  return String(value || "api")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function propMap(api) {
  const result = {};

  if (api.additionalPropertiesMap && typeof api.additionalPropertiesMap === "object") {
    Object.assign(result, api.additionalPropertiesMap);
  }

  if (Array.isArray(api.additionalProperties)) {
    for (const prop of api.additionalProperties) {
      if (prop && prop.name) {
        result[prop.name] = prop.value;
      }
    }
  }

  return result;
}

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString("base64");
}

function normalizeCriticality(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (raw === "tier 0" || raw === "tier0" || raw === "0" || raw === "t0") {
    return "Tier 0";
  }

  if (raw === "tier 1" || raw === "tier1" || raw === "1" || raw === "t1") {
    return "Tier 1";
  }

  if (raw === "tier 2" || raw === "tier2" || raw === "2" || raw === "t2") {
    return "Tier 2";
  }

  if (raw === "tier 3" || raw === "tier3" || raw === "3" || raw === "t3") {
    return "Tier 3";
  }

  return null;
}

function isDeprecatedLifecycle(lifecycle) {
  const value = String(lifecycle || "").trim().toUpperCase();
  return value === "DEPRECATED" || value === "DEPRECIATED" || value === "RETIRED";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} calling ${url}: ${body}`);
  }

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${body}`);
  }
}

async function registerRestClient() {
  const body = {
    callbackUrl: "www.google.com",
    clientName: `mi-health-sync-${Date.now()}`,
    owner: APIM_USERNAME,
    grantType: "password refresh_token",
    saasApp: true
  };

  const response = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(APIM_USERNAME, APIM_PASSWORD)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.clientId || !response.clientSecret) {
    throw new Error(`DCR response did not include clientId/clientSecret: ${JSON.stringify(response)}`);
  }

  return {
    clientId: response.clientId,
    clientSecret: response.clientSecret
  };
}

async function getAccessToken(clientId, clientSecret, scopes = ["apim:api_view"]) {
  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("username", APIM_USERNAME);
  params.set("password", APIM_PASSWORD);
  params.set("scope", scopes.join(" "));

  const response = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.access_token) {
    throw new Error(`Token response did not include access_token: ${JSON.stringify(response)}`);
  }

  return response.access_token;
}

async function listApis(token) {
  const result = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis?limit=200`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return result.list || [];
}

async function getApi(token, apiId) {
  return requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${apiId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

async function listDevPortalApplications(token) {
  const response = await requestJson(`${APIM_HOST}/api/am/devportal/v3/applications?limit=200`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.list || [];
}

async function findCatalogueApplication(token) {
  const apps = await listDevPortalApplications(token);
  const app = apps.find((item) => item.name === API_CATALOGUE_APP_NAME);

  if (!app) {
    throw new Error(`Developer Portal application not found: ${API_CATALOGUE_APP_NAME}`);
  }

  return app;
}

async function listApplicationSubscriptions(token, applicationId) {
  const subscriptions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await requestJson(
      `${APIM_HOST}/api/am/devportal/v3/subscriptions?applicationId=${encodeURIComponent(applicationId)}&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const page = response.list || [];
    subscriptions.push(...page);

    if (page.length < limit) {
      break;
    }

    offset += limit;
  }

  return subscriptions;
}

function subscriptionIdentityKeys(subscription) {
  const info = subscription.apiInfo || subscription.api || {};
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

function apiIdentityKeys(api) {
  return [
    api.id ? String(api.id) : null,
    api.name && api.version ? `${api.name}:${api.version}` : null
  ].filter(Boolean);
}


function ensureRuntimeDirectory() {
  fs.mkdirSync(path.dirname(API_CATALOGUE_GATEWAY_TOKEN_FILE), { recursive: true });
}

function readGatewayTokenCache() {
  if (!fs.existsSync(API_CATALOGUE_GATEWAY_TOKEN_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(API_CATALOGUE_GATEWAY_TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeGatewayTokenCache(payload) {
  ensureRuntimeDirectory();
  fs.writeFileSync(API_CATALOGUE_GATEWAY_TOKEN_FILE, JSON.stringify(payload, null, 2));
}


function tokenLooksUsable(value) {
  const token = String(value || "").trim();

  if (!token) {
    return false;
  }

  const lowered = token.toLowerCase();

  if (
    lowered === "n/a" ||
    lowered === "na" ||
    lowered === "null" ||
    lowered === "none" ||
    lowered === "undefined"
  ) {
    return false;
  }

  // WSO2 access tokens/JWTs are never 3 characters. This prevents caching
  // placeholder values returned by key generation responses.
  return token.length > 40;
}

function bearerTokenStillValid(cache) {
  const expiresAt = Date.parse(cache?.accessTokenExpiresAt || "");
  return tokenLooksUsable(cache?.accessToken) && Number.isFinite(expiresAt) && expiresAt > Date.now() + 120000;
}

function appCredentialsAvailable(cache) {
  return Boolean(cache?.consumerKey && cache?.consumerSecret);
}

async function devportalGetApplicationKeys(token, applicationId) {
  const urls = [
    `${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(applicationId)}/keys/PRODUCTION`,
    `${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(applicationId)}/oauth-keys/PRODUCTION`
  ];

  for (const url of urls) {
    try {
      return await requestJson(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (e) {
      if (!String(e.message).includes("HTTP 404")) {
        console.warn(`[sync-mi-health-from-apim] Could not read app keys from ${url}: ${e.message}`);
      }
    }
  }

  return null;
}

function normalizeApplicationKeyResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidates = [
    payload,
    payload.keys,
    payload.key,
    payload.production,
    payload.PRODUCTION,
    payload.keyMapping,
    payload.keyDetails,
    payload.applicationKey,
    payload.data
  ].filter(Boolean);

  let consumerKey = null;
  let consumerSecret = null;
  let accessToken = null;
  let validity = 0;

  for (const source of candidates) {
    consumerKey =
      consumerKey ||
      source.consumerKey ||
      source.consumer_key ||
      source.clientId ||
      source.client_id;

    consumerSecret =
      consumerSecret ||
      source.consumerSecret ||
      source.consumer_secret ||
      source.clientSecret ||
      source.client_secret;

    const candidateToken =
      source.accessToken ||
      source.access_token ||
      source.token ||
      source.jwtToken ||
      source.jwt_token;

    if (!accessToken && tokenLooksUsable(candidateToken)) {
      accessToken = candidateToken;
    }

    validity =
      validity ||
      Number(source.validityTime || source.validityPeriod || source.expires_in || 0);
  }

  const secretLooksMasked =
    typeof consumerSecret === "string" &&
    (consumerSecret.includes("*") || consumerSecret.toLowerCase() === "null");

  if (!consumerKey || !consumerSecret || secretLooksMasked) {
    return null;
  }

  const expiresAt =
    accessToken && validity > 0
      ? new Date(Date.now() + validity * 1000).toISOString()
      : accessToken
        ? new Date(Date.now() + API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS * 1000).toISOString()
        : null;

  return {
    consumerKey,
    consumerSecret,
    accessToken,
    accessTokenExpiresAt: expiresAt,
    tokenType: "Bearer",
    raw: payload
  };
}


function extractApplicationKeyMappingId(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidates = [
    payload,
    payload.keys,
    payload.key,
    payload.production,
    payload.PRODUCTION,
    payload.keyMapping,
    payload.keyDetails,
    payload.applicationKey,
    payload.data
  ].filter(Boolean);

  for (const source of candidates) {
    const id =
      source.keyMappingId ||
      source.keyMappingID ||
      source.keyMappingUuid ||
      source.keyMappingUUID ||
      source.id ||
      source.uuid;

    if (id) {
      return id;
    }
  }

  if (Array.isArray(payload.list)) {
    for (const item of payload.list) {
      const id = extractApplicationKeyMappingId(item);
      if (id) {
        return id;
      }
    }
  }

  return null;
}

async function devportalCleanUpApplicationKeys(token, applicationId, keyMappingId) {
  if (!keyMappingId) {
    throw new Error("Cannot clean up application keys because keyMappingId is missing.");
  }

  return requestJson(
    `${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(applicationId)}/oauth-keys/${encodeURIComponent(keyMappingId)}/clean-up`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    }
  );
}

async function devportalGetApplicationKeysRaw(token, applicationId) {
  const urls = [
    `${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(applicationId)}/keys/PRODUCTION`,
    `${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(applicationId)}/oauth-keys/PRODUCTION`
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      return await requestJson(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("Could not read existing application keys.");
}


async function devportalGenerateApplicationKeys(token, applicationId) {
  const payloads = [
    {
      keyType: "PRODUCTION",
      grantTypesToBeSupported: ["client_credentials"],
      callbackUrl: "www.google.com",
      validityTime: API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS,
      scopes: [],
      additionalProperties: []
    },
    {
      keyType: "PRODUCTION",
      keyManager: "Resident Key Manager",
      grantTypesToBeSupported: ["client_credentials"],
      callbackUrl: "www.google.com",
      validityTime: API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS,
      scopes: [],
      additionalProperties: []
    },
    {
      keyType: "PRODUCTION",
      grantTypesToBeSupported: ["client_credentials", "refresh_token"],
      callbackUrl: "www.google.com",
      validityTime: API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS,
      scopes: []
    }
  ];

  let lastError = null;

  for (const body of payloads) {
    try {
      return await requestJson(`${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(applicationId)}/generate-keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("Could not generate application keys.");
}


async function generateCatalogueApplicationToken(devportalToken, applicationId, consumerSecret) {
  if (!consumerSecret) {
    throw new Error("Cannot generate application token because consumerSecret is missing.");
  }

  const payloads = [
    {
      consumerSecret,
      validityPeriod: API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS,
      scopes: []
    },
    {
      consumerSecret,
      validityTime: API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS,
      scopes: []
    },
    {
      consumerSecret,
      validityPeriod: API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS,
      revokeToken: null,
      scopes: []
    }
  ];

  let lastError = null;

  for (const payload of payloads) {
    try {
      const token = await requestJson(
        `${APIM_HOST}/api/am/devportal/v3/applications/${encodeURIComponent(applicationId)}/keys/PRODUCTION/generate-token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${devportalToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        }
      );

      const accessToken =
        token.accessToken ||
        token.access_token ||
        token.token ||
        token.jwtToken ||
        token.jwt_token;

      if (!tokenLooksUsable(accessToken)) {
        throw new Error(`generate-token response did not include a usable access token: ${JSON.stringify(token)}`);
      }

      const validity =
        Number(token.validityTime || token.validityPeriod || token.expires_in || API_CATALOGUE_GATEWAY_TOKEN_VALIDITY_SECONDS);

      return {
        accessToken,
        accessTokenExpiresAt: new Date(Date.now() + validity * 1000).toISOString(),
        tokenType: token.tokenType || token.token_type || "Bearer",
        raw: token
      };
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(`Could not generate API Catalogue Application token through DevPortal generate-token: ${lastError?.message || "unknown error"}`);
}


async function getApplicationAccessToken(consumerKey, consumerSecret) {
  // Kept as a fallback only. In this demo we prefer the DevPortal generate-token
  // endpoint because it is tied directly to the API Catalogue Application keys.
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");

  const token = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(consumerKey, consumerSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!token.access_token) {
    throw new Error(`Application token response did not include access_token: ${JSON.stringify(token)}`);
  }

  return {
    accessToken: token.access_token,
    accessTokenExpiresAt: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(),
    tokenType: token.token_type || "Bearer"
  };
}


function applicationIdOf(app) {
  return app?.applicationId || app?.id || app?.uuid;
}

async function devportalCreateRuntimeApplication(token) {
  const name = `${API_CATALOGUE_RUNTIME_APP_NAME} ${Date.now()}`;

  return requestJson(`${APIM_HOST}/api/am/devportal/v3/applications`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name,
      throttlingPolicy: "Unlimited",
      description: "Runtime application used by the API catalogue demo to invoke subscribed APIs through APIM Gateway.",
      tokenType: "JWT",
      groups: []
    })
  });
}

function subscriptionApiId(subscription) {
  return (
    subscription?.apiId ||
    subscription?.apiInfo?.id ||
    subscription?.api?.id ||
    subscription?.apiUUID ||
    subscription?.apiUuid ||
    null
  );
}

async function subscribeRuntimeApplicationToCatalogueApis(token, runtimeApplicationId, subscriptions) {
  for (const subscription of subscriptions || []) {
    const apiId = subscriptionApiId(subscription);

    if (!apiId) {
      console.warn(`[sync-mi-health-from-apim] Could not mirror subscription because apiId was missing: ${JSON.stringify(subscription)}`);
      continue;
    }

    const throttlingPolicy =
      subscription.throttlingPolicy ||
      subscription.policy ||
      subscription.tier ||
      "Unlimited";

    try {
      await requestJson(`${APIM_HOST}/api/am/devportal/v3/subscriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          apiId,
          applicationId: runtimeApplicationId,
          throttlingPolicy
        })
      });
    } catch (e) {
      const message = String(e.message || "");
      if (!message.includes("409") && !message.includes("already")) {
        throw e;
      }
    }
  }
}

async function createRuntimeApplicationWithMirroredSubscriptions(token, subscriptions) {
  const runtimeApp = await devportalCreateRuntimeApplication(token);
  const runtimeApplicationId = applicationIdOf(runtimeApp);

  if (!runtimeApplicationId) {
    throw new Error(`Runtime application creation response did not include id: ${JSON.stringify(runtimeApp)}`);
  }

  await subscribeRuntimeApplicationToCatalogueApis(token, runtimeApplicationId, subscriptions);

  return {
    id: runtimeApplicationId,
    name: runtimeApp.name || API_CATALOGUE_RUNTIME_APP_NAME
  };
}

async function buildGatewayCredentialsForApplication(token, applicationId, applicationName) {
  let credentials = null;

  try {
    credentials = normalizeApplicationKeyResponse(
      await devportalGenerateApplicationKeys(token, applicationId)
    );
  } catch (e) {
    const message = String(e.message || "");

    if (message.includes("409") || message.includes("Key Mappings already exists")) {
      const existing = normalizeApplicationKeyResponse(
        await devportalGetApplicationKeys(token, applicationId)
      );

      if (existing?.accessToken) {
        credentials = existing;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  if (!credentials) {
    throw new Error(`Could not obtain usable production keys for ${applicationName}.`);
  }

  let appToken = null;
  let tokenSource = "devportal-production-keys-access-token";

  if (
    credentials.accessToken &&
    credentials.accessTokenExpiresAt &&
    Date.parse(credentials.accessTokenExpiresAt) > Date.now() + 120000
  ) {
    appToken = {
      accessToken: credentials.accessToken,
      accessTokenExpiresAt: credentials.accessTokenExpiresAt,
      tokenType: credentials.tokenType || "Bearer"
    };
  } else {
    tokenSource = "devportal-generate-token";
    appToken = await generateCatalogueApplicationToken(
      token,
      applicationId,
      credentials.consumerSecret
    );
  }

  return {
    applicationId,
    applicationName,
    consumerKey: credentials.consumerKey || null,
    consumerSecret: credentials.consumerSecret || null,
    accessToken: appToken.accessToken,
    accessTokenExpiresAt: appToken.accessTokenExpiresAt,
    tokenType: appToken.tokenType || "Bearer",
    tokenSource
  };
}


async function ensureCatalogueApplicationGatewayCredentials(devportalToken, applicationId, subscriptionSnapshot = null) {
  if (!API_CATALOGUE_USE_GATEWAY) {
    return {
      enabled: false,
      reason: "API_CATALOGUE_USE_GATEWAY=false"
    };
  }

  const cached = readGatewayTokenCache();

  if (bearerTokenStillValid(cached)) {
    return {
      enabled: true,
      source: "runtime-cache-access-token",
      applicationId: cached.applicationId,
      applicationName: cached.applicationName || API_CATALOGUE_RUNTIME_APP_NAME,
      consumerKey: cached.consumerKey || null,
      consumerSecret: cached.consumerSecret || null,
      accessToken: cached.accessToken,
      accessTokenExpiresAt: cached.accessTokenExpiresAt
    };
  }

  let credentials = null;

  try {
    credentials = await buildGatewayCredentialsForApplication(
      devportalToken,
      applicationId,
      API_CATALOGUE_APP_NAME
    );
  } catch (e) {
    console.warn(`[sync-mi-health-from-apim] ${API_CATALOGUE_APP_NAME} production keys are not usable: ${e.message}`);
    console.warn(`[sync-mi-health-from-apim] Creating a dedicated runtime application and mirroring catalogue subscriptions.`);

    if (!subscriptionSnapshot?.subscriptions?.length) {
      throw e;
    }

    const runtimeApp = await createRuntimeApplicationWithMirroredSubscriptions(
      devportalToken,
      subscriptionSnapshot.subscriptions
    );

    credentials = await buildGatewayCredentialsForApplication(
      devportalToken,
      runtimeApp.id,
      runtimeApp.name
    );
  }

  const cachePayload = {
    applicationId: credentials.applicationId,
    applicationName: credentials.applicationName,
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    accessToken: credentials.accessToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    tokenType: credentials.tokenType || "Bearer",
    tokenSource: credentials.tokenSource,
    updatedAt: new Date().toISOString()
  };

  writeGatewayTokenCache(cachePayload);

  return {
    enabled: true,
    source: credentials.tokenSource,
    ...cachePayload
  };
}

function joinUrl(base, pathValue) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(pathValue || "").replace(/^\/+/, "")}`;
}

function normalizeGatewayPath(api, pathValue) {
  const context = String(api.context || "").replace(/\/+$/, "");
  const version = String(api.version || "").replace(/^\/+|\/+$/g, "");
  const rawPath = String(pathValue || "/health");
  const normalizedRawPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  if (!context) {
    return normalizedRawPath;
  }

  // In this local APIM 4.7 runtime, the Gateway resolves the deployed API by
  // context + version, for example /accounts/v1/1.0.0.
  const runtimeContext =
    version && !context.endsWith(`/${version}`)
      ? `${context}/${version}`
      : context;

  if (
    normalizedRawPath === runtimeContext ||
    normalizedRawPath.startsWith(`${runtimeContext}/`)
  ) {
    return normalizedRawPath;
  }

  // Contract defaults currently store public paths such as:
  // /accounts/v1/accounts/CUST-BR-002
  // Convert them to Gateway runtime paths:
  // /accounts/v1/1.0.0/accounts/CUST-BR-002
  if (normalizedRawPath === context) {
    return runtimeContext;
  }

  if (normalizedRawPath.startsWith(`${context}/`)) {
    return `${runtimeContext}${normalizedRawPath.slice(context.length)}`;
  }

  return `${runtimeContext}/${normalizedRawPath.replace(/^\/+/, "")}`;
}

function gatewayUrlForApiPath(api, pathValue, browser = false) {
  const base = browser ? APIM_GATEWAY_BROWSER_BASE_URL : APIM_GATEWAY_INTERNAL_BASE_URL;
  return joinUrl(base, normalizeGatewayPath(api, pathValue));
}

function gatewayHeaders(gatewayAuth, existingHeaders = {}) {
  if (!gatewayAuth?.enabled || !gatewayAuth.accessToken) {
    return existingHeaders || {};
  }

  return {
    ...(existingHeaders || {}),
    Authorization: `Bearer ${gatewayAuth.accessToken}`
  };
}

async function getCatalogueApplicationSubscriptionSnapshot(token) {
  const application = await findCatalogueApplication(token);
  const applicationId = application.applicationId || application.id;

  if (!applicationId) {
    throw new Error(`Could not determine applicationId for ${API_CATALOGUE_APP_NAME}`);
  }

  const subscriptions = await listApplicationSubscriptions(token, applicationId);
  const subscribedApiKeys = new Set();

  for (const subscription of subscriptions) {
    for (const key of subscriptionIdentityKeys(subscription)) {
      subscribedApiKeys.add(key);
    }
  }

  return {
    application: {
      id: applicationId,
      name: application.name
    },
    subscriptions,
    subscribedApiKeys
  };
}

function isSubscribedToCatalogueApplication(api, snapshot) {
  return apiIdentityKeys(api).some((key) => snapshot.subscribedApiKeys.has(key));
}

function pendingSubscribedResult(record) {
  const now = new Date().toISOString();

  return {
    apiId: record.apiId,
    name: record.name,
    version: record.version,
    context: record.context,
    domain: record.domain,
    owner: record.owner,
    runtime: record.runtime,
    criticality: record.criticality,
    slaTarget: record.slaTarget,
    lifecycle: record.lifecycle,
    checkFrequency: record.probePolicy.frequency,
    checkedAt: null,
    healthUrl: record.healthStrategy ? (record.healthStrategy.healthBrowserUrl || record.healthStrategy.healthUrl || record.healthStrategy.url) : null,
    healthBrowserUrl: record.healthStrategy ? record.healthStrategy.healthBrowserUrl : null,
    healthInternalUrl: record.healthStrategy ? record.healthStrategy.healthUrl : null,
    invocationMode: (typeof record !== "undefined" && record?.invocationMode) ? record.invocationMode : "UNKNOWN",
    liveness: {
      status: record.probePolicy.active ? "PENDING" : "SKIPPED",
      httpStatus: null,
      latencyMs: null,
      checkedAt: null
    },
    contract: {
      status: record.probePolicy.active ? "PENDING" : "SKIPPED",
      reasons: [record.probePolicy.reason || "Waiting for MI health probe."]
    },
    sla: {
      status: "PENDING",
      target: record.slaTarget,
      window: "demo"
    },
    probePolicy: record.probePolicy,
    consumerStatus: record.probePolicy.active ? "UNKNOWN" : "UNKNOWN",
    reason: record.probePolicy.reason || "Subscribed in API Catalogue Application; waiting for MI health status.",
    source: "wso2-api-manager-devportal",
    sourceOfTruth: "wso2-api-manager",
    invocationMode: (typeof record !== "undefined" && record?.invocationMode) ? record.invocationMode : "UNKNOWN",
    subscriptionApplication: API_CATALOGUE_APP_NAME,
    registrySyncedAt: now
  };
}

async function syncStatusCacheCatalogueMembership(records) {
  const placeholders = records.map((record) => {
    if (!record.probePolicy.active) {
      return lifecycleControlledResult(record);
    }

    return pendingSubscribedResult(record);
  });

  try {
    await requestJson(`${STATUS_CACHE_BASE_URL}/cache/catalogue-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(placeholders)
    });

    console.log(
      `[sync-mi-health-from-apim] synced health-status-cache catalogue membership with ${placeholders.length} subscribed APIs`
    );
  } catch (e) {
    console.warn(
      `[sync-mi-health-from-apim] could not sync cache catalogue membership: ${e.message}`
    );
  }
}



function ownerFromApiDetails(api, p) {
  const business = api.businessInformation || {};

  return {
    team:
      p.health_owner_team ||
      p.owner_team ||
      business.technicalOwner ||
      business.businessOwner ||
      api.provider ||
      api.createdBy ||
      "Unknown",
    email:
      p.health_owner_email ||
      p.owner_email ||
      business.technicalOwnerEmail ||
      business.businessOwnerEmail ||
      "unknown@example.com"
  };
}

function buildRegistryRecord(api, gatewayAuth = null) {
  const p = propMap(api);
  const lifecycle = api.lifeCycleStatus || api.status || "UNKNOWN";
  const deprecated = isDeprecatedLifecycle(lifecycle);
  const enabled = String(p.health_enabled || "").toLowerCase() === "true";

  const criticalityRaw = p.health_criticality || "Tier 2";
  const normalizedCriticality = normalizeCriticality(criticalityRaw);
  const tierConfig = normalizedCriticality ? TIER_CONFIG[normalizedCriticality] : TIER_CONFIG["Tier 2"];

  const backendUrl = p.health_backend_url;
  const healthPath = p.health_path || "/health";
  const hasProbeMetadata = Boolean(enabled && backendUrl && healthPath && normalizedCriticality);
  const activeProbe = hasProbeMetadata && !deprecated;

  let healthStrategy = null;

  if (activeProbe) {
    const expectedPayloadRaw = getExpectedPayloadRaw(api, p);
    let expectedPayload = {};

    try {
      expectedPayload = JSON.parse(expectedPayloadRaw);
    } catch (e) {
      throw new Error(`Invalid health_expected_payload_json for API ${api.name}:${api.version}: ${expectedPayloadRaw}`);
    }

    const contractDefaultsForValidation = getContractDefaultConfig(api.name);
    const contractRequiredFieldsFromDefaults = Array.isArray(contractDefaultsForValidation.requiredFields)
      ? contractDefaultsForValidation.requiredFields.join(",")
      : "";

    const requiredFields = String(
      p.contract_required_fields || contractRequiredFieldsFromDefaults || "traceId,service,timestamp,data"
    )
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    const contractRequest = getContractRequest(api, p);
    const contractPath = contractRequest.path || healthPath;

    const directBackendUrl = appendQueryToUrl(
      `${String(backendUrl).replace(/\/+$/, "")}${contractPath}`,
      contractRequest.query
    );

    const gatewayInternalUrl = appendQueryToUrl(
      gatewayUrlForApiPath(api, contractPath, false),
      contractRequest.query
    );

    const gatewayBrowserHealthUrl = gatewayUrlForApiPath(api, healthPath, true);
    const gatewayInternalHealthUrl = gatewayUrlForApiPath(api, healthPath, false);

    const useGateway = Boolean(gatewayAuth?.enabled && gatewayAuth.accessToken);

    healthStrategy = {
      type: useGateway ? "APIM_GATEWAY_HEALTH_CONTRACT" : "HTTP_HEALTH_CONTRACT",
      method: contractRequest.method || p.contract_method || p.health_method || "GET",
      url: useGateway ? gatewayInternalUrl : directBackendUrl,
      expectedHttpStatus: Number(
        contractDefaultsForValidation.expectedHttpStatus ||
          p.contract_expected_http_status ||
          p.health_expected_http_status ||
          200
      ),
      request: {
        ...contractRequest,
        path: normalizeGatewayPath(api, contractPath)
      },
      requestHeaders: gatewayHeaders(gatewayAuth, contractRequest.headers || {}),
      requestBody: Object.prototype.hasOwnProperty.call(contractRequest, "body") ? contractRequest.body : null,
      expectedPayload,
      requiredFields,
      timeoutMs: Number(p.health_timeout_ms || 3000),
      invocationMode: useGateway ? "APIM_GATEWAY" : "DIRECT_BACKEND",
      gateway: useGateway
        ? {
            application: gatewayAuth.applicationName || API_CATALOGUE_APP_NAME,
            baseUrl: APIM_GATEWAY_INTERNAL_BASE_URL,
            browserBaseUrl: APIM_GATEWAY_BROWSER_BASE_URL,
            tokenExpiresAt: gatewayAuth.accessTokenExpiresAt,
            validatesSubscription: true
          }
        : null,
      directBackendUrl,
      healthPath,
      healthUrl: useGateway ? gatewayInternalHealthUrl : `${String(backendUrl).replace(/\/+$/, "")}${healthPath}`,
      healthBrowserUrl: useGateway ? gatewayBrowserHealthUrl : `${String(backendUrl).replace(/\/+$/, "")}${healthPath}`
    };
  }

  const inactiveReason = deprecated
    ? "API lifecycle is deprecated. No active probe is scheduled; status is lifecycle-controlled."
    : enabled
      ? "API is subscribed, but required health metadata is incomplete. Add health_backend_url, health_path and valid health_criticality to enable MI evaluation."
      : "API is subscribed to API Catalogue Application but health_enabled is not true. It appears in the catalogue but is not actively probed.";

  return {
    apiId: api.id,
    name: api.name,
    displayName: api.displayName || api.name,
    version: api.version,
    context: api.context,
    domain: p.health_domain || "Unclassified",
    owner: ownerFromApiDetails ? ownerFromApiDetails(api, p) : {
      team: p.health_owner_team || "Unknown",
      email: p.health_owner_email || "unknown@example.com"
    },
    criticality: normalizedCriticality || criticalityRaw || "Tier 2",
    slaTarget: p.health_sla_target || "99.50%",
    runtime: p.health_runtime || "Unknown",
    lifecycle,
    gatewayUrl: gatewayAuth?.enabled ? APIM_GATEWAY_INTERNAL_BASE_URL : (p.health_gateway_url || ""),
    gatewayBrowserUrl: gatewayAuth?.enabled ? APIM_GATEWAY_BROWSER_BASE_URL : "",
    invocationMode: gatewayAuth?.enabled ? "APIM_GATEWAY" : "DIRECT_BACKEND",
    healthStrategy,
    probePolicy: {
      active: activeProbe,
      tier: activeProbe && tierConfig ? tierConfig.key : null,
      frequency: activeProbe && tierConfig ? tierConfig.frequencyLabel : "none",
      intervalSeconds: activeProbe && tierConfig ? tierConfig.intervalSeconds : null,
      reason: activeProbe
        ? gatewayAuth?.enabled
          ? "Active probe schedule derived from APIM health_criticality. Invocation goes through APIM Gateway using API Catalogue Application token."
          : "Active probe schedule derived from APIM health_criticality."
        : inactiveReason
    },
    subscriptionApplication: API_CATALOGUE_APP_NAME
  };
}

function renderCheckSequence(record, sequenceName) {
  const expectedPayloadJson = JSON.stringify(record.healthStrategy.expectedPayload);
  const requiredFieldsCsv = record.healthStrategy.requiredFields.join(",");
  const requestHeadersXml = renderRequestHeaderProperties(record.healthStrategy.requestHeaders || {});
  const requestBodyXml = renderRequestPayloadFactory(record.healthStrategy.requestBody);
  const requestJson = JSON.stringify(record.healthStrategy.request || {});
  const requestHeadersJson = JSON.stringify(record.healthStrategy.requestHeaders || {});
  const requestBodyJson = JSON.stringify(
    Object.prototype.hasOwnProperty.call(record.healthStrategy, "requestBody")
      ? record.healthStrategy.requestBody
      : null
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<sequence xmlns="http://ws.apache.org/ns/synapse" name="${xmlEscape(sequenceName)}">
    <property name="apiId" value="${xmlEscape(record.apiId)}" type="STRING"/>
    <property name="apiName" value="${xmlEscape(record.name)}" type="STRING"/>
    <property name="apiVersion" value="${xmlEscape(record.version)}" type="STRING"/>
    <property name="apiDomain" value="${xmlEscape(record.domain)}" type="STRING"/>
    <property name="ownerTeam" value="${xmlEscape(record.owner.team)}" type="STRING"/>
    <property name="ownerEmail" value="${xmlEscape(record.owner.email)}" type="STRING"/>
    <property name="criticality" value="${xmlEscape(record.criticality)}" type="STRING"/>
    <property name="slaTarget" value="${xmlEscape(record.slaTarget)}" type="STRING"/>
    <property name="runtime" value="${xmlEscape(record.runtime)}" type="STRING"/>
    <property name="lifecycle" value="${xmlEscape(record.lifecycle)}" type="STRING"/>
    <property name="gatewayUrl" value="${xmlEscape(record.gatewayUrl)}" type="STRING"/>
    <property name="healthUrl" value="${xmlEscape(record.healthStrategy.url)}" type="STRING"/>
    <property name="probeTier" value="${xmlEscape(record.probePolicy.tier)}" type="STRING"/>
    <property name="checkFrequency" value="${xmlEscape(record.probePolicy.frequency)}" type="STRING"/>
    <property name="expectedHttpStatus" value="${xmlEscape(record.healthStrategy.expectedHttpStatus)}" type="STRING"/>
    <property name="expectedPayloadJson" value="${xmlEscape(expectedPayloadJson)}" type="STRING"/>
    <property name="requiredFields" value="${xmlEscape(requiredFieldsCsv)}" type="STRING"/>

    <script language="js"><![CDATA[
        mc.setProperty("probeStartedAt", String(new Date().getTime()));
    ]]></script>

    <property name="REST_URL_POSTFIX" scope="axis2" action="remove"/>
    <property name="non.error.http.status.codes" value="400,401,403,404,500,502,503,504" scope="axis2" type="STRING"/>
${requestHeadersXml}
${requestBodyXml}

    <call blocking="true">
        <endpoint>
            <http method="${xmlEscape(record.healthStrategy.method)}" uri-template="${xmlEscape(record.healthStrategy.url)}">
                <timeout>
                    <duration>${xmlEscape(record.healthStrategy.timeoutMs)}</duration>
                    <responseAction>fault</responseAction>
                </timeout>
                <suspendOnFailure>
                    <errorCodes>-1</errorCodes>
                    <initialDuration>0</initialDuration>
                    <progressionFactor>1.0</progressionFactor>
                    <maximumDuration>0</maximumDuration>
                </suspendOnFailure>
                <markForSuspension>
                    <errorCodes>-1</errorCodes>
                    <retriesBeforeSuspension>0</retriesBeforeSuspension>
                </markForSuspension>
            </http>
        </endpoint>
    </call>

    <property name="healthHttpStatus" expression="get-property('axis2','HTTP_SC')" type="STRING"/>

    <script language="js"><![CDATA[
        var payload = {};
        try {
            payload = mc.getPayloadJSON();
        } catch (e) {
            payload = {};
        }

        var nowMs = new Date().getTime();
        var startedAt = parseInt(String(mc.getProperty("probeStartedAt") || nowMs), 10);
        var latencyMs = nowMs - startedAt;

        var httpStatus = parseInt(String(mc.getProperty("healthHttpStatus") || "0"), 10);
        var expectedHttpStatus = parseInt(String(mc.getProperty("expectedHttpStatus") || "200"), 10);

        var expectedPayload = {};
        try {
            expectedPayload = JSON.parse(String(mc.getProperty("expectedPayloadJson") || "{}"));
        } catch (e) {
            expectedPayload = {};
        }

        var requiredFieldsRaw = String(mc.getProperty("requiredFields") || "");
        var requiredFields = requiredFieldsRaw.length > 0 ? requiredFieldsRaw.split(",") : [];

        var reasons = [];

        var contractRequestForCorrelation = ${requestJson};

        function collectCustomerIdsForContractCorrelation(value, ids) {
            if (value === null || value === undefined) {
                return;
            }

            if (Array.isArray(value)) {
                for (var ci = 0; ci < value.length; ci++) {
                    collectCustomerIdsForContractCorrelation(value[ci], ids);
                }
                return;
            }

            if (typeof value === "object") {
                if (
                    Object.prototype.hasOwnProperty.call(value, "customerId") &&
                    value.customerId !== null &&
                    value.customerId !== undefined &&
                    String(value.customerId).length > 0
                ) {
                    ids.push(String(value.customerId));
                }

                var keysForCorrelation = Object.keys(value);
                for (var ck = 0; ck < keysForCorrelation.length; ck++) {
                    collectCustomerIdsForContractCorrelation(value[keysForCorrelation[ck]], ids);
                }
            }
        }

        function uniqueValues(values) {
            var seen = {};
            var result = [];

            for (var uv = 0; uv < values.length; uv++) {
                var item = String(values[uv]);

                if (!seen[item]) {
                    seen[item] = true;
                    result.push(item);
                }
            }

            return result;
        }

        var requestedCustomerId = null;
        var requestPathForCorrelation = String(
            contractRequestForCorrelation && contractRequestForCorrelation.path
                ? contractRequestForCorrelation.path
                : ""
        );

        var customerMatch = requestPathForCorrelation.match(/(CUST-[A-Z]{2}-[0-9]+)/);
        if (customerMatch && customerMatch[1]) {
            requestedCustomerId = customerMatch[1];
        }

        if (requestedCustomerId !== null) {
            var expectedCustomerIds = [];
            var actualCustomerIds = [];

            collectCustomerIdsForContractCorrelation(expectedPayload, expectedCustomerIds);
            collectCustomerIdsForContractCorrelation(payload, actualCustomerIds);

            expectedCustomerIds = uniqueValues(expectedCustomerIds);
            actualCustomerIds = uniqueValues(actualCustomerIds);

            for (var eci = 0; eci < expectedCustomerIds.length; eci++) {
                if (expectedCustomerIds[eci] !== requestedCustomerId) {
                    expectedPayloadOk = false;
                    reasons.push(
                        "Expected payload customerId '" +
                        expectedCustomerIds[eci] +
                        "' does not match request customerId '" +
                        requestedCustomerId +
                        "'"
                    );
                }
            }

            for (var aci = 0; aci < actualCustomerIds.length; aci++) {
                if (actualCustomerIds[aci] !== requestedCustomerId) {
                    expectedPayloadOk = false;
                    reasons.push(
                        "Actual payload customerId '" +
                        actualCustomerIds[aci] +
                        "' does not match request customerId '" +
                        requestedCustomerId +
                        "'"
                    );
                }
            }
        }


        var livenessOk = httpStatus === expectedHttpStatus;
        var expectedPayloadOk = true;
        var requiredFieldsOk = true;

        function isPlainObject(value) {
            return value !== null && typeof value === "object" && !Array.isArray(value);
        }

        function formatValue(value) {
            if (value === undefined) {
                return "";
            }

            if (value === null) {
                return "null";
            }

            if (typeof value === "object") {
                try {
                    return JSON.stringify(value);
                } catch (e) {
                    return String(value);
                }
            }

            return String(value);
        }

        function compareLeafFields(path, actual, expected, mismatches) {
            if (Array.isArray(expected)) {
                if (!Array.isArray(actual)) {
                    mismatches.push(
                        "Expected payload field '" + path + "' to be an array but got '" +
                        formatValue(actual) + "'"
                    );
                    return;
                }

                for (var i = 0; i < expected.length; i++) {
                    var expectedItem = expected[i];

                    if (isPlainObject(expectedItem)) {
                        var matched = false;
                        var bestMismatch = null;

                        for (var j = 0; j < actual.length; j++) {
                            var trial = [];
                            compareLeafFields(path + "[" + i + "]", actual[j], expectedItem, trial);

                            if (trial.length === 0) {
                                matched = true;
                                break;
                            }

                            if (bestMismatch === null || trial.length < bestMismatch.length) {
                                bestMismatch = trial;
                            }
                        }

                        if (!matched) {
                            mismatches.push(
                                "No item in actual array matched expected payload object at '" +
                                path + "[" + i + "]'"
                            );

                            if (bestMismatch && bestMismatch.length > 0) {
                                mismatches.push(bestMismatch[0]);
                            }
                        }
                    } else {
                        compareLeafFields(path + "[" + i + "]", actual[i], expectedItem, mismatches);
                    }
                }

                return;
            }

            if (isPlainObject(expected)) {
                if (!isPlainObject(actual)) {
                    mismatches.push(
                        "Expected payload field '" + path + "' to be an object but got '" +
                        formatValue(actual) + "'"
                    );
                    return;
                }

                var keys = Object.keys(expected);

                for (var k = 0; k < keys.length; k++) {
                    var nestedKey = keys[k];
                    var nextPath = path ? path + "." + nestedKey : nestedKey;
                    compareLeafFields(nextPath, actual[nestedKey], expected[nestedKey], mismatches);
                }

                return;
            }

            if (String(actual) !== String(expected)) {
                mismatches.push(
                    "Expected payload field '" + path + "' to be '" +
                    formatValue(expected) + "' but got '" + formatValue(actual) + "'"
                );
            }
        }

        var payloadMismatches = [];
        compareLeafFields("", payload, expectedPayload, payloadMismatches);

        if (payloadMismatches.length > 0) {
            expectedPayloadOk = false;
            for (var pm = 0; pm < payloadMismatches.length; pm++) {
                reasons.push(payloadMismatches[pm]);
            }
        }

        for (var requiredIndex = 0; requiredIndex < requiredFields.length; requiredIndex++) {
            var field = String(requiredFields[requiredIndex]).trim();

            if (
                field.length > 0 &&
                (
                    !payload ||
                    payload[field] === undefined ||
                    payload[field] === null ||
                    payload[field] === ""
                )
            ) {
                requiredFieldsOk = false;
                reasons.push("Required payload field is missing: " + field);
            }
        }

        var contractOk = livenessOk && expectedPayloadOk && requiredFieldsOk;

        var livenessStatus = livenessOk ? "OK" : "FAILED";
        var contractStatus = livenessOk ? (contractOk ? "OK" : "FAILED") : "SKIPPED";

        var consumerStatus = "RED";
        var reason = "Unexpected HTTP status from backend health endpoint";

        if (livenessOk && contractOk) {
            consumerStatus = "GREEN";
            reason = "OK";
        } else if (livenessOk && !contractOk) {
            consumerStatus = "YELLOW";
            reason = "Backend returned expected HTTP status but payload did not match expected health contract";
        }

        var result = {
            apiId: String(mc.getProperty("apiId")),
            name: String(mc.getProperty("apiName")),
            version: String(mc.getProperty("apiVersion")),
            domain: String(mc.getProperty("apiDomain")),
            owner: {
                team: String(mc.getProperty("ownerTeam")),
                email: String(mc.getProperty("ownerEmail"))
            },
            runtime: String(mc.getProperty("runtime")),
            criticality: String(mc.getProperty("criticality")),
            slaTarget: String(mc.getProperty("slaTarget")),
            lifecycle: String(mc.getProperty("lifecycle")),
            checkFrequency: String(mc.getProperty("checkFrequency")),
            checkedAt: new Date().toISOString(),
            healthUrl: String(mc.getProperty("healthUrl")),
            liveness: {
                status: livenessStatus,
                httpStatus: httpStatus,
                expectedHttpStatus: expectedHttpStatus,
                latencyMs: latencyMs
            },
            contract: {
                status: contractStatus,
                reasons: reasons,
                request: ${requestJson},
      requestHeaders: ${requestHeadersJson},
      requestBody: ${requestBodyJson},
      expectedPayload,
                requiredFields: requiredFields,
                actualPayload: payload
            },
            sla: {
                status: consumerStatus === "GREEN" ? "WITHIN_TARGET" : "AT_RISK",
                target: String(mc.getProperty("slaTarget")),
                window: "demo"
            },
            probePolicy: {
                active: true,
                tier: String(mc.getProperty("probeTier")),
                frequency: String(mc.getProperty("checkFrequency"))
            },
            consumerStatus: consumerStatus,
            reason: reason,
            source: "wso2-integrator-mi",
            sourceOfTruth: "wso2-api-manager"
        };

        mc.setProperty("lastHealthResult", JSON.stringify(result));
    ]]></script>

    <payloadFactory media-type="json">
        <format>$1</format>
        <args>
            <arg evaluator="xml" expression="$ctx:lastHealthResult" literal="false"/>
        </args>
    </payloadFactory>

    <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
    <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
    <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
    <property name="REST_URL_POSTFIX" scope="axis2" action="remove"/>
    <property name="non.error.http.status.codes" value="200,201,202,204,400,409,500,502,503,504" scope="axis2" type="STRING"/>

    <call blocking="true">
        <endpoint>
            <http method="POST" uri-template="${xmlEscape(STATUS_CACHE_BASE_URL)}/cache/results"/>
        </endpoint>
    </call>
</sequence>
`;
}

function lifecycleControlledResult(record) {
  const deprecated = isDeprecatedLifecycle(record.lifecycle);
  const status = deprecated ? "DEPRECATED" : "UNKNOWN";
  const reason = record.probePolicy && record.probePolicy.reason
    ? record.probePolicy.reason
    : "No active health probe is scheduled.";

  return {
    apiId: record.apiId,
    name: record.name,
    version: record.version,
    context: record.context,
    domain: record.domain,
    owner: record.owner,
    runtime: record.runtime,
    criticality: record.criticality,
    slaTarget: record.slaTarget,
    lifecycle: record.lifecycle,
    checkFrequency: "none",
    checkedAt: null,
    healthUrl: null,
    liveness: {
      status: "SKIPPED",
      httpStatus: null,
      latencyMs: null
    },
    contract: {
      status: "SKIPPED",
      reasons: [reason]
    },
    sla: {
      status: deprecated ? "LIFECYCLE_CONTROLLED" : "PENDING",
      target: record.slaTarget,
      window: "demo"
    },
    probePolicy: record.probePolicy,
    consumerStatus: status,
    reason,
    source: "wso2-api-manager-devportal",
    sourceOfTruth: "wso2-api-manager",
    invocationMode: (typeof record !== "undefined" && record?.invocationMode) ? record.invocationMode : "UNKNOWN",
    subscriptionApplication: API_CATALOGUE_APP_NAME
  };
}

function renderRunSequence(sequenceName, activeRecords, lifecycleControlledRecords = []) {
  const calls = activeRecords
    .map((record, index) => {
      const propName = `result_${index}`;
      return `    <sequence key="${xmlEscape(record.sequenceName)}"/>
    <property name="${xmlEscape(propName)}" expression="get-property('lastHealthResult')" type="STRING"/>`;
    })
    .join("\n\n");

  const keys = activeRecords.map((_, index) => `result_${index}`);
  const lifecycleControlled = lifecycleControlledRecords.map(lifecycleControlledResult);

  return `<?xml version="1.0" encoding="UTF-8"?>
<sequence xmlns="http://ws.apache.org/ns/synapse" name="${xmlEscape(sequenceName)}">
${calls}

    <script language="js"><![CDATA[
        var keys = ${JSON.stringify(keys)};
        var lifecycleControlled = ${JSON.stringify(lifecycleControlled)};
        var results = [];

        for (var i = 0; i < keys.length; i++) {
            var raw = mc.getProperty(keys[i]);

            if (raw !== null && raw !== undefined && String(raw).length > 0) {
                try {
                    results.push(JSON.parse(String(raw)));
                } catch (e) {
                    results.push({
                        apiId: keys[i],
                        name: keys[i],
                        checkedAt: new Date().toISOString(),
                        consumerStatus: "UNKNOWN",
                        liveness: {
                            status: "UNKNOWN"
                        },
                        contract: {
                            status: "UNKNOWN"
                        },
                        sla: {
                            status: "UNKNOWN"
                        },
                        reason: "Unable to parse health result in " + "${xmlEscape(sequenceName)}" + ": " + e.message,
                        source: "wso2-integrator-mi",
                        sourceOfTruth: "wso2-api-manager"
                    });
                }
            }
        }

        for (var j = 0; j < lifecycleControlled.length; j++) {
            lifecycleControlled[j].checkedAt = new Date().toISOString();
            results.push(lifecycleControlled[j]);
        }

        mc.setProperty("healthResultsJson", JSON.stringify(results));
    ]]></script>

    <payloadFactory media-type="json">
        <format>$1</format>
        <args>
            <arg evaluator="xml" expression="$ctx:healthResultsJson" literal="false"/>
        </args>
    </payloadFactory>

    <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
    <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
    <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
    <property name="REST_URL_POSTFIX" scope="axis2" action="remove"/>
    <property name="non.error.http.status.codes" value="200,201,202,204,400,409,500,502,503,504" scope="axis2" type="STRING"/>

    <call blocking="true">
        <endpoint>
            <http method="POST" uri-template="${xmlEscape(STATUS_CACHE_BASE_URL)}/cache/results"/>
        </endpoint>
    </call>

    <payloadFactory media-type="json">
        <format>$1</format>
        <args>
            <arg evaluator="xml" expression="$ctx:healthResultsJson" literal="false"/>
        </args>
    </payloadFactory>

    <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
    <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
    <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
</sequence>
`;
}

function renderScheduledTask(taskConfig) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<task xmlns="http://ws.apache.org/ns/synapse"
      name="${xmlEscape(taskConfig.taskName)}"
      class="org.apache.synapse.startup.tasks.MessageInjector"
      group="synapse.simple.quartz">

    <trigger interval="${xmlEscape(taskConfig.intervalSeconds)}"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="injectTo"
              value="sequence"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="sequenceName"
              value="${xmlEscape(taskConfig.sequenceName)}"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="sequential"
              value="true"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="message">
        <healthCheckTrigger xmlns="">
            <source>scheduled-task</source>
            <tier>${xmlEscape(taskConfig.key)}</tier>
            <frequency>${xmlEscape(taskConfig.frequencyLabel)}</frequency>
            <intervalSeconds>${xmlEscape(taskConfig.intervalSeconds)}</intervalSeconds>
        </healthCheckTrigger>
    </property>
</task>
`;
}

function renderHealthRegistryApi(records) {
  const registryJson = JSON.stringify(records, null, 2);

  return `<?xml version="1.0" encoding="UTF-8"?>
<api xmlns="http://ws.apache.org/ns/synapse" name="HealthRegistryAPI" context="/health-registry">
    <resource methods="GET" uri-template="/v1/apis">
        <inSequence>
            <payloadFactory media-type="json">
                <format><![CDATA[${registryJson}]]></format>
            </payloadFactory>
            <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
            <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
            <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
            <respond/>
        </inSequence>
    </resource>

    <resource methods="POST" uri-template="/v1/probes/run">
    <inSequence>
      <log level="custom">
        <property name="health-registry" value="Manual full probe execution requested"/>
      </log>
      <sequence key="run_all_health_checks"/>
      <payloadFactory media-type="json">
        <format>{"status":"COMPLETED","message":"Manual full probe execution completed","source":"health-registry-api"}</format>
        <args/>
      </payloadFactory>
      <property name="HTTP_SC" value="200" scope="axis2"/>
      <respond/>
    </inSequence>
    <faultSequence>
      <payloadFactory media-type="json">
        <format>{"status":"ERROR","message":"Manual full probe execution failed"}</format>
        <args/>
      </payloadFactory>
      <property name="HTTP_SC" value="500" scope="axis2"/>
      <respond/>
    </faultSequence>
  </resource>

    <resource methods="POST" uri-template="/v1/apis">
        <inSequence>
            <payloadFactory media-type="json">
                <format>{
                    "message": "Direct registration is disabled. API Manager is the source of truth.",
                    "expectedFlow": "Add or update health_* custom properties in WSO2 API Manager and run the APIM-to-MI sync pipeline."
                }</format>
            </payloadFactory>
            <property name="HTTP_SC" value="409" scope="axis2" type="STRING"/>
            <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
            <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
            <respond/>
        </inSequence>
    </resource>
</api>
`;
}

function cleanGeneratedFiles() {
  fs.mkdirSync(API_DIR, { recursive: true });
  fs.mkdirSync(SEQUENCE_DIR, { recursive: true });
  fs.mkdirSync(TASK_DIR, { recursive: true });

  for (const file of fs.readdirSync(SEQUENCE_DIR)) {
    if (
      file.startsWith("check_") ||
      file === "run_all_health_checks.xml" ||
      /^run_tier[0-3]_health_checks\.xml$/.test(file)
    ) {
      fs.unlinkSync(path.join(SEQUENCE_DIR, file));
    }
  }

  for (const file of fs.readdirSync(TASK_DIR)) {
    if (
      file === "scheduled_health_check.xml" ||
      /^scheduled_tier[0-3]_health_check\.xml$/.test(file)
    ) {
      fs.unlinkSync(path.join(TASK_DIR, file));
    }
  }

  const healthRegistryPath = path.join(API_DIR, "health_registry_api.xml");
  if (fs.existsSync(healthRegistryPath)) {
    fs.unlinkSync(healthRegistryPath);
  }
}

function groupActiveRecordsByTier(records) {
  const groups = {
    tier0: [],
    tier1: [],
    tier2: [],
    tier3: []
  };

  for (const record of records) {
    if (!record.probePolicy.active) {
      continue;
    }

    if (!groups[record.probePolicy.tier]) {
      throw new Error(`Unsupported probe tier for API ${record.name}: ${record.probePolicy.tier}`);
    }

    groups[record.probePolicy.tier].push(record);
  }

  return groups;
}

async function main() {
  console.log(`[sync-mi-health-from-apim] APIM_HOST=${APIM_HOST}`);
  console.log(`[sync-mi-health-from-apim] ARTIFACTS_ROOT=${ARTIFACTS_ROOT}`);
  console.log(`[sync-mi-health-from-apim] STATUS_CACHE_BASE_URL=${STATUS_CACHE_BASE_URL}`);
  console.log(`[sync-mi-health-from-apim] API_CATALOGUE_APP_NAME=${API_CATALOGUE_APP_NAME}`);

  const client = await registerRestClient();
  const token = await getAccessToken(client.clientId, client.clientSecret, [
    "apim:api_view",
    "apim:subscribe",
    "apim:app_manage",
    "apim:sub_manage"
  ]);

  const subscriptionSnapshot = await getCatalogueApplicationSubscriptionSnapshot(token);

  const gatewayAuth = await ensureCatalogueApplicationGatewayCredentials(
    token,
    subscriptionSnapshot.application.id,
    subscriptionSnapshot
  );

  console.log(
    `[sync-mi-health-from-apim] ${subscriptionSnapshot.application.name} has ${subscriptionSnapshot.subscriptions.length} subscribed APIs`
  );

  console.log(
    `[sync-mi-health-from-apim] Invocation mode=${gatewayAuth.enabled ? "APIM_GATEWAY" : "DIRECT_BACKEND"}${gatewayAuth.enabled ? `; token expires at ${gatewayAuth.accessTokenExpiresAt}` : ""}`
  );

  const apiSummaries = await listApis(token);
  const fullApis = [];

  for (const summary of apiSummaries) {
    if (!summary.id) {
      continue;
    }

    const api = await getApi(token, summary.id);
    fullApis.push(api);
  }

  const subscribedApis = fullApis.filter((api) => isSubscribedToCatalogueApplication(api, subscriptionSnapshot));

  console.log(
    `[sync-mi-health-from-apim] Publisher APIs=${fullApis.length}; subscribed catalogue APIs=${subscribedApis.length}`
  );

  const records = subscribedApis
    .map((api) => buildRegistryRecord(api, gatewayAuth))
    .filter(Boolean)
    .map((record) => {
      if (!record.probePolicy.active) {
        return record;
      }

      return {
        ...record,
        sequenceName: `check_${slug(record.name)}_${slug(record.version)}`
      };
    });

  const activeRecords = records.filter((record) => record.probePolicy.active);
  const lifecycleControlledRecords = records.filter((record) => !record.probePolicy.active);
  const tierGroups = groupActiveRecordsByTier(records);

  cleanGeneratedFiles();

  for (const record of activeRecords) {
    const filePath = path.join(SEQUENCE_DIR, `${record.sequenceName}.xml`);
    fs.writeFileSync(filePath, renderCheckSequence(record, record.sequenceName));
    console.log(`[sync-mi-health-from-apim] generated ${filePath}`);
  }

  for (const criticality of Object.keys(TIER_CONFIG)) {
    const config = TIER_CONFIG[criticality];
    const tierRecords = tierGroups[config.key];

    fs.writeFileSync(
      path.join(SEQUENCE_DIR, `${config.sequenceName}.xml`),
      renderRunSequence(config.sequenceName, tierRecords)
    );

    console.log(
      `[sync-mi-health-from-apim] generated tier sequence ${config.sequenceName}.xml with ${tierRecords.length} APIs, interval=${config.frequencyLabel}`
    );

    if (tierRecords.length > 0) {
      fs.writeFileSync(
        path.join(TASK_DIR, config.taskFileName),
        renderScheduledTask(config)
      );

      console.log(
        `[sync-mi-health-from-apim] generated task ${config.taskFileName}, interval=${config.intervalSeconds}s`
      );
    }
  }

  fs.writeFileSync(
    path.join(SEQUENCE_DIR, "run_all_health_checks.xml"),
    renderRunSequence("run_all_health_checks", activeRecords, lifecycleControlledRecords)
  );

  fs.writeFileSync(
    path.join(API_DIR, "health_registry_api.xml"),
    renderHealthRegistryApi(records)
  );

  await syncStatusCacheCatalogueMembership(records);

  console.log("");
  console.log("[sync-mi-health-from-apim] summary");
  console.log(` Application: ${subscriptionSnapshot.application.name}`);
  console.log(` Subscriptions: ${subscriptionSnapshot.subscriptions.length}`);
  console.log(` Active probes: ${activeRecords.length}`);
  console.log(` Subscribed but not actively probed: ${lifecycleControlledRecords.length}`);
  console.log(` Tier 0 / 1 min: ${tierGroups.tier0.length}`);
  console.log(` Tier 1 / 3 min: ${tierGroups.tier1.length}`);
  console.log(` Tier 2 / 10 min: ${tierGroups.tier2.length}`);
  console.log(` Tier 3 / 30 min: ${tierGroups.tier3.length}`);
  console.log(`[sync-mi-health-from-apim] generated ${records.length} subscription-sourced health registry records`);
}

main().catch((error) => {
  console.error("[sync-mi-health-from-apim] failed");
  console.error(error);
  process.exit(1);
});

/* HEALTH_FAILURE_POST_PROCESSOR_START */
/*
 * Add timeout + metadata-preserving fault handlers to generated MI health checks.
 *
 * When a backend API container is stopped, the normal check can fault before the
 * successful cache-write path runs. This fault handler writes a RED result using
 * the same catalogue metadata as the normal check record, so the cache/UI updates
 * the existing deployed API row instead of creating an incomplete duplicate row.
 */
function postProcessGeneratedHealthFailureSequences() {
  const fs = require("fs");
  const path = require("path");

  const sequencesDir = path.join(
    process.cwd(),
    "wso2-integrator",
    "catalogue-health-mi",
    "src",
    "main",
    "wso2mi",
    "artifacts",
    "sequences"
  );

  if (!fs.existsSync(sequencesDir)) {
    return;
  }

  function escapeForJsSingleQuoted(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
  }

  function readGeneratedValue(xml, key, fallback = "") {
    const patterns = [
      new RegExp(`${key}\\s*:\\s*'([^']*)'`),
      new RegExp(`${key}\\s*:\\s*"([^"]*)"`),
      new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`),
      new RegExp(`"${key}"\\s*:\\s*'([^']*)'`)
    ];

    for (const pattern of patterns) {
      const match = xml.match(pattern);

      if (match) {
        return match[1];
      }
    }

    return fallback;
  }

  function readGeneratedNumber(xml, key, fallback = 0) {
    const pattern = new RegExp(`${key}\\s*:\\s*(\\d+)`);
    const match = xml.match(pattern);

    if (match) {
      return Number(match[1]);
    }

    return fallback;
  }

  const checkFiles = fs
    .readdirSync(sequencesDir)
    .filter((file) => /^check_.*_api_.*\.xml$/.test(file));

  for (const file of checkFiles) {
    const checkPath = path.join(sequencesDir, file);
    let xml = fs.readFileSync(checkPath, "utf8");

    const sequenceNameMatch = xml.match(/<sequence[^>]*\sname="([^"]+)"/);
    if (!sequenceNameMatch) {
      continue;
    }

    const checkSequenceName = sequenceNameMatch[1];
    const faultSequenceName = `fault_${checkSequenceName}`;

    const apiNameFromSequence = checkSequenceName
      .replace(/^check_/, "")
      .replace(/_\d+_\d+_\d+$/, "")
      .replace(/_/g, "-");

    const versionMatch = checkSequenceName.match(/_(\d+)_(\d+)_(\d+)$/);
    const versionFromSequence = versionMatch
      ? `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`
      : "1.0.0";

    const apiName = readGeneratedValue(xml, "name", apiNameFromSequence);
    const version = readGeneratedValue(xml, "version", versionFromSequence);
    const domain = readGeneratedValue(xml, "domain", "");
    const owner = readGeneratedValue(xml, "owner", "");
    const ownerEmail = readGeneratedValue(xml, "ownerEmail", "");
    const runtime = readGeneratedValue(xml, "runtime", "");
    const criticality = readGeneratedValue(xml, "criticality", "");
    const checkFrequency = readGeneratedValue(xml, "checkFrequency", "");
    const healthUrl = readGeneratedValue(xml, "healthUrl", "");
    const contractUrl = readGeneratedValue(xml, "contractUrl", healthUrl);
    const expectedHttpStatus = readGeneratedNumber(xml, "expectedHttpStatus", 200);
    const slaTargetMs = readGeneratedNumber(xml, "slaTargetMs", 300);

    if (!xml.includes(`onError="${faultSequenceName}"`)) {
      xml = xml.replace(
        /<sequence\b([^>]*)>/,
        (match, attrs) => {
          if (attrs.includes("onError=")) {
            return match;
          }

          return `<sequence${attrs} onError="${faultSequenceName}">`;
        }
      );
    }

    xml = xml.replace(
      /<http\s+([^>]*uri-template="http:\/\/[^"]+-api:\d+[^"]*"[^>]*)\/>/g,
      (_match, attrs) => {
        if (attrs.includes("health-status-cache")) {
          return `<http ${attrs}/>`;
        }

        return `<http ${attrs}>
                <timeout>
                    <duration>3000</duration>
                    <responseAction>fault</responseAction>
                </timeout>
                <suspendOnFailure>
                    <initialDuration>1000</initialDuration>
                    <progressionFactor>1.0</progressionFactor>
                    <maximumDuration>3000</maximumDuration>
                </suspendOnFailure>
                <markForSuspension>
                    <retriesBeforeSuspension>0</retriesBeforeSuspension>
                </markForSuspension>
            </http>`;
      }
    );

    fs.writeFileSync(checkPath, xml);

    const faultXml = `<?xml version="1.0" encoding="UTF-8"?>
<sequence name="${faultSequenceName}" trace="disable" xmlns="http://ws.apache.org/ns/synapse">
    <log level="custom">
        <property name="health.check.failure" value="${escapeForJsSingleQuoted(apiName)} backend call failed; writing RED cache result"/>
    </log>
    <script language="js"><![CDATA[
        var now = new Date().toISOString();

        function text(value, fallback) {
            if (value === null || value === undefined || String(value).length === 0) {
                return fallback;
            }

            return String(value);
        }

        var errorCode = text(mc.getProperty('ERROR_CODE'), 'BACKEND_UNAVAILABLE');
        var errorMessage = text(
            mc.getProperty('ERROR_MESSAGE') || mc.getProperty('ERROR_DETAIL'),
            'Backend endpoint is unavailable or did not respond.'
        );

        mc.setPayloadJSON({
            name: '${escapeForJsSingleQuoted(apiName)}',
            version: '${escapeForJsSingleQuoted(version)}',
            domain: '${escapeForJsSingleQuoted(domain)}',
            owner: '${escapeForJsSingleQuoted(owner)}',
            ownerEmail: '${escapeForJsSingleQuoted(ownerEmail)}',
            runtime: '${escapeForJsSingleQuoted(runtime)}',
            criticality: '${escapeForJsSingleQuoted(criticality)}',
            checkFrequency: '${escapeForJsSingleQuoted(checkFrequency)}',
            healthUrl: '${escapeForJsSingleQuoted(healthUrl)}',
            contractUrl: '${escapeForJsSingleQuoted(contractUrl)}',
            expectedHttpStatus: ${expectedHttpStatus},
            slaTargetMs: ${slaTargetMs},
            consumerStatus: 'RED',
            checkedAt: now,
            source: 'wso2-integrator',
            liveness: {
                status: 'ERROR',
                httpStatus: 0,
                responseTimeMs: 0,
                checkedAt: now,
                reasons: [
                    'Liveness check failed because the backend endpoint is unavailable.',
                    errorCode + ': ' + errorMessage
                ]
            },
            contract: {
                status: 'SKIPPED',
                checkedAt: now,
                reasons: [
                    'Contract validation skipped because liveness check failed.'
                ]
            },
            sla: {
                status: 'BREACHED',
                checkedAt: now,
                targetMs: ${slaTargetMs},
                actualMs: 0
            }
        });
    ]]></script>
    <property name="messageType" value="application/json" scope="axis2"/>
    <property name="ContentType" value="application/json" scope="axis2"/>
    <property name="HTTP_METHOD" value="POST" scope="axis2"/>
      <call>
        <endpoint>
            <http method="POST" uri-template="http://health-status-cache:6300/cache/results">
                <timeout>
                    <duration>3000</duration>
                    <responseAction>fault</responseAction>
                </timeout>
            </http>
        </endpoint>
    </call>
</sequence>
`;

    fs.writeFileSync(path.join(sequencesDir, `${faultSequenceName}.xml`), faultXml);
  }

  if (checkFiles.length > 0) {
    console.log(`[sync-mi-health-from-apim] added metadata-preserving timeout/fault handlers to ${checkFiles.length} generated health check sequence(s)`);
  }
}

process.on("beforeExit", () => {
  try {
    postProcessGeneratedHealthFailureSequences();
  } catch (e) {
    console.error(`[sync-mi-health-from-apim] health failure post-processing failed: ${e.message}`);
    process.exitCode = 1;
  }
});
/* HEALTH_FAILURE_POST_PROCESSOR_END */

