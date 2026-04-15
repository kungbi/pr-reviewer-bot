#!/bin/bash
# ─────────────────────────────────────────────
#  Kungbi PR Reviewer Bot — Start Script
# ─────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.bot.pid"
LOG_DIR="$SCRIPT_DIR/logs"

# Create log directory if not exists
mkdir -p "$LOG_DIR"

# Load .env if exists
if [ -f .env ]; then
  echo "[START] Loading .env ..."
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
else
  echo "[START] WARNING: .env not found. Using environment variables only."
  echo "[START] Copy .env.example to .env and fill in values."
fi

# Validate required vars
if [ -z "$WEBHOOK_SECRET" ]; then
  echo "[START] ERROR: WEBHOOK_SECRET is not set. Aborting."
  exit 1
fi

if [ -z "$DISCORD_WEBHOOK_URL" ]; then
  echo "[START] ERROR: DISCORD_WEBHOOK_URL is not set. Aborting."
  exit 1
fi

echo "[START] Starting Kungbi PR Reviewer Bot (PORT=${PORT:-3000}) ..."
node index.js
