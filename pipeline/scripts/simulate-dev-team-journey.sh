#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "1) Validating OpenAPI contracts"
node pipeline/scripts/validate-openapi.js

echo ""
echo "2) Validating governance metadata"
node pipeline/scripts/governance-check.js

echo ""
echo "3) Demonstrating APICTL commands for WSO2 API Manager 4.7"
for api in accounts-api payments-api customers-api cards-api loans-api; do
  echo "   apictl import api --file apictl/apis/$api --environment \$APIM_ENV --dry-run"
  echo "   apictl import api --file apictl/apis/$api --environment \$APIM_ENV --update --rotate-revision"
done

echo ""
echo "4) Registering health strategies into Integrator Health Registry"
node pipeline/scripts/register-health.js --all

echo ""
echo "5) Triggering immediate health probe"
curl -fsS -X POST "${INTEGRATOR_BASE_URL:-http://localhost:6200}/api-health-registry/v1/probes/run" | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d), null, 2)))"

echo ""
echo "Done. Open the UI at http://localhost:5173"
