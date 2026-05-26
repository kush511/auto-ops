SHELL := /bin/bash
KIND_CLUSTER ?= auto-ops
KIND_CONTEXT := kind-$(KIND_CLUSTER)
DASHBOARD_NODEPORT ?= 30080
APP_NODEPORT ?= 30000

.PHONY: demo

demo:
	@command -v kind >/dev/null 2>&1 || (echo "Install kind first: https://kind.sigs.k8s.io" && exit 1)
	@command -v kubectl >/dev/null 2>&1 || (echo "Install kubectl first: https://kubernetes.io/docs/tasks/tools/" && exit 1)
	@command -v docker >/dev/null 2>&1 || (echo "Install Docker first: https://docs.docker.com/get-docker/" && exit 1)
	@command -v helm >/dev/null 2>&1 || (echo "Install Helm first: https://helm.sh/docs/intro/install/" && exit 1)
	@if ! kind get clusters | grep -q "^$(KIND_CLUSTER)$$"; then \
		echo "Creating kind cluster: $(KIND_CLUSTER)"; \
		kind create cluster --name $(KIND_CLUSTER); \
	fi
	@kubectl config use-context $(KIND_CONTEXT)
	@helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
	@helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
	@helm repo update >/dev/null
	@kubectl create namespace monitoring >/dev/null 2>&1 || true
	@helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
		-f ops/prometheus-values.yaml \
		-n monitoring \
		--wait \
		--timeout 10m \
		--skip-crds
	@helm upgrade --install grafana grafana/grafana \
		-f ops/grafana-values.yaml \
		-n monitoring \
		--wait \
		--timeout 10m \
		--skip-crds
	@docker build -t agent:latest -f agent/Dockerfile agent
	@docker build -t my-app:latest -f app/Dockerfile app
	@docker build -t agent-watchdog:latest -f agent/sidecar.dockerfile agent
	@docker build -t auto-ops-dashboard:latest -f dashboard/Dockerfile dashboard
	@kind load docker-image agent:latest
	@kind load docker-image my-app:latest
	@kind load docker-image agent-watchdog:latest
	@kind load docker-image auto-ops-dashboard:latest
	@if [ -f ops/sealed-secret.yaml ]; then \
		kubectl apply -f ops/sealed-secret.yaml; \
	else \
		echo "WARNING: ops/sealed-secret.yaml not found. Slack + LLM features may be disabled."; \
	fi
	@kubectl apply -f ops/agent-rbac.yml
	@kubectl apply -f ops/runbook-configmap.yml
	@kubectl apply -f ops/audit-pvc.yml
	@kubectl apply -f ops/app-deployment.yml
	@kubectl apply -f ops/agent-deployment.yml
	@kubectl apply -f ops/agent-callback-service.yaml
	@kubectl apply -f ops/dashboard-deployment.yml
	@kubectl wait --for=condition=available --timeout=5m deployment/app-deployment
	@kubectl wait --for=condition=available --timeout=5m deployment/agent-deployment
	@kubectl wait --for=condition=available --timeout=5m deployment/dashboard-deployment
	@echo ""
	@echo "Dashboard URL: http://localhost:$(DASHBOARD_NODEPORT)"
	@echo "Chaos endpoint: http://localhost:$(APP_NODEPORT)/chaos/errors"
