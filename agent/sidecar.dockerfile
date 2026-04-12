FROM node:18-alpine

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
