#!/usr/bin/env bash
# Idempotent toolchain install for Cursor Cloud Agents.
# Safe to re-run. Does not read or write secret files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

# Astro, the website toolchain, requires Node >= 22.12.0.
NODE_MINIMUM="22.12.0"
NODE_VERSION="22.23.4"

node_meets_minimum() {
  local current="${1#v}"
  local minimum="$2"
  [[ "$(printf '%s\n%s\n' "$minimum" "$current" | sort -V | head -n1)" == "$minimum" ]]
}

install_node_runtime() {
  log "Installing Node ${NODE_VERSION} into /usr/local"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | sudo tar -xJ -C /usr/local --strip-components=1 --no-same-owner
  hash -r
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
    && node_meets_minimum "$(node -v)" "$NODE_MINIMUM"; then
    log "Node $(node -v) and npm $(npm -v) already on PATH"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    log "Node $(node -v) is older than ${NODE_MINIMUM}, which the website toolchain requires."
  else
    log "Node is missing."
  fi
  install_node_runtime

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 \
    || ! node_meets_minimum "$(node -v)" "$NODE_MINIMUM"; then
    echo "Node on PATH is $(node -v 2>/dev/null || echo unavailable) at $(command -v node 2>/dev/null || echo missing). The website requires Node >= ${NODE_MINIMUM}. Put Node ${NODE_VERSION} ahead of the older binary on PATH." >&2
    exit 1
  fi
}

install_node_deps() {
  if [[ ! -f package-lock.json ]]; then
    echo "package-lock.json is missing; npm ci cannot run" >&2
    exit 1
  fi
  log "Installing root dependencies with npm ci"
  npm ci

  if [[ -f website/package-lock.json ]]; then
    log "Installing website dependencies with npm ci (skipping Playwright browser download)"
    # Browsers are only required for website:a11y. The catalog and dev server do not need them.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix website
  fi
}

install_python_skills() {
  local reqs=()
  local req
  while IFS= read -r -d '' req; do
    reqs+=("$req")
  done < <(find skills -path '*/scripts/requirements.txt' -print0 | sort -z)

  if [[ ${#reqs[@]} -eq 0 ]]; then
    log "No skill requirements.txt files found"
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 is not installed. Skipped skill packages in skills/*/scripts/requirements.txt. Catalog install does not need them."
    return 0
  fi

  if ! python3 -m venv "$ROOT/.venv" >/dev/null 2>&1; then
    rm -rf "$ROOT/.venv"
    if command -v sudo >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
      log "Installing python3-venv so skill packages can be installed"
      sudo apt-get update
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv
    fi
  fi

  if ! python3 -m venv "$ROOT/.venv"; then
    warn "python3 -m venv failed. Skipped skill packages in skills/*/scripts/requirements.txt. Catalog install does not need them."
    return 0
  fi

  # shellcheck disable=SC1091
  source "$ROOT/.venv/bin/activate"
  # Python skill packages are optional. A pip upgrade failure must not abort catalog install.
  if ! python -m pip install --disable-pip-version-check --upgrade pip; then
    warn "pip upgrade failed. Continuing with the existing pip. Catalog install does not need a newer pip."
  fi
  for req in "${reqs[@]}"; do
    log "Installing Python packages from ${req}"
    if ! python -m pip install --disable-pip-version-check -r "$req"; then
      warn "Could not install ${req}. Conversion skills that import those packages will not run. Catalog install does not need them."
    fi
  done
}

generate_website_data() {
  if [[ ! -f website/package-lock.json ]]; then
    return 0
  fi
  log "Generating website catalog data"
  npm run website:data
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ensure_node
  install_node_deps
  install_python_skills
  generate_website_data

  if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
    warn "GITHUB_TOKEN is unset. Contributor and review scripts that call the GitHub API will not run until GITHUB_TOKEN or GH_TOKEN is set. Catalog install does not need it."
  fi

  log "Install complete"
fi
