#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="$(basename "$PWD")"

echo "============================================================"
echo " Full clean start for project: ${PROJECT_NAME}"
echo "============================================================"

echo
echo "1. Stopping Docker Compose services..."
docker-compose --profile platform down -v --remove-orphans 2>/dev/null || true
docker-compose down -v --remove-orphans 2>/dev/null || true

echo
echo "2. Removing known demo containers..."
docker rm -f \
  wso2-apim-47 \
  wso2-integrator-mi \
  wso2-apictl-runner \
  service-catalog-bootstrap \
  2>/dev/null || true

docker rm -f $(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT_NAME}") 2>/dev/null || true

echo
echo "3. Removing containers still attached to project networks..."
for net in $(docker network ls --format '{{.Name}}' | grep -E "^${PROJECT_NAME}(_|-).*|^${PROJECT_NAME}_default$" || true); do
  echo "Checking network: $net"
  docker rm -f $(docker ps -aq --filter "network=${net}") 2>/dev/null || true
done

echo
echo "4. Removing project networks..."
for net in $(docker network ls --format '{{.Name}}' | grep -E "^${PROJECT_NAME}(_|-).*|^${PROJECT_NAME}_default$" || true); do
  echo "Removing network: $net"
  docker network rm "$net" 2>/dev/null || true
done

echo
echo "5. Removing project volumes..."
docker volume rm $(docker volume ls -q | grep -E "${PROJECT_NAME}|health-cache|apictl") 2>/dev/null || true

echo
echo "6. Killing local watcher/sync processes..."
pkill -f watch-apim-mi-sync 2>/dev/null || true
pkill -f sync-mi-health-from-apim 2>/dev/null || true
pkill -f bootstrap-service-catalog 2>/dev/null || true

echo
echo "7. Removing generated MI health artifacts..."
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/check_*.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_all_health_checks.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/sequences/run_tier*_health_checks.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_health_check.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/tasks/scheduled_tier*_health_check.xml
rm -f wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/health_registry_api.xml

echo
echo "8. Keeping manually maintained MI APIs..."
ls wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/catalogue_status_api.xml 2>/dev/null || true
ls wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/platform_status_api.xml 2>/dev/null || true
ls wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts/apis/customer_360_api.xml 2>/dev/null || true

echo
echo "9. Installing Node dependencies..."
npm install

echo
echo "10. Starting platform from scratch..."
docker-compose --profile platform up -d --build

echo
echo "11. Waiting for APIM Carbon..."
until curl -ks -o /dev/null -w "%{http_code}" https://localhost:9443/carbon | grep -Eq "^(200|302)$"; do
  echo "Waiting for APIM /carbon..."
  sleep 15
done
echo "APIM Carbon is reachable."

echo
echo "12. Waiting for APIM Service Catalog REST app..."
until curl -ks -o /dev/null -w "%{http_code}" https://localhost:9443/api/am/service-catalog/v1/services | grep -Eq "^(200|401|403)$"; do
  echo "Waiting for APIM Service Catalog REST app..."
  sleep 15
done
echo "APIM Service Catalog REST app is reachable."

echo
echo "13. Waiting for MI Customer 360 API..."
until curl -s http://localhost:8290/customer-360/v1/health >/dev/null 2>&1; do
  echo "Waiting for MI Customer 360 API..."
  sleep 10
done
echo "MI Customer 360 API is reachable."

echo
echo "14. Bootstrapping Service Catalog entries..."
SERVICE_CATALOG_MI_HOST=wso2-integrator \
SERVICE_CATALOG_MI_PORT=8290 \
npm run platform:service-catalog:bootstrap

echo
echo "15. Listing Service Catalog entries..."
npm run platform:service-catalog:list

echo
echo "============================================================"
echo " Clean platform is ready."
echo "============================================================"
echo
echo "Open:"
echo "  APIM Publisher:       https://localhost:9443/publisher"
echo "  APIM DevPortal:       https://localhost:9443/devportal"
echo "  Catalogue UI:         http://localhost:5174"
echo
echo "Default credentials:"
echo "  admin / admin"
echo
