# WSO2 API Catalogue Modernization Demo

This repository contains an end-to-end WSO2 API catalogue modernization demo.

It demonstrates how API teams can move from a static spreadsheet-style API inventory to a governed API operating model using:

* **WSO2 API Manager 4.7** as the API control plane, catalogue, lifecycle manager, gateway, subscription layer and source of truth.
* **WSO2 Integrator / Micro Integrator 4.6** as the operational orchestration layer for scheduled health checks, contract validation, status normalization and integration APIs.
* A lightweight **health-status-cache** as the read model for the catalogue UI, including latest status, history and SLA-style windows.
* A thin **catalogue UI** that reads APIM-sourced metadata and MI-sourced cached health data without triggering live probes.

The demo is intentionally designed for conversations with customers that need to catalogue, govern and observe a heterogeneous API estate across AWS, Kubernetes, Azure, VMs, legacy backends and future WSO2-managed gateway runtimes.

---

## What this demo proves

The demo proves the following architecture pattern:

```text
API teams
  ↓
Git / API-as-code artifacts
  ↓
Local APIOps validation
  ↓
Optional APIM governance dry run
  ↓
WSO2 API Manager 4.7
  ↓
Source of truth for API catalogue, lifecycle, metadata, governance and access
  ↓
Developer Portal + subscriptions + APIM Gateway invocation
  ↓
APIM-to-MI one-shot reconciliation
  ↓
Generated WSO2 Integrator health artifacts
  ↓
WSO2 Integrator / Micro Integrator 4.6
  ↓
Tiered scheduled liveness and contract checks
  ↓
health-status-cache
  ↓
Catalogue UI, SLA views and operational summaries
```

The key message is:

```text
WSO2 API Manager owns API governance and consumer access.
WSO2 Integrator owns operational health orchestration and integration composition.
The UI reads operational state; it never executes probes.
```

---


## Current final architecture and demo flow

The current implementation uses **WSO2 API Manager as the active source of truth** and uses the **Developer Portal subscription model** to decide what appears in the catalogue UI.

The final runtime flow is:

```text
Fresh platform restart
  ↓
APIM, MI, cache, platform-control, UI and mocked APIs start
  ↓
APIM API categories are preloaded
  ↓
Service Catalog bootstrap runs best-effort
  ↓
UI opens empty
  ↓
User manually onboards APIs from the UI
  ↓
API is imported/published in APIM
  ↓
API is assigned an APIM API Category
  ↓
API is subscribed to API Catalogue Application in DevPortal
  ↓
Fresh APIM Gateway revision is created and deployed
  ↓
Runtime OAuth token is regenerated for the subscribed API set
  ↓
MI artifacts are generated from APIM + DevPortal state
  ↓
MI invokes the APIM Gateway, not the raw backend
  ↓
health-status-cache stores the result
  ↓
UI displays the APIM/DevPortal-governed view
```

Important current rules:

```text
Fresh restart does not import APIs.
Fresh restart does not publish APIs.
Fresh restart does not subscribe APIs.
Fresh restart does preload APIM API Categories.
Fresh restart does clear stale Gateway token cache.
Fresh restart leaves the UI empty.
Manual onboarding is the action that makes APIs appear.
```

The UI should therefore be empty immediately after:

```bash
./scripts/full-restart-with-service-catalog.sh
```

Validate:

```bash
curl -s http://localhost:6400/api/catalogue-status/apis | jq .
```

Expected before manual onboarding:

```json
[]
```

After manual onboarding and sync/evaluate, expected rows contain:

```text
domain/category from APIM API Category
runtime from APIM/DevPortal Gateway environment
liveness from APIM Gateway invocation
contract from APIM Gateway payload validation
healthBrowserUrl from APIM published HTTPS endpoint
secureHealthInvokeUrl from platform-control OAuth proxy
```

---

## Demo capabilities

The repository demonstrates:

* Five mocked banking APIs implemented in JavaScript/Node.js.
* APICTL projects for importing APIs into WSO2 API Manager.
* API metadata and health strategy stored as API Manager custom properties.
* Local APIOps validation for mandatory catalogue and health metadata.
* Optional APIM governance dry-run using `apictl import api --dry-run`.
* WSO2 API Manager Publisher, Developer Portal and Gateway flow.
* Developer Portal application creation, subscription, key generation and gateway invocation smoke test.
* WSO2 Integrator scheduled health checks generated from APIM metadata.
* Tier-based probe schedules: Tier 0, Tier 1, Tier 2 and Tier 3.
* Consumer-facing statuses: `GREEN`, `YELLOW`, `RED`, `DEPRECATED` and `UNKNOWN`.
* Separation between platform readiness, gateway readiness, backend liveness, payload contract status and SLA-style status.
* Cache-backed catalogue status with latest readings, history, summaries and SLA-style calculations.
* A WSO2 Integrator Customer 360 composite integration API.
* Service Catalog metadata for publishing the Integrator service into APIM.
* Optional OpenTelemetry Collector profile for observability demos.
* Progressive API onboarding:
  * onboard 3 APIs first;
  * onboard a 4th API later;
  * attempt to onboard a 5th API with missing metadata and fail;
  * fix the metadata and onboard successfully.

