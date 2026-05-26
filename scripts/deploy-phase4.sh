#!/bin/bash

###############################################################################
# Phase 4 Complete Deployment Script
# Deploys: Prometheus, Grafana, Agent with watchdog sidecar
# Run this script to set up everything after cluster recreation
###############################################################################

set -e  # Exit on any error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print with color
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

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

###############################################################################
# STEP 1: Add Helm Repositories
###############################################################################
print_header "STEP 1: Adding Helm Repositories"

print_info "Adding Prometheus Community Helm repo..."
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || \
    print_info "Prometheus Community repo already exists"

print_info "Adding Grafana Helm repo..."
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || \
    print_info "Grafana repo already exists"

print_info "Updating all Helm repositories..."
helm repo update

print_success "Helm repositories configured"

###############################################################################
# STEP 2: Create Monitoring Namespace
###############################################################################
print_header "STEP 2: Creating Monitoring Namespace"

print_info "Creating 'monitoring' namespace..."
kubectl create namespace monitoring 2>/dev/null || \
    print_info "Namespace 'monitoring' already exists"

print_success "Monitoring namespace ready"

###############################################################################
# STEP 3: Deploy Prometheus
###############################################################################
print_header "STEP 3: Deploying Prometheus via Helm"

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

print_info "Deploying Prometheus with custom values..."
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
    -f "$SCRIPT_DIR/../ops/prometheus-values.yaml" \
    -n monitoring \
    --wait \
    --timeout 10m \
    --skip-crds

print_success "Prometheus deployed successfully"
print_info "Prometheus Service: prometheus-operated.monitoring.svc.cluster.local:9090"

###############################################################################
# STEP 4: Deploy Grafana
###############################################################################
print_header "STEP 4: Deploying Grafana via Helm"

print_info "Deploying Grafana with custom values..."
# Grafana chart is deprecated - using longer timeout and skip-crds flag for stability
if ! helm upgrade --install grafana grafana/grafana \
    -f "$SCRIPT_DIR/../ops/grafana-values.yaml" \
    -n monitoring \
    --wait \
    --timeout 10m \
    --skip-crds 2>&1 | tee /tmp/grafana-deploy.log; then
    print_error "Grafana deployment failed or timed out"
    print_info "Checking Grafana pod status..."
    kubectl describe pod -l app.kubernetes.io/name=grafana -n monitoring || true
    print_info "Checking events in monitoring namespace..."
    kubectl get events -n monitoring --sort-by='.lastTimestamp' | tail -20 || true
    exit 1
fi

print_success "Grafana deployed successfully"
print_info "Grafana Credentials: admin / admin"
print_info "Grafana Service: grafana.monitoring.svc.cluster.local"

###############################################################################
# STEP 5: Wait for Pods to Be Ready
###############################################################################
print_header "STEP 5: Waiting for All Pods to Be Ready"

print_info "Waiting for Prometheus pod..."
kubectl wait --for=condition=ready pod \
    -l app.kubernetes.io/name=prometheus \
    -n monitoring \
    --timeout=10m

print_info "Waiting for Grafana pod..."
kubectl wait --for=condition=ready pod \
    -l app.kubernetes.io/name=grafana \
    -n monitoring \
    --timeout=10m

print_success "All monitoring pods are ready"

###############################################################################
# STEP 6: Verify Deployments
###############################################################################
print_header "STEP 6: Verifying Deployments"

print_info "Pods in monitoring namespace:"
kubectl get pods -n monitoring

print_info "\nServices in monitoring namespace:"
kubectl get svc -n monitoring

###############################################################################
# STEP 7: Build Docker Images (Optional)
###############################################################################
print_header "STEP 7: Building Docker Images"

print_info "Checking if Docker images need to be built..."

# Build agent image if it doesn't exist or if requested
if ! docker image ls | grep -q "^agent[[:space:]]"; then
    print_info "Building agent Docker image..."
    docker build -t agent:latest -f "$SCRIPT_DIR/../agent/Dockerfile" "$SCRIPT_DIR/../agent"
    print_success "Agent image built"
