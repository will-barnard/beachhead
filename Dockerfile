# Stage 1: build the Vue dashboard
FROM node:20-alpine AS dashboard-build
WORKDIR /dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# Stage 2: production API image
FROM node:20-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Copy built dashboard so the API can serve it as static files
COPY --from=dashboard-build /dashboard/dist ./dashboard/dist

EXPOSE 3000

CMD ["node", "src/server.js"]
