---
name: azure-container-registry-cli
description: 'Manage Azure Container Registry via the az acr CLI including registries, images, cloud builds, ACR Tasks, authentication, tokens, geo-replication, and networking. Use when working with ACR, az acr commands, pushing/importing/purging container images in Azure, or when the user mentions Azure Container Registry.'
---

# Azure Container Registry CLI

Manage Azure Container Registry (ACR) resources using the `az acr` command group of the Azure CLI.

**CLI:** `az acr` ships with core Azure CLI — no extension required (the `acrtransfer` extension is only needed for export/import pipelines).

## Prerequisites

```bash
# Install Azure CLI
brew install azure-cli  # macOS
winget install Microsoft.AzureCLI  # Windows

# Linux (Debian/Ubuntu): version-pinned package from Microsoft's signed apt repository.
# Never pipe a downloaded install script into a shell (e.g. `curl ... | sudo bash`).
# This block uses sudo; confirm with the user before running it.
(
  set -euo pipefail
  AZ_VER=2.81.0
  # Keep a CLI that is already at least this version. An exact install refuses to downgrade.
  if command -v az >/dev/null 2>&1; then
    AZ_CURRENT=$(az version -o tsv --query '"azure-cli"' 2>/dev/null || true)
    if [ -n "${AZ_CURRENT}" ] && [ "$(printf '%s\n%s\n' "$AZ_VER" "$AZ_CURRENT" | sort -V | head -n1)" = "$AZ_VER" ]; then
      exit 0
    fi
  fi
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg lsb-release
  AZ_ID=$(lsb_release -is)
  AZ_DIST=$(lsb_release -cs)
  # Mint's own codename is not an Azure CLI suite. Use the Ubuntu base it reports.
  if [ "$AZ_ID" = "LinuxMint" ]; then
    AZ_OS_RELEASE_FILE=${AZ_OS_RELEASE:-/etc/os-release}
    AZ_DIST=$(. "$AZ_OS_RELEASE_FILE"; printf '%s' "${UBUNTU_CODENAME:-$AZ_DIST}")
  fi
  # 2.81.0-1 was published for these suites. Anything newer falls back the way
  # the signed apt installer does: jammy for Ubuntu-family, bookworm for Debian.
  case "$AZ_DIST" in
    noble|jammy|focal|bookworm|bullseye) ;;
    *)
      case "$AZ_ID" in
        Debian) AZ_DIST=bookworm ;;
        *) AZ_DIST=jammy ;;
      esac
      ;;
  esac
  # Microsoft (Release signing) <gpgsecurity@microsoft.com>
  MS_KEY_FPR=BC528686B50D79E339D3721CEB3E94ADBE1229CF
  GNUPGHOME=$(mktemp -d); export GNUPGHOME
  trap 'gpgconf --kill all || true; rm -rf "$GNUPGHOME"' EXIT
  curl -fsSL -o "$GNUPGHOME/microsoft.asc" https://packages.microsoft.com/keys/microsoft.asc
  gpg --batch --quiet --import "$GNUPGHOME/microsoft.asc"
  # Export only the pinned key; anything else in the download is discarded.
  gpg --batch --export "$MS_KEY_FPR" > "$GNUPGHOME/microsoft.gpg"
  [ -s "$GNUPGHOME/microsoft.gpg" ] || { echo "Microsoft signing key $MS_KEY_FPR not found; aborting" >&2; exit 1; }
  sudo install -d -m 0755 /etc/apt/keyrings
  sudo install -m 0644 "$GNUPGHOME/microsoft.gpg" /etc/apt/keyrings/microsoft.gpg
  printf 'Types: deb\nURIs: https://packages.microsoft.com/repos/azure-cli/\nSuites: %s\nComponents: main\nArchitectures: %s\nSigned-by: /etc/apt/keyrings/microsoft.gpg\n' \
    "$AZ_DIST" "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/azure-cli.sources > /dev/null
  sudo apt-get update
  # apt verifies the package's SHA256 against the repository index signed by the pinned key.
  sudo apt-get install -y "azure-cli=${AZ_VER}-1~${AZ_DIST}"
)

# Sign in and select subscription
az login
az account set --subscription {subscription-id}
```

