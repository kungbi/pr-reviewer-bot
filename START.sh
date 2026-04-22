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

# ── Single-instance guard ──────────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(cat "$PID_FILE")
  if kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "[START] ERROR: Bot is already running (PID $EXISTING_PID). Aborting."
    echo "[START] Run KILL.sh first, or: kill $EXISTING_PID"
    exit 1
  else
    echo "[START] Stale PID file found (PID $EXISTING_PID not running). Cleaning up."
    rm -f "$PID_FILE"
  fi
fi

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
if [ -z "$DISCORD_WEBHOOK_URL" ]; then
  echo "[START] ERROR: DISCORD_WEBHOOK_URL is not set. Aborting."
  exit 1
fi

echo "[START] Building ..."
npm run build

echo "[START] Starting Kungbi PR Reviewer Bot (PORT=${PORT:-3000}) ..."

# Write PID and clean up on exit
cleanup() {
  rm -f "$PID_FILE"
}
trap cleanup EXIT INT TERM

node dist/src/index.js &
BOT_PID=$!
echo "$BOT_PID" > "$PID_FILE"
echo "[START] Bot started (PID $BOT_PID)"
wait "$BOT_PID"
