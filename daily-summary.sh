#!/bin/bash
# daily-summary.sh — Cron script to send daily PR review summary
#
# Usage:
#   ./daily-summary.sh
#
# Recommended cron (run once daily at 09:00 UTC):
#   0 9 * * * cd /home/node/.openclaw/workspace/kungbi-pr-reviewer-bot && ./daily-summary.sh >> logs/daily-summary.log 2>&1

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# Load .env if present
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Running daily summary..."

node src/daily-summary.js

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Done."
