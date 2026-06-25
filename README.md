# WSO2 API Catalogue Modernization Demo

This repository contains an end-to-end WSO2 API Catalogue modernization demo.

It demonstrates how API teams can onboard APIs through a governed API-as-code process, using **WSO2 API Manager as the source of truth** and **WSO2 Integrator / Integrator as the operational health validation layer**.

The demo covers:

* 5 mocked banking APIs implemented in JavaScript/Node.js.
* WSO2 API Manager 4.7 for API lifecycle, catalogue, governance and gateway exposure.
* APICTL projects for importing APIs into WSO2 API Manager.
* API metadata and health strategy stored as API Manager custom properties.
* WSO2 Integrator / Micro Integrator 4.6 executing tiered scheduled health checks generated from API Manager metadata.
* A cache-backed catalogue UI that reads the latest known MI health result without triggering probes.
* A CI/CD-style onboarding flow that validates API artifacts before importing them.
* Progressive API onboarding:
  * Deploy 3 APIs first.
  * Deploy a 4th API later.
  * Attempt to deploy a 5th API with missing metadata and fail.
  * Fix the API metadata and deploy successfully.
* Consumer-facing API health states: `GREEN`, `YELLOW`, `RED` and lifecycle-controlled statuses such as `DEPRECATED`.

---

## Current architecture

```text
Developer Git repository
   ↓
API-as-code artifacts
   ↓
CI/CD-style onboarding scripts
   ↓
OpenAPI + APIM health metadata validation
   ↓
WSO2 API Manager 4.7
   ↓
Source of truth for API catalogue, lifecycle and health strategy
   ↓
APIM-to-MI one-shot reconciliation
   ↓
Generated WSO2 Integrator artifacts
   ↓
WSO2 Integrator / Micro Integrator 4.6
   ↓
Tiered scheduled health checks
   ↓
health-status-cache
   ↓
Catalogue UI
```

The runtime responsibility split is:

```text
WSO2 API Manager
  = source of truth for API metadata, lifecycle and health strategy

APIM-to-MI sync script
  = reads API Manager metadata and generates MI artifacts

WSO2 Integrator / MI
  = executes tiered scheduled health checks

health-status-cache
  = stores the latest known MI health reading per API

Catalogue UI
  = reads the latest known status only; it does not trigger probes
```

---

## Important behavior

The current demo intentionally avoids having the UI trigger health checks.

The UI reads only cached status:

```text
Catalogue UI
  → /catalogue-status/v1/apis
  → health-status-cache
  → latest known MI readings
```

The actual probes are executed only by WSO2 Integrator scheduled tasks:

```text
MI scheduled task
  → generated tier sequence
  → generated per-API check sequence
  → mocked backend /health endpoint
  → health-status-cache
```

Manual full-probe execution is disabled:

```text
POST /health-registry/v1/probes/run
  → HTTP 409 Conflict
```

This prevents browser refreshes, manual curl calls or old UI code from forcing all APIs to be checked at the same time.

---

## Runtime components

| Component | Purpose | URL / Port |
| --- | --- | --- |
| Accounts API | Mocked banking API | `http://localhost:5101/accounts/v1` |
| Payments API | Mocked banking API | `http://localhost:5102/payments/v1` |
| Customers API | Mocked banking API | `http://localhost:5103/customers/v1` |
| Cards API | Mocked banking API | `http://localhost:5104/cards/v1` |
| Loans API | Mocked banking API | `http://localhost:5105/loans/v1` |
| WSO2 API Manager Publisher | API lifecycle and publishing | `https://localhost:9443/publisher` |
| WSO2 API Manager Developer Portal | API discovery and subscription | `https://localhost:9443/devportal` |
| WSO2 API Manager Carbon Console | Admin console | `https://localhost:9443/carbon` |
| WSO2 Integrator Health Registry API | APIM-sourced registry metadata | `http://localhost:8290/health-registry/v1/apis` |
| WSO2 Integrator Catalogue Status API | Last known cached status through MI | `http://localhost:8290/catalogue-status/v1/apis` |
| Health Status Cache | Latest known MI readings | `http://localhost:6300/cache/results` |
| Catalogue UI | Demo UI | `http://localhost:5174` |

Default credentials:

