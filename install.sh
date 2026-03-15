#!/bin/bash
set -euo pipefail

# ──────────────────────────────────────────────
# Beachhead Installer
# Self-hosted deployment platform
# ──────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  ⚓  Beachhead Installer${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Install prerequisites ─────────────────────

info "Checking and installing prerequisites..."

# Detect package manager
if command -v apt-get &>/dev/null; then
  PKG_MGR="apt"
elif command -v yum &>/dev/null; then
  PKG_MGR="yum"
elif command -v dnf &>/dev/null; then
  PKG_MGR="dnf"
else
  PKG_MGR=""
fi

install_pkg() {
  local pkg="$1"
  if [[ -z "$PKG_MGR" ]]; then
    fail "No supported package manager found (apt/yum/dnf). Install $pkg manually."
  fi
  info "Installing $pkg..."
  case "$PKG_MGR" in
    apt) sudo apt-get update -qq && sudo apt-get install -y -qq "$pkg" ;;
    yum) sudo yum install -y -q "$pkg" ;;
    dnf) sudo dnf install -y -q "$pkg" ;;
  esac
}

# Git
if ! command -v git &>/dev/null; then
  install_pkg git
fi
ok "Git found: $(git --version)"

# curl (needed for Docker install and health checks)
if ! command -v curl &>/dev/null; then
  install_pkg curl
fi

# Docker Engine
if ! command -v docker &>/dev/null; then
  info "Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable --now docker
  # Add current user to docker group so we don't need sudo for docker commands
  if ! groups | grep -q docker; then
    sudo usermod -aG docker "$USER"
    warn "Added $USER to docker group. Group change takes effect on next login."
    warn "For now, the installer will use sudo for docker commands."
    # Re-exec with newgrp so the current script can use docker without sudo
    DOCKER_SUDO="sudo"
  fi
fi
DOCKER_SUDO="${DOCKER_SUDO:-}"
ok "Docker found: $(docker --version)"

# Docker Compose (V2 plugin)
if ! docker compose version &>/dev/null; then
  info "Installing Docker Compose plugin..."
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  COMPOSE_VERSION=$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  COMPOSE_VERSION="${COMPOSE_VERSION:-v2.24.5}"
  sudo curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi
ok "Docker Compose found: $(docker compose version --short)"

# Check Docker daemon is running
if ! ${DOCKER_SUDO} docker info &>/dev/null; then
  info "Starting Docker daemon..."
  sudo systemctl start docker
  sleep 2
  if ! ${DOCKER_SUDO} docker info &>/dev/null; then
    fail "Docker daemon failed to start. Check: sudo systemctl status docker"
  fi
fi
ok "Docker daemon is running"

echo ""

# ── Prompt for configuration ─────────────────

echo -e "${BOLD}Configuration${NC}"
echo ""

# Domain
read -rp "$(echo -e "${CYAN}▸${NC}") Enter your root domain (e.g. example.com): " ROOT_DOMAIN
if [[ -z "$ROOT_DOMAIN" ]]; then
  fail "Domain name is required."
fi

# Strip any leading subdomain the user may have accidentally included
ROOT_DOMAIN="${ROOT_DOMAIN#beachhead.}"

# Validate domain format (basic check)
if ! echo "$ROOT_DOMAIN" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'; then
  warn "Domain '${ROOT_DOMAIN}' may not be valid. Continuing anyway."
fi

# Beachhead will be served at beachhead.<root-domain>
BEACHHEAD_DOMAIN="beachhead.${ROOT_DOMAIN}"
info "Beachhead will be available at: https://${BEACHHEAD_DOMAIN}"

# Email for LetsEncrypt
read -rp "$(echo -e "${CYAN}▸${NC}") Email for SSL certificates (LetsEncrypt): " LETSENCRYPT_EMAIL
if [[ -z "$LETSENCRYPT_EMAIL" ]]; then
  fail "Email is required for LetsEncrypt SSL certificates."
fi

# Database password
# Reuse existing DB password if .env already exists — new password would break existing pgdata volume
if [[ -f .env ]] && grep -q "^POSTGRES_PASSWORD=" .env; then
  DB_PASSWORD=$(grep "^POSTGRES_PASSWORD=" .env | cut -d'=' -f2)
  info "Reusing existing database password from .env"
