#!/usr/bin/env node
/*
 * Enhanced catalogue governance validator for the demo-api-catalogue repository.
 *
 * Purpose:
 * - Validate catalogue-specific APIM custom properties before APICTL import.
 * - Understand the APICTL api.yaml structure where API data lives under `data`.
 * - Keep the default demo mode practical: existing valid demo APIs pass, while truly
 *   incomplete APIs such as loans-api without health_expected_payload_json fail.
 * - Allow stricter customer/production validation with GOVERNANCE_STRICT=true.
 *
 * Usage:
 *   node pipeline/scripts/enhanced-governance-check.js apictl/apis/accounts-api
 *   node pipeline/scripts/enhanced-governance-check.js apictl/apis/*
 *   GOVERNANCE_STRICT=true node pipeline/scripts/enhanced-governance-check.js apictl/apis/*
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_RULES_PATH = path.join(ROOT, 'governance', 'catalogue-governance-rules.json');
const STRICT = String(process.env.GOVERNANCE_STRICT || 'false').toLowerCase() === 'true';

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function stripQuotes(value) {
  if (value === undefined || value === null) return '';
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readRules() {
  const rulesPath = process.env.CATALOGUE_GOVERNANCE_RULES || DEFAULT_RULES_PATH;
  if (!fs.existsSync(rulesPath)) {
    throw new Error(`Governance rules file not found: ${rulesPath}`);
  }
  return JSON.parse(readText(rulesPath));
}

/*
 * APICTL api.yaml format:
 *
 * type: api
 * version: v4.4.0
 * data:
 *   name: accounts-api
 *   context: /accounts/v1
 *   version: 1.0.0
 *
 * Some APICTL exports or copied files may be compacted into fewer lines.
 * This parser intentionally avoids a third-party YAML dependency and extracts
 * only the fields needed by this demo validator.
 */
function getDataScope(apiYaml) {
  const dataIndex = apiYaml.search(/\bdata\s*:/);
  if (dataIndex === -1) return apiYaml;

  const afterData = apiYaml.slice(dataIndex);
  const additionalIndex = afterData.search(/\badditionalProperties\s*:/);
  if (additionalIndex === -1) return afterData;

  return afterData.slice(0, additionalIndex);
}

function getApiCtlFormatVersion(apiYaml) {
  const match = apiYaml.match(/(?:^|\s)version\s*:\s*("[^"]*"|'[^']*'|[^\s]+)/);
  return match ? stripQuotes(match[1]) : 'unknown';
}

function getDataField(apiYaml, field) {
  const scope = getDataScope(apiYaml);
  const regex = new RegExp(`(?:^|\\s)${field}\\s*:\\s*("[^"]*"|'[^']*'|[^\\s]+)`, 'm');
  const match = scope.match(regex);
  return match ? stripQuotes(match[1]) : '';
}

function parseAdditionalProperties(apiYaml) {
  const props = {};
  const additionalIndex = apiYaml.search(/\badditionalProperties\s*:/);
  if (additionalIndex === -1) return props;

  const scope = apiYaml.slice(additionalIndex);

  /*
   * Supports both normal multiline:
   * - name: health_enabled
   *   value: "true"
   *   display: true
   *
   * and compacted one-line-ish:
   * - name: health_enabled value: "true" display: true
   */
  const regex = /-\s*name\s*:\s*([A-Za-z0-9_.-]+)[\s\S]*?\bvalue\s*:\s*("[^"]*"|'[^']*'|[\s\S]*?)(?=\s+\bdisplay\s*:|\n\s*-\s*name\s*:|\r?\n\S|$)/g;

  let match;
  while ((match = regex.exec(scope)) !== null) {
    const name = stripQuotes(match[1]);
    let value = stripQuotes(match[2]);

    // Defensive cleanup when compact YAML causes the value capture to include display.
    value = value.replace(/\s+display\s*:\s*(true|false)\s*$/i, '').trim();

    props[name] = value;
  }

  return props;
}

function findApiDefinition(apiProjectPath) {
  const candidates = [
    'Definitions/swagger.yaml',
    'Definitions/swagger.yml',
    'Definitions/swagger.json',
    'Definitions/openapi.yaml',
    'Definitions/openapi.yml',
    'Definitions/openapi.json',
    'definitions/swagger.yaml',
    'definitions/swagger.yml',
    'definitions/swagger.json',
    'definitions/openapi.yaml',
    'definitions/openapi.yml',
    'definitions/openapi.json'
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(apiProjectPath, candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return null;
}

function parsePercent(value) {
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*%?$/);
  if (!match) return null;
  return Number(match[1]);
}

function isLikelyEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim());
}

