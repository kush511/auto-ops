FROM node:18-alpine

# Install kubectl
RUN apk add --no-cache curl \
	&& curl -LO "https://dl.k8s.io/release/v1.29.0/bin/linux/amd64/kubectl" \
	&& chmod +x kubectl \
	&& mv kubectl /usr/local/bin/

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