#!/usr/bin/env bash
set -euo pipefail

PORT="${PLATFORM_CONTROL_PORT:-6400}"
LOG_FILE="logs/platform-control.log"
PID_FILE=".pids/platform-control.pid"

mkdir -p logs .pids

echo "============================================================"
echo " Starting platform control server"
echo "============================================================"

if curl -s "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "Platform control server is already running on http://localhost:${PORT}"
  exit 0
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping stale platform control process: $OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$PID_FILE"
fi

echo "Starting platform control server in background..."
echo "Logs: $LOG_FILE"

nohup node platform-control/server.js > "$LOG_FILE" 2>&1 &
PID="$!"

echo "$PID" > "$PID_FILE"
echo "PID: $PID"

echo
echo "Waiting for platform control server..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo "Platform control server is ready: http://localhost:${PORT}"
    exit 0
  fi

  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Platform control server failed to start."
    echo
    echo "Last logs:"
    tail -80 "$LOG_FILE" || true
    exit 1
  fi

  sleep 1
done

echo "Timed out waiting for platform control server."
echo
echo "Last logs:"
tail -80 "$LOG_FILE" || true
exit 1