else
  DB_PASSWORD=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -p | head -c 32)
  info "Generated secure database password"
fi

# GitHub webhook secret (optional)
echo ""
read -rp "$(echo -e "${CYAN}▸${NC}") Default GitHub webhook secret (leave blank to skip): " GITHUB_WEBHOOK_SECRET
GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-}"

echo ""
echo -e "${BOLD}Summary${NC}"
echo "  Root domain: ${ROOT_DOMAIN}"
echo "  Beachhead:   https://${BEACHHEAD_DOMAIN}"
echo "  Email:       ${LETSENCRYPT_EMAIL}"
echo "  Webhook:   ${GITHUB_WEBHOOK_SECRET:-<not set>}"
echo ""
read -rp "$(echo -e "${CYAN}▸${NC}") Proceed with installation? [Y/n] " CONFIRM
CONFIRM="${CONFIRM:-Y}"
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo ""

# ── Write .env ───────────────────────────────

info "Writing .env configuration..."

cat > .env <<EOF
# Beachhead Configuration — generated by install.sh
NODE_ENV=production
PORT=3000

# Domain
BEACHHEAD_DOMAIN=${BEACHHEAD_DOMAIN}

# SSL
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL}

# Database
POSTGRES_PASSWORD=${DB_PASSWORD}
DATABASE_URL=postgresql://beachhead:${DB_PASSWORD}@beachhead-db:5432/beachhead

# Auth (empty = bootstrap mode — no auth required)
AUTH_JWKS_URL=
AUTH_ISSUER=

# GitHub
GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET}

# Deployment
DEPLOY_BASE_DIR=/var/beachhead/deployments
DOCKER_NETWORK=beachhead-net

# Health Check
HEALTH_CHECK_TIMEOUT=30000
HEALTH_CHECK_INTERVAL=2000
EOF

ok ".env written"

# ── Create Docker network ────────────────────

info "Ensuring beachhead-net Docker network exists..."
if ${DOCKER_SUDO} docker network inspect beachhead-net &>/dev/null; then
  ok "Network beachhead-net already exists"
else
  ${DOCKER_SUDO} docker network create beachhead-net
  ok "Created network beachhead-net"
fi

# ── Build dashboard ──────────────────────────

if command -v node &>/dev/null && [[ -d "dashboard" ]]; then
  info "Building dashboard..."
  (cd dashboard && npm install --silent && npm run build --silent) 2>&1 | tail -3
  ok "Dashboard built"
else
  warn "Node.js not found locally — dashboard will be built inside Docker"
fi

# ── Start services ───────────────────────────

info "Building and starting Beachhead..."
${DOCKER_SUDO} docker compose up -d --build 2>&1 | tail -10

echo ""

# ── Wait for health ──────────────────────────

info "Waiting for Beachhead API to become healthy..."
RETRIES=30
until curl -sf http://localhost:3000/api/health &>/dev/null || [[ $RETRIES -eq 0 ]]; do
  sleep 2
  RETRIES=$((RETRIES - 1))
done

if [[ $RETRIES -gt 0 ]]; then
  ok "Beachhead API is healthy"
else
  warn "API did not respond within 60s — it may still be starting. Check: docker compose logs beachhead"
fi

# ── Done ─────────────────────────────────────

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  ⚓  Beachhead is running!${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Dashboard:   ${BOLD}https://${BEACHHEAD_DOMAIN}${NC}"
echo -e "  API:         ${BOLD}https://${BEACHHEAD_DOMAIN}/api/health${NC}"
echo -e "  Webhook URL: ${BOLD}https://${BEACHHEAD_DOMAIN}/api/webhooks/github${NC}"
echo ""
echo -e "  ${YELLOW}Note:${NC} DNS for ${BEACHHEAD_DOMAIN} must point to this server's IP."
echo -e "  ${YELLOW}Note:${NC} SSL certificates will be provisioned automatically once DNS resolves."
echo ""
echo -e "  Useful commands:"
echo -e "    docker compose logs -f beachhead     ${CYAN}# API logs${NC}"
echo -e "    docker compose logs -f nginx-proxy   ${CYAN}# Proxy logs${NC}"
echo -e "    docker compose ps                    ${CYAN}# Service status${NC}"
echo -e "    docker compose down                  ${CYAN}# Stop everything${NC}"
echo ""
