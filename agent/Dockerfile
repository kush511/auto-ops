FROM node:18-alpine

WORKDIR /agent

# Install docker CLI
RUN apk add --no-cache docker-cli

RUN apk add --no-cache curl

RUN curl -LO "https://dl.k8s.io/release/v1.29.0/bin/linux/amd64/kubectl" \
 && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]