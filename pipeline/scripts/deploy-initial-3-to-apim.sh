#!/usr/bin/env bash
set -euo pipefail

bash pipeline/scripts/deploy-selected-to-apim.sh \
  apictl/apis/accounts-api \
  apictl/apis/payments-api \
  apictl/apis/customers-api