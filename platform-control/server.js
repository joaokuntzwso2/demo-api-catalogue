#!/usr/bin/env node
/*
 * Local demo control plane.
 *
 * Exposes a small HTTP API for the browser UI to:
 * - list API onboarding options that are not yet onboarded;
 * - run whitelisted npm onboarding scripts;
 * - stream real-time logs through Server-Sent Events.
 *
 * This is intended for local demo usage only.
 */

const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const PORT = Number(process.env.PLATFORM_CONTROL_PORT || 6400);
const REPO_ROOT = path.resolve(__dirname, '..');

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

  return {
    registry,
    onboardedApis: registry.onboarded,
    actions,
    availableActions: actions.filter((action) => action.enabled)
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

  appendLog(
    job,
    'system',
    `Waiting for ${label}: ${expectedApis.join(', ')}\n`
  );

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
        appendLog(
          job,
          'system',
          `${label} is ready for: ${expectedApis.join(', ')}\n`
        );
        return;
      }

      appendLog(
        job,
        'system',
        `${label} not ready yet. Missing: ${missingApis.join(', ')}. Seen: ${lastSeen.join(', ') || 'none'}\n`
      );
    } catch (e) {
      appendLog(
        job,
        'system',
        `${label} check failed: ${e.message}\n`
      );
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

async function startJob(actionId) {
  const action = ACTIONS.find((item) => item.id === actionId);
  if (!action) {
    throw new Error(`Unknown onboarding action: ${actionId}`);
  }

  const options = await getOptions();
  const option = options.actions.find((item) => item.id === actionId);

  if (!option || !option.enabled) {
    throw new Error(`Nothing to onboard for action: ${actionId}`);
  }

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
  appendLog(job, 'system', `Target APIs: ${option.missingApis.join(', ')}\n\n`);

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

const server = http.createServer(async (req, res) => {
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
        port: PORT
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/onboarding/options') {
      sendJson(res, 200, await getOptions());
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

      const job = await startJob(actionId);
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
});