```text
admin / admin
```

---

## Mocked APIs

| API | Port | Context | Criticality | Schedule |
| --- | ---: | --- | --- | --- |
| Accounts API | 5101 | `/accounts/v1` | Tier 0 | 1 min |
| Payments API | 5102 | `/payments/v1` | Tier 0 | 1 min |
| Customers API | 5103 | `/customers/v1` | Tier 1 | 3 min |
| Cards API | 5104 | `/cards/v1` | Tier 1 | 3 min |
| Loans API | 5105 | `/loans/v1` | Tier 2 | 10 min |

Each mocked API exposes:

* `GET <context>/health`
* business endpoints
* `GET <context>/openapi.json`
* `POST <context>/__admin/health-mode`

The health mode endpoint supports:

```text
healthy
wrongPayload
down
```

Example:

```bash
curl http://localhost:5101/accounts/v1/health

curl -X POST http://localhost:5101/accounts/v1/__admin/health-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"wrongPayload"}'
```

---

## Removed old local service

This demo no longer uses the old local `integrator-local` service.

These old endpoints are no longer used:

```text
http://localhost:6200/api-status/v1/apis
http://localhost:6200/api-health-registry/v1/apis
```

Use these instead:

```text
http://localhost:8290/health-registry/v1/apis
http://localhost:8290/catalogue-status/v1/apis
http://localhost:6300/cache/results
http://localhost:5174
```

---

## Project structure

```text
.
├── apis/
│   ├── accounts-api/
│   ├── payments-api/
│   ├── customers-api/
│   ├── cards-api/
│   └── loans-api/
│
├── apictl/
│   └── apis/
│       ├── accounts-api/
│       ├── payments-api/
│       ├── customers-api/
│       ├── cards-api/
│       └── loans-api/
│
├── health-status-cache/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
│
├── pipeline/
│   └── scripts/
│       ├── deploy-selected-to-apim.sh
│       ├── deploy-initial-3-to-apim.sh
│       ├── deploy-cards-later-to-apim.sh
│       ├── deploy-loans-later-to-apim.sh
│       ├── sync-mi-health-from-apim.js
│       └── watch-apim-mi-sync.sh
│
├── ui/
│
├── wso2-integrator/
│   └── catalogue-health-mi/
│       └── src/main/wso2mi/artifacts/
│           ├── apis/
│           ├── sequences/
│           └── tasks/
│
├── docker-compose.yml
└── package.json
```

---

## API Manager health metadata

Each APICTL API project contains an `api.yaml`.

The `api.yaml` contains APIM custom properties under `additionalProperties`.

These properties define the health strategy that WSO2 Integrator will execute.

Example:

```yaml
additionalProperties:
  - name: health_enabled
    value: "true"
    display: true
  - name: health_backend_url
    value: "http://accounts-api:5101"
    display: false
  - name: health_path
    value: "/accounts/v1/health"
    display: true
  - name: health_method
    value: "GET"
    display: true
  - name: health_expected_http_status
    value: "200"
    display: true
  - name: health_expected_payload_json
    value: '{"status":"UP","service":"accounts-api"}'
    display: true
  - name: health_required_fields
    value: "status,service,timestamp"
    display: true
  - name: health_sla_target
    value: "99.95%"
    display: true
  - name: health_criticality
    value: "Tier 0"
    display: true
  - name: health_runtime
    value: "Kubernetes"
    display: true
  - name: health_domain
    value: "Retail Banking"
    display: true
  - name: health_owner_team
    value: "Accounts Platform Team"
    display: true
  - name: health_owner_email
    value: "accounts-platform@bank.example"
    display: true
```

---

## Required health metadata

The onboarding script validates that each API contains these properties:

```text
health_enabled
health_backend_url
health_path
health_method
health_expected_http_status
health_expected_payload_json
health_required_fields
health_sla_target
health_criticality
health_runtime
health_domain
health_owner_team
health_owner_email
```

If an API is missing required health metadata, it is rejected before import.

This demonstrates that incomplete operational metadata does not enter the governed API catalogue.

---

## WSO2 Integrator generated artifacts

The APIM-to-MI sync script reads WSO2 API Manager and generates WSO2 Integrator artifacts.

Generated files include:

