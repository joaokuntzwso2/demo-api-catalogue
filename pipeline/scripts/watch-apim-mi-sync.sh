#!/usr/bin/env bash
set -euo pipefail

SYNC_INTERVAL_SECONDS="${SYNC_INTERVAL_SECONDS:-30}"
APIM_ALLOW_INSECURE_TLS="${APIM_ALLOW_INSECURE_TLS:-true}"

ARTIFACTS_ROOT="wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts"

checksum_artifacts() {
  if [ ! -d "${ARTIFACTS_ROOT}" ]; then
    echo "missing"
    return
  fi

  find "${ARTIFACTS_ROOT}" \
    -type f \
    \( \
      -name "check_*.xml" \
      -o -name "run_all_health_checks.xml" \
      -o -name "run_tier*_health_checks.xml" \
      -o -name "scheduled_tier*_health_check.xml" \
      -o -name "scheduled_health_check.xml" \
      -o -name "health_registry_api.xml" \
    \) \
    -print \
    | sort \
    | xargs shasum 2>/dev/null \
    | shasum \
    | awk '{print $1}'
}

run_sync() {
  docker-compose --profile platform run --rm \
    -e APIM_ALLOW_INSECURE_TLS="${APIM_ALLOW_INSECURE_TLS}" \
    apictl "node pipeline/scripts/sync-mi-health-from-apim.js"
}

reload_integrator() {
  echo "[apim-mi-watch] MI artifacts changed. Recreating WSO2 Integrator and UI."
  docker-compose --profile platform up -d --force-recreate wso2-integrator ui-platform
}

echo "[apim-mi-watch] Starting APIM-to-MI reconciler"
echo "[apim-mi-watch] Interval: ${SYNC_INTERVAL_SECONDS}s"
echo "[apim-mi-watch] APIM_ALLOW_INSECURE_TLS=${APIM_ALLOW_INSECURE_TLS}"
echo ""

while true; do
  echo ""
  echo "[apim-mi-watch] Reconciling APIM metadata into MI artifacts..."

  before_checksum="$(checksum_artifacts || true)"

  if run_sync; then
    after_checksum="$(checksum_artifacts || true)"

    if [ "${before_checksum}" != "${after_checksum}" ]; then
      reload_integrator
    else
      echo "[apim-mi-watch] No artifact changes detected."
    fi
  else
    echo "[apim-mi-watch] Sync failed. Will retry in ${SYNC_INTERVAL_SECONDS}s."
  fi

  sleep "${SYNC_INTERVAL_SECONDS}"
done