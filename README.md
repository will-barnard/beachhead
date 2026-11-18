# Beachhead

Self-hosted deployment platform for multi-language web apps with automated CI/CD, proxy routing, SSL, environment injection, and auth integration. foo

## Architecture

```
GitHub Push → Webhook → Beachhead API → Deployment Job → Worker
  → Clone → Env Inject → Docker Compose Build → Start → Proxy → Health Check → HTTPS Ready
```

### Components

- **Beachhead API** (Express) — App registration, deployment triggers, env var management, webhook receiver
- **Deployment Worker** — State machine that clones, builds, and deploys apps through Docker Compose
- **Nginx Proxy** — `nginxproxy/nginx-proxy` with automatic routing via `VIRTUAL_HOST` env vars
- **LetsEncrypt Companion** — Automatic SSL certs via `nginxproxy/acme-companion`
- **Vue Dashboard** — Web UI for managing apps, deployments, and environment variables
- **PostgreSQL** — Stores apps, deployments, and env vars

### Docker Network

All deployed containers join `beachhead-net`, enabling the nginx proxy to route traffic by reading `VIRTUAL_HOST` / `VIRTUAL_PORT` environment variables.

## Quick Start

### 1. Install

SSH into your server (or open a terminal on your Mac) and run:

```bash
git clone https://github.com/your-org/beachhead.git
cd beachhead
./install.sh
```

The installer auto-detects Linux vs macOS and adjusts accordingly:

| | Linux (Ubuntu/Debian/RHEL) | macOS |
|---|---|---|
| Docker | Auto-installs via `get.docker.com` if missing | Must pre-install Docker Desktop or colima — installer fails fast otherwise |
| Boot startup | systemd units (`beachhead.service`, `docker-beachhead-net.service`) | Docker Desktop "Open at login" + `restart: unless-stopped` (no LaunchAgent) |
| Deploy dir | `/var/beachhead/deployments` (created with sudo) | `~/beachhead/deployments` (no sudo) |
| Package mgr | apt / yum / dnf | brew (for any missing CLI tool) |

In both cases the installer will:
- Verify Docker, Docker Compose, and Git
- Prompt for the **hostname** this Beachhead will be served at (e.g. `beachhead.example.com`) and an **email** for SSL
- Generate a secure database password
- Write `.env` with all configuration (including the platform-appropriate `DEPLOY_BASE_DIR`)
- Create the `beachhead-net` Docker network
- Build and start all services
- Verify the API is healthy

> **Prerequisite:** Point your domain's DNS to this server's IP before or shortly after running the installer. SSL certificates are provisioned automatically once DNS resolves.

> **Running more than one Beachhead:** the hostname prompt accepts any hostname you control, so a second install can sit at `beachhead2.example.com` alongside the first at `beachhead.example.com`. Re-running `install.sh` keeps the current hostname as the default, so an update never silently moves the dashboard.
>
> Each Beachhead needs its **own VM**. Container names (`beachhead-api`, `beachhead-proxy`, …), the `beachhead-net` network, host ports 80/443/3000, and the systemd units are fixed names — two stacks on one machine collide, and only one nginx-proxy can bind :80/:443.

> **macOS note:** Docker Desktop must be running before you start the installer. Ports 80 and 443 must be free (Docker Desktop binds them on the host). `~/beachhead/deployments` is bind-mounted at the same path inside the container, so the host docker daemon and the in-container code agree on absolute paths.

### 2. Manual setup (alternative)

```bash
cp .env.example .env
# Edit .env — set BEACHHEAD_DOMAIN, LETSENCRYPT_EMAIL, POSTGRES_PASSWORD
docker compose up -d --build
```

### 3. Register an app

```bash
curl -X POST http://localhost:3000/api/apps \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-app",
    "repo_url": "https://github.com/user/repo",
    "domain": "app.example.com",
    "branch": "main",
    "public_service": "web",
    "public_port": 3000
  }'
```

### 4. Set up GitHub webhook

Point your repo's webhook to `https://<BEACHHEAD_DOMAIN>/api/webhooks/github` with:
- Content type: `application/json`
- Events: `push`
- Secret: match the `webhook_secret` on the app (or `GITHUB_WEBHOOK_SECRET` global default)

### 5. Push and deploy

