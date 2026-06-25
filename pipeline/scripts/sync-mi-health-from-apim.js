const fs = require("fs");
const path = require("path");

const STATUS_CACHE_BASE_URL =
  process.env.STATUS_CACHE_BASE_URL ||
  "http://health-status-cache:6300";

if (String(process.env.APIM_ALLOW_INSECURE_TLS || "false").toLowerCase() === "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn(
    "[sync-mi-health-from-apim] WARNING: APIM_ALLOW_INSECURE_TLS=true. Self-signed APIM certificate validation is disabled for this local demo."
  );
}

const APIM_HOST = process.env.APIM_HOST || "https://wso2-apim:9443";
const APIM_USERNAME = process.env.APIM_USERNAME || "admin";
const APIM_PASSWORD = process.env.APIM_PASSWORD || "admin";

const ARTIFACTS_ROOT =
  process.env.MI_ARTIFACTS_ROOT ||
  "/workspace/wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts";

const API_DIR = path.join(ARTIFACTS_ROOT, "apis");
const SEQUENCE_DIR = path.join(ARTIFACTS_ROOT, "sequences");
const TASK_DIR = path.join(ARTIFACTS_ROOT, "tasks");

const TIER_CONFIG = {
  "Tier 0": {
    key: "tier0",
    sequenceName: "run_tier0_health_checks",
    taskName: "ScheduledTier0HealthCheck",
    taskFileName: "scheduled_tier0_health_check.xml",
    intervalSeconds: 60,
    frequencyLabel: "1 min"
  },
  "Tier 1": {
    key: "tier1",
    sequenceName: "run_tier1_health_checks",
    taskName: "ScheduledTier1HealthCheck",
    taskFileName: "scheduled_tier1_health_check.xml",
    intervalSeconds: 180,
    frequencyLabel: "3 min"
  },
  "Tier 2": {
    key: "tier2",
    sequenceName: "run_tier2_health_checks",
    taskName: "ScheduledTier2HealthCheck",
    taskFileName: "scheduled_tier2_health_check.xml",
    intervalSeconds: 600,
    frequencyLabel: "10 min"
  },
  "Tier 3": {
    key: "tier3",
    sequenceName: "run_tier3_health_checks",
    taskName: "ScheduledTier3HealthCheck",
    taskFileName: "scheduled_tier3_health_check.xml",
    intervalSeconds: 1800,
    frequencyLabel: "30 min"
  }
};

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slug(value) {
  return String(value || "api")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function propMap(api) {
  const result = {};

  if (api.additionalPropertiesMap && typeof api.additionalPropertiesMap === "object") {
    Object.assign(result, api.additionalPropertiesMap);
  }

  if (Array.isArray(api.additionalProperties)) {
    for (const prop of api.additionalProperties) {
      if (prop && prop.name) {
        result[prop.name] = prop.value;
      }
    }
  }

  return result;
}

function basicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString("base64");
}

function normalizeCriticality(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (raw === "tier 0" || raw === "tier0" || raw === "0" || raw === "t0") {
    return "Tier 0";
  }

  if (raw === "tier 1" || raw === "tier1" || raw === "1" || raw === "t1") {
    return "Tier 1";
  }

  if (raw === "tier 2" || raw === "tier2" || raw === "2" || raw === "t2") {
    return "Tier 2";
  }

  if (raw === "tier 3" || raw === "tier3" || raw === "3" || raw === "t3") {
    return "Tier 3";
  }

  return null;
}

function isDeprecatedLifecycle(lifecycle) {
  const value = String(lifecycle || "").trim().toUpperCase();
  return value === "DEPRECATED" || value === "DEPRECIATED" || value === "RETIRED";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} calling ${url}: ${body}`);
  }

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${body}`);
  }
}

async function registerRestClient() {
  const body = {
    callbackUrl: "www.google.com",
    clientName: `mi-health-sync-${Date.now()}`,
    owner: APIM_USERNAME,
    grantType: "password refresh_token",
    saasApp: true
  };

  const response = await requestJson(`${APIM_HOST}/client-registration/v0.17/register`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(APIM_USERNAME, APIM_PASSWORD)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.clientId || !response.clientSecret) {
    throw new Error(`DCR response did not include clientId/clientSecret: ${JSON.stringify(response)}`);
  }

  return {
    clientId: response.clientId,
    clientSecret: response.clientSecret
  };
}

