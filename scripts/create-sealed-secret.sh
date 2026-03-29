#!/bin/bash
# Usage: ./scripts/create-sealed-secret.sh <secret-name> <key-name> <plaintext-value>

SECRET_NAME=$1
KEY_NAME=$2
PLAINTEXT_VALUE=$3

# Create temporary secret
kubectl create secret generic $SECRET_NAME \
    --dry-run=client \
    --from-literal=$KEY_NAME="$PLAINTEXT_VALUE" \
    -o yaml > temp-secret.yaml

# Seal it
kubeseal --format yaml < temp-secret.yaml > ops/sealed-$SECRET_NAME.yaml

# Clean up
rm temp-secret.yaml

echo "Sealed secret created at k8s/sealed-$SECRET_NAME.yaml"
echo "You can now commit this file to git"