#!/usr/bin/env bash
set -euo pipefail

APIM_ENV="${APIM_ENV:-local-apim}"
APIM_HOST="${APIM_HOST:-https://wso2-apim:9443}"
APIM_USERNAME="${APIM_USERNAME:-admin}"
APIM_PASSWORD="${APIM_PASSWORD:-admin}"

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

API_PROJECTS=(
  "apictl/apis/accounts-api"
  "apictl/apis/payments-api"
  "apictl/apis/customers-api"
  "apictl/apis/cards-api"
  "apictl/apis/loans-api"
)

echo ""
echo "Importing APIs into WSO2 API Manager"

for API_PROJECT in "${API_PROJECTS[@]}"; do
  if [ ! -f "${API_PROJECT}/api.yaml" ]; then
    echo "Skipping ${API_PROJECT}: api.yaml not found"
    continue
  fi

  API_NAME="$(basename "${API_PROJECT}")"

  echo ""
  echo "------------------------------------------------------------"
  echo "Importing/updating API: ${API_NAME}"
  echo "Project: ${API_PROJECT}"
  echo "------------------------------------------------------------"

  apictl import api \
    -f "${API_PROJECT}" \
    -e "${APIM_ENV}" \
    -k \
    --preserve-provider=false \
    --update

  echo "Successfully imported/updated ${API_NAME}"
done

echo ""
echo "Done. APIs are now available in API Manager."
echo "Open Publisher at: https://localhost:9443/publisher"
echo ""
echo "Health metadata is no longer registered directly in Integrator from this script."
echo "Run the APIM-to-MI sync step next:"
echo "  node pipeline/scripts/sync-mi-health-from-apim.js"