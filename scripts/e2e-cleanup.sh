#!/usr/bin/env bash
# Next.js adapter test suite - cleanup script
set -euo pipefail

if [ -f ".adapter-server.pid" ]; then
  PID=$(cat .adapter-server.pid)
  if [ "${ADAPTER_KEEP_SERVER:-}" = "1" ]; then
    echo "[adapter-creekd] Keeping server alive (PID ${PID}) because ADAPTER_KEEP_SERVER=1" >&2
    exit 0
  fi

  if kill -0 "${PID}" 2>/dev/null; then
    echo "[adapter-creekd] Stopping server (PID ${PID})..." >&2
    kill -- -"${PID}" 2>/dev/null || kill "${PID}" 2>/dev/null || true

    for _ in $(seq 1 10); do
      if ! kill -0 "${PID}" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done

    if kill -0 "${PID}" 2>/dev/null; then
      kill -9 -- -"${PID}" 2>/dev/null || kill -9 "${PID}" 2>/dev/null || true
    fi
  fi
  rm -f .adapter-server.pid
fi

if [ -f ".adapter-server.log" ]; then
  echo "[adapter-creekd] === server log (last 200 lines) ===" >&2
  tail -200 ".adapter-server.log" >&2
  echo "[adapter-creekd] === end server log ===" >&2
fi

echo "[adapter-creekd] Cleanup complete" >&2
