# Deploying an App on Beachhead

## Quick reference — paste this to an AI when building a Beachhead-compatible app

> **Deploying on Beachhead** — include a `beachhead.json` in the repo root specifying `public_service` (the service name that handles HTTP, e.g. `frontend`) and `public_port` (e.g. `80`). In `docker-compose.yml`: no `version:` key; use `expose:` not `ports:` for all services (Beachhead's nginx-proxy handles routing); do NOT set `container_name` on any service (Beachhead sets unique names per deployment via its override — a hardcoded name will conflict and crash the deploy); postgres healthcheck must have `start_period: 30s`; database volume **must** use a fixed `name:` (e.g. `name: myapp-postgres`) — without it every redeploy creates a fresh volume and wipes the database; frontend nginx must proxy to `backend` by Docker service name (not `localhost`). Set `DB_PASSWORD` and any vars shared between services as **global** env vars in the Beachhead dashboard (no Target Service) so they're written to `.env` for Docker Compose variable substitution. Use `npm install` not `npm ci` in Dockerfiles.

---

## How Beachhead deploys your app

1. Clones your repo into a fresh directory per deployment
2. Writes a `beachhead.override.yml` that adds `VIRTUAL_HOST`, `VIRTUAL_PORT`, `LETSENCRYPT_HOST` to your public service, connects it to the `beachhead-net` Docker network, and sets a unique `container_name` per deployment
3. Writes a `.env` file in the repo root from any **global** env vars you've configured in the dashboard
4. Runs `docker compose -f docker-compose.yml -f beachhead.override.yml up -d --build`
5. Health-checks your domain over HTTPS
6. On success, stops the previous deployment's containers

---

## Required: `beachhead.json` in repo root

Tells Beachhead which service exposes HTTP traffic and on what port.

```json
{
  "public_service": "frontend",
  "public_port": 80
}
```

- `public_service` must match a service name in your `docker-compose.yml`
- `public_port` is the port that service listens on inside the container

---

## `docker-compose.yml` requirements

### General
- **No `version:` key** — it's obsolete and Docker Compose will warn
- Use `npm install` not `npm ci` in Dockerfiles (avoids lockfile conflicts)
- Use `expose:` not `ports:` for all services — Beachhead's nginx-proxy handles routing; binding host ports is unnecessary and can conflict
- **Do not set `container_name`** on any service — Beachhead's override sets unique names per deployment (`slug-service-dN`); a hardcoded name will conflict with the running previous deploy and cause the entire deploy to fail

### Postgres healthcheck
Must include `start_period` so Beachhead doesn't fail while postgres is initializing:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s     # required — gives postgres time to init before health checks count
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

### Persistent database volume
Each deploy runs in a fresh directory, so volumes must use a fixed `name:` to survive redeployments:

```yaml
volumes:
  postgres_data:
    name: myapp-postgres     # required — fixed name survives redeploys
```

**Do not use `driver: local` instead of `name:`.** Without `name:`, Docker Compose scopes the volume to the project directory (`deploy-N_postgres_data`), creating a fresh empty database on every deploy and wiping all user data.

### Backend depends_on postgres
```yaml
  backend:
    depends_on:
      postgres:
        condition: service_healthy
```

### Frontend nginx → backend proxy
If your frontend is an nginx container proxying API calls to a backend service, use the Docker Compose service name as the upstream hostname:

```nginx
location /api/ {
    proxy_pass http://backend:3000/api/;
}
```

The service name resolves on the compose default network. Do **not** use `localhost`.

---

## Env vars in Beachhead dashboard

Beachhead writes env vars to a `.env` file in the cloned repo root before running `docker compose`. Docker Compose reads this file for `${VAR}` substitution in `docker-compose.yml`.

**Key rules:**
- **Global env vars** (no Target Service set) → written to `.env` → available for `${VAR}` substitution in `docker-compose.yml` (e.g. `DB_PASSWORD`, `JWT_SECRET`)
- **Targeted env vars** (Target Service = `backend`) → injected directly into that service's environment in the override — useful for secrets that only one service needs and shouldn't be in `.env`
- Variables used by multiple services (like `DB_PASSWORD` shared by postgres and backend) must be **global** so they land in `.env`

### Typical env vars to configure
| Key | Target | Notes |
|-----|--------|-------|
| `DB_PASSWORD` | *(global)* | Used by both postgres and backend |
| `JWT_SECRET` | *(global)* or `backend` | Only needed by backend |
| `CORS_ORIGIN` | *(global)* or `backend` | Set to `https://your.domain` |
| `NODE_ENV` | `backend` | `production` |

---

## Full working example

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql
    expose:
      - "5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: myapp
      DB_USER: postgres
      DB_PASSWORD: ${DB_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      CORS_ORIGIN: ${CORS_ORIGIN}
    expose:
      - "3000"
    depends_on:
      postgres:
        condition: service_healthy

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    restart: unless-stopped
    expose:
      - "80"
    depends_on:
      - backend

volumes:
  postgres_data:
    name: myapp-postgres
```

```json
// beachhead.json
{
  "public_service": "frontend",
  "public_port": 80
}
```

---

## Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `dependency failed to start: container is unhealthy` | Postgres health check fires before init completes | Add `start_period: 30s` to healthcheck |
| 502 from nginx after redeploy | Old frontend container still on `beachhead-net`, proxying to a backend that no longer exists | Beachhead auto-cleans up on success; for manual recovery `docker stop <old-frontend-container>` |
| `${DB_PASSWORD}` empty in postgres | Env var is targeted to `backend` only, not written to `.env` | Set `DB_PASSWORD` as a global env var (no target service) |
| Data wiped on every deploy / logged out after redeploy | Volume uses `driver: local` with no `name:` | Replace with `name: myapp-postgres` — `driver: local` scopes the volume to the deploy directory |
| Container name conflict on redeploy / deploy fails at STARTING_CONTAINERS | `container_name` hardcoded in `docker-compose.yml`, conflicts with still-running previous deploy | Remove all `container_name` entries — Beachhead sets unique names per deployment via its override |
| Port conflict or deploy fails | `ports:` binding a host port that's already in use | Replace `ports:` with `expose:` for all services |
