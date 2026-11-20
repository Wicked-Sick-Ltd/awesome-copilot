# Gem Team

**Turn AI coding into an engineering process.**

> Agent definitions that enforce good software engineering: optimizing cost, time, and quality.

<p align="center">
  <a href="https://mubaidr.github.io/gem-team/"><b>Visit Homepage</b></a>
</p>

<br/>

<p align="center">
  <img src="https://img.shields.io/badge/APM-mubaidr/gem--team-blue?style=flat-square" alt="APM package: mubaidr/gem-team">
  <img src="https://img.shields.io/github/v/release/mubaidr/gem-team?style=flat-square&color=important" alt="Latest release">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green?style=flat-square" alt="Apache-2.0 license">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="Pull requests welcome">
</p>

## Real-world performance

> Sub-$0.001 per API call on 100K+ token contexts. 82.8M+ tokens processed across 666 agent runs, with typical responses completing in 2-5 seconds. Prompt caching turns large contexts into sub-penny operations - a 10x cost reduction vs. uncached input.

_Observed during Gem-Team development using DeepSeek V4.1 Flash via CommandCode._

## The Problem

Current AI coding is often one-off and ad-hoc. You get code, but you don't get a repeatable process. This leads to inconsistent quality, wasted tokens, and a lack of long-term learning.

## The Solution

Gem Team wraps your AI with a disciplined engineering delivery system. It enforces good software engineering practices automatically, so you get better results with less effort.

## Why Gem Team?

- **Quality by Default**: TDD and acceptance checks always apply; reviews and security audits run when risk requires them. No more "vibe coding" that breaks in production.
- **Smart & Efficient**: 40-60% less context per task through scoped handoffs and proportional architecture. Cached tokens and compact evidence paths keep costs predictable and your AI focused.
- **Works With Your Tools**: Seamless integration with Copilot, Claude, Cursor, Codex, Gemini, and Windsurf. Use your preferred environment.
- **Learns & Improves**: Remembers what works and extracts reusable skills. Your AI gets smarter and more efficient over time.
- **Resumable Plans**: Every MEDIUM/HIGH task gets a persistent plan ID. Pause, resume, or extend work without losing context or re-discovering what you already know.
- **Works With Any Model**: Hardened output contracts and relational invariant fallbacks mean every agent works across commercial and open models - not just the ones that memorized your schema.

### Intelligent Model Routing

Gem Team automatically uses the right model for each kind of work:

- **Premium models** handle planning, debugging, and review where deeper reasoning matters.
- **Explore models** handle research, implementation, testing, documentation, and other bounded tasks efficiently.
- **Configurable tiers** let you choose the models and providers that fit your budget and workflow.

This gives you stronger verification where it matters without paying the highest model cost for every task. Configure it once in `.gem-team.yaml`:

```yaml
model_routing:
  enabled: true
  tiers:
    premium: "your-strong-model (provider)"
    explore: "your-fast-model (provider)"
```

**TL;DR:** Gem Team turns AI coding into a structured, repeatable engineering process with built-in quality, efficiency, and learning.

## Quick Start

