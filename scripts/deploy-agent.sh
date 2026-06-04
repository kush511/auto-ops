#!/bin/bash

###############################################################################
# Agent + App Deployment Script (Quick Redeploy)
# Use this to redeploy the agent after modifications
# Assumes Prometheus/Grafana are already running in monitoring namespace
###############################################################################

set -e

# Color codes
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

print_error() {
    echo -e "${RED}$1${NC}"
}

print_info() {
    echo -e "${YELLOW}$1${NC}"
}

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

###############################################################################
# STEP 1: Build Docker Images
###############################################################################
print_header "STEP 1: Building Docker Images"

print_info "Building agent image..."
docker build -t auto-ops-agent:latest "$SCRIPT_DIR/agent" -f "$SCRIPT_DIR/agent/Dockerfile" || \
    print_error "Failed to build agent image"

print_info "Building app image..."
docker build -t auto-ops-app:latest "$SCRIPT_DIR/app" -f "$SCRIPT_DIR/app/Dockerfile" || \
    print_error "Failed to build app image"

print_info "Building watchdog sidecar image..."
docker build -t agent-watchdog:latest "$SCRIPT_DIR/agent" -f "$SCRIPT_DIR/agent/sidecar.dockerfile" || \
    print_error "Failed to build watchdog image"

print_success "All images built"

###############################################################################
# STEP 2: Load Images into Kind (if using kind)
###############################################################################
print_header "STEP 2: Loading Images into Kind Cluster"

if kubectl cluster-info 2>&1 | grep -q "kind"; then
    print_info "Loading images into kind..."
    kind load docker-image auto-ops-agent:latest
    kind load docker-image auto-ops-app:latest
    kind load docker-image agent-watchdog:latest
    print_success "Images loaded"
else
    print_info "Not using kind - skipping image loading"
fi

###############################################################################
# STEP 3: Delete Existing Deployments (if they exist)
###############################################################################
print_header "STEP 3: Preparing for New Deployment"

print_info "Checking for existing deployments..."
if kubectl get deployment agent -n default &>/dev/null; then
    print_info "Deleting existing agent deployment..."
    kubectl delete deployment agent
    sleep 2
fi

if kubectl get deployment app-deployment -n default &>/dev/null; then
    print_info "Deleting existing app deployment..."
    kubectl delete deployment app-deployment
    sleep 2
fi

print_success "Old deployments cleaned up"

###############################################################################
# STEP 4: Deploy App
###############################################################################
print_header "STEP 4: Deploying App"

print_info "Applying app deployment..."
kubectl apply -f "$SCRIPT_DIR/../ops/app-deployment.yml"

print_info "Waiting for app to be ready..."
kubectl wait --for=condition=available --timeout=3m deployment/app-deployment

print_success "App deployed"

###############################################################################
# STEP 5: Deploy Agent with Watchdog
###############################################################################
print_header "STEP 5: Deploying Agent with Watchdog Sidecar"

print_info "Applying agent deployment..."
kubectl apply -f "$SCRIPT_DIR/../ops/agent-deployment.yml"

print_info "Waiting for agent pod to be ready..."
kubectl wait --for=condition=ready pod -l app=agent --timeout=3m

print_success "Agent deployed with watchdog sidecar"

###############################################################################
# STEP 6: Verify
###############################################################################
print_header "STEP 6: Verifying Deployment"

echo -e "${GREEN}App Pod Status:${NC}"
kubectl get pod -l app=app

echo ""
echo -e "${GREEN}Agent Pod Status (with watchdog sidecar):${NC}"
kubectl get pod -l app=agent

echo ""
echo -e "${GREEN}Recent Agent Logs:${NC}"
kubectl logs deployment/agent -c agent --tail=20

###############################################################################
# STEP 7: Ready
###############################################################################
print_header "DEPLOYMENT COMPLETE"

echo -e "${GREEN}Next Steps:${NC}"
echo ""
echo "View Agent Logs:"
echo "   kubectl logs -f deployment/agent -c agent"
echo ""
echo "View Watchdog Logs:"
echo "   kubectl logs -f deployment/agent -c watchdog"
echo ""
echo "Port Forward Prometheus:"
echo "   kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090"
echo ""
echo "Port Forward Grafana:"
echo "   kubectl port-forward -n monitoring svc/grafana 3000:80"
echo ""
echo "Test Metrics Endpoint:"
echo "   kubectl port-forward svc/app 3000:3000"
echo "   # Then: curl http://localhost:3000/metrics"
echo ""

