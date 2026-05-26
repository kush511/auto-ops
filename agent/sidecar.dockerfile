
FROM node:18-slim

# Install CA certificates for HTTPS/TLS support
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl openssl \
	&& rm -rf /var/lib/apt/lists/*

RUN ls -l /etc/ssl/certs/ca-certificates.crt && head -20 /etc/ssl/certs/ca-certificates.crt

# Use a non-root user for security
USER node

WORKDIR /agent

# Copy only the watchdog and package files
COPY src/sidecar/ ./src/sidecar/
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Run the watchdog
CMD ["node", "src/sidecar/watchdog.js"]
