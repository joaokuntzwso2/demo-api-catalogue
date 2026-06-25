# WSO2 alignment

## WSO2 API Manager 4.7

The demo uses WSO2 API Manager as the API control plane:

- API projects are prepared in `apictl/apis/*`.
- APICTL dry-run is represented in the CI/CD scripts.
- APICTL import/update/rotate-revision is represented in `pipeline/scripts/deploy-api-to-apim.sh`.
- API metadata includes lifecycle, owner, context, version, endpoint, policies and tags.

## WSO2 Integrator

The demo uses WSO2 Integrator as the operational health layer:

- Integration-as-API pattern through Health Registry and Status APIs.
- Automation/scheduled health-check pattern through recurring probe execution.
- HTTP calls to heterogeneous backend services.
- Payload validation and status normalization.

The `integrator-local` service is a Node.js runtime mirror for local demo convenience. The WSO2 Integrator/Ballerina implementation is under `wso2-integrator/health-registry-service`.

## CI/CD registration pattern

The Integrator should not passively discover APIs. The pipeline registers new/updated APIs as part of onboarding:

```text
Git commit → OpenAPI validation → governance dry run → APICTL import → health registration → status visible in catalogue
```

A scheduled reconciliation job can be added to compare APIs in API Manager against the Integrator Health Registry and flag missing health strategies.
