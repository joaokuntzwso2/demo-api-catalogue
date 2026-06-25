#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');

const root = path.resolve(__dirname, '../..');
const apisDir = path.join(root, 'apis');

(async () => {
  const folders = fs.readdirSync(apisDir).filter(name => fs.existsSync(path.join(apisDir, name, 'openapi.json')));
  for (const folder of folders) {
    const file = path.join(apisDir, folder, 'openapi.json');
    await SwaggerParser.validate(file);
    console.log(`✅ OpenAPI valid: ${folder}`);
  }
})().catch(err => {
  console.error(`❌ OpenAPI validation failed: ${err.message}`);
  process.exit(1);
});
