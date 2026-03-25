FROM node:18-alpine

WORKDIR /agent

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]