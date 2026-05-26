#!/bin/bash

###############################################################################
# Full Deployment Script (Existing Kind Cluster)
# Deploys: Sealed Secrets controller, Prometheus, Grafana, App, Agent, Dashboard
# Requires: kind cluster already exists and kubectl context is set
###############################################################################

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

print_header() {
  echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
}

print_success() {
  echo -e "${GREEN}$1${NC}"
}

print_info() {
  echo -e "${YELLOW}$1${NC}"
}

print_error() {
  echo -e "${RED}$1${NC}"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v kubectl >/dev/null 2>&1; then
  print_error "kubectl is required"
  exit 1
fi

if ! command -v kind >/dev/null 2>&1; then
  print_error "kind is required (cluster must already exist)"
  exit 1
fi

if ! kind get clusters >/dev/null 2>&1; then
  print_error "No kind clusters found. Create one first."
  exit 1
fi

###############################################################################
# STEP 1: Install Sealed Secrets Controller
###############################################################################
print_header "STEP 1: Installing Sealed Secrets Controller"

kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.24.5/controller.yaml

if kubectl -n kube-system get deployment sealed-secrets-controller >/dev/null 2>&1; then
  kubectl -n kube-system rollout status deployment/sealed-secrets-controller --timeout=3m
fi

print_success "Sealed Secrets controller applied"

###############################################################################
# STEP 2: Create Sealed Secret
###############################################################################
print_header "STEP 2: Creating Sealed Secret"

INCEPTION_API_KEY="${1:-${INCEPTION_API_KEY:-}}"
SLACK_WEBHOOK_URL="${2:-${SLACK_WEBHOOK_URL:-}}"
SLACK_SIGNING_SECRET="${3:-${SLACK_SIGNING_SECRET:-}}"
SLACK_BOT_TOKEN="${4:-${SLACK_BOT_TOKEN:-}}"

if [[ -z "$INCEPTION_API_KEY" ]]; then
  read -r -p "Inception API key: " INCEPTION_API_KEY
fi

if [[ -z "$SLACK_WEBHOOK_URL" ]]; then
  read -r -p "Slack webhook URL: " SLACK_WEBHOOK_URL
fi

if [[ -z "$SLACK_SIGNING_SECRET" ]]; then
  read -r -p "Slack signing secret: " SLACK_SIGNING_SECRET
fi

if [[ -z "$SLACK_BOT_TOKEN" ]]; then
  read -r -p "Slack bot token (optional, press enter to skip): " SLACK_BOT_TOKEN
fi

"${ROOT_DIR}/scripts/create-sealed-secret.sh" \
  "$INCEPTION_API_KEY" \
  "$SLACK_WEBHOOK_URL" \
  "$SLACK_SIGNING_SECRET" \
  "$SLACK_BOT_TOKEN"
print_success "Sealed secret generated"

###############################################################################
# STEP 3: Apply Secret and Core Config
###############################################################################
print_header "STEP 3: Applying Core Config"

kubectl apply -f "${ROOT_DIR}/ops/sealed-secret.yaml"
kubectl apply -f "${ROOT_DIR}/ops/agent-rbac.yml"
kubectl apply -f "${ROOT_DIR}/ops/runbook-configmap.yml"
kubectl apply -f "${ROOT_DIR}/ops/audit-pvc.yml"
print_success "Core config applied"

###############################################################################
# STEP 4: Deploy Prometheus + Grafana
###############################################################################
print_header "STEP 4: Deploying Prometheus and Grafana"

if ! command -v helm >/dev/null 2>&1; then
  print_error "helm is required to install Prometheus/Grafana"
  exit 1
fi

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

kubectl create namespace monitoring >/dev/null 2>&1 || true

print_info "Installing Prometheus Operator CRDs..."
helm show crds prometheus-community/kube-prometheus-stack | kubectl apply --server-side -f -

CRDS=(
  alertmanagers.monitoring.coreos.com
  prometheuses.monitoring.coreos.com
  prometheusrules.monitoring.coreos.com
  servicemonitors.monitoring.coreos.com
  podmonitors.monitoring.coreos.com
  probes.monitoring.coreos.com
  thanosrulers.monitoring.coreos.com
)

for crd in "${CRDS[@]}"; do
  kubectl wait --for=condition=Established "crd/${crd}" --timeout=2m
done

helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  -f "${ROOT_DIR}/ops/prometheus-values.yaml" \
  -n monitoring \
  --wait \
  --timeout 10m \
  --skip-crds

helm upgrade --install grafana grafana/grafana \
  -f "${ROOT_DIR}/ops/grafana-values.yaml" \
  -n monitoring \
  --wait \
  --timeout 10m \
  --skip-crds

print_success "Prometheus and Grafana deployed"

###############################################################################
# STEP 5: Build Docker Images
###############################################################################
print_header "STEP 5: Building Docker Images"

docker build -t agent:latest -f "${ROOT_DIR}/agent/Dockerfile" "${ROOT_DIR}/agent"
docker build -t my-app:latest -f "${ROOT_DIR}/app/Dockerfile" "${ROOT_DIR}/app"
docker build -t agent-watchdog:latest -f "${ROOT_DIR}/agent/sidecar.dockerfile" "${ROOT_DIR}/agent"
docker build -t auto-ops-dashboard:latest -f "${ROOT_DIR}/dashboard/Dockerfile" "${ROOT_DIR}/dashboard"

print_success "Docker images built"

###############################################################################
# STEP 6: Load Images into Kind
###############################################################################
print_header "STEP 6: Loading Images into Kind"

kind load docker-image agent:latest --name local
kind load docker-image my-app:latest --name local
kind load docker-image agent-watchdog:latest --name local
kind load docker-image auto-ops-dashboard:latest --name local

print_success "Images loaded into kind"

###############################################################################
# STEP 7: Deploy App, Agent, Dashboard
###############################################################################
print_header "STEP 7: Deploying Workloads"

kubectl apply -f "${ROOT_DIR}/ops/app-deployment.yml"
kubectl apply -f "${ROOT_DIR}/ops/agent-deployment.yml"
kubectl apply -f "${ROOT_DIR}/ops/agent-callback-service.yaml"
kubectl apply -f "${ROOT_DIR}/ops/dashboard-deployment.yml"

kubectl wait --for=condition=available --timeout=5m deployment/app-deployment
kubectl wait --for=condition=available --timeout=5m deployment/agent-deployment
kubectl wait --for=condition=available --timeout=5m deployment/dashboard-deployment

print_success "Deployments are ready"

###############################################################################
# STEP 8: Summary
###############################################################################
print_header "FULL DEPLOY COMPLETE"

if command -v ngrok >/dev/null 2>&1; then
  print_info "ngrok is installed. Start it in a separate terminal:"
  echo "   ngrok http 3001"
else
  print_info "ngrok not found. Downloading a temporary copy to /tmp..."
  curl -L -o /tmp/ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip
  unzip -o /tmp/ngrok.zip -d /tmp >/dev/null
  chmod +x /tmp/ngrok
  print_info "Start ngrok in a separate terminal:"
  echo "   /tmp/ngrok http 3001"
fi

echo -e "${GREEN}Dashboard (NodePort):${NC} http://localhost:30080"
echo -e "${GREEN}Dashboard (Port-forward):${NC} kubectl port-forward svc/dashboard-service 8080:8080"
echo -e "${GREEN}Chaos endpoint (NodePort):${NC} http://localhost:30000/chaos/errors"
echo -e "${GREEN}Chaos endpoint (Port-forward):${NC} kubectl port-forward svc/app-service 3000:3000"
echo -e "${GREEN}Prometheus:${NC} kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090"
echo -e "${GREEN}Grafana:${NC} kubectl port-forward -n monitoring svc/grafana 3000:80 (admin/admin)"
echo -e "${GREEN}Slack callback:${NC} kubectl port-forward svc/agent-callback 3001:3001"
