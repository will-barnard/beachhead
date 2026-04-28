#!/bin/bash
# Deletes all user accounts and restarts Beachhead in bootstrap mode.
# Use this when you are locked out of the dashboard.
# After restart, visit the dashboard to create a new admin account.

set -euo pipefail

BOLD='\033[1m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo ""
echo -e "${BOLD}⚓  Beachhead — Reset Auth${NC}"
echo ""
echo -e "${YELLOW}This will DELETE all user accounts from the database${NC}"
echo -e "${YELLOW}and restart Beachhead in bootstrap mode (no auth required).${NC}"
echo ""
read -rp "Continue? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Delete all users via the postgres container.
# The compose service is named `beachhead-db` and the container_name is also
# `beachhead-db`, so both forms below target the same container.
docker compose exec -T beachhead-db psql -U beachhead -d beachhead -c "DELETE FROM users;" 2>/dev/null || \
  docker exec beachhead-db psql -U beachhead -d beachhead -c "DELETE FROM users;"

docker compose restart beachhead

echo ""
echo -e "${GREEN}✓ Done. Beachhead is now in bootstrap mode.${NC}"
echo ""
echo "  1. Open the dashboard — no login required"
echo "  2. Create a new admin account when prompted"
echo ""
