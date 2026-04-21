#!/bin/bash
# ─────────────────────────────────────────────
#  Kungbi PR Reviewer Bot — Kill Script
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"

echo "[KILL] Looking for bot process on port $PORT ..."

# Find PID using the port
PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)

if [ -z "$PID" ]; then
  # Fallback: find by process name
  PID=$(pgrep -f "node dist/src/index.js" 2>/dev/null || true)
fi

if [ -z "$PID" ]; then
  echo "[KILL] No running bot process found."
  exit 0
fi

echo "[KILL] Sending SIGTERM to PID(s): $PID"
kill -TERM $PID 2>/dev/null || true

# Wait up to 5 seconds for graceful shutdown
for i in $(seq 1 5); do
  sleep 1
  if ! kill -0 $PID 2>/dev/null; then
    echo "[KILL] Process stopped cleanly."
    exit 0
  fi
done

# Force kill if still running
echo "[KILL] Process still alive after 5s. Sending SIGKILL ..."
kill -KILL $PID 2>/dev/null || true
echo "[KILL] Done."
