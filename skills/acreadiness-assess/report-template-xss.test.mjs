/**
 * The readiness report is built by substituting report-template.html.
 * skills/acreadiness-assess/SKILL.md tells the agent to substitute
 * placeholders and embed the AgentRC JSON. The template puts that JSON in
 * a script element and a pre element, and puts policy and pillar text in
 * the body. agents/ai-readiness-reporter.agent.md adds an incomplete
 * encoding step: HTML-escape text placeholders, and replace the exact
 * lowercase sequence "</script" inside the compact JSON.
 *
 * These tests open the substituted report in Chrome. They fail while a
 * repository-controlled policy name, criterion title, or copied repo string
 * can run script there.
 *
 * A fix should add skills/acreadiness-assess/render-report.mjs exporting
 * renderReadinessReport(templateHtml, values). The tests call that function
 * when it exists. Until then they follow the substitution rules written in
 * the skill, the template, and the reporter agent. The report must:
 *   - show each substituted value as text, including one live pillar card
 *     (the template's pillar markup is an example inside a comment; the
 *     instructions say to repeat that block in the page)
 *   - keep {{rawJsonCompact}} inside script#raw-data as JSON that parses to
 *     the same value
 *   - leave no substituted string able to close a script, pre, title, or
 *     comment, or to break out of an attribute
 *
 * Placeholders filled from the scan or from repository text are all covered.
 * {{date}} is covered by the same text encoding as {{levelName}}.
 *
 * Run:
 *   node --test skills/acreadiness-assess/report-template-xss.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const skillDir = path.dirname(new URL(import.meta.url).pathname);
const templatePath = path.join(skillDir, "report-template.html");
const rendererPath = path.join(skillDir, "render-report.mjs");
const templateHtml = readFileSync(templatePath, "utf8");

const BENIGN_SCAN = {
  ok: true,
  status: "success",
  data: {
    policies: { chain: ["benign-policy"], criteriaCount: 1 },
    criteria: [{ id: "readme", title: "Readme present" }],
  },
};

function scriptPayload(id, closer) {
  const js = `document.documentElement.dataset.xss=${JSON.stringify(id)}`;
  return `${closer}<script>${js}</script>`;
}

function scanWithChain(chainName) {
  return {
    ok: true,
    status: "success",
    data: {
      policies: { chain: [chainName], criteriaCount: 29 },
      criteria: [{ id: "readme", title: `${chainName}-title` }],
    },
  };
}

function baseValues(overrides) {
  const scan = overrides.scan ?? BENIGN_SCAN;
  const values = {
    repoName: "example-repo",
    date: "2026-11-15",
    level: "1",
    levelName: "Functional",
    overallPct: "10",
    grade: "F",
    passRate: "0%",
    threshold: "80%",
    policyName: "benign-policy",
    policySummary: "No criteria overridden.",
    rawJsonCompact: JSON.stringify(scan),
    rawJsonPretty: JSON.stringify(scan, null, 2),
    pillarName: "Style",
    pillarScore: "10",
    pillarRelevance: "medium",
    pillarStatus: "warn",
    pillarWhat: "Linter configuration.",
    pillarWhyAi: "Lint rules steer generated code.",
    pillarCurrent: "No linter config found.",
    pillarRecommendation: "Add eslint.config.js.",
  };
  return { ...values, ...overrides.values };
}

function materializePillarExample(html) {
  const marker = '<div class="pillar">';
  const markerAt = html.indexOf(marker);
  assert.notEqual(markerAt, -1, "template is missing the pillar example");
  const commentStart = html.lastIndexOf("<!--", markerAt);
  const commentEnd = html.indexOf("-->", markerAt);
  assert.ok(commentStart !== -1 && commentEnd !== -1 && commentStart < markerAt);
  const innerEnd = html.lastIndexOf("</div>", commentEnd);
  assert.ok(innerEnd > markerAt);
  const inner = html.slice(markerAt, innerEnd + "</div>".length);
  return `${html.slice(0, commentStart)}\n${inner}\n${html.slice(commentEnd + 3)}`;
}

function fillPlaceholders(html, values) {
  let filled = html;
  for (const [key, value] of Object.entries(values)) {
    filled = filled.replaceAll(`{{${key}}}`, String(value));
  }
  return filled;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Substitution required by SKILL.md and the template comments: raw text. */
