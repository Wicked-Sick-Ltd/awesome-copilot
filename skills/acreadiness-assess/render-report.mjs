#!/usr/bin/env node
/**
 * Renders report-template.html into a static AI readiness report.
 *
 * Every value is encoded for the place it lands: HTML text and quoted
 * attributes are HTML-escaped, class tokens come from fixed allowlists,
 * CSS widths are clamped numbers, and the AgentRC JSON is re-serialized so
 * it contains no "<", ">" or "&" and cannot close the script element that
 * holds it. Values are substituted in one pass, so a value that contains
 * "{{placeholder}}" text is shown literally instead of being expanded.
 *
 * Usage:
 *   node render-report.mjs --values <values.json> [--raw <agentrc.json>] [--out reports/index.html]
 *
 * values.json holds the top-level placeholders (repoName, date, level,
 * levelName, overallPct, grade, passRate, threshold, optional policyName
 * and policySummary) plus these optional lists:
 *   repoHealthPillars, aiSetupPillars  objects keyed by pillarName,
 *     pillarScore, pillarRelevance, pillarStatus, pillarWhat, pillarWhyAi,
 *     pillarCurrent, pillarRecommendation
 *   extras                             objects { extraName, extraPresent }
 *   fixFirst, fixNext, plan            objects { planFinding, planFile, planWhy }
 * The AgentRC JSON comes from --raw, from values.rawJson (an object), or
 * from values.rawJsonCompact (a JSON string). If no pillar list is given,
 * top-level pillar* values render as a single Repo Health pillar.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MATURITY_LEVELS = [
  [5, "Autonomous"],
  [4, "Optimized"],
  [3, "Standardized"],
  [2, "Documented"],
  [1, "Functional"],
];
const PILLAR_STATUSES = new Set(["good", "warn", "bad"]);
const PILLAR_RELEVANCES = new Set(["high", "medium", "low"]);

const BLOCK_OR_PLACEHOLDER =
  /<!--\s*\{\{#(\w+)\}\}\s*-->([\s\S]*?)<!--\s*\{\{\/\1\}\}\s*-->|\{\{(\w+)\}\}/g;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const BLOCK_MARKER = /^<!--\s*\{\{[#/]\w+\}\}\s*-->$/;

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON that is safe as the text of a <script> element and parses to the same value. */
export function jsonForScript(data) {
  return JSON.stringify(data).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function scalar(name, value) {
  if (value === undefined || value === null) {
    throw new Error(`renderReadinessReport: missing value for {{${name}}}`);
  }
  if (typeof value === "object") {
    throw new Error(`renderReadinessReport: {{${name}}} must be a string or number`);
  }
  return String(value);
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function resolveRawJson(values) {
  if (present(values.rawJson)) {
    return typeof values.rawJson === "string" ? JSON.parse(values.rawJson) : values.rawJson;
  }
  if (present(values.rawJsonCompact)) {
    return JSON.parse(scalar("rawJsonCompact", values.rawJsonCompact));
  }
  throw new Error("renderReadinessReport: the AgentRC JSON (rawJson or rawJsonCompact) is required");
}

function pillarScope(pillar) {
  return {
    ...pillar,
    pillarStatusClass: PILLAR_STATUSES.has(pillar.pillarStatus) ? pillar.pillarStatus : "",
    pillarRelevanceClass: PILLAR_RELEVANCES.has(pillar.pillarRelevance) ? pillar.pillarRelevance : "",
    pillarWidth: percent(pillar.pillarScore),
  };
}

function listOf(values, key) {
  const list = values[key] ?? [];
  if (!Array.isArray(list)) {
    throw new Error(`renderReadinessReport: ${key} must be an array`);
  }
  return list;
}

function buildBlocks(values) {
  let repoHealth = listOf(values, "repoHealthPillars");
  const aiSetup = listOf(values, "aiSetupPillars");
  if (repoHealth.length === 0 && aiSetup.length === 0 && present(values.pillarName)) {
    repoHealth = [values];
  }
  const planRows = (key) =>
    listOf(values, key).map((row, index) => ({ ...row, planIndex: index + 1 }));
  const currentLevel = String(values.level);
  return {
    policy: present(values.policyName) ? [{}] : [],
    maturityRows: MATURITY_LEVELS.map(([level, name]) => ({
      rowLevel: level,
      rowName: name,
      rowStatus: String(level) === currentLevel ? "◼ You are here" : "",
    })),
    repoHealthPillars: repoHealth.map(pillarScope),
    aiSetupPillars: aiSetup.map(pillarScope),
    extras: listOf(values, "extras").map((extra) => ({
      ...extra,
      extraMark: extra.extraPresent ? "✅" : "◻",
      extraStatus: extra.extraPresent ? "present" : "missing",
    })),
    fixFirst: planRows("fixFirst"),
    fixNext: planRows("fixNext"),
    plan: planRows("plan"),
  };
}

/**
 * @param {string} templateHtml contents of report-template.html
 * @param {Record<string, unknown>} values see the file header
 * @returns {string} the report HTML
 */
export function renderReadinessReport(templateHtml, values) {
  const raw = resolveRawJson(values);
  const level = present(values.level) ? String(values.level) : "";
  const top = {
    ...values,
    levelClass: /^[1-5]$/.test(level) ? `lvl-${level}` : "",
    rawJsonPretty: present(values.rawJsonPretty)
      ? values.rawJsonPretty
      : JSON.stringify(raw, null, 2),
  };
  const blocks = buildBlocks(values);

  const encode = (name, scope) => {
    if (name === "rawJsonCompact") return jsonForScript(raw);
    return escapeHtml(scalar(name, scope[name]));
  };

  const template = templateHtml.replace(/<!--[\s\S]*?-->/g, (comment) =>
    BLOCK_MARKER.test(comment) ? comment : "",
  );

  return template.replace(BLOCK_OR_PLACEHOLDER, (match, blockName, body, name) => {
    if (name) return encode(name, top);
    const items = blocks[blockName];
    if (!items) {
      throw new Error(`renderReadinessReport: unknown block {{#${blockName}}}`);
    }
    return items
      .map((item) => {
        const scope = { ...top, ...item };
        return body.replace(PLACEHOLDER, (_, inner) => encode(inner, scope));
      })
      .join("");
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!["--values", "--raw", "--out"].includes(flag) || i + 1 >= argv.length) {
      throw new Error(
        "Usage: node render-report.mjs --values <values.json> [--raw <agentrc.json>] [--out reports/index.html]",
      );
    }
    args[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  if (!args.values) throw new Error("--values is required");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const templateHtml = readFileSync(path.join(here, "report-template.html"), "utf8");
  const values = JSON.parse(readFileSync(args.values, "utf8"));
  if (args.raw) {
    values.rawJson = JSON.parse(readFileSync(args.raw, "utf8"));
    delete values.rawJsonCompact;
    delete values.rawJsonPretty;
  }
  const out = args.out ?? path.join("reports", "index.html");
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, renderReadinessReport(templateHtml, values), "utf8");
  console.log(`Wrote ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
