const https = require("https");

if (String(process.env.APIM_ALLOW_INSECURE_TLS || "").toLowerCase() === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("[set-api-operation-auth-application] WARNING: TLS validation disabled for local demo.");
}

const APIM_HOST = process.env.APIM_HOST || "https://wso2-apim:9443";
const USER = process.env.APIM_USERNAME || "admin";
const PASS = process.env.APIM_PASSWORD || "admin";

const targetNames = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["accounts-api", "payments-api", "customers-api", "cards-api", "loans-api"];

const agent = new https.Agent({ rejectUnauthorized: false });

function basic(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString("base64");
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, agent }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        let parsed = body;
        try { parsed = body ? JSON.parse(body) : {}; } catch {}

        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${url}: ${body}`));
          return;
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function token() {
  const dcr = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic(USER, PASS)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      callbackUrl: "www.google.com",
      clientName: `api-auth-patcher-${Date.now()}`,
      owner: USER,
      grantType: "password refresh_token client_credentials",
      saasApp: true
    })
  });

  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("username", USER);
  params.set("password", PASS);
  params.set("scope", "apim:api_view apim:api_create apim:api_publish");

  const t = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic(dcr.clientId, dcr.clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  return t.access_token;
}

function listOf(payload) {
  return Array.isArray(payload) ? payload : (payload.list || []);
}

(async () => {
  const accessToken = await token();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };

  const apis = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis?limit=200`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  for (const api of listOf(apis).filter((api) => targetNames.includes(api.name))) {
    const detail = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${api.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const before = (detail.operations || []).map((op) => ({
      target: op.target,
      verb: op.verb,
      authType: op.authType
    }));

    detail.operations = (detail.operations || []).map((op) => ({
      ...op,
      authType: "Application"
    }));

    // MI invokes the Gateway internally through http://wso2-apim:8280.
    // Keep HTTPS for browser/demo calls, but allow HTTP for Docker-internal MI probes.
    detail.transport = ["http", "https"];

    await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${api.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(detail)
    });

    console.log(`[set-api-operation-auth-application] updated ${detail.name}:${detail.version}`);
    console.log(JSON.stringify({ before, after: detail.operations.map((op) => ({ target: op.target, verb: op.verb, authType: op.authType })) }, null, 2));
  }
})().catch((e) => {
  console.error(`[set-api-operation-auth-application] failed: ${e.message}`);
  process.exit(1);
});