function renderAsSkillSpecifies(values) {
  return fillPlaceholders(materializePillarExample(templateHtml), values);
}

/**
 * Substitution required by agents/ai-readiness-reporter.agent.md:
 * HTML-escape every text and attribute placeholder, and replace the exact
 * lowercase characters "</script" in the compact JSON with "<" + "\" + "/script".
 */
function renderAsAgentSpecifies(values) {
  const encoded = {};
  for (const [key, value] of Object.entries(values)) {
    const text = String(value);
    encoded[key] =
      key === "rawJsonCompact" ? text.replaceAll("</script", "<\\/script") : htmlEscape(text);
  }
  return fillPlaceholders(materializePillarExample(templateHtml), encoded);
}

async function renderReport(group, values) {
  if (existsSync(rendererPath)) {
    const mod = await import(pathToFileURL(rendererPath).href);
    assert.equal(typeof mod.renderReadinessReport, "function");
    return mod.renderReadinessReport(templateHtml, values);
  }
  return group === "agent" ? renderAsAgentSpecifies(values) : renderAsSkillSpecifies(values);
}

function instrument(html) {
  return `${html}\n<script>document.documentElement.dataset.checker="ran"</script>\n`;
}

function unescapeAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function runChrome(url) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "acreadiness-chrome-"));
  return new Promise((resolve, reject) => {
    const chrome = spawn(
      "google-chrome",
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--user-data-dir=${userDataDir}`,
        "--virtual-time-budget=15000",
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => {
      chrome.kill("SIGKILL");
    }, 40000);
    chrome.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    chrome.on("error", (error) => {
      clearTimeout(timer);
      rmSync(userDataDir, { recursive: true, force: true });
      reject(error);
    });
    chrome.on("close", () => {
      clearTimeout(timer);
      rmSync(userDataDir, { recursive: true, force: true });
      resolve(stdout);
    });
  });
}

async function openReports(reports) {
  const dir = mkdtempSync(path.join(tmpdir(), "acreadiness-reports-"));
  for (const report of reports) {
    writeFileSync(path.join(dir, `${report.id}.html`), instrument(report.html), "utf8");
  }
  const frames = reports
    .map((report) => `<iframe id="${report.id}" src="/${report.id}.html"></iframe>`)
    .join("\n");
  writeFileSync(
    path.join(dir, "index.html"),
    `<!DOCTYPE html><html><body>
${frames}
<script>
window.addEventListener("load", () => {
  const out = [];
  for (const frame of document.querySelectorAll("iframe")) {
    const doc = frame.contentDocument;
    const raw = doc.getElementById("raw-data");
    const pre = doc.querySelector("pre");
    out.push({
      id: frame.id,
      xss: doc.documentElement.dataset.xss || "",
      checker: doc.documentElement.dataset.checker || "",
      title: doc.title,
      policy: doc.querySelector("p code") ? doc.querySelector("p code").textContent : "",
      current: Array.from(doc.querySelectorAll("p")).map((node) => node.textContent).join("\\n"),
      pre: pre ? pre.textContent : "",
      raw: raw ? raw.textContent : ""
    });
  }
  document.documentElement.dataset.results = JSON.stringify(out);
});
</script>
</body></html>`,
    "utf8",
  );

  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const filePath = path.join(dir, requestPath === "/" ? "index.html" : requestPath);
    if (!filePath.startsWith(dir)) {
      response.writeHead(400);
      response.end("bad path");
      return;
    }
    try {
      const body = readFileSync(filePath);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("missing");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const dom = await runChrome(`http://127.0.0.1:${port}/`);
    const match = dom.match(/data-results="([^"]*)"/);
    assert.ok(match, `Chrome did not return report results.\n${dom.slice(0, 500)}`);
    const parsed = JSON.parse(unescapeAttribute(match[1]));
    return Object.fromEntries(parsed.map((entry) => [entry.id, entry]));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonCase(group, id, closer) {
  const payload = scriptPayload(id, closer);
  const scan = scanWithChain(payload);
  return {
    group,
    id,
    values: baseValues({ scan, values: {} }),
    scan,
    visible: null,
  };
}

function textCase(group, id, key, payload) {
  return {
    group,
    id,
    values: baseValues({ values: { [key]: payload } }),
    scan: BENIGN_SCAN,
    visible: { key, payload },
  };
}

const cases = [
  jsonCase("skill", "skill-json-lower", "</script>"),
  jsonCase("skill", "skill-json-mixed", "</ScRiPt>"),
  jsonCase("skill", "skill-json-upper", "</SCRIPT>"),
  jsonCase("skill", "skill-json-upper-space", "</SCRIPT >"),
  textCase("skill", "skill-pre", "rawJsonPretty", scriptPayload("skill-pre", "</pre>")),
  textCase(
    "skill",
    "skill-policy-summary",
    "policySummary",
    `<img src=x onerror="document.documentElement.dataset.xss='skill-policy-summary'"><script>document.documentElement.dataset.xss='skill-policy-summary'</script>`,
  ),
  textCase("skill", "skill-policy-name", "policyName", scriptPayload("skill-policy-name", "</code>")),
  textCase("skill", "skill-pillar-current", "pillarCurrent", scriptPayload("skill-pillar-current", "")),
  textCase(
    "skill",
    "skill-pillar-recommendation",
    "pillarRecommendation",
    scriptPayload("skill-pillar-recommendation", ""),
  ),
  textCase("skill", "skill-pillar-what", "pillarWhat", scriptPayload("skill-pillar-what", "")),
  textCase("skill", "skill-pillar-why", "pillarWhyAi", scriptPayload("skill-pillar-why", "")),
  textCase("skill", "skill-pillar-name", "pillarName", scriptPayload("skill-pillar-name", "")),
  textCase("skill", "skill-repo-name", "repoName", scriptPayload("skill-repo-name", "</title>")),
  textCase(
    "skill",
    "skill-pillar-status",
    "pillarStatus",
    `"><img src=x onerror="document.documentElement.dataset.xss='skill-pillar-status'>`,
  ),
  textCase("skill", "skill-level-name", "levelName", scriptPayload("skill-level-name", "</span>")),
  jsonCase("agent", "agent-json-lower", "</script>"),
  jsonCase("agent", "agent-json-mixed", "</ScRiPt>"),
  jsonCase("agent", "agent-json-upper", "</SCRIPT>"),
  jsonCase("agent", "agent-json-upper-space", "</SCRIPT >"),
  textCase("agent", "agent-pre", "rawJsonPretty", scriptPayload("agent-pre", "</pre>")),
  textCase(
    "agent",
    "agent-policy-summary",
    "policySummary",
    `<img src=x onerror="document.documentElement.dataset.xss='agent-policy-summary'"><script>document.documentElement.dataset.xss='agent-policy-summary'</script>`,
  ),
  textCase("agent", "agent-pillar-current", "pillarCurrent", scriptPayload("agent-pillar-current", "")),
  textCase("agent", "agent-repo-name", "repoName", scriptPayload("agent-repo-name", "</title>")),
  textCase(
    "agent",
    "agent-pillar-status",
    "pillarStatus",
    `"><img src=x onerror="document.documentElement.dataset.xss='agent-pillar-status'>`,
  ),
];

let observed;

test.before(async () => {
  const reports = [];
  for (const entry of cases) {
    reports.push({
      id: entry.id,
      html: await renderReport(entry.group, entry.values),
    });
  }
  observed = await openReports(reports);
}, { timeout: 90000 });

for (const entry of cases) {
  test(`${entry.id} does not run substituted repository text`, { timeout: 10000 }, () => {
    const result = observed[entry.id];
    assert.ok(result, `missing browser result for ${entry.id}`);
    assert.equal(result.xss, "", `${entry.id} executed script (${result.xss})`);
    assert.equal(result.checker, "ran", `${entry.id} did not finish loading`);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.raw);
    }, `${entry.id} compact JSON did not stay inside script#raw-data`);
    assert.deepEqual(parsed, entry.scan);
    if (entry.visible) {
      const haystack = `${result.title}\n${result.policy}\n${result.current}\n${result.pre}`;
      assert.ok(
        haystack.includes(entry.visible.payload),
        `${entry.id} did not show ${entry.visible.key} as text`,
      );
    }
  });
}
