#!/usr/bin/env bash
set -euo pipefail

API_PROJECT="${1:-}"
if [[ -z "$API_PROJECT" ]]; then
  echo "Usage: bash pipeline/scripts/apictl-governance-dry-run.sh apictl/apis/accounts-api" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APIM_ENV="${APIM_ENV:-local-apim}"
APIM_HOST="${APIM_HOST:-https://wso2-apim:9443}"
APIM_USERNAME="${APIM_USERNAME:-admin}"
APIM_PASSWORD="${APIM_PASSWORD:-admin}"

if [[ ! -d "$API_PROJECT" ]]; then
  if [[ -d "$ROOT_DIR/$API_PROJECT" ]]; then
    API_PROJECT="$ROOT_DIR/$API_PROJECT"
  else
    echo "API project not found: $API_PROJECT" >&2
    exit 2
  fi
fi

echo "[governance] Running local catalogue metadata validation"
node "$ROOT_DIR/pipeline/scripts/enhanced-governance-check.js" "$API_PROJECT"

echo "[governance] Running WSO2 API Manager governance dry-run through APICTL"
if ! command -v apictl >/dev/null 2>&1; then
  echo "apictl not found in PATH. Run this inside the existing apictl Docker runner or install WSO2 API Controller." >&2
  exit 2
fi

apictl add env "$APIM_ENV" --apim "$APIM_HOST" || true
apictl login "$APIM_ENV" -u "$APIM_USERNAME" -p "$APIM_PASSWORD" -k
apictl import api --file "$API_PROJECT" --environment "$APIM_ENV" --dry-run -k

echo "[governance] PASS: local checks and APIM governance dry-run completed successfully."
