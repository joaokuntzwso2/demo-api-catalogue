#!/usr/bin/env node
/*
 * Deterministic APIM Service Catalog bootstrap for the local demo.
 *
 * Why this exists:
 * - The official MI Service Catalog feature publishes services during MI startup.
 * - In this repository we mount loose Synapse artifacts/resources directly for fast demo iteration.
 * - Loose mounted metadata may not be picked up the same way as a packaged MI/CApp deployment.
 * - This script makes the demo deterministic by registering services directly in APIM Service Catalog.
 *
 * Usage:
 *   node pipeline/scripts/bootstrap-service-catalog.js
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');

const APIM_HOST = process.env.APIM_HOST || 'https://localhost:9443';
const APIM_USERNAME = process.env.APIM_USERNAME || 'admin';
const APIM_PASSWORD = process.env.APIM_PASSWORD || 'admin';

// These values are used only by the fallback bootstrap importer.
// Native MI Service Catalog publishing resolves {MI_HOST}/{MI_PORT} itself.
// The bootstrap script must resolve them before importing into APIM.
const MI_HOST = process.env.MI_HOST || process.env.SERVICE_CATALOG_MI_HOST || 'wso2-integrator';
const MI_PORT = process.env.MI_PORT || process.env.SERVICE_CATALOG_MI_PORT || '8290';

const ROOT = path.resolve(__dirname, '../..');

const SERVICE_ROOT =
  process.env.SERVICE_CATALOG_ROOT ||
  path.join(ROOT, 'wso2-integrator', 'catalogue-health-mi', 'src', 'main', 'wso2mi', 'resources');

const METADATA_DIR = path.join(SERVICE_ROOT, 'metadata');
const DEFINITIONS_DIR = path.join(SERVICE_ROOT, 'api-definitions');

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForApim() {
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    try {
      const carbon = await requestRaw(`${APIM_HOST}/carbon`, { method: 'GET' });
      const serviceCatalog = await requestRaw(`${APIM_HOST}/api/am/service-catalog/v1/services`, { method: 'GET' });

      const carbonReady = [200, 302].includes(carbon.status);
      const serviceCatalogReady = [200, 401, 403].includes(serviceCatalog.status);

      if (carbonReady && serviceCatalogReady) {
        return;
      }

      console.log(
        `Waiting for APIM. /carbon=${carbon.status}, service-catalog=${serviceCatalog.status}`
      );
    } catch (e) {
      console.log(`Waiting for APIM. ${e.message}`);
    }

    await sleep(15000);
  }

  throw new Error('Timed out waiting for APIM and Service Catalog REST app.');
}

async function getToken() {
  const client = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(APIM_USERNAME, APIM_PASSWORD)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackUrl: 'www.google.com',
      clientName: `service-catalog-bootstrap-${Date.now()}`,
      owner: APIM_USERNAME,
      grantType: 'password refresh_token client_credentials',
      saasApp: true
    })
  });

  const params = new URLSearchParams();
  params.set('grant_type', 'password');
  params.set('username', APIM_USERNAME);
  params.set('password', APIM_PASSWORD);
  params.set('scope', 'service_catalog:service_view service_catalog:service_write apim:api_view apim:api_create apim:api_publish apim:admin');

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

function readYamlScalar(yaml, key) {
  const regex = new RegExp(`^${key}\\s*:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm');
  const match = yaml.match(regex);
  return match ? match[1].trim() : '';
}

function resolveServiceCatalogPlaceholders(value) {
  return String(value)
    .replaceAll('{MI_HOST}', MI_HOST)
    .replaceAll('{MI_PORT}', MI_PORT)
    .replaceAll('{MI_URL}', `${MI_HOST}:${MI_PORT}`);
}

function loadServices() {
  if (!fs.existsSync(METADATA_DIR)) {
    throw new Error(`Metadata directory not found: ${METADATA_DIR}`);
  }

  if (!fs.existsSync(DEFINITIONS_DIR)) {
    throw new Error(`API definitions directory not found: ${DEFINITIONS_DIR}`);
  }

  const metadataFiles = fs
    .readdirSync(METADATA_DIR)
    .filter((file) => file.endsWith('_metadata.yaml') || file.endsWith('_metadata.yml'))
    .sort();

  return metadataFiles.map((file) => {
    const metadataPath = path.join(METADATA_DIR, file);
    const metadataYaml = resolveServiceCatalogPlaceholders(fs.readFileSync(metadataPath, 'utf8'));

    const name = readYamlScalar(metadataYaml, 'name');
    const key = readYamlScalar(metadataYaml, 'key');
    const version = readYamlScalar(metadataYaml, 'version');
    const definitionType = readYamlScalar(metadataYaml, 'definitionType') || 'OAS3';

    if (!name || !key || !version) {
      throw new Error(`Invalid metadata file. Required fields: key, name, version. File: ${metadataPath}`);
    }

    const definitionCandidates = [
      `${name}.yaml`,
      `${name}.yml`,
      `${name}.json`,
      file.replace('_metadata.yaml', '.yaml'),
      file.replace('_metadata.yml', '.yaml')
    ];

    const definitionPath = definitionCandidates
      .map((candidate) => path.join(DEFINITIONS_DIR, candidate))
      .find((candidate) => fs.existsSync(candidate));

    if (!definitionPath) {
      throw new Error(
        `No OpenAPI definition found for ${name}. Tried: ${definitionCandidates.join(', ')}`
      );
    }

    return {
      metadataPath,
      definitionPath,
      metadataYaml,
      definition: fs.readFileSync(definitionPath, 'utf8'),
      key,
      name,
      version,
      definitionType
    };
  });
}

async function listServices(token) {
  const response = await requestJson(`${APIM_HOST}/api/am/service-catalog/v1/services?limit=100`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return response.list || [];
}

async function importServicesZip(token) {
  /*
   * This script avoids external npm dependencies and direct multipart construction.
   * For robustness, use curl with the APIM token and a generated zip.
   */
  const tmpRoot = path.join(ROOT, '.tmp-service-catalog-import');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const services = loadServices();

  for (const service of services) {
    const serviceDir = path.join(tmpRoot, service.key);
    fs.mkdirSync(serviceDir, { recursive: true });

    fs.writeFileSync(path.join(serviceDir, 'metadata.yaml'), service.metadataYaml);
    fs.copyFileSync(service.definitionPath, path.join(serviceDir, 'definition.yaml'));
  }

  const zipPath = path.join(ROOT, '.tmp-service-catalog-import.zip');
  fs.rmSync(zipPath, { force: true });

  const { spawnSync } = require('child_process');

  const zip = spawnSync('zip', ['-qr', zipPath, '.'], {
    cwd: tmpRoot,
    stdio: 'inherit'
  });

  if (zip.status !== 0) {
    throw new Error('Failed to create Service Catalog import zip. Make sure the zip command is installed.');
  }

  const curl = spawnSync(
    'curl',
    [
      '-ks',
      '-w',
      '\n%{http_code}',
      '-H',
      `Authorization: Bearer ${token}`,
      '-F',
      `file=@${zipPath}`,
      `${APIM_HOST}/api/am/service-catalog/v1/services/import?overwrite=true`
    ],
    {
      encoding: 'utf8'
    }
  );

  if (curl.error) {
    throw curl.error;
  }

  const output = curl.stdout || '';
  const status = output.trim().split('\n').pop();
  const body = output.trim().split('\n').slice(0, -1).join('\n');

  if (!['200', '201', '202'].includes(status)) {
    throw new Error(`Service import failed. HTTP ${status}: ${body || curl.stderr}`);
  }

  return {
    status,
    body
  };
}

async function main() {
  console.log('Waiting for APIM Service Catalog REST app...');
  await waitForApim();

  console.log('Getting APIM token...');
  const token = await getToken();

  console.log('Importing services into APIM Service Catalog...');
  const result = await importServicesZip(token);
  console.log(`Service import completed with HTTP ${result.status}.`);

  const services = await listServices(token);
  const interesting = services.filter((service) =>
    /Customer360|Catalogue|HealthRegistry/i.test(`${service.name} ${service.key}`)
  );

  console.log(JSON.stringify({
    status: 'PASS',
    importedServices: interesting.map((service) => ({
      name: service.name,
      version: service.version,
      key: service.key,
      serviceUrl: service.serviceUrl,
      definitionType: service.definitionType
    }))
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    error: e.message
  }, null, 2));
  process.exit(1);
});
