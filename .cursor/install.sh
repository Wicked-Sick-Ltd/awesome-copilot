#!/usr/bin/env bash
# Idempotent toolchain install for Cursor Cloud Agents.
# Safe to re-run. Does not read or write secret files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -ge 22 ]]; then
      log "Node $(node -v) and npm $(npm -v) already on PATH"
      return 0
    fi
    warn "Node $(node -v) is older than the CI major (22). Continuing with the installed Node."
    return 0
  fi

  local version="22.23.4"
  log "Node is missing. Installing Node ${version} into /usr/local"
  curl -fsSL "https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz" \
    | sudo tar -xJ -C /usr/local --strip-components=1 --no-same-owner
  hash -r
  command -v node >/dev/null 2>&1 || {
    echo "Node install did not put node on PATH" >&2
    exit 1
  }
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
  python -m pip install --disable-pip-version-check --upgrade pip
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

ensure_node
install_node_deps
install_python_skills
generate_website_data

if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
  warn "GITHUB_TOKEN is unset. Contributor and review scripts that call the GitHub API will not run until GITHUB_TOKEN or GH_TOKEN is set. Catalog install does not need it."
fi

log "Install complete"
