#!/usr/bin/env bash
set -euo pipefail

SOURCE_API="apictl/apis/loans-api"
BROKEN_API="/tmp/loans-api-incomplete"

echo "Preparing intentionally incomplete loans-api artifact"
echo "Source: ${SOURCE_API}"
echo "Temp:   ${BROKEN_API}"

rm -rf "${BROKEN_API}"
cp -R "${SOURCE_API}" "${BROKEN_API}"

echo ""
echo "Removing required health metadata property: health_expected_payload_json"

awk '
  BEGIN { skip=0 }

  /^[[:space:]]*-[[:space:]]*name:[[:space:]]*health_expected_payload_json[[:space:]]*$/ {
    skip=1
    next
  }

  skip == 1 && /^[[:space:]]*value:/ {
    next
  }

  skip == 1 && /^[[:space:]]*display:/ {
    skip=0
    next
  }

  {
    print
  }
' "${BROKEN_API}/api.yaml" > "${BROKEN_API}/api.yaml.tmp"

mv "${BROKEN_API}/api.yaml.tmp" "${BROKEN_API}/api.yaml"

echo ""
echo "Attempting to deploy incomplete loans-api."
echo "Expected result: this must fail before import."

bash pipeline/scripts/deploy-selected-to-apim.sh "${BROKEN_API}"