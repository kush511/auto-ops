
FROM node:18-slim

# Install CA certificates for HTTPS/TLS support
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl openssl \
	&& rm -rf /var/lib/apt/lists/*

RUN ls -l /etc/ssl/certs/ca-certificates.crt && head -20 /etc/ssl/certs/ca-certificates.crt

# Install kubectl
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl \
	&& curl -LO "https://dl.k8s.io/release/v1.29.0/bin/linux/amd64/kubectl" \
	&& chmod +x kubectl \
	&& mv kubectl /usr/local/bin/ \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /agent

# Copy package files
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

# Create writable audit directory
RUN mkdir -p /agent/audit \
	&& chown -R node:node /agent

# Run as non-root user
USER node

CMD ["node", "src/core/index.js"]