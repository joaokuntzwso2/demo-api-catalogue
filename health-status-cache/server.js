const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 6300);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DATA_FILE = path.join(DATA_DIR, "latest-results.json");

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ results: [] }, null, 2));
  }
}

function readStore() {
  ensureDataFile();

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return { results: [] };
  }
}

function writeStore(store) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(body);
}

function resultKey(result) {
  return `${result.apiId || result.name}:${result.version || ""}`;
}

function upsertResults(incomingResults) {
  const store = readStore();
  const existing = Array.isArray(store.results) ? store.results : [];
  const map = new Map();

  for (const result of existing) {
    map.set(resultKey(result), result);
  }

  for (const result of incomingResults) {
    map.set(resultKey(result), {
      ...result,
      cachedAt: new Date().toISOString()
    });
  }

  const results = Array.from(map.values()).sort((a, b) => {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  writeStore({ results });

  return results;
}

function buildSummary(results) {
  const summary = {
    total: results.length,
    counts: {
      GREEN: 0,
      YELLOW: 0,
      RED: 0,
      DEPRECATED: 0,
      UNKNOWN: 0
    },
    generatedAt: new Date().toISOString(),
    source: "health-status-cache",
    semantics: "last-known-mi-reading"
  };

  for (const result of results) {
    const status = result.consumerStatus || "UNKNOWN";

    if (summary.counts[status] === undefined) {
      summary.counts.UNKNOWN++;
    } else {
      summary.counts[status]++;
    }
  }

  return summary;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 200, {});
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        status: "UP",
        service: "health-status-cache",
        checkedAt: new Date().toISOString()
      });
      return;
    }

    if (req.method === "GET" && req.url === "/cache/results") {
      const store = readStore();
      sendJson(res, 200, store.results || []);
      return;
    }

    if (req.method === "GET" && req.url === "/cache/summary") {
      const store = readStore();
      sendJson(res, 200, buildSummary(store.results || []));
      return;
    }

    if (req.method === "POST" && req.url === "/cache/results") {
      const body = await readBody(req);

      if (!body) {
        sendJson(res, 400, { error: "Request body is required" });
        return;
      }

      const incomingResults = Array.isArray(body) ? body : [body];
      const results = upsertResults(incomingResults);

      sendJson(res, 200, {
        message: "Results cached",
        count: incomingResults.length,
        total: results.length
      });
      return;
    }

    if (req.method === "DELETE" && req.url === "/cache/results") {
      writeStore({ results: [] });
      sendJson(res, 200, { message: "Cache cleared" });
      return;
    }

    sendJson(res, 404, {
      error: "Not found",
      method: req.method,
      url: req.url
    });
  } catch (e) {
    sendJson(res, 500, {
      error: e.message || String(e)
    });
  }
});

ensureDataFile();

server.listen(PORT, () => {
  console.log(`[health-status-cache] listening on port ${PORT}`);
  console.log(`[health-status-cache] data file: ${DATA_FILE}`);
});