```text
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/check_*.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier0_health_checks.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier1_health_checks.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier2_health_checks.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier3_health_checks.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_all_health_checks.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_tier*_health_check.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/health_registry_api.xml
```

Do not manually edit generated `check_*.xml`, `run_tier*.xml`, task files or `health_registry_api.xml`.

The source of truth is API Manager. If API metadata changes, run a one-shot reconciliation.

This file is manually maintained and should remain in place:

```text
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/catalogue_status_api.xml
```

---

## Health-check schedules

The generated MI tasks use tier-based schedules:

| Criticality | Frequency | Purpose |
| --- | ---: | --- |
| Tier 0 | 60 seconds | Most critical APIs |
| Tier 1 | 180 seconds | Important business APIs |
| Tier 2 | 600 seconds | Lower criticality APIs |
| Tier 3 | 1800 seconds | Lowest criticality APIs |

After an MI restart, the first checks may fire close together. This is normal.

For timing validation, ignore the initial startup burst and observe the cache over several minutes.

---

## Prerequisites

Install:

* Docker Desktop
* Node.js and npm
* `jq`

On macOS:

```bash
brew install jq
```

---

## Install dependencies

From the project root:

```bash
npm install
```

---

## Recommended `package.json` behavior

The onboarding commands should import APIs and perform one one-shot reconciliation automatically.

The important behavior is:

```text
platform:onboard:* = import into APIM + reconcile once + recreate MI/UI once + stop
```

Do not keep a continuous watcher running during tier timing tests.

Recommended scripts:

```json
{
  "platform:up": "docker-compose --profile platform up -d --build",
  "platform:down": "docker-compose --profile platform down -v --remove-orphans",

  "platform:import:all": "docker-compose --profile platform run --rm -e APIM_ALLOW_INSECURE_TLS=true apictl \"bash pipeline/scripts/deploy-all-to-apim.sh\"",
  "platform:import:initial3": "docker-compose --profile platform run --rm -e APIM_ALLOW_INSECURE_TLS=true apictl \"bash pipeline/scripts/deploy-initial-3-to-apim.sh\"",
  "platform:import:cards": "docker-compose --profile platform run --rm -e APIM_ALLOW_INSECURE_TLS=true apictl \"bash pipeline/scripts/deploy-cards-later-to-apim.sh\"",
  "platform:import:loans": "docker-compose --profile platform run --rm -e APIM_ALLOW_INSECURE_TLS=true apictl \"bash pipeline/scripts/deploy-loans-later-to-apim.sh\"",

  "platform:reconcile-once": "docker-compose --profile platform run --rm -e APIM_ALLOW_INSECURE_TLS=true apictl \"node pipeline/scripts/sync-mi-health-from-apim.js\" && docker-compose --profile platform up -d --force-recreate wso2-integrator ui-platform",

  "platform:onboard": "npm run platform:import:all && npm run platform:reconcile-once",
  "platform:onboard:initial3": "npm run platform:import:initial3 && npm run platform:reconcile-once",
  "platform:onboard:cards": "npm run platform:import:cards && npm run platform:reconcile-once",
  "platform:onboard:loans": "npm run platform:import:loans && npm run platform:reconcile-once",

  "platform:sync-health": "npm run platform:reconcile-once",

  "platform:watch-sync": "echo 'Do not use platform:watch-sync during tier timing tests. Use platform:onboard:* or platform:reconcile-once instead.'",

  "platform:apictl": "docker-compose --profile platform run --rm apictl \"apictl version\"",
  "platform:logs:apim": "docker-compose --profile platform logs -f wso2-apim",
  "platform:logs:integrator": "docker-compose --profile platform logs -f wso2-integrator"
}
```

---

## Full clean reset

Use this when you want the UI to start empty and APIM to contain no previously imported APIs.

From the project root:

```bash
cd "/Users/joaoluiskuntz/Documents/wso2-api-catalogue-demo(5)"
```

Stop containers and remove volumes:

```bash
docker-compose --profile platform down -v --remove-orphans
docker rm -f wso2-apim-47 wso2-integrator-mi wso2-apictl-runner 2>/dev/null || true
docker rm -f $(docker ps -a --filter "name=wso2-api-catalogue-demo5" -q) 2>/dev/null || true
docker network rm wso2-api-catalogue-demo5_default 2>/dev/null || true
```