---

## Runtime responsibility split

| Responsibility | Component |
| --- | --- |
| API inventory source of truth | WSO2 API Manager |
| API lifecycle | WSO2 API Manager Publisher |
| API discovery | WSO2 API Manager Developer Portal and/or custom catalogue UI |
| Subscriptions and application access | WSO2 API Manager Developer Portal |
| Runtime API exposure | WSO2 API Gateway |
| API metadata and health strategy | APIM custom properties in `api.yaml` |
| Local metadata validation | `pipeline/scripts/enhanced-governance-check.js` |
| APIM governance compliance check | `pipeline/scripts/apictl-governance-dry-run.sh` |
| APIM-to-MI reconciliation | `pipeline/scripts/sync-mi-health-from-apim.js` |
| Health probe execution | WSO2 Integrator / Micro Integrator scheduled tasks |
| Contract validation | WSO2 Integrator generated sequences |
| Latest operational state | `health-status-cache` |
| History and SLA-style windows | `health-status-cache` |
| UI read model | Catalogue UI via MI/cache endpoints |
| Integration composition | WSO2 Integrator Customer 360 API |
| Integration-to-APIM exposure | WSO2 Integrator Service Catalog metadata |

---

## Important behavior
The UI intentionally does **not** execute live health probes as a side effect of browser refresh or catalogue reads.

The UI reads the governed status model through `platform-control`:

```text
Catalogue UI
  → platform-control /api/catalogue-status/apis
  → APIM Publisher metadata
  → APIM Developer Portal subscriptions
  → APIM Gateway deployment metadata
  → MI/cache operational state
  → health-status-cache latest readings
```

The actual API health checks are executed by WSO2 Integrator / Micro Integrator:

```text
MI scheduled task or explicit operator probe
  → generated tier orchestration sequence
  → generated per-API check sequence
  → APIM Gateway endpoint
  → APIM subscription/auth validation
  → mocked backend
  → response payload validation
  → health-status-cache
```

The current demo **does support an explicit operator-triggered probe**:

```bash
npm run platform:probe
```

or directly:

```bash
curl -s -X POST http://localhost:8290/health-registry/v1/probes/run | jq .
```

Expected:

```json
{
  "status": "COMPLETED",
  "message": "Manual full probe execution completed",
  "source": "health-registry-api"
}
```

This is different from a UI refresh. The UI remains a read model. Manual probe execution is an intentional operator/demo action.

The UI also exposes a clickable APIM health URL in the side panel. Because a normal browser link cannot attach an OAuth bearer token, the link opens a local `platform-control` proxy route:

```text
Displayed URL:
  https://localhost:8243/cards/v1/1.0.0/health

Clicked URL:
  http://localhost:6400/api/gateway/invoke?apiName=cards-api&target=health

platform-control then calls APIM Gateway with:
  Authorization: Bearer <runtime application token>
```

---

## Platform health vs API health

This demo separates these signals:

| Signal | Meaning | Demo mechanism |
| --- | --- | --- |
| Platform readiness | APIM, MI and cache are reachable | `npm run platform:readiness` |
| Gateway readiness | Gateway is ready for deployed APIs | APIM gateway readiness endpoint where applicable |
| Backend liveness | Backend `/health` responds | MI scheduled liveness probe |
| Contract health | Backend payload matches expected fields/body | MI generated validation logic |
| Consumer-facing status | Simplified catalogue badge | `GREEN`, `YELLOW`, `RED`, etc. |
| SLA-style status | Availability and latency over cached samples | `/cache/sla`, `/cache/sla/breaches` |

This is intentional. A healthy APIM node does not guarantee that every API is deployed, that every backend is alive, or that the backend response is semantically correct.

---

## Runtime components
| Component | Purpose | URL / Port |
| --- | --- | --- |
| Accounts API | Mocked banking API | `http://localhost:5101/accounts/v1` |
| Payments API | Mocked banking API | `http://localhost:5102/payments/v1` |
| Customers API | Mocked banking API | `http://localhost:5103/customers/v1` |
| Cards API | Mocked banking API | `http://localhost:5104/cards/v1` |
| Loans API | Mocked banking API | `http://localhost:5105/loans/v1` |
| WSO2 API Manager Publisher | API lifecycle, API categories, deployment and publishing | `https://localhost:9443/publisher` |
| WSO2 API Manager Developer Portal | API discovery, application and subscriptions | `https://localhost:9443/devportal` |
| WSO2 API Manager Carbon Console | Admin console | `https://localhost:9443/carbon` |
| APIM Gateway HTTPS | DevPortal-aligned published API endpoint | `https://localhost:8243` |
| APIM Gateway HTTP | Docker-internal MI invocation path | `http://wso2-apim:8280` |
| WSO2 Integrator Health Registry API | APIM-sourced health registry metadata | `http://localhost:8290/health-registry/v1/apis` |
| WSO2 Integrator Catalogue Status API | Cached status exposed through MI | `http://localhost:8290/catalogue-status/v1/apis` |
| WSO2 Integrator Platform Status API | MI-level platform status endpoint | `http://localhost:8290/platform-status/v1/health` |
| WSO2 Integrator Customer 360 API | Composite integration API | `http://localhost:8290/customer-360/v1/customers/{customerId}` |
| Health Status Cache | Latest status, history and SLA-style windows | `http://localhost:6300` |
| Platform Control | UI orchestration, DevPortal-backed catalogue, secure Gateway invoke proxy | `http://localhost:6400` |
| Catalogue UI | Demo UI | `http://localhost:5174` |
| Optional OpenTelemetry Collector | Local observability profile | `localhost:4317`, `localhost:4318` |