else
    print_info "Agent image already exists"
fi

# Build app image if it doesn't exist
if ! docker image ls | grep -q "^my-app[[:space:]]"; then
    print_info "Building app Docker image..."
    docker build -t my-app:latest -f "$SCRIPT_DIR/../app/Dockerfile" "$SCRIPT_DIR/../app"
    print_success "App image built"
else
    print_info "App image already exists"
fi

# Build watchdog image if it doesn't exist
if ! docker image ls | grep -q "^agent-watchdog[[:space:]]"; then
    print_info "Building watchdog Docker image..."
    docker build -t agent-watchdog:latest -f "$SCRIPT_DIR/../agent/sidecar.dockerfile" "$SCRIPT_DIR/../agent"
    print_success "Watchdog image built"
else
    print_info "Watchdog image already exists"
fi

###############################################################################
# STEP 8: Load Images into Kind Cluster
###############################################################################
print_header "STEP 8: Loading Images into Kind Cluster"

# Check if we're using kind
if kubectl cluster-info 2>&1 | grep -q "kind"; then
    print_info "Loading images into kind cluster..."

    kind load docker-image agent:latest 2>/dev/null || \
        print_info "Could not load agent:latest"

    kind load docker-image my-app:latest 2>/dev/null || \
        print_info "Could not load my-app:latest"

    kind load docker-image agent-watchdog:latest 2>/dev/null || \
        print_info "Could not load agent-watchdog:latest"

    print_success "Images loaded into kind cluster"
else
    print_info "Not using kind cluster - skipping image loading"
fi

###############################################################################
# STEP 9: Deploy Agent with Phase 4 Features (Optional)
###############################################################################
print_header "STEP 9: Ready to Deploy Agent"

read -p "Deploy agent with Phase 4 features now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Deploying agent with watchdog sidecar..."
    kubectl apply -f "$SCRIPT_DIR/../ops/agent-deployment.yml"
    kubectl apply -f "$SCRIPT_DIR/../ops/app-deployment.yml"

    print_info "Waiting for agent to be ready..."
    kubectl wait --for=condition=ready pod \
        -l app=agent \
        --timeout=3m

    print_success "Agent deployed with Phase 4 features"
    print_info "View agent logs: kubectl logs -f deployment/agent -c agent"
    print_info "View watchdog logs: kubectl logs -f deployment/agent -c watchdog"
else
    print_info "Skipping agent deployment"
fi

###############################################################################
# STEP 10: Summary
###############################################################################
print_header "PHASE 4 DEPLOYMENT COMPLETE"

echo -e "${GREEN}Infrastructure Summary:${NC}"
echo ""
echo "Prometheus:"
echo "   Service: prometheus-operated.monitoring.svc.cluster.local:9090"
echo "   Retention: 15 days"
echo "   Scrape Interval: 30 seconds"
echo ""
echo "Grafana:"
echo "   Service: grafana.monitoring.svc.cluster.local"
echo "   User: admin / Password: admin"
echo ""
echo "Dead Man's Switch (if agent deployed):"
echo "   Heartbeat: /agent/heartbeat/timestamp.txt"
echo "   Watchdog checks every 30 seconds"
echo "   Alert on 120+ seconds of silence"
echo ""
echo "Useful Commands:"
echo "   # Watch agent logs"
echo "   kubectl logs -f deployment/agent -c agent"
echo ""
echo "   # Watch watchdog logs"
echo "   kubectl logs -f deployment/agent -c watchdog"
echo ""
echo "   # Check Prometheus targets"
echo "   kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090"
echo "   # Then visit: http://localhost:9090/targets"
echo ""
echo "   # Check Grafana"
echo "   kubectl port-forward -n monitoring svc/grafana 3000:80"
echo "   # Then visit: http://localhost:3000"
echo ""
echo "   # View all monitoring resources"
echo "   kubectl get all -n monitoring"
echo ""
echo -e "${GREEN}Ready for Phase 4 testing!${NC}\n"