Remove generated MI artifacts:

```bash
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/check_*.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_all_health_checks.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier*_health_checks.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_health_check.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_tier*_health_check.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/health_registry_api.xml
```

Keep:

```text
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/catalogue_status_api.xml
```

Remove persistent cache and APICTL volumes explicitly:

```bash
docker volume rm wso2-api-catalogue-demo5_health-cache-data 2>/dev/null || true
docker volume rm wso2-api-catalogue-demo5_apictl-home 2>/dev/null || true
```

Validate clean state:

```bash
docker ps -a | grep -E "wso2-api-catalogue-demo5|wso2-apim|wso2-integrator|wso2-apictl|health-status-cache" || echo "No project containers left"
docker network ls | grep wso2-api-catalogue-demo5 || echo "No project network left"
```

---

## Start the platform

```bash
npm run platform:up
```

Wait for WSO2 API Manager:

```bash
until curl -ksf https://localhost:9443/carbon >/dev/null; do
  echo "Waiting for WSO2 API Manager..."
  sleep 15
done

echo "WSO2 API Manager is ready"
```

Check containers:

```bash
docker-compose --profile platform ps
```

Validate the cache:

```bash
curl http://localhost:6300/health | jq
curl http://localhost:6300/cache/results | jq
```

For a clean start, the cache should be empty:

```json
[]
```

Open the UI:

```text
http://localhost:5174
```

For a clean start, the UI should be empty until APIs are onboarded and MI scheduled tasks populate the cache.

---

## Progressive onboarding demo

This is the main storyline.

### Phase 1 — Onboard the initial 3 APIs

This deploys:

```text
accounts-api
payments-api
customers-api
```

Run:

```bash
npm run platform:onboard:initial3
```

This automatically performs:

```text
1. Import accounts/payments/customers into API Manager.
2. Read API Manager metadata.
3. Generate MI artifacts.
4. Recreate WSO2 Integrator and UI once.
5. Stop.
```

Validate the health registry:

```bash
curl http://localhost:8290/health-registry/v1/apis | jq 'length, .[].name'
```

Expected:

```text
3
"accounts-api"
"customers-api"
"payments-api"
```

Confirm manual full probes are disabled:

```bash
curl -i -X POST http://localhost:8290/health-registry/v1/probes/run
```

Expected:

```text
HTTP/1.1 409 Conflict
```

Wait for scheduled MI tasks to populate cache:

```bash
sleep 30
```

Validate cache directly:

```bash
curl http://localhost:6300/cache/results | jq '.[] | {name, criticality, checkFrequency, checkedAt, cachedAt}'
```

Validate status through MI:

```bash
curl http://localhost:8290/catalogue-status/v1/apis | jq '.[] | {name, criticality, checkFrequency, checkedAt, cachedAt, consumerStatus}'
```

Validate status through the UI route:

```bash
curl http://localhost:5174/catalogue-status/v1/apis | jq '.[] | {name, criticality, checkFrequency, checkedAt, cachedAt, consumerStatus}'
```

Open the UI:

```text
http://localhost:5174
```

The UI should show 3 APIs.

---

### Phase 2 — Onboard `cards-api` later

This simulates a new API team onboarding another API after the initial rollout.

Run:

```bash
npm run platform:onboard:cards
```

Validate:

```bash
curl http://localhost:8290/health-registry/v1/apis | jq 'length, .[].name'
```

Expected:

```text
4
"accounts-api"
"cards-api"
"customers-api"
"payments-api"
```

Wait for MI scheduled tasks to populate/update the cache:

```bash
sleep 30
```

Validate cached status:

```bash
curl http://localhost:6300/cache/results | jq 'length, .[].name'
```

Reload the UI:

```text
http://localhost:5174
```

The UI should now show 4 APIs.

---

### Phase 3 — Try to onboard an invalid `loans-api`

For this part of the demo, `loans-api` should be intentionally incomplete.

Remove this block from:

```text
apictl/apis/loans-api/api.yaml
```

```yaml
  - name: health_expected_payload_json
    value: '{"status":"UP","service":"loans-api"}'
    display: true
```

