#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <command> [args...]"
  exit 1
fi

echo ""
echo "Temporarily disabling API Catalogue APIM Governance for controlled onboarding."
echo "Reason: APICTL artifacts are validated locally before import; APIM metadata/revisions are normalized during post-onboard."

npm run platform:governance:disable-catalogue-policies

restore_api_catalogue_governance() {
  local exit_code=$?

  echo ""
  echo "Restoring API Catalogue APIM Governance policy..."
  npm run platform:governance:bootstrap || echo "⚠️ Could not restore API Catalogue governance policy automatically."

  exit "$exit_code"
}

trap restore_api_catalogue_governance EXIT

"$@"
