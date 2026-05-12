#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.sync-state/my_app_docs.pid"
LOG_FILE="$ROOT/.sync-state/my_app_docs.log"

mkdir -p "$ROOT/.sync-state"

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "sync already running (pid=$old_pid)"
    exit 0
  fi
fi

nohup node "$ROOT/script_sync_my_app_docs.js" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "sync started (pid=$(cat "$PID_FILE"))"
echo "log: $LOG_FILE"