Default credentials:

```text
admin / admin
```

Gateway URL rule:

```text
MI checks use:       http://wso2-apim:8280
UI display uses:    https://localhost:8243
UI click uses:      http://localhost:6400/api/gateway/invoke?... 
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
http://localhost:6300/cache/history
http://localhost:6300/cache/sla
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
├── governance/
│   └── catalogue-governance-rules.json
│
├── health-status-cache/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
│
├── observability/
│   └── otel-collector-config.yaml
│
├── pipeline/
│   └── scripts/
│       ├── deploy-selected-to-apim.sh
│       ├── deploy-initial-3-to-apim.sh
│       ├── deploy-cards-later-to-apim.sh
│       ├── deploy-loans-later-to-apim.sh
│       ├── sync-mi-health-from-apim.js
│       ├── watch-apim-mi-sync.sh
│       ├── enhanced-governance-check.js
│       ├── apictl-governance-dry-run.sh
│       ├── apim-platform-readiness.js
│       └── devportal-subscribe-and-invoke.js
│
├── ui/
│
├── wso2-integrator/
│   └── catalogue-health-mi/
│       └── src/main/wso2mi/
│           ├── artifacts/
│           │   ├── apis/
│           │   │   ├── catalogue_status_api.xml
│           │   │   ├── customer_360_api.xml
│           │   │   └── platform_status_api.xml
│           │   ├── sequences/
│           │   └── tasks/
│           └── resources/
│               └── service-catalog/
│                   ├── customer_360_openapi.yaml
│                   └── customer_360_service.yaml
│
├── docker-compose.yml
└── package.json
```

---


## APIM API Categories and UI Domain


APIM API Categories are the source of truth for the UI `Domain` field.

The platform preloads these categories when APIM starts:

```text
Accounts
Cards
Customers
Payments
Loans
```

The category bootstrap script is:

```bash
npm run platform:categories:bootstrap
```

Each APICTL API project should include the API category in `api.yaml`:

```yaml
categories:
  - Cards
```

Expected mapping:

| API | APIM Category | UI Domain |
| --- | --- | --- |
| `accounts-api` | `Accounts` | `Accounts` |
| `cards-api` | `Cards` | `Cards` |
| `customers-api` | `Customers` | `Customers` |
| `payments-api` | `Payments` | `Payments` |
| `loans-api` | `Loans` | `Loans` |

Existing APIs can be corrected after import using:

```bash
npm run platform:set-api-categories
```

The post-onboard reconciliation also runs category bootstrap and category assignment before creating the fresh Gateway revision.

Validate the effective UI data:

```bash
curl -s http://localhost:6400/api/catalogue-status/apis \
  | jq '.[] | {
    name,
    domain,
    category,
    categories,
    runtime
  }'
```

Expected:

```json
{
  "name": "cards-api",
  "domain": "Cards",
  "category": "Cards",
  "categories": ["Cards"],
  "runtime": "Default / localhost"
}
```

If category assignment fails with `The API category is invalid`, run:

```bash
npm run platform:categories:bootstrap
npm run platform:set-api-categories
npm run platform:post-onboard
```

---

## API Manager health metadata
Each APICTL API project contains an `api.yaml`.

The API contract contains two different metadata families:

1. **APIM-native metadata**, such as `categories`, lifecycle, context, version and Gateway deployment metadata.
2. **Demo health strategy metadata**, stored under `additionalProperties`, used by MI to generate APIM Gateway liveness and contract checks.

The preferred model for business grouping is APIM API Categories:

```yaml
categories:
  - Accounts
```

The old `health_domain` property can remain as a legacy fallback, but it is no longer the preferred source for the UI Domain column.

Example health strategy metadata:

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
  - name: health_owner_team
    value: "Accounts Platform Team"
    display: true
  - name: health_owner_email
    value: "accounts-platform@bank.example"
    display: true
```

Recommended extended catalogue metadata:

```yaml
  - name: data_classification
    value: "Confidential"
    display: true
  - name: regulatory_scope
    value: "LGPD"
    display: true
  - name: support_channel
    value: "teams://accounts-platform-support"
    display: true
  - name: repository_url
    value: "https://github.com/example/accounts-api"
    display: true
  - name: runbook_url
    value: "https://internal.example/runbooks/accounts-api"
    display: true
  - name: maintenance_window
    value: "Saturday 01:00-03:00 BRT"
    display: true
  - name: retirement_date
    value: ""
    display: true
  - name: gateway_type
    value: "wso2-classic"
    display: true