Or remove it automatically:

```bash
python3 - <<'PY'
from pathlib import Path

path = Path("apictl/apis/loans-api/api.yaml")
text = path.read_text()

lines = text.splitlines()
out = []
skip = False

for line in lines:
    stripped = line.strip()

    if stripped == "- name: health_expected_payload_json":
        skip = True
        continue

    if skip and stripped.startswith("value:"):
        continue

    if skip and stripped.startswith("display:"):
        skip = False
        continue

    out.append(line)

path.write_text("\n".join(out) + "\n")
print("loans-api/api.yaml is now intentionally missing health_expected_payload_json")
PY
```

Confirm it is missing:

```bash
grep -n "health_expected_payload_json" apictl/apis/loans-api/api.yaml || echo "OK: missing as expected"
```

Now attempt to onboard loans:

```bash
npm run platform:onboard:loans
```

Expected failure:

```text
Missing required APIM health metadata property: health_expected_payload_json

APICTL artifact check failed for loans-api.
This API will not be imported into WSO2 API Manager.
```

Validate that it did not enter the registry:

```bash
curl http://localhost:8290/health-registry/v1/apis | jq 'length, .[].name'
```

Expected still:

```text
4
"accounts-api"
"cards-api"
"customers-api"
"payments-api"
```

---

### Phase 4 — Fix `loans-api` and onboard successfully

Add this block back to:

```text
apictl/apis/loans-api/api.yaml
```

```yaml
  - name: health_expected_payload_json
    value: '{"status":"UP","service":"loans-api"}'
    display: true
```

Recommended placement:

```yaml
  - name: health_expected_http_status
    value: "200"
    display: true
  - name: health_expected_payload_json
    value: '{"status":"UP","service":"loans-api"}'
    display: true
  - name: health_required_fields
    value: "status,service,timestamp"
    display: true
```

Or fix it automatically:

```bash
python3 - <<'PY'
from pathlib import Path

path = Path("apictl/apis/loans-api/api.yaml")
text = path.read_text()

if "health_expected_payload_json" in text:
    print("health_expected_payload_json already exists. Nothing to change.")
else:
    marker = '''  - name: health_expected_http_status
    value: "200"
    display: true'''
    insertion = '''  - name: health_expected_http_status
    value: "200"
    display: true
  - name: health_expected_payload_json
    value: '{"status":"UP","service":"loans-api"}'
    display: true'''
    if marker not in text:
        raise SystemExit("Could not find health_expected_http_status block in loans-api/api.yaml")
    text = text.replace(marker, insertion)
    path.write_text(text)
    print("loans-api/api.yaml fixed with health_expected_payload_json")
PY
```

Confirm it exists:

```bash
grep -n "health_expected_payload_json" apictl/apis/loans-api/api.yaml
```

Run the same onboarding command again:

```bash
npm run platform:onboard:loans
```

Expected success:

```text
APICTL artifact check passed for loans-api
Successfully imported/updated loans-api
Generated 5 APIM-sourced health checks
```

Validate registry:

```bash
curl http://localhost:8290/health-registry/v1/apis | jq 'length, .[].name'
```

Expected:

```text
5
"accounts-api"
"cards-api"
"customers-api"
"loans-api"
"payments-api"
```

Wait for scheduled MI tasks to populate/update cache:

```bash
sleep 30
```

Validate UI route:

```bash
curl http://localhost:5174/catalogue-status/v1/apis | jq 'length, .[].name'
```

Reload:

```text
http://localhost:5174
```

The UI should now show 5 APIs.

---

## Tier timing validation

Do not run any command that recreates MI while validating timing.

Do not run:

```bash
npm run platform:watch-sync
npm run platform:sync-health
npm run platform:reconcile-once
docker-compose --profile platform up -d --force-recreate wso2-integrator
```

Do not call:

```bash
curl -X POST http://localhost:8290/health-registry/v1/probes/run
```

It is disabled and should return HTTP 409.

Use this macOS-compatible loop:

```bash
while true; do
  clear
  date
  curl -s http://localhost:6300/cache/results | jq '.[] | {name, criticality, checkFrequency, checkedAt, cachedAt}'
  sleep 10
done
```

Expected after the initial MI startup burst:

