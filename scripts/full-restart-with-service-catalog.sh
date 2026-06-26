#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo " Full clean restart with Service Catalog bootstrap"
echo "============================================================"

echo
echo "1. Stopping everything and removing volumes..."
docker-compose --profile platform down -v --remove-orphans 2>/dev/null || true
docker-compose down -v --remove-orphans 2>/dev/null || true

echo
echo "2. Removing known containers..."
docker rm -f \
  wso2-apim-47 \
  wso2-integrator-mi \
  wso2-apictl-runner \
  service-catalog-bootstrap \
  2>/dev/null || true

docker rm -f $(docker ps -aq --filter "name=demo-api-catalogue") 2>/dev/null || true

echo
echo "3. Removing project networks still in use..."
docker rm -f $(docker ps -aq --filter network=demo-api-catalogue_default) 2>/dev/null || true
docker network rm demo-api-catalogue_default 2>/dev/null || true

echo
echo "4. Removing demo volumes..."
docker volume rm $(docker volume ls -q | grep -E "demo-api-catalogue|health-cache|apictl") 2>/dev/null || true

echo
echo "5. Removing generated MI health artifacts..."
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/check_*.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_all_health_checks.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier*_health_checks.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_health_check.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_tier*_health_check.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/health_registry_api.xml

echo
echo "6. Installing dependencies..."
npm install

echo
echo "7. Starting platform..."
docker-compose --profile platform up -d --build

echo
echo "8. Waiting for APIM Carbon..."
until curl -ks -o /dev/null -w "%{http_code}" https://localhost:9443/carbon | grep -Eq "^(200|302)$"; do
  echo "Waiting for APIM /carbon..."
  sleep 15
done
echo "APIM Carbon is reachable."

echo
echo "9. Waiting for APIM Service Catalog REST app..."
until curl -ks -o /dev/null -w "%{http_code}" https://localhost:9443/api/am/service-catalog/v1/services | grep -Eq "^(200|401|403)$"; do
  echo "Waiting for APIM Service Catalog REST app..."
  sleep 15
done
echo "APIM Service Catalog REST app is reachable."

echo
echo "10. Waiting for MI Customer 360 API..."
until curl -s http://localhost:8290/customer-360/v1/health >/dev/null 2>&1; do
  echo "Waiting for MI..."
  sleep 10
done
echo "MI is reachable."

echo
echo "11. Bootstrapping APIM Service Catalog..."
SERVICE_CATALOG_MI_HOST=wso2-integrator \
SERVICE_CATALOG_MI_PORT=8290 \
npm run platform:service-catalog:bootstrap

echo
echo "12. Verifying Service Catalog entries..."
npm run platform:service-catalog:list

echo
echo "13. Starting local UI onboarding control server..."
npm run platform:control:start

echo
echo "============================================================"
echo " Platform restarted from scratch and Service Catalog is ready"
echo "============================================================"
echo
echo "Open:"
echo "  Publisher:  https://localhost:9443/publisher"
echo "  DevPortal:  https://localhost:9443/devportal"
echo "  UI:         http://localhost:5174"
echo "  Control API:http://localhost:6400"
echo
echo "Credentials:"
echo "  admin / admin"
