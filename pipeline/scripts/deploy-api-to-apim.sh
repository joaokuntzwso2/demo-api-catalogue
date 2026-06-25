#!/usr/bin/env bash
set -euo pipefail

API_FOLDER="${1:-}"
if [[ -z "$API_FOLDER" ]]; then
  echo "Usage: bash pipeline/scripts/deploy-api-to-apim.sh <api-folder>"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APICTL_PROJECT="$ROOT_DIR/apictl/apis/$API_FOLDER"
APIM_ENV="${APIM_ENV:-local-apim}"
APIM_HOST="${APIM_HOST:-https://localhost:9443}"
APIM_USERNAME="${APIM_USERNAME:-admin}"
APIM_PASSWORD="${APIM_PASSWORD:-admin}"
APIM_DRY_RUN_ONLY="${APIM_DRY_RUN_ONLY:-false}"
INTEGRATOR_BASE_URL="${INTEGRATOR_BASE_URL:-http://localhost:6200}"

if [[ ! -d "$APICTL_PROJECT" ]]; then
  echo "APICTL project not found: $APICTL_PROJECT"
  exit 1
fi

bash "$ROOT_DIR/pipeline/scripts/wait-for-apim.sh"

if ! command -v apictl >/dev/null 2>&1; then
  echo "apictl not found. Install WSO2 API Controller and retry."
  echo "Project prepared at: $APICTL_PROJECT"
  exit 2
fi

apictl add env "$APIM_ENV" --apim "$APIM_HOST" || true
apictl login "$APIM_ENV" -u "$APIM_USERNAME" -p "$APIM_PASSWORD" -k

echo "Running APICTL governance dry-run for $API_FOLDER"
apictl import api --file "$APICTL_PROJECT" --environment "$APIM_ENV" --dry-run -k

if [[ "$APIM_DRY_RUN_ONLY" == "true" ]]; then
  echo "Dry-run-only mode enabled. Skipping import/deploy."
else
  echo "Importing/updating API in WSO2 API Manager"
  apictl import api --file "$APICTL_PROJECT" --environment "$APIM_ENV" --update --rotate-revision -k
fi

echo "Registering health strategy in Integrator"
INTEGRATOR_BASE_URL="$INTEGRATOR_BASE_URL" node "$ROOT_DIR/pipeline/scripts/register-health.js" "$API_FOLDER"