```

Runtime and Domain values in the UI are now intentionally APIM/DevPortal-backed:

```text
Domain  = APIM API Category
Runtime = APIM/DevPortal Gateway environment
```

---

## Required metadata
The local governance script validates required API metadata before import.

Required health metadata:

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
health_owner_team
health_owner_email
```

Required APIM-native metadata:

```text
categories
```

`health_domain` and `health_runtime` are no longer preferred as the UI source of truth. They may remain as fallback or legacy metadata, but the current UI should resolve:

```text
Domain  → APIM API Category
Runtime → APIM/DevPortal Gateway environment
```

Recommended production governance rules:

| Rule | Blocking for demo |
| --- | --- |
| API has valid OpenAPI definition | Yes |
| API has APIM API Category | Yes |
| API has valid health strategy | Yes |
| API has criticality | Yes |
| API has owner team and email | Yes |
| API has SLA target | Yes |
| Tier 0 / Tier 1 APIs have liveness and payload validation | Yes |
| Deprecated APIs have lifecycle/status handling | Recommended |
| Production APIs have support channel and runbook | Recommended |
| Production APIs have data classification | Recommended |

If an API is missing required operational metadata, it is rejected before import.

This demonstrates that incomplete APIs do not enter the governed API catalogue.

---

## Governance commands

Run local governance validation against all APICTL projects:

```bash
npm run platform:governance:check
```

Run local validation plus APIM governance dry-run for `accounts-api`:

```bash
npm run platform:governance:dry-run:accounts
```

The local governance script validates demo-specific metadata. The APIM dry-run validates the API against governance policies configured in the target WSO2 API Manager environment.

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

These files are manually maintained and should remain in place:

```text
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/catalogue_status_api.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/customer_360_api.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/platform_status_api.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/resources/service-catalog/customer_360_openapi.yaml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/resources/service-catalog/customer_360_service.yaml
```

---


## APIM Gateway invocation model

MI performs liveness and contract validation through APIM Gateway.

For MI-generated checks, the internal Gateway URL is HTTP:

```text
http://wso2-apim:8280/<context>/<version>/<resource>
```

This is intentional because MI runs inside Docker and the local APIM certificate is issued for `localhost`, not `wso2-apim`.

For user-facing display, the UI shows the DevPortal-aligned HTTPS Gateway URL:

```text
https://localhost:8243/<context>/<version>/health
```

Clicking that URL in the UI opens the secure platform-control route:

```text
http://localhost:6400/api/gateway/invoke?apiName=<api-name>&target=health
```

`platform-control` injects the OAuth token and calls APIM Gateway securely.

Direct validation with the current runtime token:

```bash
TOKEN="$(jq -r .accessToken .runtime/api-catalogue-gateway-token.json)"

curl -k -i -s \
  -H "Authorization: Bearer $TOKEN" \
  https://localhost:8243/cards/v1/1.0.0/health | head -60
```

Docker-internal validation:

```bash
TOKEN="$(jq -r .accessToken .runtime/api-catalogue-gateway-token.json)"

docker-compose --profile platform run --rm -e TOKEN="$TOKEN" apictl \
  "curl -i -s -H \"Authorization: Bearer \\$TOKEN\" http://wso2-apim:8280/cards/v1/1.0.0/health | head -60"
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

## Health status model

| Scenario | Consumer status | Meaning |
| --- | --- | --- |
| Health endpoint returns expected HTTP status and expected payload | `GREEN` | Backend is reachable and contract check passed |
| Health endpoint returns HTTP 200 but payload is wrong | `YELLOW` | Backend is reachable but semantic/contract check failed |
| Health endpoint returns non-200 or is unavailable | `RED` | Backend liveness failed |
| API lifecycle indicates deprecated/retired | `DEPRECATED` | API is intentionally not treated as a normal production API |
| No valid health strategy exists | `UNKNOWN` | API is not yet operationally classified |

---

## Health status cache endpoints

| Endpoint | Description |
| --- | --- |
| `GET /health` | Cache service health |
| `GET /cache/results` | Latest result per API |
| `POST /cache/results` | Upsert one or more MI probe results |
| `DELETE /cache/results` | Clear latest results and history |
| `GET /cache/history` | Recent probe history |
| `GET /cache/history?api=accounts-api&limit=25` | History for one API |
| `GET /cache/summary` | Counts by status, domain, team and criticality |
| `GET /cache/sla?api=accounts-api&window=30d` | SLA-style window for one API |
| `GET /cache/sla/breaches?window=30d` | APIs that are not currently `OK` for the requested window |

Examples:

```bash
curl http://localhost:6300/health | jq
curl http://localhost:6300/cache/results | jq
curl http://localhost:6300/cache/history?api=accounts-api\&limit=25 | jq
curl 'http://localhost:6300/cache/sla?api=accounts-api&window=30d' | jq
curl 'http://localhost:6300/cache/sla/breaches?window=30d' | jq
```

Supported SLA windows:

```text
30m
6h
7d
30d
```

The SLA calculation is demo-grade and sample-based. It is not a replacement for a production observability store.

---

## Customer 360 integration API

The enhanced demo includes a WSO2 Integrator composite API:

```text
GET /customer-360/v1/customers/{customerId}
GET /customer-360/v1/health
```

It calls multiple mocked backend APIs and composes a single response:

```text
customers-api
accounts-api
cards-api
loans-api
```

Example:

```bash
curl http://localhost:8290/customer-360/v1/customers/CUST-BR-001 | jq
curl http://localhost:8290/customer-360/v1/health | jq
```

This exists to demonstrate that WSO2 Integrator is not only a health-check executor. It can also create reusable integration APIs that are then exposed and governed through WSO2 API Manager.

---

## Service Catalog integration

The repository includes Service Catalog metadata for the Customer 360 API:

```text
wso2-integrator/catalogue-health-mi/src/main/wso2mi/resources/service-catalog/customer_360_openapi.yaml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/resources/service-catalog/customer_360_service.yaml
```

To automatically publish this integration service to APIM Service Catalog, enable the MI service catalog client in the MI `deployment.toml`:

```toml
[[service_catalog]]
apim_host = "https://localhost:9443"
enable = true
username = "admin"
password = "admin"
```

In a production-grade demo image, use a derived MI Docker image or controlled configuration overlay instead of bind-mounting a partial `deployment.toml` over the product default.

Expected Service Catalog flow:

```text
WSO2 Integrator service
  ↓
