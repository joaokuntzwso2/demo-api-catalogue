# Platform mode: WSO2 API Manager 4.7 + APICTL + WSO2 Integrator

The default `docker-compose up --build` command starts the lightweight demo only: mocked APIs, local health engine, and UI.

For the full platform demo, start the Docker Compose `platform` profile. This adds:

- `wso2-apim`: WSO2 API Manager 4.7.0
- `apictl`: WSO2 API Controller 4.7.0 runner container
- `wso2-integrator`: WSO2 Integrator / Micro Integrator runtime

## Start the full platform

```bash
npm run platform:up
```

or directly:

```bash
docker-compose --profile platform up --build
```

API Manager can take several minutes to start. Watch logs with:

```bash
npm run platform:logs:apim
```

## Access WSO2 API Manager

- Publisher: https://localhost:9443/publisher
- Developer Portal: https://localhost:9443/devportal
- Admin Portal: https://localhost:9443/admin
- Carbon Console: https://localhost:9443/carbon
- Username: `admin`
- Password: `admin`

Gateway URLs:

- HTTP Gateway: http://localhost:8280
- HTTPS Gateway: https://localhost:8243

## Access WSO2 Integrator

The WSO2 Integrator runtime fronts the health/status capability through integration APIs:

```bash
curl http://localhost:8290/catalogue-status/v1/apis
curl http://localhost:8290/catalogue-status/v1/summary
curl http://localhost:8290/health-registry/v1/apis
curl -X POST http://localhost:8290/health-registry/v1/probes/run
```

The local health worker remains available directly at:

```bash
curl http://localhost:6200/api-status/v1/apis
```

## Deploy the APIs to WSO2 API Manager using APICTL

After API Manager is healthy, run:

```bash
npm run platform:onboard
```

or directly:

```bash
docker-compose --profile platform run --rm apictl bash pipeline/scripts/deploy-all-to-apim.sh
```

This performs the same journey expected from a development team pipeline:

1. Validate OpenAPI contracts.
2. Validate mandatory governance metadata.
3. Wait for WSO2 API Manager.
4. Register/login to the APIM environment using APICTL.
5. Run APICTL dry-run governance validation.
6. Import/update and deploy the APIs in WSO2 API Manager.
7. Register health strategies in the Integrator Health Registry.
8. Trigger a health probe run.

## Test an exposed API through API Manager

After onboarding, try one of the APIs through the gateway:

```bash
curl http://localhost:8280/accounts/v1/health
curl http://localhost:8280/payments/v1/health
```

If your local APIM import requires an application/subscription before invocation, first confirm the APIs are visible in the Developer Portal and subscribe from there. The mocked APIs are imported with `Unlimited` policy and published lifecycle metadata for demo purposes.

## Stop the full platform

```bash
npm run platform:down
```

## Notes for demo presenters

This is intentionally split into two layers:

- `integrator-local`: deterministic health engine used to make the demo easy to run on a laptop.
- `wso2-integrator`: actual WSO2 Integrator/Micro Integrator runtime exposing the health/status contract as integration APIs.

For a production implementation, the registry state, scheduler, and health execution can be packaged as proper WSO2 Integrator artifacts and backed by persistent storage.
