#!/usr/bin/env bash
set -euo pipefail

APIM_ENV="${APIM_ENV:-local-apim}"
APIM_HOST="${APIM_HOST:-https://wso2-apim:9443}"
APIM_USERNAME="${APIM_USERNAME:-admin}"
APIM_PASSWORD="${APIM_PASSWORD:-admin}"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <api-project-path> [api-project-path...]"
  echo ""
  echo "Example:"
  echo "  $0 apictl/apis/accounts-api apictl/apis/payments-api"
  exit 1
fi

REQUIRED_HEALTH_PROPERTIES=(
  "health_enabled"
  "health_backend_url"
  "health_path"
  "health_method"
  "health_expected_http_status"
  "health_expected_payload_json"
  "health_required_fields"
  "health_sla_target"
  "health_criticality"
  "health_runtime"
  "health_domain"
  "health_owner_team"
  "health_owner_email"
)

check_api_project() {
  local api_project="$1"
  local api_yaml="${api_project}/api.yaml"
  local api_name
  api_name="$(basename "${api_project}")"

  echo ""
  echo "Checking APICTL project: ${api_name}"

  if [ ! -d "${api_project}" ]; then
    echo "❌ API project directory not found: ${api_project}"
    exit 1
  fi

  if [ ! -f "${api_yaml}" ]; then
    echo "❌ api.yaml not found: ${api_yaml}"
    exit 1
  fi

  local missing=0

  for prop in "${REQUIRED_HEALTH_PROPERTIES[@]}"; do
    if ! grep -Eq "name:[[:space:]]*${prop}[[:space:]]*$" "${api_yaml}"; then
      echo "❌ Missing required APIM health metadata property: ${prop}"
      missing=1
    fi
  done

  if ! grep -Eq "name:[[:space:]]*health_enabled[[:space:]]*$" "${api_yaml}"; then
    echo "❌ health_enabled property is missing"
    missing=1
  fi

  if grep -Eq "name:[[:space:]]*health_enabled[[:space:]]*$" "${api_yaml}"; then
    if ! awk '
      /name:[[:space:]]*health_enabled[[:space:]]*$/ { found=1; next }
      found == 1 && /value:[[:space:]]*"?true"?[[:space:]]*$/ { ok=1; found=0 }
      found == 1 && /name:[[:space:]]*/ { found=0 }
      END { exit ok ? 0 : 1 }
    ' "${api_yaml}"; then
      echo "❌ health_enabled must have value: \"true\""
      missing=1
    fi
  fi

  if [ "${missing}" -ne 0 ]; then
    echo ""
    echo "❌ APICTL artifact check failed for ${api_name}."
    echo "This API will not be imported into WSO2 API Manager."
    echo ""
    echo "Reason: API Manager is the source of truth, so every onboarded API must include the required health_* metadata in api.yaml."
    exit 1
  fi

  echo "✅ APICTL artifact check passed for ${api_name}"
}

configure_apictl() {
  echo ""
  echo "Using API Manager:"
  echo "  APIM_ENV=${APIM_ENV}"
  echo "  APIM_HOST=${APIM_HOST}"

  echo ""
  echo "Configuring APICTL environment"

  apictl remove env "${APIM_ENV}" >/dev/null 2>&1 || true

  apictl add env "${APIM_ENV}" \
    --apim "${APIM_HOST}" \
    --token "${APIM_HOST}/oauth2/token"

  echo ""
  echo "Logging into API Manager"

  apictl login "${APIM_ENV}" \
    -u "${APIM_USERNAME}" \
    -p "${APIM_PASSWORD}" \
    -k
}

import_api() {
  local api_project="$1"
  local api_name
  api_name="$(basename "${api_project}")"

  echo ""
  echo "------------------------------------------------------------"
  echo "Importing/updating API in WSO2 API Manager: ${api_name}"
  echo "Project: ${api_project}"
  echo "------------------------------------------------------------"

  apictl import api \
    -f "${api_project}" \
    -e "${APIM_ENV}" \
    -k \
    --preserve-provider=false \
    --update

  echo "✅ Successfully imported/updated ${api_name}"
}

configure_apictl

echo ""
echo "Running APICTL artifact checks"

for api_project in "$@"; do
  check_api_project "${api_project}"
done

echo ""
echo "All APICTL artifact checks passed."
echo "Starting API imports."

for api_project in "$@"; do
  import_api "${api_project}"
done

echo ""
echo "Done. Selected APIs are now available in WSO2 API Manager."
echo "Next step: run the APIM-to-MI sync script so Integrator regenerates the health-check artifacts."