```text
accounts-api   Tier 0 / 1 min  → checkedAt changes around every 60 seconds
payments-api   Tier 0 / 1 min  → checkedAt changes around every 60 seconds
customers-api  Tier 1 / 3 min  → checkedAt changes around every 180 seconds
cards-api      Tier 1 / 3 min  → checkedAt changes around every 180 seconds
loans-api      Tier 2 / 10 min → checkedAt changes around every 600 seconds
```

Stop the loop with:

```text
CTRL + C
```

If all APIs keep updating at the same time, something is recreating MI. Check that no continuous watcher is running:

```bash
ps aux | grep watch-apim-mi-sync | grep -v grep || echo "No watcher running"
```

---

## Prove the UI does not trigger probes

Terminal 1:

```bash
docker-compose --profile platform logs -f --tail=0 accounts-api payments-api customers-api cards-api loans-api
```

Terminal 2:

```bash
for i in 1 2 3 4 5; do
  echo "UI cache read $i"
  curl -s http://localhost:5174/catalogue-status/v1/apis >/dev/null
  sleep 2
done
```

Expected: no immediate `/health` calls caused by the UI route.

Then refresh the browser at:

```text
http://localhost:5174
```

Expected: no immediate `/health` calls caused by browser refresh.

If `/health` calls appear at their tier interval, that is expected. Those are MI scheduled tasks.

---

## Health behavior testing

The Integrator classifies API health into consumer-facing states:

| Scenario | Result |
| --- | --- |
| Health endpoint returns expected HTTP status and expected payload | `GREEN` |
| Health endpoint returns HTTP 200 but payload contract is wrong | `YELLOW` |
| Health endpoint returns non-200 or unavailable state | `RED` |

Because manual full-probe execution is disabled, wait for the next scheduled MI task after changing a backend mode.

For `accounts-api`, wait up to 60 seconds because it is Tier 0.

### Test `YELLOW`

Break the accounts API contract:

```bash
curl -X POST http://localhost:5101/accounts/v1/__admin/health-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"wrongPayload"}'
```

Wait for the next Tier 0 scheduled check, then inspect cache:

```bash
sleep 70

curl http://localhost:6300/cache/results | jq '.[] | select(.name=="accounts-api")'
```

Expected:

```text
consumerStatus = YELLOW
liveness.status = OK
contract.status = FAILED
```

### Test `RED`

Break the accounts API endpoint:

```bash
curl -X POST http://localhost:5101/accounts/v1/__admin/health-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"down"}'
```

Wait for the next Tier 0 scheduled check, then inspect cache:

```bash
sleep 70

curl http://localhost:6300/cache/results | jq '.[] | select(.name=="accounts-api")'
```

Expected:

```text
consumerStatus = RED
liveness.status = FAILED
contract.status = SKIPPED
```

### Recover

Return accounts API to normal:

```bash
curl -X POST http://localhost:5101/accounts/v1/__admin/health-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"healthy"}'
```

Wait for the next Tier 0 scheduled check, then inspect cache:

```bash
sleep 70

curl http://localhost:6300/cache/results | jq '.[] | select(.name=="accounts-api")'
```

Expected:

```text
consumerStatus = GREEN
liveness.status = OK
contract.status = OK
```

---

## Direct validation endpoints

### Health registry from MI

```bash
curl http://localhost:8290/health-registry/v1/apis | jq
```

### Last known status from MI

```bash
curl http://localhost:8290/catalogue-status/v1/apis | jq
```

### Last known status from cache

```bash
curl http://localhost:6300/cache/results | jq
```

### Summary from MI

```bash
curl http://localhost:8290/catalogue-status/v1/summary | jq
```

### Summary from cache

```bash
curl http://localhost:6300/cache/summary | jq
```

### UI route

```bash
curl http://localhost:5174/catalogue-status/v1/apis | jq
```

### Names only

```bash
curl http://localhost:5174/catalogue-status/v1/apis | jq 'length, .[].name'
```

### Manual full probe endpoint

```bash
curl -i -X POST http://localhost:8290/health-registry/v1/probes/run
```

Expected:

```text
HTTP/1.1 409 Conflict
```

---

## Useful commands

### Start platform

