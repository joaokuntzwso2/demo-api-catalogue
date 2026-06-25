const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 6300);
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'status-store.json');
const MAX_HISTORY_PER_API = Number(process.env.MAX_HISTORY_PER_API || 500);

function now() {
  return new Date().toISOString();
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ results: [], history: [] }, null, 2));
  }
}

function readStore() {
  ensureDataFile();
  try {
    const store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      results: Array.isArray(store.results) ? store.results : [],
      history: Array.isArray(store.history) ? store.history : []
    };
  } catch (e) {
    return { results: [], history: [] };
  }
}

function writeStore(store) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ results: store.results || [], history: store.history || [] }, null, 2));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve(null);
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function resultKey(result) {
  return `${result.apiId || result.name}:${result.version || ''}`;
}

function effectiveStatus(result) {
  return result.consumerStatus || result.status || 'UNKNOWN';
}

function normalizeIncoming(result) {
  const timestamp = now();
  const status = effectiveStatus(result);
  const normalized = {
    ...result,
    consumerStatus: status,
    cachedAt: timestamp
  };

  if (!normalized.checkedAt) normalized.checkedAt = result.checkedAt || timestamp;
  if (!normalized.sla) {
    normalized.sla = {
      status: status === 'GREEN' ? 'OK' : status === 'YELLOW' ? 'AT_RISK' : status === 'RED' ? 'BREACHED' : 'UNKNOWN',
      target: result.slaTarget || null,
      window: 'current'
    };
  }
  return normalized;
}

