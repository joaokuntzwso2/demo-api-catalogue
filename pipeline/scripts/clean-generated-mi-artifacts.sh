#!/usr/bin/env bash
set -euo pipefail

ARTIFACTS_ROOT="wso2-integrator/catalogue-health-mi/src/main/wso2mi/artifacts"

echo "Cleaning generated WSO2 Integrator artifacts..."

rm -f "${ARTIFACTS_ROOT}/sequences"/check_*.xml
rm -f "${ARTIFACTS_ROOT}/sequences"/run_all_health_checks.xml
rm -f "${ARTIFACTS_ROOT}/sequences"/run_tier*_health_checks.xml

rm -f "${ARTIFACTS_ROOT}/tasks"/scheduled_health_check.xml
rm -f "${ARTIFACTS_ROOT}/tasks"/scheduled_tier*_health_check.xml

rm -f "${ARTIFACTS_ROOT}/apis"/health_registry_api.xml

mkdir -p "${ARTIFACTS_ROOT}/sequences"
mkdir -p "${ARTIFACTS_ROOT}/tasks"
mkdir -p "${ARTIFACTS_ROOT}/apis"

touch "${ARTIFACTS_ROOT}/sequences/.gitkeep"
touch "${ARTIFACTS_ROOT}/tasks/.gitkeep"

echo "Done."
echo ""
echo "Kept:"
echo "  - ${ARTIFACTS_ROOT}/apis/catalogue_status_api.xml"
echo "  - ${ARTIFACTS_ROOT}/apis/customer_360_api.xml"
echo "  - ${ARTIFACTS_ROOT}/apis/platform_status_api.xml"
echo ""
echo "Removed generated files:"
echo "  check_*.xml"
echo "  run_all_health_checks.xml"
echo "  run_tier*_health_checks.xml"
echo "  scheduled_health_check.xml"
echo "  scheduled_tier*_health_check.xml"
echo "  health_registry_api.xml"
