#!/usr/bin/env bash
set -euo pipefail

PORT="${PLATFORM_CONTROL_PORT:-6400}"
PID_FILE=".pids/platform-control.pid"

echo "============================================================"
echo " Stopping platform control server"
echo "============================================================"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"

  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Stopping PID $PID"
    kill "$PID" 2>/dev/null || true
    sleep 2
  fi

  rm -f "$PID_FILE"
fi

pkill -f "platform-control/server.js" 2>/dev/null || true

if curl -s "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "Warning: something is still responding on http://localhost:${PORT}"
else
  echo "Platform control server stopped."
fi