```bash
npm run platform:up
```

### Stop platform and remove volumes

```bash
npm run platform:down
```

### Onboard initial 3 APIs

```bash
npm run platform:onboard:initial3
```

### Onboard cards later

```bash
npm run platform:onboard:cards
```

### Onboard loans later

```bash
npm run platform:onboard:loans
```

### One-shot APIM-to-MI reconciliation

```bash
npm run platform:reconcile-once
```

### Sync API Manager metadata into Integrator

```bash
npm run platform:sync-health
```

This is an alias for one-shot reconciliation.

Do not run it while validating tier timing because it recreates MI and resets the scheduler.

### Follow API Manager logs

```bash
npm run platform:logs:apim
```

### Follow Integrator logs

```bash
npm run platform:logs:integrator
```

---

## API Manager access

Open:

```text
https://localhost:9443/publisher
```

Login:

```text
admin / admin
```

The APIs appear in Publisher only after they are onboarded through the APICTL scripts.

---

## WSO2 Integrator access

The Integrator exposes:

```text
GET  /catalogue-status/v1/apis
GET  /catalogue-status/v1/summary
GET  /health-registry/v1/apis
POST /health-registry/v1/probes/run
```

Important:

```text
POST /health-registry/v1/probes/run returns HTTP 409 by design.
```

Examples:

```bash
curl http://localhost:8290/catalogue-status/v1/apis | jq
curl http://localhost:8290/catalogue-status/v1/summary | jq
curl http://localhost:8290/health-registry/v1/apis | jq
curl -i -X POST http://localhost:8290/health-registry/v1/probes/run
```

---

## APIM-to-MI sync behavior

The sync script is:

```text
pipeline/scripts/sync-mi-health-from-apim.js
```

It performs these steps:

```text
1. Connects to WSO2 API Manager.
2. Registers/uses an OAuth client.
3. Gets an access token.
4. Lists APIs from the Publisher REST API.
5. Reads each full API definition.
6. Extracts health_* custom properties.
7. Generates per-API health check sequences.
8. Generates tier orchestration sequences.
9. Generates tier scheduled tasks.
10. Generates health_registry_api.xml.
```

For the local demo, the script disables APIM certificate validation when:

```text
APIM_ALLOW_INSECURE_TLS=true
```

This is needed because the local APIM container uses a self-signed certificate.

For production, use a trusted certificate instead of disabling TLS validation.

---

## CI/CD story

The demo models a CI/CD process where:

```text
1. API team commits APICTL project.
2. Pipeline validates required API metadata.
3. Pipeline imports the API into WSO2 API Manager.
4. API Manager becomes the source of truth.
5. Pipeline performs one-shot APIM-to-MI reconciliation.
6. WSO2 Integrator executes tiered scheduled health checks.
7. Health status cache stores latest known readings.
8. Catalogue UI reflects only successfully governed APIs.
```

The key point is:

```text
If an API is missing required operational metadata, it does not enter API Manager and does not appear in the operational catalogue.
```

---

## Why this design

This design separates responsibilities clearly:

```text
WSO2 API Manager
  API lifecycle
  API catalogue
  API governance
  API publication
  API metadata source of truth

WSO2 Integrator
  Health check execution
  Synthetic validation
  Contract validation
  Status normalization
  Tiered scheduled checks

health-status-cache
  Latest known health readings
  Stable UI read model
  No direct probe execution from UI

Catalogue UI
  Consumer-facing API visibility
  Operational status display
  Cache reader only
```

This avoids making the UI an operational execution trigger.

New APIs are onboarded through API Manager metadata and synchronized into MI through a one-shot reconciliation process.

---

## Docker Compose container names

Docker Compose may create containers such as:

```text
wso2-api-catalogue-demo5-accounts-api-1
wso2-api-catalogue-demo5-payments-api-1
wso2-api-catalogue-demo5-health-status-cache-1
```

The `-1` suffix is normal. It means Compose replica number 1.

Inside Docker networking, services communicate using service names, for example:

```text
http://accounts-api:5101
http://payments-api:5102
http://health-status-cache:6300
```

The suffix does not affect the demo.

---

## Apple Silicon / Docker Desktop troubleshooting

The WSO2 product containers use `linux/amd64`.