async function getAccessToken(clientId, clientSecret) {
  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("username", APIM_USERNAME);
  params.set("password", APIM_PASSWORD);
  params.set("scope", "apim:api_view");

  const response = await requestJson(`${APIM_HOST}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.access_token) {
    throw new Error(`Token response did not include access_token: ${JSON.stringify(response)}`);
  }

  return response.access_token;
}

async function listApis(token) {
  const result = await requestJson(`${APIM_HOST}/api/am/publisher/v4/apis?limit=200`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return result.list || [];
}

async function getApi(token, apiId) {
  return requestJson(`${APIM_HOST}/api/am/publisher/v4/apis/${apiId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

function buildRegistryRecord(api) {
  const p = propMap(api);

  const lifecycle = api.lifeCycleStatus || api.status || "UNKNOWN";
  const deprecated = isDeprecatedLifecycle(lifecycle);

  const enabled = String(p.health_enabled || "").toLowerCase() === "true";

  if (!enabled && !deprecated) {
    return null;
  }

  const criticalityRaw = p.health_criticality || "Tier 2";
  const normalizedCriticality = normalizeCriticality(criticalityRaw);

  if (!normalizedCriticality && !deprecated) {
    throw new Error(
      `Invalid health_criticality for API ${api.name}:${api.version}. ` +
        `Expected Tier 0, Tier 1, Tier 2 or Tier 3. Actual value: ${criticalityRaw}`
    );
  }

  const tierConfig = normalizedCriticality ? TIER_CONFIG[normalizedCriticality] : null;
  const activeProbe = enabled && !deprecated;

  let healthStrategy = null;

  if (activeProbe) {
    const backendUrl = p.health_backend_url;
    const healthPath = p.health_path;

    if (!backendUrl || !healthPath) {
      throw new Error(
        `API ${api.name}:${api.version} has health_enabled=true but is missing health_backend_url or health_path`
      );
    }

    const expectedPayloadRaw = p.health_expected_payload_json || "{}";
    let expectedPayload = {};

    try {
      expectedPayload = JSON.parse(expectedPayloadRaw);
    } catch (e) {
      throw new Error(`Invalid health_expected_payload_json for API ${api.name}:${api.version}: ${expectedPayloadRaw}`);
    }

    const requiredFields = String(p.health_required_fields || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    const healthUrl = `${String(backendUrl).replace(/\/+$/, "")}${healthPath}`;

    healthStrategy = {
      type: "HTTP_HEALTH_CONTRACT",
      method: p.health_method || "GET",
      url: healthUrl,
      expectedHttpStatus: Number(p.health_expected_http_status || 200),
      expectedPayload,
      requiredFields,
      timeoutMs: Number(p.health_timeout_ms || 3000)
    };
  }

  return {
    apiId: api.id,
    name: api.name,
    version: api.version,
    context: api.context,
    domain: p.health_domain || "Unclassified",
    owner: {
      team: p.health_owner_team || "Unknown",
      email: p.health_owner_email || "unknown@example.com"
    },
    criticality: normalizedCriticality || criticalityRaw,
    slaTarget: p.health_sla_target || "99.50%",
    runtime: p.health_runtime || "Unknown",
    lifecycle,
    gatewayUrl: p.health_gateway_url || "",
    healthStrategy,
    probePolicy: {
      active: activeProbe,
      tier: tierConfig ? tierConfig.key : null,
      frequency: activeProbe && tierConfig ? tierConfig.frequencyLabel : "none",
      intervalSeconds: activeProbe && tierConfig ? tierConfig.intervalSeconds : null,
      reason: deprecated
        ? "API lifecycle is deprecated. No active probe is scheduled; status is lifecycle-controlled."
        : "Active probe schedule derived from APIM health_criticality."
    }
  };
}

function renderCheckSequence(record, sequenceName) {
  const expectedPayloadJson = JSON.stringify(record.healthStrategy.expectedPayload);
  const requiredFieldsCsv = record.healthStrategy.requiredFields.join(",");

  return `<?xml version="1.0" encoding="UTF-8"?>
<sequence xmlns="http://ws.apache.org/ns/synapse" name="${xmlEscape(sequenceName)}">
    <property name="apiId" value="${xmlEscape(record.apiId)}" type="STRING"/>
    <property name="apiName" value="${xmlEscape(record.name)}" type="STRING"/>
    <property name="apiVersion" value="${xmlEscape(record.version)}" type="STRING"/>
    <property name="apiDomain" value="${xmlEscape(record.domain)}" type="STRING"/>
    <property name="ownerTeam" value="${xmlEscape(record.owner.team)}" type="STRING"/>
    <property name="ownerEmail" value="${xmlEscape(record.owner.email)}" type="STRING"/>
    <property name="criticality" value="${xmlEscape(record.criticality)}" type="STRING"/>
    <property name="slaTarget" value="${xmlEscape(record.slaTarget)}" type="STRING"/>
    <property name="runtime" value="${xmlEscape(record.runtime)}" type="STRING"/>
    <property name="lifecycle" value="${xmlEscape(record.lifecycle)}" type="STRING"/>
    <property name="gatewayUrl" value="${xmlEscape(record.gatewayUrl)}" type="STRING"/>
    <property name="healthUrl" value="${xmlEscape(record.healthStrategy.url)}" type="STRING"/>
    <property name="probeTier" value="${xmlEscape(record.probePolicy.tier)}" type="STRING"/>
    <property name="checkFrequency" value="${xmlEscape(record.probePolicy.frequency)}" type="STRING"/>
    <property name="expectedHttpStatus" value="${xmlEscape(record.healthStrategy.expectedHttpStatus)}" type="STRING"/>
    <property name="expectedPayloadJson" value="${xmlEscape(expectedPayloadJson)}" type="STRING"/>
    <property name="requiredFields" value="${xmlEscape(requiredFieldsCsv)}" type="STRING"/>

    <script language="js"><![CDATA[
        mc.setProperty("probeStartedAt", String(new Date().getTime()));
    ]]></script>

    <property name="REST_URL_POSTFIX" scope="axis2" action="remove"/>
    <property name="non.error.http.status.codes" value="400,401,403,404,500,502,503,504" scope="axis2" type="STRING"/>

    <call blocking="true">
        <endpoint>
            <http method="${xmlEscape(record.healthStrategy.method)}" uri-template="${xmlEscape(record.healthStrategy.url)}">
                <timeout>
                    <duration>${xmlEscape(record.healthStrategy.timeoutMs)}</duration>
                    <responseAction>fault</responseAction>
                </timeout>
                <suspendOnFailure>
                    <errorCodes>-1</errorCodes>
                    <initialDuration>0</initialDuration>
                    <progressionFactor>1.0</progressionFactor>
                    <maximumDuration>0</maximumDuration>
                </suspendOnFailure>
                <markForSuspension>
                    <errorCodes>-1</errorCodes>
                    <retriesBeforeSuspension>0</retriesBeforeSuspension>
                </markForSuspension>
            </http>
        </endpoint>
    </call>

    <property name="healthHttpStatus" expression="get-property('axis2','HTTP_SC')" type="STRING"/>

    <script language="js"><![CDATA[
        var payload = {};
        try {
            payload = mc.getPayloadJSON();
        } catch (e) {
            payload = {};
        }

        var nowMs = new Date().getTime();
        var startedAt = parseInt(String(mc.getProperty("probeStartedAt") || nowMs), 10);
        var latencyMs = nowMs - startedAt;

        var httpStatus = parseInt(String(mc.getProperty("healthHttpStatus") || "0"), 10);
        var expectedHttpStatus = parseInt(String(mc.getProperty("expectedHttpStatus") || "200"), 10);

        var expectedPayload = {};
        try {
            expectedPayload = JSON.parse(String(mc.getProperty("expectedPayloadJson") || "{}"));
        } catch (e) {
            expectedPayload = {};
        }

        var requiredFieldsRaw = String(mc.getProperty("requiredFields") || "");
        var requiredFields = requiredFieldsRaw.length > 0 ? requiredFieldsRaw.split(",") : [];

        var reasons = [];

        var livenessOk = httpStatus === expectedHttpStatus;
        var expectedPayloadOk = true;
        var requiredFieldsOk = true;

        for (var key in expectedPayload) {
            if (expectedPayload.hasOwnProperty(key)) {
                var actualValue = payload && payload[key] !== undefined ? String(payload[key]) : "";
                var expectedValue = String(expectedPayload[key]);

                if (actualValue !== expectedValue) {
                    expectedPayloadOk = false;
                    reasons.push("Expected payload field '" + key + "' to be '" + expectedValue + "' but got '" + actualValue + "'");
                }
            }
        }

        for (var i = 0; i < requiredFields.length; i++) {
            var field = String(requiredFields[i]).trim();

            if (field.length > 0 && (!payload || payload[field] === undefined)) {
                requiredFieldsOk = false;
                reasons.push("Required payload field is missing: " + field);
            }
        }

        var contractOk = livenessOk && expectedPayloadOk && requiredFieldsOk;

        var livenessStatus = livenessOk ? "OK" : "FAILED";
        var contractStatus = livenessOk ? (contractOk ? "OK" : "FAILED") : "SKIPPED";

        var consumerStatus = "RED";
        var reason = "Unexpected HTTP status from backend health endpoint";

        if (livenessOk && contractOk) {
            consumerStatus = "GREEN";
            reason = "OK";
        } else if (livenessOk && !contractOk) {
            consumerStatus = "YELLOW";
            reason = "Backend returned expected HTTP status but payload did not match expected health contract";
        }

        var result = {
            apiId: String(mc.getProperty("apiId")),
            name: String(mc.getProperty("apiName")),
            version: String(mc.getProperty("apiVersion")),
            domain: String(mc.getProperty("apiDomain")),
            owner: {
                team: String(mc.getProperty("ownerTeam")),
                email: String(mc.getProperty("ownerEmail"))
            },
            runtime: String(mc.getProperty("runtime")),
            criticality: String(mc.getProperty("criticality")),
            slaTarget: String(mc.getProperty("slaTarget")),
            lifecycle: String(mc.getProperty("lifecycle")),
            checkFrequency: String(mc.getProperty("checkFrequency")),
            checkedAt: new Date().toISOString(),
            healthUrl: String(mc.getProperty("healthUrl")),
            liveness: {
                status: livenessStatus,
                httpStatus: httpStatus,
                expectedHttpStatus: expectedHttpStatus,
                latencyMs: latencyMs
            },
            contract: {
                status: contractStatus,
                reasons: reasons,
                expectedPayload: expectedPayload,
                requiredFields: requiredFields,
                actualPayload: payload
            },
            sla: {
                status: consumerStatus === "GREEN" ? "WITHIN_TARGET" : "AT_RISK",
                target: String(mc.getProperty("slaTarget")),
                window: "demo"
            },
            probePolicy: {
                active: true,
                tier: String(mc.getProperty("probeTier")),
                frequency: String(mc.getProperty("checkFrequency"))
            },
            consumerStatus: consumerStatus,
            reason: reason,
            source: "wso2-integrator-mi",
            sourceOfTruth: "wso2-api-manager"
        };

        mc.setProperty("lastHealthResult", JSON.stringify(result));
    ]]></script>

    <payloadFactory media-type="json">
        <format>$1</format>
        <args>
            <arg evaluator="xml" expression="$ctx:lastHealthResult" literal="false"/>
        </args>
    </payloadFactory>

    <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
    <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
    <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
    <property name="REST_URL_POSTFIX" scope="axis2" action="remove"/>
    <property name="non.error.http.status.codes" value="200,201,202,204,400,409,500,502,503,504" scope="axis2" type="STRING"/>

    <call blocking="true">
        <endpoint>
            <http method="POST" uri-template="${xmlEscape(STATUS_CACHE_BASE_URL)}/cache/results"/>
        </endpoint>
    </call>
</sequence>
`;
}

function lifecycleControlledResult(record) {
  return {
    apiId: record.apiId,
    name: record.name,
    version: record.version,
    domain: record.domain,
    owner: record.owner,
    runtime: record.runtime,
    criticality: record.criticality,
    slaTarget: record.slaTarget,
    lifecycle: record.lifecycle,
    checkFrequency: "none",
    checkedAt: null,
    healthUrl: null,
    liveness: {
      status: "SKIPPED",
      httpStatus: null,
      latencyMs: null
    },
    contract: {
      status: "SKIPPED",
      reasons: ["API lifecycle is deprecated; no active health probe is scheduled."]
    },
    sla: {
      status: "LIFECYCLE_CONTROLLED",
      target: record.slaTarget,
      window: "demo"
    },
    probePolicy: record.probePolicy,
    consumerStatus: "DEPRECATED",
    reason: "API lifecycle is deprecated. Status is controlled by API Manager lifecycle, not by active probing.",
    source: "wso2-integrator-mi",
    sourceOfTruth: "wso2-api-manager"
  };
}

function renderRunSequence(sequenceName, activeRecords, lifecycleControlledRecords = []) {
  const calls = activeRecords
    .map((record, index) => {
      const propName = `result_${index}`;
      return `    <sequence key="${xmlEscape(record.sequenceName)}"/>
    <property name="${xmlEscape(propName)}" expression="get-property('lastHealthResult')" type="STRING"/>`;
    })
    .join("\n\n");

  const keys = activeRecords.map((_, index) => `result_${index}`);
  const lifecycleControlled = lifecycleControlledRecords.map(lifecycleControlledResult);

  return `<?xml version="1.0" encoding="UTF-8"?>
<sequence xmlns="http://ws.apache.org/ns/synapse" name="${xmlEscape(sequenceName)}">
${calls}

    <script language="js"><![CDATA[
        var keys = ${JSON.stringify(keys)};
        var lifecycleControlled = ${JSON.stringify(lifecycleControlled)};
        var results = [];

        for (var i = 0; i < keys.length; i++) {
            var raw = mc.getProperty(keys[i]);

            if (raw !== null && raw !== undefined && String(raw).length > 0) {
                try {
                    results.push(JSON.parse(String(raw)));
                } catch (e) {
                    results.push({
                        apiId: keys[i],
                        name: keys[i],
                        checkedAt: new Date().toISOString(),
                        consumerStatus: "UNKNOWN",
                        liveness: {
                            status: "UNKNOWN"
                        },
                        contract: {
                            status: "UNKNOWN"
                        },
                        sla: {
                            status: "UNKNOWN"
                        },
                        reason: "Unable to parse health result in " + "${xmlEscape(sequenceName)}" + ": " + e.message,
                        source: "wso2-integrator-mi",
                        sourceOfTruth: "wso2-api-manager"
                    });
                }
            }
        }

        for (var j = 0; j < lifecycleControlled.length; j++) {
            lifecycleControlled[j].checkedAt = new Date().toISOString();
            results.push(lifecycleControlled[j]);
        }

        mc.setProperty("healthResultsJson", JSON.stringify(results));
    ]]></script>

    <payloadFactory media-type="json">
        <format>$1</format>
        <args>
            <arg evaluator="xml" expression="$ctx:healthResultsJson" literal="false"/>
        </args>
    </payloadFactory>

    <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
    <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
    <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
    <property name="REST_URL_POSTFIX" scope="axis2" action="remove"/>
    <property name="non.error.http.status.codes" value="200,201,202,204,400,409,500,502,503,504" scope="axis2" type="STRING"/>

    <call blocking="true">
        <endpoint>
            <http method="POST" uri-template="${xmlEscape(STATUS_CACHE_BASE_URL)}/cache/results"/>
        </endpoint>
    </call>

    <payloadFactory media-type="json">
        <format>$1</format>
        <args>
            <arg evaluator="xml" expression="$ctx:healthResultsJson" literal="false"/>
        </args>
    </payloadFactory>

    <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
    <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
    <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
</sequence>
`;
}

function renderScheduledTask(taskConfig) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<task xmlns="http://ws.apache.org/ns/synapse"
      name="${xmlEscape(taskConfig.taskName)}"
      class="org.apache.synapse.startup.tasks.MessageInjector"
      group="synapse.simple.quartz">

    <trigger interval="${xmlEscape(taskConfig.intervalSeconds)}"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="injectTo"
              value="sequence"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="sequenceName"
              value="${xmlEscape(taskConfig.sequenceName)}"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="sequential"
              value="true"/>

    <property xmlns:task="http://www.wso2.org/products/wso2commons/tasks"
              name="message">
        <healthCheckTrigger xmlns="">
            <source>scheduled-task</source>
            <tier>${xmlEscape(taskConfig.key)}</tier>
            <frequency>${xmlEscape(taskConfig.frequencyLabel)}</frequency>
            <intervalSeconds>${xmlEscape(taskConfig.intervalSeconds)}</intervalSeconds>
        </healthCheckTrigger>
    </property>
</task>
`;
}

function renderHealthRegistryApi(records) {
  const registryJson = JSON.stringify(records, null, 2);

  return `<?xml version="1.0" encoding="UTF-8"?>
<api xmlns="http://ws.apache.org/ns/synapse" name="HealthRegistryAPI" context="/health-registry">
    <resource methods="GET" uri-template="/v1/apis">
        <inSequence>
            <payloadFactory media-type="json">
                <format><![CDATA[${registryJson}]]></format>
            </payloadFactory>
            <property name="NO_ENTITY_BODY" scope="axis2" action="remove"/>
            <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
            <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
            <respond/>
        </inSequence>
    </resource>

    <resource methods="POST" uri-template="/v1/probes/run">
        <inSequence>
            <payloadFactory media-type="json">
                <format>{
                    "message": "Manual full probe execution is disabled for tier-timing validation.",
                    "reason": "Health probes are executed only by scheduled MI tier tasks.",
                    "expectedFlow": "Use GET /catalogue-status/v1/apis to read the latest cached status."
                }</format>
            </payloadFactory>
            <property name="HTTP_SC" value="409" scope="axis2" type="STRING"/>
            <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
            <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
            <respond/>
        </inSequence>
    </resource>

    <resource methods="POST" uri-template="/v1/apis">
        <inSequence>
            <payloadFactory media-type="json">
                <format>{
                    "message": "Direct registration is disabled. API Manager is the source of truth.",
                    "expectedFlow": "Add or update health_* custom properties in WSO2 API Manager and run the APIM-to-MI sync pipeline."
                }</format>
            </payloadFactory>
            <property name="HTTP_SC" value="409" scope="axis2" type="STRING"/>
            <property name="messageType" value="application/json" scope="axis2" type="STRING"/>
            <property name="ContentType" value="application/json" scope="axis2" type="STRING"/>
            <respond/>
        </inSequence>
    </resource>
</api>
`;
}

function cleanGeneratedFiles() {
  fs.mkdirSync(API_DIR, { recursive: true });
  fs.mkdirSync(SEQUENCE_DIR, { recursive: true });
  fs.mkdirSync(TASK_DIR, { recursive: true });

  for (const file of fs.readdirSync(SEQUENCE_DIR)) {
    if (
      file.startsWith("check_") ||
      file === "run_all_health_checks.xml" ||
      /^run_tier[0-3]_health_checks\.xml$/.test(file)
    ) {
      fs.unlinkSync(path.join(SEQUENCE_DIR, file));
    }
  }

  for (const file of fs.readdirSync(TASK_DIR)) {
    if (
      file === "scheduled_health_check.xml" ||
      /^scheduled_tier[0-3]_health_check\.xml$/.test(file)
    ) {
      fs.unlinkSync(path.join(TASK_DIR, file));
    }
  }

  const healthRegistryPath = path.join(API_DIR, "health_registry_api.xml");
  if (fs.existsSync(healthRegistryPath)) {
    fs.unlinkSync(healthRegistryPath);
  }
}

function groupActiveRecordsByTier(records) {
  const groups = {
    tier0: [],
    tier1: [],
    tier2: [],
    tier3: []
  };

  for (const record of records) {
    if (!record.probePolicy.active) {
      continue;
    }

    if (!groups[record.probePolicy.tier]) {
      throw new Error(`Unsupported probe tier for API ${record.name}: ${record.probePolicy.tier}`);
    }

    groups[record.probePolicy.tier].push(record);
  }

  return groups;
}

async function main() {
  console.log(`[sync-mi-health-from-apim] APIM_HOST=${APIM_HOST}`);
  console.log(`[sync-mi-health-from-apim] ARTIFACTS_ROOT=${ARTIFACTS_ROOT}`);
  console.log(`[sync-mi-health-from-apim] STATUS_CACHE_BASE_URL=${STATUS_CACHE_BASE_URL}`);

  const client = await registerRestClient();
  const token = await getAccessToken(client.clientId, client.clientSecret);

  const apiSummaries = await listApis(token);
  const fullApis = [];

  for (const summary of apiSummaries) {
    if (!summary.id) {
      continue;
    }

    const api = await getApi(token, summary.id);
    fullApis.push(api);
  }

  const records = fullApis
    .map(buildRegistryRecord)
    .filter(Boolean)
    .map((record) => {
      if (!record.probePolicy.active) {
        return record;
      }

      return {
        ...record,
        sequenceName: `check_${slug(record.name)}_${slug(record.version)}`
      };
    });

  const activeRecords = records.filter((record) => record.probePolicy.active);
  const lifecycleControlledRecords = records.filter((record) => !record.probePolicy.active);
  const tierGroups = groupActiveRecordsByTier(records);

  cleanGeneratedFiles();

  for (const record of activeRecords) {
    const filePath = path.join(SEQUENCE_DIR, `${record.sequenceName}.xml`);
    fs.writeFileSync(filePath, renderCheckSequence(record, record.sequenceName));
    console.log(`[sync-mi-health-from-apim] generated ${filePath}`);
  }

  for (const criticality of Object.keys(TIER_CONFIG)) {
    const config = TIER_CONFIG[criticality];
    const tierRecords = tierGroups[config.key];

    fs.writeFileSync(
      path.join(SEQUENCE_DIR, `${config.sequenceName}.xml`),
      renderRunSequence(config.sequenceName, tierRecords)
    );

    console.log(
      `[sync-mi-health-from-apim] generated tier sequence ${config.sequenceName}.xml with ${tierRecords.length} APIs, interval=${config.frequencyLabel}`
    );

    if (tierRecords.length > 0) {
      fs.writeFileSync(
        path.join(TASK_DIR, config.taskFileName),
        renderScheduledTask(config)
      );

      console.log(
        `[sync-mi-health-from-apim] generated task ${config.taskFileName}, interval=${config.intervalSeconds}s`
      );
    }
  }

  fs.writeFileSync(
    path.join(SEQUENCE_DIR, "run_all_health_checks.xml"),
    renderRunSequence("run_all_health_checks", activeRecords, lifecycleControlledRecords)
  );

  fs.writeFileSync(
    path.join(API_DIR, "health_registry_api.xml"),
    renderHealthRegistryApi(records)
  );

  console.log("");
  console.log("[sync-mi-health-from-apim] summary");
  console.log(`  Active probes: ${activeRecords.length}`);
  console.log(`  Lifecycle-controlled APIs: ${lifecycleControlledRecords.length}`);
  console.log(`  Tier 0 / 1 min: ${tierGroups.tier0.length}`);
  console.log(`  Tier 1 / 3 min: ${tierGroups.tier1.length}`);
  console.log(`  Tier 2 / 10 min: ${tierGroups.tier2.length}`);
  console.log(`  Tier 3 / 30 min: ${tierGroups.tier3.length}`);
  console.log(`[sync-mi-health-from-apim] generated ${records.length} APIM-sourced health registry records`);
}

main().catch((error) => {
  console.error("[sync-mi-health-from-apim] failed");
  console.error(error);
  process.exit(1);
});