Service Catalog metadata
  ↓
APIM Service Catalog
  ↓
Create API from service in Publisher
  ↓
Deploy to Gateway
  ↓
Publish to Developer Portal
  ↓
Subscribe and invoke through APIM Gateway
```

---

## API Products demo

For the customer narrative, create one API Product in APIM Publisher after the individual REST APIs are published.

Suggested product:

```text
Retail Banking API Product
```

Suggested resources:

```text
customers-api
accounts-api
cards-api
```

Suggested second product:

```text
Credit Origination API Product
```

Suggested resources:

```text
customers-api
loans-api
payments-api
```

This shows the difference between technical API inventory and business capability packaging.

API Products are best demonstrated manually in the Publisher UI unless you add dedicated API Product APICTL artifacts later.

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

## Expected package scripts
The current script model separates platform startup from API onboarding.

Important behavior:

```text
full-restart-with-service-catalog.sh
  = infrastructure startup only + category bootstrap + Service Catalog bootstrap
  = no automatic API import
  = no automatic API publish
  = no automatic API subscription

platform:post-onboard
  = reconcile onboarded APIs after manual onboarding
  = category bootstrap
  = API category assignment
  = operation auth update
  = fresh Gateway revision
  = Gateway token regeneration
  = MI artifact generation
  = MI/UI recreate
  = explicit probe
```

Important scripts:

```bash
npm run platform:up
npm run platform:down
npm run platform:categories:bootstrap
npm run platform:set-api-categories
npm run platform:service-catalog:bootstrap
npm run platform:import:all
npm run platform:reconcile-once
npm run platform:post-onboard
npm run platform:probe
npm run platform:status:apis
npm run platform:governance:check
npm run platform:control:start
npm run platform:control:stop
```

The reconciliation container should execute in this order:

```text
rm -f .runtime/api-catalogue-gateway-token.json
node pipeline/scripts/bootstrap-api-categories.js
node pipeline/scripts/set-api-operation-auth-application.js
node pipeline/scripts/set-api-categories.js
node pipeline/scripts/force-fresh-gateway-revision.js
APIM_GATEWAY_INTERNAL_BASE_URL=http://wso2-apim:8280 \
APIM_GATEWAY_BROWSER_BASE_URL=http://localhost:8280 \
node pipeline/scripts/sync-mi-health-from-apim.js
```

Validate the current local scripts:

```bash
cat package.json | jq -r '.scripts["platform:reconcile:container"]'
cat package.json | jq -r '.scripts["platform:post-onboard"]'
```

The older `platform:onboard:*` commands can still be kept for terminal-driven demos, but the current preferred story is manual onboarding from the UI followed by sync/evaluate.

---

## Optional observability profile

The enhancement pack includes:

```text
observability/otel-collector-config.yaml
```

Merge the `otel-collector` service into `docker-compose.yml` if you want to run a local OpenTelemetry Collector:

```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector:0.104.0
    profiles: ["observability"]
    command: ["--config=/etc/otelcol/config.yaml"]
    volumes:
      - ./observability/otel-collector-config.yaml:/etc/otelcol/config.yaml:ro
    ports:
      - "4317:4317"
      - "4318:4318"
    depends_on:
      - wso2-integrator
      - health-status-cache
```

Start with observability:

```bash
docker compose --profile platform --profile observability up -d --build
```

For a customer-facing Datadog story, the recommended architecture is:

```text
APIM traffic analytics
  → APIM analytics log / external analytics sink
  → Datadog or another observability backend

MI synthetic health results
  → health-status-cache
  → summarized events only to Datadog