Push to the configured branch. Beachhead receives the webhook, creates a deployment job, and the worker runs the full pipeline.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/apps` | List all apps |
| `POST` | `/api/apps` | Register a new app |
| `GET` | `/api/apps/:id` | Get app details |
| `PUT` | `/api/apps/:id` | Update app |
| `DELETE` | `/api/apps/:id` | Delete app |
| `POST` | `/api/apps/:id/deploy` | Trigger manual deployment |
| `GET` | `/api/apps/:id/deployments` | Deployment history |
| `GET` | `/api/apps/:id/env` | List env vars |
| `POST` | `/api/apps/:id/env` | Set env var |
| `DELETE` | `/api/apps/:appId/env/:envId` | Delete env var |
| `POST` | `/api/webhooks/github` | GitHub webhook receiver |
| `GET` | `/api/system/monitor/health` | Instance health summary (stable shape — what Cabana polls) |
| `GET` | `/api/system/monitor/snapshot` | Everything the collector last saw |
| `GET` | `/api/system/monitor/metrics?kind=&subject=&range=` | Time series (`host`, `disk`, `container`; `1h`–`30d`) |
| `GET` | `/api/system/monitor/alerts?status=open` | Open / resolved alerts |
| `POST` | `/api/system/monitor/alerts/:id/resolve` | Dismiss an alert |
| `GET`/`PUT` | `/api/system/monitor/config` | Thresholds, alert email, heartbeat |
| `POST` | `/api/system/monitor/test-email` | Send a test alert email |

## System Monitor

Beachhead samples itself every minute and alerts by email (Resend) when something
needs attention. Dashboard → **Health**.

**What it watches**

| Area | Checks |
|------|--------|
| Host / VM | Memory, swap, CPU, load per core |
| Disk | Docker storage and the deploy directory: % used, plus a "full in N days" projection from the last 24h |
| Containers | CPU, memory (vs. its limit, or vs. the host when unlimited), steady memory climb toward the ceiling, failing healthchecks |
| Events | OOM kills; crash loops (3+ unexpected exits in 10 min) |
| Apps | A service of the active deployment not running; HTTPS probe through nginx-proxy every 2 min (5xx / no response = down) |
| Beachhead | Core containers down, deploys stuck > 20 min, latest deploy failed, certificates < 14 days from expiry (renewal is failing) |

On macOS "host" means Docker Desktop's VM — its memory and disk-image size are the
ceiling containers actually hit. Paused and auto-paused apps are skipped, and probe
traffic is excluded from the on-demand activity log.

Alerts open after the condition holds for a few minutes, resolve with a small margin
so they don't flap, and are batched into one email per 30 seconds (max 12/hour).
Samples are kept 48h raw and 30 days as 15-minute averages.

**Setup:** Health → Alert settings → Resend API key, a verified sender, recipients →
*Send test*. Optionally add a heartbeat URL (e.g. healthchecks.io): Beachhead pings
it every minute, so if the whole machine goes down, that service emails you.


## Deployment State Machine

```
PENDING → CLONING → ENV_INJECTION → BUILDING → STARTING_CONTAINERS → PROXY_SETUP → VERIFY_HEALTH → SUCCESS
                                                                                                      ↓
Any failure ──────────────────────────────────────────────────────────────────────────────────────→ FAILED
```

## Compose Wrapper

Your repo provides `docker-compose.yml`. Beachhead generates `beachhead.override.yml`:

```yaml
version: "3.9"
services:
  <public_service>:
    environment:
      - VIRTUAL_HOST=<domain>
      - VIRTUAL_PORT=<internal_port>
      - LETSENCRYPT_HOST=<domain>
    networks:
      - beachhead-net
networks:
  beachhead-net:
    external: true
```

Deployment runs:
```bash
docker compose -f docker-compose.yml -f beachhead.override.yml up -d --build
```

## beachhead.json (Optional)

Place in your repo root to auto-configure:

```json
{
  "public_service": "web",
  "public_port": 3000,
  "health_check": "/healthz"
}
```

## Auth

Beachhead starts in **bootstrap mode** (no auth required). Once you deploy an auth service and configure `AUTH_JWKS_URL` / `AUTH_ISSUER`, all sensitive endpoints require a JWT with `super_admin` role.

## Development

```bash
# Backend
npm install
npm run dev

# Dashboard
cd dashboard
npm install
npm run dev
```

The dashboard dev server proxies `/api` requests to `localhost:3000`.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BEACHHEAD_DOMAIN` | Domain for dashboard & API (set by installer) | — |
| `LETSENCRYPT_EMAIL` | Email for SSL certificates | — |
| `POSTGRES_PASSWORD` | Database password (auto-generated by installer) | — |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `PORT` | API server port | `3000` |
| `AUTH_JWKS_URL` | JWKS endpoint for JWT verification (empty = bootstrap mode) | — |
| `AUTH_ISSUER` | Expected JWT issuer | — |
| `GITHUB_WEBHOOK_SECRET` | Default webhook secret | — |
| `DEPLOY_BASE_DIR` | Directory for cloned repos | `/var/beachhead/deployments` |
| `DOCKER_NETWORK` | Docker network name | `beachhead-net` |
| `HEALTH_CHECK_TIMEOUT` | Health check timeout (ms) | `30000` |
| `HEALTH_CHECK_INTERVAL` | Health check retry interval (ms) | `2000` |
| `RESEND_API_KEY` | Fallback for the alert email API key (dashboard setting wins) | — |
| `ALERT_EMAIL_TO` | Fallback alert recipients, comma-separated | — |
| `ALERT_EMAIL_FROM` | Fallback alert sender (must be verified in Resend) | — |