Install [APM](https://microsoft.github.io/apm/) first. These steps download a
fixed APM release archive from GitHub and compare it with the SHA-256 digest
written below before anything is unpacked or run. If the digest does not match,
nothing is installed.

```bash
# macOS / Linux
(
  set -eu
  version=v0.35.1
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) asset=apm-darwin-arm64 sha256=8047f2443699cb7fd904f691f3c97d82766060bf70a4b868e7f994e44f07c47b ;;
    Darwin/x86_64) asset=apm-darwin-x86_64 sha256=34eb25c97663b35dc91a46b8a4bb0eeefa9e8749d73d7505948281ecb05b899f ;;
    Linux/x86_64) asset=apm-linux-x86_64 sha256=e7f06b9c80e26152ab579fe50d7dcd3d76ebbd8eacd44eed424e39880044eb3e ;;
    Linux/aarch64 | Linux/arm64) asset=apm-linux-arm64 sha256=96d65f6ed385d4c4c6093257e9f083bd3e4b51617c228abd787def92c18ab429 ;;
    *) echo "No pinned APM build for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  archive="$tmp/$asset.tar.gz"
  curl -fsSL -o "$archive" "https://github.com/microsoft/apm/releases/download/$version/$asset.tar.gz"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | cut -d ' ' -f 1)"
  else
    actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
  fi
  if [ "$actual" != "$sha256" ]; then
    echo "$asset.tar.gz does not match the pinned SHA-256; not installing." >&2
    exit 1
  fi
  tar -xzf "$archive" -C "$tmp"
  mkdir -p "$HOME/.local/lib" "$HOME/.local/bin"
  rm -rf "$HOME/.local/lib/apm"
  mv "$tmp/$asset" "$HOME/.local/lib/apm"
  ln -sfn "$HOME/.local/lib/apm/apm" "$HOME/.local/bin/apm"
)
```

Make sure `~/.local/bin` is on your `PATH`.

```powershell
# Windows PowerShell
& {
  $ErrorActionPreference = 'Stop'
  $sha256 = '5725ca5c817c5d0b68a3093dbdd2c64c119ea85b5b588d6d4103801680809177'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'apm-windows-x86_64.zip'
    Invoke-WebRequest -UseBasicParsing -OutFile $zip -Uri https://github.com/microsoft/apm/releases/download/v0.35.1/apm-windows-x86_64.zip
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $sha256) {
      throw 'apm-windows-x86_64.zip does not match the pinned SHA-256; not installing.'
    }
    $root = Join-Path $env:LOCALAPPDATA 'Programs\apm'
    $bin = Join-Path $root 'apm-windows-x86_64'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    if (Test-Path -LiteralPath $bin) { Remove-Item -Recurse -Force -LiteralPath $bin }
    Expand-Archive -LiteralPath $zip -DestinationPath $root
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $bin) {
      [Environment]::SetEnvironmentVariable('Path', ((@($bin, $userPath) | Where-Object { $_ }) -join ';'), 'User')
    }
    $env:Path = "$bin;$env:Path"
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmp
  }
}
```

Then confirm APM is available:

```bash
apm --version
```

Install Gem Team into your current project:

```bash
apm install mubaidr/gem-team --target copilot,claude,cursor,opencode,codex,gemini,windsurf
```

Or install for one target only:

```bash
apm install mubaidr/gem-team --target copilot
```

Install globally for personal use:

```bash
apm install -g mubaidr/gem-team
```

APM records the resolved commit in `apm.lock.yaml`. Repeating `apm install`
replays that lockfile; it does not silently upgrade an existing installation.
Refresh Gem Team explicitly when desired:

```bash
# Project-scoped installation
apm update mubaidr/gem-team --yes

# Global installation
apm update -g mubaidr/gem-team --yes
```

To check for an update to the APM CLI itself, use `apm self-update --check`.
To upgrade, take the new release tag and the SHA-256 digests published with
that release on the [APM releases](https://github.com/microsoft/apm/releases)
page, update them in the install steps above, and run those steps again.

For reproducible environments, pin a release tag:

```bash
apm install 'mubaidr/gem-team#gem-team-v<version>' --target copilot
```

Replace `<version>` with a published version from the
[GitHub Releases](https://github.com/mubaidr/gem-team/releases) page.

After the first install, commit the generated APM files that belong to your repo, especially `apm.yml`, `apm.lock.yaml`, and the generated harness directories such as `.github/`, `.claude/`, `.cursor/`, `.opencode/`, `.codex/`, `.gemini/`, or `.windsurf/`. Do **not** commit `apm_modules/`.

> APM can auto-detect targets from existing harness directories, but explicit `--target` is recommended for predictable installs and fresh repositories.
>
> Direct Git installs use the canonical sources in `.apm/`. Maintainers do not
> need to commit `build/`; release archives and checksums are generated and
> attached automatically to each GitHub Release.

## The Process

Gem Team uses a structured workflow to turn AI coding into a reliable engineering process:

1. **Route**: Classify the request from supplied evidence and select only the workflow depth it needs.
2. **Plan**: Use an in-memory wave plan for TRIVIAL/LOW work or a persistent, planner-confirmed wave plan for MEDIUM/HIGH work.
3. **Build**: Execute every wave plan through the same ordered-wave loop, using TDD and specialist agents.
4. **Verify**: Check every task and run reviewer integration checks only when changed-scope risk requires them.
5. **Learn**: Promote only stable, high-confidence patterns after successful execution.

## Features

- **Risk-Based Quality Gates**: TDD and deterministic verification always apply; specialist reviews and audits run when the plan or changed scope requires them.
- **Effortless Context**: Progressive context management prevents bloat. Scoped handoffs, context-coalesced tasks, verbatim cluster `shared_context`, a cache-lifetime payload order, and evidence-by-reference keep each agent's token footprint minimal while maximizing cached token reuse across waves.
- **Smart Routing**: Tasks are automatically routed to the right agents based on complexity.
- **Parallel Execution**: Independent tasks run in parallel within waves; overlapping ownership is serialized to prevent conflicts.
- **Resumable Plans**: Every MEDIUM/HIGH task gets a persistent plan ID and `plan.yaml`. Pause, resume, or extend work without losing context.
- **Reusable Knowledge**: High-confidence patterns and skills are extracted and reused for future tasks.
- **Cost Efficiency**: Model routing, output hygiene, and compact handoffs ensure you only use the tokens you need. Evidence travels by reference, not by copy - keeping context usage low and cache hits high across waves.
- **Failure Classification**: Every failure is classified (retry, fixable, replan, flaky, regression, platform-specific, test-bug) so the Orchestrator routes it to the right agent instead of blindly retrying.
- **Verification Boundary**: The Orchestrator never re-verifies or second-guesses specialist output. Verification is owned exclusively by the specialist responsible for the work.
- **Quality Directives**: Every agent follows specific rules that prevent common AI coding issues: no dead buttons, no buzzwords, no template filler, and every decision has a reason.

## How it Works

Gem Team installs a set of specialized agents that work together under the guidance of an Orchestrator. This team follows a disciplined workflow that includes planning, implementation, verification, and learning.

- **Specialist Agents**: Dedicated agents for planning, research, implementation, review, and more.
- **Orchestration**: One wave loop coordinates ordered work, parallel tasks, bounded retries, and final acceptance checks at every complexity level.
- **Context Management**: Execution agents receive an authoritative `task_definition` with a nested `handoff`; constraints, evidence, and prior-wave outputs travel through it. Planner receives a bounded `planning_context`; reviewer uses a dedicated review `handoff`; every delegate receives only a role-scoped configuration snapshot.

### Agent Roles

| Role                | Description                                                                                                                                                                                                                   |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator**    | Classifies intent, routes work, tracks state, and enforces verification gates. Never re-verifies specialist output.                                                                                                           |
| **Planner**         | Creates bounded wave plans with YAGNI/KISS scope reduction and concern-separated slices: milestones, routing, handoffs, risks, and criteria.                                                                                  |
| **Implementer**     | Implements features, fixes, and refactors with TDD. Covers happy paths, boundaries, errors, and state transitions. Applies SOLID, fail-fast, and least-surprise. Every major decision has a one-line reason. No dead buttons. |
| **Reviewer**        | Independent reviews for quality, security, and compliance. Read-only critic mode for decisions. Verifies every decision has a reason. Flags dead buttons and external script patches as blocking issues.                      |
| **Debugger**        | Root-cause analysis, stack traces, regression bisection. Adds a reproduction test; never implements fixes.                                                                                                                    |
| **Researcher**      | Codebase exploration in five budgeted modes: scan, question, audit, trace, deep.                                                                                                                                              |
| **Browser Tester**  | E2E browser tests with visual, accessibility, performance, network, and regression checks.                                                                                                                                    |
| **Mobile Tester**   | Mobile E2E on iOS/Android with Detox, Maestro, or Appium.                                                                                                                                                                     |
| **DevOps**          | Infrastructure, CI/CD, containers, health checks, rollback, and production approvals.                                                                                                                                         |
| **Documentation**   | Technical docs, READMEs, API references, diagrams, and walkthroughs. No buzzwords. Every section exists because the product needs it. No fabricated statistics.                                                               |
| **Code Simplifier** | Removes dead code, reduces complexity, consolidates duplicates, and improves naming. Every refactoring has a one-line reason. No buzzwords. Removes AI-slop comments.                                                         |
| **Skill Creator**   | Extracts high-confidence patterns into reusable `SKILL.md` files and assets.                                                                                                                                                  |

## Compatible Tools

Gem Team works with your favorite AI coding tools:

| Tool         | Harness             | Description                          |
| :----------- | :------------------ | :----------------------------------- |
| **Copilot**  | `.github/agents/`   | VS Code Copilot / GitHub Copilot CLI |
| **Claude**   | `.claude/agents/`   | Claude Code                          |
| **Cursor**   | `.cursor/agents/`   | Cursor                               |
| **OpenCode** | `.opencode/agents/` | OpenCode                             |
| **Codex**    | `.codex/agents/`    | Codex CLI                            |
| **Gemini**   | `GEMINI.md`         | Gemini CLI                           |
| **Windsurf** | `.windsurf/rules/`  | Windsurf / Cascade                   |

## Configuration

Gem Team is designed to work out of the box with smart defaults. You can customize behavior by editing the `AGENTS.md` file or specific agent definitions in the `.apm/agents/` directory.

### Reviewer and critic modes

`gem-reviewer` uses three independent axes:

- `review_mode`: `standard`, `high`, or `critic` controls review intensity.
- `review_target`: `plan`, `task`, `code`, `decision`, `docs`, `config`, or `integration` selects what is reviewed.
- `review_scope`: `changed`, `affected`, or `full` limits the evidence breadth.

TRIVIAL/LOW work does not invoke the planner or reviewer during planning.
MEDIUM/HIGH work receives one pre-execution plan review: standard for MEDIUM,
high for HIGH or high-risk work, and critic for architecture, breaking-change,
or cross-domain signals. Later integration review is risk-triggered, not a
routine wave gate.

Discussion is answered directly. A requested evaluation or decision becomes a
read-only challenge with `review_mode: critic`, `review_target: decision`, and
`review_scope: full`. Critic mode does not mutate files or claim implementation.
Its subject and context are passed through `handoff`:

```yaml
review_mode: critic
review_target: decision
review_scope: full
handoff:
  critic_subject:
    objective: str
    proposal: str
    constraints:
      - str
    alternatives:
      - str
    evidence:
      - str
    decision_needed: str
  critic_context:
    audience: str
    time_horizon: str
    success_criteria:
      - str
    known_unknowns:
      - str
```

## Learn More

- [Documentation](https://mubaidr.github.io/gem-team/)
- [Contributing](https://mubaidr.github.io/gem-team/5.resources/2.contributing.html)
- [License](LICENSE)

## Support

If you have questions or need help, please open an issue on [GitHub](https://github.com/mubaidr/gem-team/issues).