function isLikelyUrlOrChannel(value) {
  const v = String(value || '').trim();
  return (
    /^https?:\/\//.test(v) ||
    /^teams:/.test(v) ||
    /^slack:/.test(v) ||
    /^mailto:/.test(v) ||
    v.length >= 3
  );
}

function validateOpenApi(definitionPath) {
  const errors = [];
  const warnings = [];

  if (!definitionPath) {
    errors.push('OpenAPI definition was not found under Definitions/');
    return { errors, warnings };
  }

  const raw = readText(definitionPath);
  const lower = raw.toLowerCase();

  if (
    !lower.includes('openapi:') &&
    !lower.includes('"openapi"') &&
    !lower.includes('swagger:') &&
    !lower.includes('"swagger"')
  ) {
    errors.push(`Definition does not look like OpenAPI/Swagger: ${definitionPath}`);
  }

  if (!lower.includes('paths:') && !lower.includes('"paths"')) {
    errors.push(`Definition has no paths section: ${definitionPath}`);
  }

  if (
    !lower.includes('security') &&
    !lower.includes('securityschemes') &&
    !lower.includes('securitydefinitions')
  ) {
    warnings.push(
      'OpenAPI definition has no obvious security declaration. APIM may still secure it at API level, but design-time contract does not show security.'
    );
  }

  return { errors, warnings };
}

function validateApiProject(apiProjectPath, rules) {
  const errors = [];
  const warnings = [];
  const apiYamlPath = path.join(apiProjectPath, 'api.yaml');

  if (!fs.existsSync(apiYamlPath)) {
    return {
      project: apiProjectPath,
      apiName: path.basename(apiProjectPath),
      version: 'unknown',
      lifecycle: 'UNKNOWN',
      passed: false,
      errors: [`api.yaml not found: ${apiYamlPath}`],
      warnings
    };
  }

  const apiYaml = readText(apiYamlPath);
  const props = parseAdditionalProperties(apiYaml);

  const apiName = getDataField(apiYaml, 'name') || path.basename(apiProjectPath);
  const apiVersion = getDataField(apiYaml, 'version') || 'unknown';
  const context = getDataField(apiYaml, 'context');
  const lifecycle = String(getDataField(apiYaml, 'lifeCycleStatus') || getDataField(apiYaml, 'status') || '')
    .trim()
    .toUpperCase();

  const apiCtlFormatVersion = getApiCtlFormatVersion(apiYaml);
  const deprecated = (rules.deprecatedLifecycleValues || []).includes(lifecycle);

  // Required APICTL data fields.
  const requiredFields = rules.requiredTopLevelFields || [];
  for (const field of requiredFields) {
    let value = '';
    if (field === 'name') value = apiName;
    else if (field === 'version') value = apiVersion;
    else if (field === 'context') value = context;
    else value = getDataField(apiYaml, field);

    if (!value) {
      errors.push(`Missing APICTL data field: data.${field}`);
    }
  }

  for (const prop of rules.requiredAdditionalProperties || []) {
    if (!Object.prototype.hasOwnProperty.call(props, prop) || String(props[prop]).trim() === '') {
      errors.push(`Missing required APIM custom property: ${prop}`);
    }
  }

  for (const prop of rules.recommendedAdditionalProperties || []) {
    if (!Object.prototype.hasOwnProperty.call(props, prop) || String(props[prop]).trim() === '') {
      warnings.push(`Recommended APIM custom property is not set: ${prop}`);
    }
  }

  for (const [prop, allowed] of Object.entries(rules.allowedValues || {})) {
    if (props[prop] && !allowed.includes(props[prop])) {
      errors.push(`Invalid value for ${prop}: "${props[prop]}". Allowed values: ${allowed.join(', ')}`);
    }
  }

  if (props.health_owner_email && !isLikelyEmail(props.health_owner_email)) {
    errors.push(`health_owner_email is not a valid email address: ${props.health_owner_email}`);
  }

  if (props.health_enabled && !['true', 'false'].includes(String(props.health_enabled).toLowerCase())) {
    errors.push('health_enabled must be "true" or "false"');
  }

  if (String(props.health_enabled).toLowerCase() === 'true') {
    if (!/^\//.test(props.health_path || '')) {
      errors.push(`health_path must start with /, actual: ${props.health_path || '<empty>'}`);
    }

    if (!/^https?:\/\//.test(props.health_backend_url || '')) {
      errors.push(`health_backend_url must be an HTTP(S) URL, actual: ${props.health_backend_url || '<empty>'}`);
    }

    const expectedStatus = Number(props.health_expected_http_status);
    if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
      errors.push(`health_expected_http_status must be a valid HTTP status code, actual: ${props.health_expected_http_status}`);
    }

    try {
      JSON.parse(props.health_expected_payload_json || '{}');
    } catch (e) {
      errors.push(`health_expected_payload_json is not valid JSON: ${e.message}`);
    }
  }

  const sla = parsePercent(props.health_sla_target);
  if (sla === null || sla <= 0 || sla > 100) {
    errors.push(`health_sla_target must be a valid percentage, actual: ${props.health_sla_target || '<empty>'}`);
  }

  const tier = props.health_criticality;
  const tierRule = rules.tierRules && rules.tierRules[tier];

  if (tierRule) {
    if (sla !== null && sla < tierRule.minimumSlaPercent) {
      errors.push(`${tier} requires SLA >= ${tierRule.minimumSlaPercent}%, actual: ${props.health_sla_target}`);
    }

    if (tierRule.requiresSemanticValidation && String(props.health_required_fields || '').trim() === '') {
      errors.push(`${tier} requires semantic validation through health_required_fields`);
    }

    const runbookMissing = !isLikelyUrlOrChannel(props.runbook_url);
    const supportMissing = !isLikelyUrlOrChannel(props.support_channel);

    if (tierRule.requiresRunbook && runbookMissing) {
      const msg = `${tier} should define runbook_url`;
      STRICT ? errors.push(msg) : warnings.push(`${msg} [strict-mode only]`);
    }

    if (tierRule.requiresSupportChannel && supportMissing) {
      const msg = `${tier} should define support_channel`;
      STRICT ? errors.push(msg) : warnings.push(`${msg} [strict-mode only]`);
    }
  }

  if (deprecated && rules.productionRules?.retirementDateRequiredForDeprecatedApis && !props.retirement_date) {
    const msg = 'Deprecated/retired APIs should define retirement_date';
    STRICT ? errors.push(msg) : warnings.push(`${msg} [strict-mode only]`);
  }

  if (
    props.environment === 'production' &&
    rules.productionRules?.healthStrategyRequired &&
    String(props.health_enabled).toLowerCase() !== 'true' &&
    !deprecated
  ) {
    errors.push('Production APIs must have health_enabled=true unless lifecycle is deprecated/retired');
  }

  const definitionResult = validateOpenApi(findApiDefinition(apiProjectPath));
  errors.push(...definitionResult.errors);
  warnings.push(...definitionResult.warnings);

  return {
    project: apiProjectPath,
    apiName,
    version: apiVersion,
    apiCtlFormatVersion,
    context,
    lifecycle: lifecycle || 'UNKNOWN',
    passed: errors.length === 0,
    errors,
    warnings
  };
}