```

Do not send full probe payloads or sensitive business response bodies to Datadog.

---

## Full clean reset

Use this when you want the UI to start empty and APIM to contain no previously imported APIs.

Stop containers and remove volumes:

```bash
docker-compose --profile platform down -v --remove-orphans
docker rm -f wso2-apim-47 wso2-integrator-mi wso2-apictl-runner 2>/dev/null || true
docker rm -f $(docker ps -a --filter "name=wso2-api-catalogue-demo" -q) 2>/dev/null || true
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

Keep these manual MI artifacts:

```text
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/catalogue_status_api.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/customer_360_api.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/platform_status_api.xml
```

Remove persistent cache and APICTL volumes explicitly:

```bash
docker volume rm wso2-api-catalogue-demo5_health-cache-data 2>/dev/null || true
docker volume rm wso2-api-catalogue-demo5_apictl-home 2>/dev/null || true
```

Validate clean state:

```bash
docker ps -a | grep -E "wso2-api-catalogue-demo|wso2-apim|wso2-integrator|wso2-apictl|health-status-cache" || echo "No project containers left"
docker network ls | grep wso2-api-catalogue-demo || echo "No project network left"
```

---

## Start the platform
For the final demo flow, use the full restart script:

```bash
./scripts/full-restart-with-service-catalog.sh
```

The script should:

```text
clear stale Gateway runtime token
start/restart APIM, MI, cache, mocks, UI and platform-control
wait for APIM readiness
preload APIM API Categories
bootstrap Service Catalog best-effort
leave the catalogue empty
```

It should **not** call:

```text
platform:onboard
platform:import:all
platform:post-onboard
platform:reconcile-once
```

Audit the restart script:

```bash
grep -n "platform:categories:bootstrap\|platform:service-catalog:bootstrap\|platform:onboard\|platform:import:all\|platform:post-onboard\|platform:reconcile-once\|api-catalogue-gateway-token" \
  scripts/full-restart-with-service-catalog.sh
```

Before manual onboarding, validate empty UI state:

```bash
curl -s http://localhost:6400/api/catalogue-status/apis | jq .
```

Expected:

```json
[]
```

You can still use lower-level startup commands for debugging:

```bash
npm run platform:up
npm run platform:control:start
```

Wait for WSO2 API Manager manually if needed:

```bash
until curl -ksf https://localhost:9443/carbon >/dev/null; do
  echo "Waiting for WSO2 API Manager..."
  sleep 15
done

echo "WSO2 API Manager is ready"
```

---

## Check platform readiness

Run:

```bash
npm run platform:readiness
```

This validates platform-level reachability for APIM, MI and the cache. It does not prove that every backend API is healthy.

You can also directly check the MI platform status API:

```bash
curl http://localhost:8290/platform-status/v1/health | jq
```

For APIM gateway startup readiness, use the APIM gateway health-check endpoint where applicable:

```bash
curl -k https://localhost:9443/api/am/gateway/v2/server-startup-healthcheck
```

---


## Manual UI onboarding flow

Open:

```text
http://localhost:5174
```

Use the onboarding panel to select and onboard an API.

Then click:

```text
Sync assinaturas & avaliar
```

Expected result:

```text
API imported/published in APIM
APIM Category applied
API subscribed to API Catalogue Application
fresh Gateway revision deployed
runtime OAuth token regenerated
MI artifacts regenerated
MI restarted
probe executed
UI row turns GREEN when liveness and contract pass
```

Validate after onboarding:

```bash
curl -s http://localhost:6400/api/catalogue-status/apis \
  | jq '.[] | {
    name,
    domain,
    category,
    categories,
    runtime,
    consumerStatus,
    liveness: .liveness.status,
    contract: .contract.status,
    healthBrowserUrl,
    secureHealthInvokeUrl
  }'
```

Expected:

```text
Domain/category from APIM Category
Runtime from APIM Gateway environment
Health URL from APIM HTTPS Gateway
Liveness checked through APIM Gateway
Contract checked through APIM Gateway
```

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

Run local governance validation first:

```bash
npm run platform:governance:check
```

Run onboarding:

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

Confirm an explicit manual full probe works:

```bash
curl -i -X POST http://localhost:8290/health-registry/v1/probes/run
```

Expected:

```json
{
  "status": "COMPLETED",
  "message": "Manual full probe execution completed",
  "source": "health-registry-api"
}
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

### Phase 2 — Demonstrate Developer Portal subscription and APIM Gateway invocation

After `accounts-api` is published, run:

```bash
npm run platform:subscribe:accounts
```

This script:

```text
1. Registers a temporary REST client against APIM.
2. Finds accounts-api in the Developer Portal API list.
3. Creates or reuses a demo application.
4. Subscribes the application to the API.
5. Generates production keys.
6. Obtains a client-credentials token.
7. Invokes the API through the APIM Gateway.
```

Expected invocation target:

```text
https://localhost:8243/accounts/v1/health
```

This proves the demo is not only an API list. It shows governed consumer access through the Developer Portal and Gateway.

---

### Phase 3 — Onboard `cards-api` later

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

### Phase 4 — Try to onboard an invalid `loans-api`

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

Run local governance validation:

```bash
npm run platform:governance:check
```

Expected failure:

```text
Missing required metadata property: health_expected_payload_json
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