If you are on Apple Silicon and Docker behaves inconsistently, run:

```bash
docker-compose --profile platform down -v --remove-orphans
docker builder prune -af
docker-compose --profile platform up -d --build
```

If the APICTL runner needs to be rebuilt:

```bash
docker-compose --profile platform build --no-cache apictl
```

---

## Troubleshooting

### UI starts with APIs already displayed

This is usually because the cache volume still has previous readings or generated MI artifacts still exist on the host filesystem.

Clear only the UI cache:

```bash
curl -X DELETE http://localhost:6300/cache/results | jq
```

Or perform the full clean reset described earlier.

### Network is still in use

Stop any watcher terminal first.

Then run:

```bash
docker-compose --profile platform down -v --remove-orphans
docker rm -f wso2-apim-47 wso2-integrator-mi wso2-apictl-runner 2>/dev/null || true
docker rm -f $(docker ps -a --filter "name=wso2-api-catalogue-demo5" -q) 2>/dev/null || true
docker network inspect wso2-api-catalogue-demo5_default \
  --format '{{range $id, $c := .Containers}}{{$id}} {{end}}' \
  2>/dev/null | xargs docker rm -f 2>/dev/null || true
docker network rm wso2-api-catalogue-demo5_default 2>/dev/null || true
```

### APIM DCR or token request times out

API Manager can take longer than `/carbon` readiness to initialize all internal APIs.

Wait and retry:

```bash
sleep 60
npm run platform:onboard:initial3
```

### APIM self-signed certificate error

If the sync script fails with:

```text
DEPTH_ZERO_SELF_SIGNED_CERT
```

Run with:

```bash
docker-compose --profile platform run --rm -e APIM_ALLOW_INSECURE_TLS=true apictl \
  "node pipeline/scripts/sync-mi-health-from-apim.js"
```

### All APIs update at the same time forever

A continuous watcher or repeated MI recreate is probably running.

Check:

```bash
ps aux | grep watch-apim-mi-sync | grep -v grep || echo "No watcher running"
```

Do not run these during timing validation:

```bash
npm run platform:watch-sync
npm run platform:sync-health
npm run platform:reconcile-once
docker-compose --profile platform up -d --force-recreate wso2-integrator
```

### Only one API appears in the UI

Check the registry:

```bash
curl http://localhost:8290/health-registry/v1/apis | jq 'length, .[].name'
```

Check the cache:

```bash
curl http://localhost:6300/cache/results | jq 'length, .[].name'
```

If the registry has the API but the cache does not, wait for the next scheduled task for that API tier.

If the registry does not have the API, run the appropriate onboarding command again:

```bash
npm run platform:onboard:initial3
npm run platform:onboard:cards
npm run platform:onboard:loans
```

### `integrator-local` path not found

This means your compose file still references the old local service.

The current demo should not include:

```text
integrator-local
integrator-data
```

Validate:

```bash
grep -n "integrator-local" docker-compose.yml
```

Expected: no output.

### UI should be opened on port 5174

Use:

```text
http://localhost:5174
```

Do not use the old direct UI path:

```text
http://localhost:5173
```

---

## Demo narrative

The final demo story is:

```text
1. The platform starts with WSO2 API Manager, WSO2 Integrator, mocked banking APIs, health-status-cache and the catalogue UI.
2. The UI starts empty after a clean reset.
3. Three APIs are onboarded through APICTL.
4. API Manager stores their lifecycle and health metadata.
5. The onboarding command performs one-shot APIM-to-MI reconciliation.
6. WSO2 Integrator executes tiered scheduled checks.
7. The cache stores the latest known readings.
8. The UI shows the three governed APIs.
9. A fourth API is onboarded later and appears after reconciliation and scheduled checks.
10. A fifth API is attempted with missing metadata and is rejected before import.
11. The metadata is fixed.
12. The same onboarding command is rerun.
13. The fifth API is imported, synchronized and shown in the catalogue.
14. Health tests prove GREEN, YELLOW and RED behavior.
15. Tier timing proves that Tier 0, Tier 1 and Tier 2 APIs are checked at different frequencies.
```

This demonstrates a governed, production-style API catalogue modernization pattern using WSO2 API Manager and WSO2 Integrator.
