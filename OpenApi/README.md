# Manual OpenAPI governance demo

This folder contains two OpenAPI files for manually testing APIM Governance.

## Files

1. sefaz-service-fail.yaml

Use this file to demonstrate a failing API.

Expected result:
- Import may be allowed.
- Deploy/Publish must fail.
- Governance should report missing APIM category and missing health_* metadata.

2. sefaz-service-pass.yaml

Use this file to demonstrate a compliant API.

Important:
The OpenAPI file contains an x-api-catalogue-governance block for traceability, but the current APIM Governance policy evaluates APIM API metadata, not arbitrary OpenAPI vendor extensions.

Therefore, after importing this file manually in Publisher, you must set the APIM category and custom properties listed in sefaz-service-pass-apim-metadata.properties.

Expected result:
- Import the OpenAPI.
- Add APIM category: Payments.
- Add all required custom properties.
- Deploy/Publish should pass.

## Why metadata is separate

The current APIM Governance policy validates APIM metadata fields:

- $.data.categories
- $.data.additionalPropertiesMap.health_*

Those fields belong to the APIM API metadata model. They are not automatically populated from the custom OpenAPI block x-api-catalogue-governance.

The custom block is included only to make the OpenAPI self-documenting for the demo.
