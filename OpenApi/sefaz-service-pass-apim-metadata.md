# Metadata required for sefaz-service-pass.yaml

After importing sefaz-service-pass.yaml manually in APIM Publisher, configure the following before Deploy/Publish.

## APIM Category

Payments

## APIM Custom Properties

| Property | Value |
|---|---|
| health_enabled | true |
| health_backend_url | http://host.docker.internal:9302 |
| health_path | /health |
| health_method | GET |
| health_expected_http_status | 200 |
| health_expected_payload_json | {"status":"UP","service":"sefaz-service"} |
| health_required_fields | status,service |
| health_sla_target | 99.5% |
| health_criticality | Tier 1 |
| health_owner_team | SEFAZ Integration Squad |
| health_owner_email | sefaz-integration@nova-finance.demo |

## Expected governance result

Without category/custom properties:
Deploy/Publish fails.

With category and all custom properties:
Deploy/Publish passes.
