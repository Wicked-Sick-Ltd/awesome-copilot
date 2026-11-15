---
name: acreadiness-assess
description: 'Run the AgentRC readiness assessment on the current repository and produce a static HTML dashboard at reports/index.html. Wraps `npx github:microsoft/agentrc readiness` and hands off rendering to the @ai-readiness-reporter custom agent. Supports policies (--policy) for org-specific scoring. Use when asked to assess, audit, or score the AI readiness of a repo.'
argument-hint: "[--policy <path-or-pkg>] [--per-area] — e.g. /acreadiness-assess, /acreadiness-assess --policy ./policies/strict.json"
---

# /acreadiness-assess — AI-readiness assessment

Use this skill whenever the user asks for an **AI-readiness assessment**, a **readiness check**, an **audit**, or wants to **see how AI-ready** their repository is.

This skill is the *Measure* step in AgentRC's **Measure → Generate → Maintain** loop. The result is a self-contained HTML dashboard the user can open with `file://` or commit to the repo.

## Steps

1. **Confirm prerequisites.** Node 20+ must be on PATH. If unsure, run `node --version`.

2. **Decide on a policy** (optional but encouraged):
   - If the user provided `--policy <source>`, capture it.
   - Otherwise check `agentrc.config.json` for a `policies` array.
   - If neither, run with no policy (built-in defaults).
   - For a primer on policies, suggest the `acreadiness-policy` skill.

3. **Run the readiness scan** in the repo root with structured output:
   ```bash
   npx -y github:microsoft/agentrc readiness --json [--policy <source>] [--per-area]
   ```
   The `CommandResult<T>` JSON envelope is your input for the next step. Save it to a file in the OS temp directory (not in the repository).

4. **Hand off to the `ai-readiness-reporter` custom agent** to interpret the JSON and produce `reports/index.html`. The agent renders the bundled template `report-template.html` with the bundled `render-report.mjs` (both shipped alongside this skill) so every report has an identical look & feel. The agent:
   - Writes its interpretation (scores, pillar text, policy summary, plan rows) to a values JSON file in the OS temp directory and runs `node render-report.mjs --values <values.json> --raw <agentrc.json> --out reports/index.html`. The renderer encodes every value for the place it lands, including the embedded AgentRC JSON. Never fill in the template by hand or with string replacement: scan output and repository text can contain markup that would run when the report is opened.
   - Inlines all CSS, ships a single static file (works under `file://`).
   - Renders maturity level, overall score, grade, pass-rate vs threshold.
   - Breaks down all 9 pillars across **Repo Health** (8) and **AI Setup** (1) with *what it measures*, *why it matters for AI*, *current state*, and *a specific recommendation*.
   - Tags every pillar with an **AI relevance** badge (High / Medium / Low).
   - Surfaces **Extras** separately (they never affect the score).
   - Shows the **Active Policy** including any disabled/overridden criteria and thresholds.
   - Produces a **Prioritised Remediation Plan** (🔴 Fix First / 🟡 Fix Next / 🔵 Plan).
   - Embeds the raw AgentRC JSON for reuse.

5. **Tell the user where the report lives** (`reports/index.html`) and how to open it. Summarise in chat: maturity level, overall score, top three lowest pillars, and the single highest-leverage next action (almost always: run the `acreadiness-generate-instructions` skill).

## Notes

- AgentRC also has a built-in HTML renderer (`--visual` / `--output report.html`) but its output is intentionally generic. This skill produces a tailored, opinionated dashboard via the custom agent — closer to a code review than a metrics dump.
- For CI gating, recommend `agentrc readiness --fail-level <n>` (1–5).
- The skill never modifies repository files other than creating `reports/index.html`.
