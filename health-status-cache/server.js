const http = require("http");

const PORT = Number(process.env.PORT || 6300);

let results = [];
let history = [];

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body, null, 2);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function recordKey(record) {
  return `${record?.name || ""}:${record?.version || "1.0.0"}`;
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

function mergePreservingMetadata(previous, incoming) {
  if (!previous) {
    return incoming;
  }

  const merged = {
    ...previous,
    ...incoming
  };

  for (const key of [
    "domain",
    "owner",
    "ownerEmail",
    "runtime",
    "criticality",
    "checkFrequency",
    "healthUrl",
    "contractUrl",
    "expectedHttpStatus",
    "slaTargetMs"
  ]) {
    if (!hasMeaningfulValue(incoming[key]) && hasMeaningfulValue(previous[key])) {
      merged[key] = previous[key];
    }
  }

  return merged;
}

function upsertRecord(incoming) {
  if (!incoming || !incoming.name) {
    return;
  }

  if (!incoming.version) {
    incoming.version = "1.0.0";
  }

  const key = recordKey(incoming);
  const index = results.findIndex((record) => recordKey(record) === key);

  if (index >= 0) {
    results[index] = mergePreservingMetadata(results[index], incoming);
    history.push(results[index]);
  } else {
    results.push(incoming);
    history.push(incoming);
  }
}

function dedupeResults() {
  const byKey = new Map();

  for (const record of results) {
    const key = recordKey(record);
    const previous = byKey.get(key);
    byKey.set(key, mergePreservingMetadata(previous, record));
  }

  results = Array.from(byKey.values());
}


function normalizeStatus(value) {
  return String(value || "UNKNOWN").toUpperCase();
}

function buildSummary() {
  dedupeResults();

  const summary = {
    total: results.length,
    registered: results.length,
    healthy: 0,
    attention: 0,
    green: 0,
    red: 0,
    grey: 0,
    unknown: 0,
    consumerStatusCounts: {},
    livenessCounts: {},
    contractCounts: {},
    generatedAt: new Date().toISOString()
  };

  for (const record of results) {
    const consumerStatus = normalizeStatus(record.consumerStatus);
    const livenessStatus = normalizeStatus(record.liveness && record.liveness.status);
    const contractStatus = normalizeStatus(record.contract && record.contract.status);

    summary.consumerStatusCounts[consumerStatus] =
      (summary.consumerStatusCounts[consumerStatus] || 0) + 1;

    summary.livenessCounts[livenessStatus] =
      (summary.livenessCounts[livenessStatus] || 0) + 1;

    summary.contractCounts[contractStatus] =
      (summary.contractCounts[contractStatus] || 0) + 1;

    if (consumerStatus === "GREEN") {
      summary.green += 1;
      summary.healthy += 1;
    } else if (consumerStatus === "RED") {
      summary.red += 1;
      summary.attention += 1;
    } else if (consumerStatus === "GREY" || consumerStatus === "GRAY") {
      summary.grey += 1;
    } else {
      summary.unknown += 1;
    }
  }

  return summary;
}


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 200, { status: "OK" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      status: "OK",
      service: "health-status-cache"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/cache/summary") {
    sendJson(res, 200, buildSummary());
    return;
  }

  if (req.method === "GET" && url.pathname === "/cache/results") {
    dedupeResults();
    sendJson(res, 200, results);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/cache/results") {
    results = [];
    history = [];

    sendJson(res, 200, {
      message: "Cache and history cleared"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/cache/results") {
    try {
      const rawBody = await readBody(req);
      const payload = rawBody ? JSON.parse(rawBody) : {};

      const records = Array.isArray(payload) ? payload : [payload];

      for (const record of records) {
        upsertRecord(record);
      }

      dedupeResults();

      sendJson(res, 200, {
        message: "Cache updated",
        count: results.length
      });
    } catch (error) {
      sendJson(res, 400, {
        status: "ERROR",
        message: error.message
      });
    }

    return;
  }

  if (req.method === "GET" && url.pathname === "/cache/history") {
    sendJson(res, 200, history);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/cache/history") {
    history = [];

    sendJson(res, 200, {
      message: "History cleared"
    });
    return;
  }

  sendJson(res, 404, {
    status: "ERROR",
    message: `No route for ${req.method} ${url.pathname}`
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`health-status-cache listening on ${PORT}`);
});