### Phase 5 — Fix `loans-api` and onboard successfully

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

Validate again:

```bash
npm run platform:governance:check
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

Do not call the manual probe while validating tier timing, because it intentionally runs all checks immediately and will distort timing observations.

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

For timing demonstrations, wait for the next scheduled MI task after changing a backend mode. For quick functional validation, you may explicitly run `npm run platform:probe`.

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

## SLA and history validation

After the scheduled tasks have run several times, inspect history:

```bash
npm run platform:history
```

Inspect one API SLA-style window:

```bash
npm run platform:sla:accounts
```

Inspect non-OK SLA-style windows:

```bash
npm run platform:sla:breaches
```

Example direct calls:

```bash
curl 'http://localhost:6300/cache/sla?api=accounts-api&window=30m' | jq
curl 'http://localhost:6300/cache/sla?api=accounts-api&window=7d' | jq
curl 'http://localhost:6300/cache/sla/breaches?window=30d' | jq
```

The SLA model is sample-based for the demo. In production, send gateway traffic analytics and synthetic probe results to a proper observability store such as Datadog, OpenSearch or another platform selected by the customer.

---


## Platform-control endpoints

`platform-control` runs on the host at:

```text
http://localhost:6400
```

Important routes:

| Endpoint | Description |
| --- | --- |
| `GET /api/catalogue-status/apis` | APIM/DevPortal-enriched catalogue rows for the UI |
| `GET /api/catalogue-status/summary` | Summary for UI |
| `POST /api/catalogue-sync/run` | Sync/evaluate flow used by the UI |
| `GET /api/catalogue-sync/status` | Sync/evaluate status |
| `GET /api/gateway/invoke?apiName=<name>&target=health` | Secure APIM Gateway invoke with OAuth token injection |

The side-panel health link displays the APIM published HTTPS Gateway URL, but opens the secure platform-control route because browsers cannot add the runtime OAuth bearer token to a normal link.

Validate:

```bash
curl -s http://localhost:6400/api/catalogue-status/apis | jq
curl -k -i -s "http://localhost:6400/api/gateway/invoke?apiName=cards-api&target=health" | head -60
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

### History from cache

```bash
curl http://localhost:6300/cache/history | jq
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

```json
{
  "status": "COMPLETED",
  "message": "Manual full probe execution completed",
  "source": "health-registry-api"
}
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

### Validate governance metadata

```bash
npm run platform:governance:check
```

### Run APIM dry-run governance check for accounts

```bash
npm run platform:governance:dry-run:accounts
```

### Check platform readiness

```bash
npm run platform:readiness
```

### Onboard initial 3 APIs

```bash
npm run platform:onboard:initial3
```

### Subscribe to accounts and invoke through APIM Gateway

```bash
npm run platform:subscribe:accounts
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

Open the Developer Portal:

```text
https://localhost:9443/devportal
```

Use the Developer Portal to show:

```text
API discovery
API documentation
Application creation
Subscription
Key generation
API invocation through Gateway
```

---

## WSO2 Integrator access

The Integrator exposes:

```text
GET  /catalogue-status/v1/apis
GET  /catalogue-status/v1/summary
GET  /health-registry/v1/apis
POST /health-registry/v1/probes/run
GET  /platform-status/v1/health
GET  /customer-360/v1/customers/{customerId}
GET  /customer-360/v1/health
```

Important:

```text
POST /health-registry/v1/probes/run runs an explicit operator-triggered full probe. UI reads do not call it.
```

Examples:

```bash
curl http://localhost:8290/catalogue-status/v1/apis | jq
curl http://localhost:8290/catalogue-status/v1/summary | jq
curl http://localhost:8290/health-registry/v1/apis | jq
curl http://localhost:8290/platform-status/v1/health | jq
curl http://localhost:8290/customer-360/v1/customers/CUST-BR-001 | jq
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
2. Pipeline validates required catalogue and health metadata.
3. Pipeline optionally runs APIM governance dry-run.
4. Pipeline imports the API into WSO2 API Manager.
5. API Manager becomes the source of truth.
6. Pipeline performs one-shot APIM-to-MI reconciliation.
7. WSO2 Integrator executes tiered scheduled health checks.
8. Health status cache stores latest known readings and history.
9. Catalogue UI reflects only successfully governed APIs.
10. Consumers discover, subscribe and invoke through APIM.
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
  API subscriptions
  API gateway exposure
  API metadata source of truth

WSO2 Integrator
  Health check execution
  Synthetic validation
  Contract validation
  Status normalization
  Tiered scheduled checks
  Composite integration APIs
  Service Catalog contribution to APIM

health-status-cache
  Latest known health readings
  Historical probe samples
  SLA-style windows
  Stable UI read model
  No direct probe execution from UI

Catalogue UI
  Consumer-facing API visibility
  Operational status display
  Cache reader only
