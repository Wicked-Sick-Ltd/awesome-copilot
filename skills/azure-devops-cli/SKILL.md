---
name: azure-devops-cli
description: Manage Azure DevOps resources via CLI including projects, repos, pipelines, builds, pull requests, work items, artifacts, and service endpoints. Use when working with Azure DevOps, az commands, devops automation, CI/CD, or when user mentions Azure DevOps CLI.
---

# Azure DevOps CLI

Manage Azure DevOps resources using the Azure CLI with the Azure DevOps extension.

**CLI Version:** 2.81.0 (current as of 2025)

## Prerequisites

```bash
# Install Azure CLI
brew install azure-cli  # macOS

# Linux (Debian/Ubuntu): version-pinned package from Microsoft's signed apt repository.
# Never pipe a downloaded install script into a shell (e.g. `curl ... | sudo bash`).
# This block uses sudo; confirm with the user before running it.
(
  set -euo pipefail
  AZ_VER=2.81.0
  # 2.81.0-1~<suite> exists only for noble, jammy, bookworm, and bullseye.
  # Ubuntu 26.04 (resolute), Debian 13 (trixie), and Mint's own codename were
  # never published. Keep a published suite; Mint uses UBUNTU_CODENAME first.
  AZ_ID=$(lsb_release -is)
  AZ_DIST=$(lsb_release -cs)
  case "$AZ_ID" in
    LinuxMint|Linuxmint)
      AZ_DIST=$(grep -Po 'UBUNTU_CODENAME=\K.*' /etc/os-release || true)
      ;;
  esac
  case "$AZ_DIST" in
    noble|jammy|bookworm|bullseye) ;;
    *)
      case "$AZ_ID" in
        Debian|debian) AZ_DIST=bookworm ;;
        *) AZ_DIST=noble ;;
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

# Install Azure DevOps extension
az extension add --name azure-devops
```

## Authentication

```bash
# Login with PAT token
az devops login --organization https://dev.azure.com/{org} --token YOUR_PAT_TOKEN

# Set default organization and project (avoids repeating --org/--project)
# Note: Legacy URL https://{org}.visualstudio.com should be replaced with https://dev.azure.com/{org}
az devops configure --defaults organization=https://dev.azure.com/{org} project={project}

# List current configuration
az devops configure --list
```

## CLI Structure

```
az devops          # Main DevOps commands
├── admin          # Administration (banner)
├── extension      # Extension management
├── project        # Team projects
├── security       # Security operations
│   ├── group      # Security groups
│   └── permission # Security permissions
├── service-endpoint # Service connections
├── team           # Teams
├── user           # Users
├── wiki           # Wikis
├── configure      # Set defaults
├── invoke         # Invoke REST API
├── login          # Authenticate
└── logout         # Clear credentials

az pipelines       # Azure Pipelines
├── agent          # Agents
├── build          # Builds
├── folder         # Pipeline folders
├── pool           # Agent pools
├── queue          # Agent queues
├── release        # Releases
├── runs           # Pipeline runs
├── variable       # Pipeline variables
└── variable-group # Variable groups

az boards          # Azure Boards
├── area           # Area paths
├── iteration      # Iterations
└── work-item      # Work items

az repos           # Azure Repos
├── import         # Git imports
├── policy         # Branch policies
├── pr             # Pull requests
└── ref            # Git references

az artifacts       # Azure Artifacts
└── universal      # Universal Packages
```

## Reference Files

Read the relevant reference file based on the user's task. Each file contains complete command syntax and examples for its domain.

| File | When to read | Covers |
|---|---|---|
| `references/repos-and-prs.md` | Repos, branches, pull requests, branch policies | Repositories, Import, PRs (create/list/vote/reviewers/policies), Git refs, Branch policies |
| `references/pipelines-and-builds.md` | Pipelines, builds, releases, artifacts | Pipelines CRUD, runs, builds, releases, artifacts download/upload |
| `references/boards-and-iterations.md` | Work items, sprints, area paths | Work items (WIQL/create/update/relations), Area paths, Iterations, Team iterations |
| `references/variables-and-agents.md` | Pipeline variables, agent pools | Pipeline variables, Variable groups, Pipeline folders, Agent pools/queues |
| `references/org-and-security.md` | Projects, teams, users, permissions, wikis | Projects, Extensions, Teams, Users, Security groups/permissions, Service endpoints, Wikis, Admin |
| `references/advanced-usage.md` | Output formatting, JMESPath queries | Output formats, JMESPath queries (basic + advanced), Global args, Common params, Git aliases |
| `references/workflows-and-patterns.md` | Automation scripts, best practices, error handling | Common workflows, Best practices, Error handling, Scripting patterns, Real-world examples |
| `references/long-comments-on-windows.md` | Long `--discussion`, `--description`, or `--content` values failing on Windows | The `cmd.exe` 8191 char cap on `az.cmd`, shell detection, and three verified workarounds (`azps.ps1`, native `--file-path`, `az devops invoke --in-file`) |
