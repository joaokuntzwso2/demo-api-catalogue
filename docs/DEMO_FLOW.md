# Demo flow

## 1. Start the platform

```bash
docker-compose up --build
```

## 2. Show mocked APIs

```bash
curl http://localhost:5101/accounts/v1/health
curl http://localhost:5102/payments/v1/health
```

## 3. Show catalogue UI

Open `http://localhost:5173`.

## 4. Simulate an API degradation

```bash
curl -X POST http://localhost:5101/accounts/v1/__admin/health-mode   -H 'Content-Type: application/json'   -d '{"mode":"wrongPayload"}'
```

Then click **Executar checks agora** in the UI.

Expected result:

- Accounts API remains reachable.
- Liveness may be green.
- Contract becomes yellow.
- SLA/status becomes yellow.

## 5. Simulate outage

```bash
curl -X POST http://localhost:5101/accounts/v1/__admin/health-mode   -H 'Content-Type: application/json'   -d '{"mode":"down"}'
```

Expected result:

- Accounts API status becomes RED.

## 6. Recover

```bash
curl -X POST http://localhost:5101/accounts/v1/__admin/health-mode   -H 'Content-Type: application/json'   -d '{"mode":"healthy"}'
```

## 7. Show development team journey

```bash
npm run simulate:dev-team
```

Explain that in production this same flow would be executed from GitHub Actions/Jenkins/Azure DevOps, using APICTL against WSO2 API Manager and registering the health strategy into WSO2 Integrator.
