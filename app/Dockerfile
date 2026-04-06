FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# Copy the entire src directory (includes new chaos routes)
COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/index.js"]