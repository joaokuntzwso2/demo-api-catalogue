const fs = require('fs');
const path = require('path');

const ALLOWED_CATEGORIES = new Set(
  (process.env.APIM_ALLOWED_API_CATEGORIES || 'Accounts,Cards,Customers,Payments,Loans')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

function fail(message) {
  console.error(`[validate-apictl-categories] ERROR: ${message}`);
  process.exitCode = 1;
}

function findApiYaml(inputPath) {
  const stat = fs.statSync(inputPath);

  if (stat.isFile()) {
    return inputPath;
  }

  const candidates = [
    path.join(inputPath, 'api.yaml'),
    path.join(inputPath, 'Meta-information', 'api.yaml')
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error(`Could not find api.yaml under ${inputPath}`);
  }

  return found;
}

function readScalarValue(line) {
  const [, value = ''] = line.split(/:(.*)/s);
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function readApiName(lines, fallback) {
  for (const line of lines) {
    if (/^\s*name\s*:/.test(line)) {
      return readScalarValue(line);
    }
  }

  return fallback;
}

function indentation(line) {
  return line.length - line.trimStart().length;
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
    const inlineValue = readScalarValue(line);

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

      const listItem = child.match(/^\s*-\s*(.+?)\s*$/);

      if (listItem) {
        categories.push(listItem[1].trim().replace(/^['"]|['"]$/g, ''));
      }
    }
  }

  return [...new Set(categories.filter(Boolean))];
}

function validateApiProject(inputPath) {
  const apiYaml = findApiYaml(inputPath);
  const text = fs.readFileSync(apiYaml, 'utf8');
  const lines = text.split(/\r?\n/);
  const apiName = readApiName(lines, path.basename(path.dirname(apiYaml)));
  const categories = extractCategories(text);

  if (categories.length === 0) {
    fail(`${apiName}: missing required APICTL contract field 'categories' in ${apiYaml}`);
    return;
  }

  const invalid = categories.filter((category) => !ALLOWED_CATEGORIES.has(category));

  if (invalid.length > 0) {
    fail(
      `${apiName}: invalid category/categories [${invalid.join(', ')}] in ${apiYaml}. ` +
      `Allowed categories: ${[...ALLOWED_CATEGORIES].join(', ')}`
    );
    return;
  }

  console.log(
    `[validate-apictl-categories] OK ${apiName}: categories=[${categories.join(', ')}]`
  );
}

function main() {
  const inputs = process.argv.slice(2);

  if (inputs.length === 0) {
    fail('Usage: node pipeline/scripts/validate-apictl-categories.js apictl/apis/<api-project> [...]');
    process.exit();
  }

  for (const input of inputs) {
    validateApiProject(input);
  }

  if (process.exitCode) {
    console.error('[validate-apictl-categories] Blocking API onboarding because one or more APICTL contracts are missing valid categories.');
    process.exit(process.exitCode);
  }

  console.log('[validate-apictl-categories] All APICTL category checks passed.');
}

main();
