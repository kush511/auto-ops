FROM node:18-alpine

WORKDIR /agent

# Install docker CLI
RUN apk add --no-cache docker-cli

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]