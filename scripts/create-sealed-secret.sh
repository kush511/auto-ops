#!/bin/bash
set -euo pipefail

# =============================================================================
# Create Kubernetes Secret with All Required Credentials
# =============================================================================
#
# Usage:
# ./scripts/create-sealed-secret.sh \
#   <inception_api_key> \
#   <slack_webhook_url> \
#   <slack_signing_secret> \
#   [slack_bot_token]
#
# Example:
# ./scripts/create-sealed-secret.sh \
#   'sk_2b2e1f9834d740d450c595bb7ca7a895' \
#   'https://hooks.slack.com/services/T.../B.../...' \
#   '1db9cab318943649227927cad1a5b173' \
#   'xoxb-1234567890-1234567890-abcdefghijklmn'
#
# =============================================================================

INCEPTION_API_KEY="${1:-}"
SLACK_WEBHOOK_URL="${2:-}"
SLACK_SIGNING_SECRET="${3:-}"
SLACK_BOT_TOKEN="${4:-}"

# Validate required parameters
if [[ -z "$INCEPTION_API_KEY" || -z "$SLACK_WEBHOOK_URL" || -z "$SLACK_SIGNING_SECRET" ]]; then
    cat <<EOF
  Missing required parameters!

Usage: ./scripts/create-sealed-secret.sh <inception_api_key> <slack_webhook_url> <slack_signing_secret> [slack_bot_token]

Required Credentials:
  1. INCEPTION_API_KEY         - LLM API key from Inception Labs
  2. SLACK_WEBHOOK_URL         - Incoming webhook URL from Slack
  3. SLACK_SIGNING_SECRET      - Signing secret from Slack app "Basic Information"

Optional:
  4. SLACK_BOT_TOKEN           - Bot token from Slack (optional, for enhanced features)

How to get them:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SLACK_WEBHOOK_URL:
   1. Go to https://api.slack.com/apps
   2. Click your app → "Incoming Webhooks"
   3. Click "Add New Webhook to Workspace"
   4. Select channel, click "Allow"
   5. Copy the Webhook URL

SLACK_SIGNING_SECRET:
   1. Go to https://api.slack.com/apps
   2. Click your app → "Basic Information"
   3. Under "App Credentials", copy "Signing Secret"

SLACK_BOT_TOKEN (Optional but Recommended):
   1. Go to https://api.slack.com/apps
   2. Click your app → "OAuth & Permissions"
   3. Add scopes: chat:write, users:read, users:read:email
   4. Click "Install to Workspace"
   5. Copy "Bot User OAuth Token" (starts with xoxb-)

Example with all parameters:
  ./scripts/create-sealed-secret.sh \\
    'sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' \\
    'https://hooks.slack.com/services/T.../B.../...' \\
    '1db9cab318943649227927cad1a5b173' \\
    'xoxb-1234567890-1234567890-abcdefghijklmn'

Example with optional bot token omitted:
  ./scripts/create-sealed-secret.sh \\
    'sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx' \\
    'https://hooks.slack.com/services/T.../B.../...' \\
    '1db9cab318943649227927cad1a5b173'

EOF
    exit 1
fi

TEMP_SECRET_FILE="temp-secret.yaml"
OUTPUT_FILE="ops/sealed-secret.yaml"

echo "Creating secret with credentials..."

# Build kubectl command with required fields
kubectl create secret generic inception-secret \
    --dry-run=client \
    --from-literal=api-key="$INCEPTION_API_KEY" \
    --from-literal=slack-webhook-url="$SLACK_WEBHOOK_URL" \
    --from-literal=slack-signing-secret="$SLACK_SIGNING_SECRET" \
    $(if [[ -n "$SLACK_BOT_TOKEN" ]]; then echo "--from-literal=slack-bot-token=\"$SLACK_BOT_TOKEN\""; fi) \
    -o yaml > "$TEMP_SECRET_FILE"

# Check if kubeseal is available (for SealedSecrets)
if command -v kubeseal &> /dev/null; then
    echo "Sealing secret with kubeseal..."
    kubeseal --format yaml < "$TEMP_SECRET_FILE" > "$OUTPUT_FILE"
    rm -f "$TEMP_SECRET_FILE"
    echo "Sealed secret created at $OUTPUT_FILE"
    echo ""
    echo "Apply to cluster:"
    echo "   kubectl apply -f $OUTPUT_FILE"
else
    # Fallback: Direct secret creation without sealing
    echo "kubeseal not found. Creating unsealed secret (use kubeseal for production)."
    echo "   Install: https://github.com/bitnami-labs/sealed-secrets/releases"
    mv "$TEMP_SECRET_FILE" "$OUTPUT_FILE"
    echo "Secret created at $OUTPUT_FILE (NOT SEALED)"
    echo ""
    echo "Apply to cluster:"
    echo "   kubectl apply -f $OUTPUT_FILE"
    echo ""
    echo "WARNING: This secret is not encrypted. Seal it with kubeseal for production use."
fi

# Verify what was created
echo ""
echo "Secret Contents:"
echo "   api-key: OK"
echo "   slack-webhook-url: OK"
echo "   slack-signing-secret: OK"
if [[ -n "$SLACK_BOT_TOKEN" ]]; then
    echo "   slack-bot-token: OK"
else
    echo "   slack-bot-token: (omitted)"
fi

echo ""
echo "Next steps:"
echo "   1. kubectl apply -f $OUTPUT_FILE"
echo "   2. kubectl apply -f ops/agent-deployment.yml"
echo "   3. kubectl apply -f ops/agent-callback-service.yaml"