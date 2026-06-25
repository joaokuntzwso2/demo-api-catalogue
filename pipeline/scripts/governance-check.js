#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const catalogDir = path.join(root, 'catalog/apis');
const required = ['apiId','name','version','domain','owner.team','owner.email','criticality','slaTarget','runtime','lifecycle','backendBaseUrl','healthStrategy.path','healthStrategy.expectedHttpStatus'];

function get(obj, dotted) { return dotted.split('.').reduce((acc, key) => acc && acc[key], obj); }

let failed = false;
for (const file of fs.readdirSync(catalogDir).filter(f => f.endsWith('.json'))) {
  const api = JSON.parse(fs.readFileSync(path.join(catalogDir, file), 'utf8'));
  const missing = required.filter(key => get(api, key) === undefined || get(api, key) === null || get(api, key) === '');
  if (missing.length) {
    failed = true;
    console.error(`❌ ${api.apiId || file}: missing ${missing.join(', ')}`);
  } else {
    console.log(`✅ Governance metadata valid: ${api.apiId}`);
  }
}
if (failed) process.exit(1);