## Quick Start

```bash
# Create a registry (SKU: Basic | Standard | Premium)
az acr create --resource-group {rg} --name {registry} --sku Standard

# Authenticate Docker/Podman against the registry
az acr login --name {registry}

# Build and push in the cloud — no local Docker needed
az acr build --registry {registry} --image app:v1 .

# Copy an image from another registry without pull/push
az acr import --name {registry} --source mcr.microsoft.com/hello-world:latest

# List repositories and tags
az acr repository list --name {registry} --output table
az acr repository show-tags --name {registry} --repository app --orderby time_desc

# Diagnose registry connectivity and configuration
az acr check-health --name {registry} --yes
```

## Key Principles

- **Prefer `az acr build` / ACR Tasks** over local `docker build` + `docker push`: builds run in Azure, work without a local daemon, and integrate with triggers.
- **Prefer `az acr import`** to move images between registries: it is server-side, faster, and requires no local storage.
- **Never enable the admin user for production** — use Microsoft Entra identities (RBAC roles `AcrPull`/`AcrPush`, or `Container Registry Repository Reader`/`Writer` on ABAC-enabled registries), repository-scoped tokens, or managed identities.
- **Premium-only features**: geo-replication, private endpoints, retention policies, connected registries, agent pools. (Repository-scoped tokens work in all tiers; zone redundancy is automatic in all tiers in supported regions.)

## CLI Structure

```
az acr
├── create / delete / list / show / update   # Registry lifecycle
├── login                  # Docker credential helper (or --expose-token)
├── check-health / check-name / show-usage   # Diagnostics & quota
├── build                  # Cloud image build (quick task)
├── run                    # Run a command / multi-step task once
├── task                   # ACR Tasks (triggers, timers, logs, runs)
├── agentpool              # Dedicated task agent pools (Premium)
├── import                 # Server-side image copy into the registry
├── repository             # List/show/delete/untag repos & tags, lock images
├── manifest               # Manifest metadata, delete, OCI referrers
├── credential             # Admin user credentials (avoid in production)
├── token / scope-map      # Repository-scoped tokens (Premium)
├── replication            # Geo-replication (Premium)
├── network-rule           # IP network rules
├── private-endpoint-connection  # Private Link approvals
├── config                 # content-trust, retention, soft-delete, ...
├── cache / credential-set # Artifact cache (pull-through cache) rules
├── webhook                # Push/delete event webhooks
├── connected-registry     # On-premises / IoT connected registries
└── export-pipeline / import-pipeline / pipeline-run  # acrtransfer extension
```

## Reference Files

Read the relevant reference file based on the user's task. Each file contains complete command syntax and examples for its domain.

| File | When to read | Covers |
|---|---|---|
| `references/auth-and-security.md` | Login failures, permissions, CI/CD or AKS pull access | `az acr login` (incl. `--expose-token`), Entra RBAC roles, service principals, managed identities, `--attach-acr` for AKS, repository-scoped tokens & scope maps, admin user, content trust |
| `references/build-and-tasks.md` | Building images in Azure, automation, CI triggers | `az acr build`, `az acr run`, multi-step task YAML, `az acr task` (git/base-image/timer triggers, logs, runs), agent pools |
| `references/images-and-artifacts.md` | Managing repos, tags, cleanup, storage costs | `az acr import`, repository & manifest commands, untag vs delete, purge (`acr purge`), image locking, retention policy, soft delete, artifact cache, `show-usage` |
| `references/networking-and-geo.md` | Multi-region, private access, edge scenarios | Geo-replication, zone redundancy, private endpoints, network rules, dedicated data endpoints, connected registries, registry transfer pipelines |
