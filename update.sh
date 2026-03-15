#!/bin/bash
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}▸${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  ⚓  Beachhead Updater${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Pull latest changes ───────────────────────

info "Pulling latest changes from git..."
git pull --ff-only
ok "Repository up to date"

# ── Rebuild and restart ───────────────────────

info "Rebuilding and restarting Beachhead (zero-downtime swap)..."
docker compose pull --quiet || true   # pull any updated base images
docker compose up -d --build --remove-orphans 2>&1 | tail -10
ok "Beachhead updated and running"

# ── Wait for health ───────────────────────────

info "Waiting for API to become healthy..."
RETRIES=30
until curl -sf http://localhost:3000/api/health &>/dev/null || [[ $RETRIES -eq 0 ]]; do
  sleep 2
  RETRIES=$((RETRIES - 1))
done

if [[ $RETRIES -gt 0 ]]; then
  ok "API is healthy"
else
  echo -e "\033[1;33m⚠${NC} API did not respond within 60s — check: docker compose logs beachhead"
fi

# ── Clean up old images ───────────────────────

info "Pruning unused Docker images..."
docker image prune -f --filter "until=24h" &>/dev/null || true
ok "Done"

echo ""
echo -e "${GREEN}${BOLD}  ⚓  Update complete!${NC}"
echo ""