```

This avoids making the UI an operational execution trigger and avoids hiding business health logic inside the gateway request path.

New APIs are onboarded through API Manager metadata and synchronized into MI through a one-shot reconciliation process.

---

## Git hygiene

Generated MI artifacts should not be committed unless you intentionally want to version generated outputs for a demo snapshot.

Recommended `.gitignore` additions:

```gitignore
# Generated WSO2 Integrator health artifacts
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/check_*.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_all_health_checks.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier*_health_checks.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_health_check.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_tier*_health_check.xml
wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/health_registry_api.xml

# Local runtime data
health-status-cache/data/
*.log
.DS_Store
node_modules/
.env
```

Keep the manually maintained MI APIs and Service Catalog metadata under version control.

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


### API category is invalid

If category assignment fails with:

```text
The API category is invalid
```

APIM does not yet have the category registered at platform level.

Run:

```bash
npm run platform:categories:bootstrap
npm run platform:set-api-categories
npm run platform:post-onboard
```

### Liveness is RED with Unsupported Transport

If the APIM response says:

```text
Unsupported Transport [ http ]
```

then the deployed Gateway revision is stale or HTTPS-only.

Run:

```bash
npm run platform:post-onboard
```

The current post-onboard flow creates a fresh Gateway revision.

### Liveness is RED with subscription validation failed

If APIM returns:

```text
API Subscription validation failed
```

then the runtime token may have been generated before the API was subscribed.

Run:

```bash
rm -f .runtime/api-catalogue-gateway-token.json
npm run platform:post-onboard
```

### platform-control secure invoke returns `fetch failed`

`platform-control` runs on the host. Its secure Gateway proxy should call APIM through localhost:

```text
https://localhost:8243
```

It should not use Docker DNS such as:

```text
http://wso2-apim:8280
```

### Maximum number of API revisions reached

The post-onboard flow uses `force-fresh-gateway-revision.js` to undeploy/delete old revisions and deploy a fresh one.

Run:

```bash
npm run platform:post-onboard
```


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
docker rm -f $(docker ps -a --filter "name=wso2-api-catalogue-demo" -q) 2>/dev/null || true
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

For production, use a trusted certificate instead of disabling TLS validation.

### Developer Portal subscription script cannot find the API

Confirm the API is published and visible in Developer Portal:

```bash
curl -ks https://localhost:9443/devportal >/dev/null && echo "Developer Portal reachable"
```

Then confirm the API was imported and published:

```bash
npm run platform:onboard:initial3
```

Then retry:

```bash
npm run platform:subscribe:accounts
```

### Gateway invocation returns 401 or 403

The API may not be published, the subscription may not exist, or the generated token may not match the subscribed application.

Retry the full subscription smoke test:

```bash
npm run platform:subscribe:accounts
```

If the problem persists, inspect the API in Publisher and the application/subscription in Developer Portal.

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

The final customer story is:

```text
1. The platform starts with WSO2 API Manager, WSO2 Integrator, mocked banking APIs, health-status-cache and the catalogue UI.
2. The UI starts empty after a clean reset.
3. Three APIs are validated and onboarded through APICTL.
4. API Manager stores their lifecycle and health metadata.
5. The onboarding command performs one-shot APIM-to-MI reconciliation.
6. WSO2 Integrator executes tiered scheduled checks.
7. The cache stores latest readings, history and SLA-style samples.
8. The UI shows the three governed APIs.
9. A Developer Portal application subscribes to an API and invokes it through APIM Gateway.
10. A fourth API is onboarded later and appears after reconciliation and scheduled checks.
11. A fifth API is attempted with missing metadata and is rejected before import.
12. The metadata is fixed.
13. The same onboarding command is rerun.
14. The fifth API is imported, synchronized and shown in the catalogue.
15. Health tests prove GREEN, YELLOW and RED behavior.
16. Tier timing proves Tier 0, Tier 1 and Tier 2 APIs are checked at different frequencies.
17. Customer 360 proves Integrator can create a composed business API.
18. Service Catalog metadata shows how Integrator services can become APIM-managed APIs.
19. API Products show how technical APIs can be packaged into business capabilities.
```

This demonstrates a governed, production-style API catalogue modernization pattern using WSO2 API Manager and WSO2 Integrator.

---

## Official documentation references

* WSO2 API Manager 4.7 documentation: `https://apim.docs.wso2.com/en/4.7.0/`
* CI/CD-driven API governance with APICTL dry-run: `https://apim.docs.wso2.com/en/4.7.0/administer/governance/api-governance-cicd/`
* Publishing Integrator services to API Manager Service Catalog: `https://apim.docs.wso2.com/en/4.7.0/integrate/develop/working-with-service-catalog/`
* API Product overview: `https://apim.docs.wso2.com/en/4.7.0/api-design-manage/design/create-api-product/api-product-overview/`
* API category-based grouping: `https://apim.docs.wso2.com/en/4.7.0/reference/customize-product/customizations/customizing-the-developer-portal/customize-api-listing/api-category-based-grouping/`
* API Manager basic and gateway startup health checks: `https://apim.docs.wso2.com/en/4.7.0/install-and-setup/setup/deployment-best-practices/basic-health-checks/`
* Datadog analytics installation guide for API Manager: `https://apim.docs.wso2.com/en/4.7.0/monitoring/api-analytics/on-prem/datadog-installation-guide/`
