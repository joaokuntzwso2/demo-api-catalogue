const fs = require('fs');
const path = require('path');

const REQUIRED_HEALTH_PROPERTIES = [
  'health_enabled',
  'health_backend_url',
  'health_path',
  'health_method',
  'health_expected_http_status',
  'health_expected_payload_json',
  'health_required_fields',
  'health_sla_target',
  'health_criticality',
  'health_owner_team',
  'health_owner_email'
];

const ALLOWED_CATEGORIES = new Set(
  (process.env.APIM_ALLOWED_API_CATEGORIES || 'Accounts,Cards,Customers,Payments,Loans')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

function findApiYaml(input) {
  const stat = fs.statSync(input);

  if (stat.isFile()) {
    return input;
  }

  const candidates = [
    path.join(input, 'api.yaml'),
    path.join(input, 'Meta-information', 'api.yaml')
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error(`Could not find api.yaml under ${input}`);
  }

  return found;
}

function readScalar(line) {
  const match = line.match(/:\s*(.*)$/);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function readApiName(text, apiYaml) {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (/^\s*name\s*:/.test(line)) {
      return readScalar(line);
    }
  }

  return path.basename(path.dirname(apiYaml));
}

function extractAdditionalPropertyNames(text) {
  const names = new Set();
  const regex = /^\s*-\s*name\s*:\s*['"]?([^'"\n]+)['"]?\s*$/gm;
  let match;

  while ((match = regex.exec(text)) !== null) {
    names.add(match[1].trim());
  }

  return names;
}

function extractCategories(text) {
  const lines = text.split(/\r?\n/);
  const categories = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (!/^\s*categories\s*:/.test(line)) {
      continue;
    }

    const baseIndent = indentation(line);
    const inlineValue = readScalar(line);

    if (inlineValue && inlineValue !== '[]') {
      inlineValue
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .forEach((item) => categories.push(item));
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const child = lines[j];

      if (!child.trim()) {
        continue;
      }

      const childIndent = indentation(child);

      if (childIndent <= baseIndent) {
        break;
      }

      const item = child.match(/^\s*-\s*(.+?)\s*$/);

      if (item) {
        categories.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
      }
    }
  }

  return [...new Set(categories.filter(Boolean))];
}

function validateProject(input) {
  const apiYaml = findApiYaml(input);
  const text = fs.readFileSync(apiYaml, 'utf8');
  const apiName = readApiName(text, apiYaml);
  const propertyNames = extractAdditionalPropertyNames(text);
  const categories = extractCategories(text);
  const errors = [];

  for (const property of REQUIRED_HEALTH_PROPERTIES) {
    if (!propertyNames.has(property)) {
      errors.push(`Missing required APIM health metadata property: ${property}`);
    }
  }

  if (categories.length === 0) {
    errors.push(`Missing required APICTL contract field: categories`);
  } else {
    const invalid = categories.filter((category) => !ALLOWED_CATEGORIES.has(category));

    if (invalid.length > 0) {
      errors.push(
        `Invalid API category/categories [${invalid.join(', ')}]. ` +
        `Allowed categories: ${[...ALLOWED_CATEGORIES].join(', ')}`
      );
    }
  }

  console.log(`\nChecking APICTL onboarding contract: ${apiName}`);

  if (errors.length === 0) {
    console.log(`✅ APICTL onboarding contract passed for ${apiName}`);
    return true;
  }

  for (const error of errors) {
    console.error(`❌ ${error}`);
  }

  console.error(`\n❌ APICTL onboarding contract failed for ${apiName}.`);
  console.error('This API will not be imported into WSO2 API Manager.');
  return false;
}

function main() {
  const inputs = process.argv.slice(2);

  if (inputs.length === 0) {
    console.error('Usage: node pipeline/scripts/validate-apictl-onboarding-contract.js apictl/apis/<api-project> [...]');
    process.exit(1);
  }

  let ok = true;

  for (const input of inputs) {
    ok = validateProject(input) && ok;
  }

  if (!ok) {
    process.exit(1);
  }

  console.log('\nAll APICTL onboarding contract checks passed.');
}

main();