function expandInputs(args) {
  const inputs = args.filter((arg) => !arg.startsWith('--'));
  if (inputs.length > 0) return inputs.map((p) => path.resolve(p));

  const apictlApis = path.join(ROOT, 'apictl', 'apis');
  return fs
    .readdirSync(apictlApis)
    .map((name) => path.join(apictlApis, name))
    .filter((p) => fs.existsSync(path.join(p, 'api.yaml')));
}

function printHuman(results) {
  let passed = 0;
  let failed = 0;
  let warningCount = 0;

  for (const result of results) {
    warningCount += result.warnings.length;

    if (result.passed) {
      passed += 1;
      console.log(`PASS ${result.apiName}:${result.version} (${result.project})`);
    } else {
      failed += 1;
      console.log(`FAIL ${result.apiName}:${result.version} (${result.project})`);
    }

    for (const error of result.errors) {
      console.log(`  ERROR: ${error}`);
    }

    for (const warning of result.warnings) {
      console.log(`  WARN : ${warning}`);
    }
  }

  console.log('');
  console.log(`Governance summary: ${passed}/${results.length} passed, ${failed} failed, ${warningCount} warnings`);

  if (!STRICT) {
    console.log('Mode: demo/default. Use GOVERNANCE_STRICT=true to turn strict production recommendations into blockers.');
  }
}

function main() {
  const json = process.argv.includes('--json');
  const rules = readRules();
  const projects = expandInputs(process.argv.slice(2));
  const results = projects.map((project) => validateApiProject(project, rules));

  if (json) {
    console.log(JSON.stringify({ strict: STRICT, results }, null, 2));
  } else {
    printHuman(results);
  }

  if (results.some((r) => !r.passed)) {
    process.exit(1);
  }
}

main();
