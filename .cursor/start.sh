#!/usr/bin/env bash
# Boot the Astro website. Idempotent: a second invocation attaches to the
# server that is already listening instead of binding port 4321 again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=4321
LOG=/tmp/awesome-copilot-website.log
LOCK=/tmp/awesome-copilot-website.lock

ready() {
  curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"
}

attach() {
  echo "Awesome Copilot website is listening on port ${PORT}"
  if [[ -f "$LOG" ]]; then
    exec tail -n +1 -f "$LOG"
  fi
  exec sleep infinity
}

if ready; then
  attach
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Waiting for the website to listen on port ${PORT}"
  for _ in $(seq 1 90); do
    if ready; then
      attach
    fi
    sleep 2
  done
  echo "WARNING: website did not become ready on port ${PORT}" >&2
  exit 1
fi

if [[ ! -d node_modules || ! -d website/node_modules ]]; then
  echo "Dependencies are missing. Run: bash .cursor/install.sh" >&2
  exit 1
fi

if [[ ! -f website/public/data/agents.json ]]; then
  npm run website:data
fi

echo "Starting Astro on 0.0.0.0:${PORT}"
npm run --prefix website dev -- --host 0.0.0.0 --port "$PORT" 2>&1 | tee -a "$LOG"