function trimHistory(history) {
  const groups = new Map();
  for (const entry of history) {
    const key = resultKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const trimmed = [];
  for (const entries of groups.values()) {
    entries.sort((a, b) => String(b.checkedAt || b.cachedAt).localeCompare(String(a.checkedAt || a.cachedAt)));
    trimmed.push(...entries.slice(0, MAX_HISTORY_PER_API));
  }
  trimmed.sort((a, b) => String(b.checkedAt || b.cachedAt).localeCompare(String(a.checkedAt || a.cachedAt)));
  return trimmed;
}

function upsertResults(incomingResults) {
  const store = readStore();
  const map = new Map();
  for (const result of store.results) map.set(resultKey(result), result);

  const normalizedIncoming = incomingResults.map(normalizeIncoming);
  for (const result of normalizedIncoming) map.set(resultKey(result), result);

  const results = Array.from(map.values()).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const history = trimHistory([...store.history, ...normalizedIncoming]);
  writeStore({ results, history });
  return { results, history };
}

function buildSummary(results) {
  const summary = {
    total: results.length,
    counts: { GREEN: 0, YELLOW: 0, RED: 0, DEPRECATED: 0, UNKNOWN: 0 },
    byDomain: {},
    byTeam: {},
    byCriticality: {},
    generatedAt: now(),
    source: 'health-status-cache',
    semantics: 'last-known-mi-reading-plus-history'
  };

  for (const result of results) {
    const status = effectiveStatus(result);
    if (summary.counts[status] === undefined) summary.counts.UNKNOWN += 1;
    else summary.counts[status] += 1;

    const domain = result.domain || 'Unclassified';
    const team = result.owner?.team || result.ownerTeam || 'Unknown';
    const criticality = result.criticality || 'Unknown';
    for (const [bucket, key] of [[summary.byDomain, domain], [summary.byTeam, team], [summary.byCriticality, criticality]]) {
      if (!bucket[key]) bucket[key] = { total: 0, GREEN: 0, YELLOW: 0, RED: 0, DEPRECATED: 0, UNKNOWN: 0 };
      bucket[key].total += 1;
      if (bucket[key][status] === undefined) bucket[key].UNKNOWN += 1;
      else bucket[key][status] += 1;
    }
  }
  return summary;
}

function parseWindowMs(value) {
  const raw = String(value || '30d').trim();
  const match = raw.match(/^(\d+)(m|h|d)$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

function statusIsAvailable(status) {
  return status === 'GREEN' || status === 'YELLOW' || status === 'DEPRECATED';
}

function latencyOf(entry) {
  return Number(entry.liveness?.latencyMs ?? entry.latencyMs ?? NaN);
}

function percentile(values, p) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const index = Math.ceil((p / 100) * nums.length) - 1;
  return nums[Math.max(0, Math.min(nums.length - 1, index))];
}

function buildSla(history, apiIdOrName, windowMs) {
  const since = Date.now() - windowMs;
  const filtered = history.filter((entry) => {
    const idMatch = entry.apiId === apiIdOrName || entry.name === apiIdOrName || resultKey(entry) === apiIdOrName;
    const ts = Date.parse(entry.checkedAt || entry.cachedAt || '');
    return idMatch && Number.isFinite(ts) && ts >= since;
  });

  const total = filtered.length;
  const available = filtered.filter((entry) => statusIsAvailable(effectiveStatus(entry))).length;
  const red = filtered.filter((entry) => effectiveStatus(entry) === 'RED').length;
  const yellow = filtered.filter((entry) => effectiveStatus(entry) === 'YELLOW').length;
  const p95LatencyMs = percentile(filtered.map(latencyOf), 95);
  const availabilityPercent = total === 0 ? null : Number(((available / total) * 100).toFixed(3));

  return {
    api: apiIdOrName,
    window: `${Math.round(windowMs / 1000)}s`,
    sampleCount: total,
    availableSamples: available,
    redSamples: red,
    yellowSamples: yellow,
    availabilityPercent,
    p95LatencyMs,
    status: total === 0 ? 'UNKNOWN' : red > 0 ? 'AT_RISK_OR_BREACHED' : yellow > 0 ? 'AT_RISK' : 'OK',
    generatedAt: now()
  };
}

function getHistory(reqUrl, history) {
  const api = reqUrl.searchParams.get('api');
  const limit = Number(reqUrl.searchParams.get('limit') || 50);
  let output = history;
  if (api) {
    output = output.filter((entry) => entry.apiId === api || entry.name === api || resultKey(entry) === api);
  }
  return output.slice(0, Math.max(1, Math.min(500, limit)));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 200, {});

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && reqUrl.pathname === '/health') {
      return sendJson(res, 200, { status: 'UP', service: 'health-status-cache', checkedAt: now(), dataFile: DATA_FILE });
    }

    if (req.method === 'GET' && reqUrl.pathname === '/cache/results') {
      const store = readStore();
      return sendJson(res, 200, store.results);
    }

    if (req.method === 'GET' && reqUrl.pathname === '/cache/history') {
      const store = readStore();
      return sendJson(res, 200, getHistory(reqUrl, store.history));
    }

    if (req.method === 'GET' && reqUrl.pathname === '/cache/summary') {
      const store = readStore();
      return sendJson(res, 200, buildSummary(store.results));
    }

    if (req.method === 'GET' && reqUrl.pathname === '/cache/sla') {
      const api = reqUrl.searchParams.get('api');
      if (!api) return sendJson(res, 400, { error: 'api query parameter is required. Example: /cache/sla?api=accounts-api&window=30d' });
      const windowMs = parseWindowMs(reqUrl.searchParams.get('window'));
      const store = readStore();
      return sendJson(res, 200, buildSla(store.history, api, windowMs));
    }

    if (req.method === 'GET' && reqUrl.pathname === '/cache/sla/breaches') {
      const windowMs = parseWindowMs(reqUrl.searchParams.get('window'));
      const store = readStore();
      const apis = [...new Set(store.results.map((r) => r.apiId || r.name).filter(Boolean))];
      const breaches = apis.map((api) => buildSla(store.history, api, windowMs)).filter((sla) => sla.status !== 'OK');
      return sendJson(res, 200, { generatedAt: now(), count: breaches.length, breaches });
    }

    if (req.method === 'POST' && reqUrl.pathname === '/cache/results') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'Request body is required' });
      const incomingResults = Array.isArray(body) ? body : [body];
      const { results, history } = upsertResults(incomingResults);
      return sendJson(res, 200, { message: 'Results cached', count: incomingResults.length, total: results.length, historySamples: history.length });
    }

    if (req.method === 'DELETE' && reqUrl.pathname === '/cache/results') {
      writeStore({ results: [], history: [] });
      return sendJson(res, 200, { message: 'Cache and history cleared' });
    }

    return sendJson(res, 404, { error: 'Not found', method: req.method, url: req.url });
  } catch (e) {
    return sendJson(res, 500, { error: e.message || String(e) });
  }
});

ensureDataFile();
server.listen(PORT, () => {
  console.log(`[health-status-cache] listening on port ${PORT}`);
  console.log(`[health-status-cache] data file: ${DATA_FILE}`);
  console.log(`[health-status-cache] max history per API: ${MAX_HISTORY_PER_API}`);
});
