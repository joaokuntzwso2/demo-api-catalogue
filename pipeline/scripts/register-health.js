#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const root = path.resolve(__dirname, '../..');
const catalogDir = path.join(root, 'catalog/apis');
const baseUrl = process.env.INTEGRATOR_BASE_URL || 'http://localhost:6200';

function loadMetadata() {
  if (args.includes('--all')) {
    return fs.readdirSync(catalogDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(catalogDir, f), 'utf8')));
  }
  const apiFolder = args[0];
  if (!apiFolder) {
    console.error('Usage: node register-health.js --all OR node register-health.js <api-folder-or-api-id>');
    process.exit(1);
  }
  const candidates = fs.readdirSync(catalogDir).filter(f => f.includes(apiFolder) || f === `${apiFolder}.json`);
  if (!candidates.length) throw new Error(`No catalog metadata found for ${apiFolder}`);
  return [JSON.parse(fs.readFileSync(path.join(catalogDir, candidates[0]), 'utf8'))];
}

(async () => {
  const apis = loadMetadata();
  for (const api of apis) {
    const res = await fetch(`${baseUrl}/api-health-registry/v1/apis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(api)
    });
    if (!res.ok) throw new Error(`Failed registering ${api.apiId}: ${res.status} ${await res.text()}`);
    console.log(`✅ Health strategy registered: ${api.apiId}`);
  }
})().catch(err => {
  console.error(`❌ Health registration failed: ${err.message}`);
  process.exit(1);
});
