#!/bin/bash
# Clears auth configuration and restarts Beachhead in bootstrap mode.
# Use this when brew-auth is down and you are locked out of the dashboard.
# After brew-auth is redeployed and healthy, click "Activate Auth" in the
# dashboard to re-enable JWT validation.

set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo ""
echo -e "${BOLD}⚓  Beachhead — Reset Auth${NC}"
echo ""
echo -e "${YELLOW}This will clear AUTH_JWKS_URL, AUTH_ISSUER, and AUTH_COOKIE_NAME${NC}"
echo -e "${YELLOW}from .env and restart Beachhead in bootstrap mode (no auth required).${NC}"
echo ""
read -rp "Continue? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

sed -i 's/^AUTH_JWKS_URL=.*/AUTH_JWKS_URL=/' .env
sed -i 's/^AUTH_ISSUER=.*/AUTH_ISSUER=/' .env
sed -i 's/^AUTH_COOKIE_NAME=.*/AUTH_COOKIE_NAME=/' .env

docker compose restart beachhead

echo ""
echo -e "${GREEN}✓ Done. Beachhead is now in bootstrap mode.${NC}"
echo ""
echo "  1. Open https://beachhead.brew.rip — no login required"
echo "  2. Redeploy brew-auth from the dashboard if needed"
echo "  3. Once brew-auth is healthy, click 'Activate Auth' to re-enable JWT validation"
echo ""
