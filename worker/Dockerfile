FROM node:20-alpine

RUN apk add --no-cache git docker-cli docker-cli-buildx

WORKDIR /worker

COPY package*.json ./
COPY cli.js ./

ENV NODE_ENV=production

CMD ["node", "cli.js", "start"]
