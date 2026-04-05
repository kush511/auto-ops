#!/bin/bash
set -euo pipefail

# Usage:
# ./scripts/create-sealed-secret.sh <inception_api_key> <slack_webhook_url>

INCEPTION_API_KEY="${1:-}"
SLACK_WEBHOOK_URL="${2:-}"

if [[ -z "$INCEPTION_API_KEY" || -z "$SLACK_WEBHOOK_URL" ]]; then
    echo "Usage: ./scripts/create-sealed-secret.sh <inception_api_key> <slack_webhook_url>"
    exit 1
fi

TEMP_SECRET_FILE="temp-secret.yaml"
OUTPUT_FILE="ops/sealed-secret.yaml"

kubectl create secret generic inception-secret \
    --dry-run=client \
    --from-literal=api-key="$INCEPTION_API_KEY" \
    --from-literal=slack-webhook-url="$SLACK_WEBHOOK_URL" \
    -o yaml > "$TEMP_SECRET_FILE"

kubeseal --format yaml < "$TEMP_SECRET_FILE" > "$OUTPUT_FILE"
rm -f "$TEMP_SECRET_FILE"

echo "Sealed secret created at $OUTPUT_FILE"
echo "Apply with: kubectl apply -f $OUTPUT_FILE"