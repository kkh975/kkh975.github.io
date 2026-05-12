#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.sync-state/my_app_docs.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "no pid file"
  exit 0
fi

pid="$(cat "$PID_FILE" || true)"
if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  echo "sync stopped (pid=$pid)"
else
  echo "process already not running"
fi

rm -f "$PID_FILE"
