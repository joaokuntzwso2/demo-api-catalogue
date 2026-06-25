#!/usr/bin/env bash
set -euo pipefail

APIM_HOST="${APIM_HOST:-https://localhost:9443}"
TIMEOUT_SECONDS="${APIM_WAIT_TIMEOUT_SECONDS:-600}"
SLEEP_SECONDS="${APIM_WAIT_SLEEP_SECONDS:-10}"

start_ts=$(date +%s)
echo "Waiting for WSO2 API Manager at ${APIM_HOST} ..."

while true; do
  if curl -ksf "${APIM_HOST}/carbon" >/dev/null 2>&1; then
    echo "WSO2 API Manager is reachable: ${APIM_HOST}"
    exit 0
  fi

  now_ts=$(date +%s)
  elapsed=$((now_ts - start_ts))
  if (( elapsed >= TIMEOUT_SECONDS )); then
    echo "Timed out waiting for WSO2 API Manager after ${TIMEOUT_SECONDS}s" >&2
    echo "Check logs with: docker-compose --profile platform logs -f wso2-apim" >&2
    exit 1
  fi

  echo "Still waiting for API Manager... ${elapsed}s elapsed"
  sleep "$SLEEP_SECONDS"
done
