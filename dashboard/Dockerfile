FROM node:18-alpine

RUN apk add --no-cache curl \
  && curl -LO "https://dl.k8s.io/release/v1.29.0/bin/linux/amd64/kubectl" \
  && chmod +x kubectl \
  && mv kubectl /usr/local/bin/

WORKDIR /dashboard

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY public/ ./public/

EXPOSE 8080

CMD ["node", "src/index.js"]
