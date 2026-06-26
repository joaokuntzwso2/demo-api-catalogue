#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo " Stopping WSO2 API Catalogue demo platform"
echo "============================================================"

echo
echo "0. Stopping platform control server..."
npm run platform:control:stop 2>/dev/null || true

echo
echo "1. Stopping Docker Compose services..."
docker-compose --profile platform down --remove-orphans 2>/dev/null || true
docker-compose down --remove-orphans 2>/dev/null || true

echo
echo "2. Removing known demo containers if still present..."
docker rm -f \
  wso2-apim-47 \
  wso2-integrator-mi \
  wso2-apictl-runner \
  service-catalog-bootstrap \
  health-status-cache \
  api-catalogue-ui \
  accounts-api \
  payments-api \
  customers-api \
  cards-api \
  loans-api \
  banking-backend \
  2>/dev/null || true

echo
echo "3. Killing local watcher/sync processes..."
pkill -f watch-apim-mi-sync 2>/dev/null || true
pkill -f sync-mi-health-from-apim 2>/dev/null || true
pkill -f bootstrap-service-catalog 2>/dev/null || true
pkill -f "platform-control/server.js" 2>/dev/null || true

echo
echo "4. Checking remaining project containers..."
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
  | grep -E "wso2|catalogue|accounts|payments|customers|cards|loans|banking" || true

echo
echo "============================================================"
echo " Platform stopped."
echo "============================================================"
