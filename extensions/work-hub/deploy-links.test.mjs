import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const root = mkdtempSync(join(tmpdir(), "work-hub-links-"));
const bin = join(root, "bin");
mkdirSync(bin);
mkdirSync(join(root, ".copilot", "extensions", "work-hub", "artifacts"), { recursive: true });
writeFileSync(
    join(root, ".copilot", "extensions", "work-hub", "artifacts", "config.json"),
    JSON.stringify({ repos: ["acme/site"], onboarded: true }),
);
writeFileSync(
    join(root, ".copilot", "extensions", "work-hub", "artifacts", "preferences.json"),
    JSON.stringify({ mood: "focused", minutes: 120, busyness: "open", focusIntent: "maintenance" }),
);

// Stand-in for the gh CLI. The deployment status environment_url is whatever
// the test puts in WORK_HUB_TEST_ENV_URL, as a repo collaborator could set it.
writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const now = new Date().toISOString();
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args === "api user") out({ login: "victim" });
if (args === "api repos/acme/site") out({ html_url: "https://github.com/acme/site", default_branch: "main", pushed_at: now });
if (args === "api repos/acme/site/releases/latest") { process.stderr.write("HTTP 404: Not Found"); process.exit(1); }
if (args === "api repos/acme/site/tags?per_page=1") out([]);
if (args.startsWith("pr list")) out([{ number: 7, title: "Ship it", author: { login: "alice" }, url: "https://github.com/acme/site/pull/7", updatedAt: now, createdAt: now, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], labels: [], assignees: [] }]);
if (args.startsWith("issue list")) out([{ number: 9, title: "Bug", author: { login: "bob" }, url: "https://github.com/acme/site/issues/9", updatedAt: now, createdAt: now, labels: [], assignees: [], comments: [] }]);
if (args === "api repos/acme/site/deployments?per_page=30") out([{ id: 1, environment: "production", ref: "main", created_at: now }]);
if (args === "api repos/acme/site/deployments/1/statuses?per_page=1") out([{ state: "failure", environment_url: process.env.WORK_HUB_TEST_ENV_URL }]);
process.stderr.write("unexpected gh call: " + args);
process.exit(1);
`, { mode: 0o755 });

process.env.HOME = root;
process.env.PATH = `${bin}:${process.env.PATH}`;

const { collectDashboardState, invalidateCache } = await import("./data.mjs");
const { renderHtml } = await import("./renderer.mjs");

test.after(() => rmSync(root, { recursive: true, force: true }));

const MERGE_PAYLOAD = "javascript:fetch('/api/item/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repo:'acme/site',type:'pr',number:7,action:'merge'})})";
const UNSAFE_URLS = [
    MERGE_PAYLOAD,
    " JaVaScRiPt:alert(document.domain)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example/x",
    "/api/item/action",
];

async function collectWith(environmentUrl) {
    process.env.WORK_HUB_TEST_ENV_URL = environmentUrl;
    invalidateCache();
    return collectDashboardState(true);
}

function stubElement() {
    return {
        innerHTML: "",
        textContent: "",
        value: "",
        disabled: false,
        dataset: {},
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {},
        querySelectorAll: () => [],
        querySelector: () => null,
        closest: () => null,
        focus() {},
    };
}

async function bootClient(model) {
    const html = renderHtml();
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    const elements = new Map();
    const opened = [];
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        URL,
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, stubElement());
                return elements.get(id);
            },
            querySelectorAll: () => [],
            addEventListener() {},
        },
        window: { open: (...args) => opened.push(args) },
        navigator: {},
        EventSource: class { addEventListener() {} },
        fetch: async () => ({ ok: true, json: async () => model }),
    });
    vm.runInContext(script, context);
    await new Promise((resolve) => setImmediate(resolve));
    context.__model = model;
    vm.runInContext("state.model = __model; render();", context);
    return {
        el: (id) => elements.get(id) || stubElement(),
        run: (code) => vm.runInContext(code, context),
        opened,
    };
}

function decodeAttr(value) {
    return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function hrefs(html) {
    return [...html.matchAll(/href="([^"]*)"/g)].map((match) => decodeAttr(match[1]));
}

function sameHttpUrl(href, expected) {
    let got;
    let want;
    try {
        got = new URL(href);
        want = new URL(expected);
    } catch {
        return false;
    }
    return got.protocol === want.protocol
        && got.host === want.host
        && got.pathname === want.pathname
        && got.search === want.search
        && got.hash === want.hash;
}

// Resolve the way a browser would for a link on the Work Hub loopback page.
function assertHttpLinks(html, where) {
    const links = hrefs(html);
    assert.ok(links.length > 0, `${where} rendered no links`);
    for (const href of links) {
        const resolved = new URL(href, "http://127.0.0.1:4321/");
        assert.ok(["http:", "https:"].includes(resolved.protocol), `${where} rendered a ${resolved.protocol} link: ${JSON.stringify(href)}`);
        assert.notEqual(resolved.origin, "http://127.0.0.1:4321", `${where} rendered a link back into the Work Hub origin: ${JSON.stringify(href)}`);
    }
}

test("a failed deployment's non-http environment_url never becomes a link", async (t) => {
    for (const environmentUrl of UNSAFE_URLS) {
        await t.test(JSON.stringify(environmentUrl), async () => {
            const model = await collectWith(environmentUrl);
            const repo = model.repos.find((r) => r.slug === "acme/site");
            assert.equal(repo.failedDeploy, true);
            const deployItem = model.focusItems.find((it) => it.kind === "deploy");
            assert.ok(deployItem, "expected a failed deployment focus item");

            const client = await bootClient(model);
            const focus = client.el("focusList").innerHTML;
            assert.match(focus, /Fix failed deployment to production/);
            assertHttpLinks(focus, "focus list");
            assertHttpLinks(client.el("workList").innerHTML, "work list");

            client.run("openRepoDetail('acme/site')");
            const drawer = client.el("detailDrawer").innerHTML;
            assert.match(drawer, /production/);
            assertHttpLinks(drawer, "repo detail drawer");
        });
    }
});

test("an https environment_url is still linked from the focus card and drawer", async () => {
    const model = await collectWith("https://preview.acme.example/build/1");
    assert.equal(model.repos[0].deployments[0].url, "https://preview.acme.example/build/1");
    const client = await bootClient(model);
    assert.ok(hrefs(client.el("focusList").innerHTML).some((href) => sameHttpUrl(href, "https://preview.acme.example/build/1")));
    client.run("openRepoDetail('acme/site')");
    assert.ok(hrefs(client.el("detailDrawer").innerHTML).some((href) => sameHttpUrl(href, "https://preview.acme.example/build/1")));
});

test("the renderer refuses non-http URLs in every link it builds", async (t) => {
    const base = await collectWith("https://preview.acme.example/build/1");
    for (const unsafe of UNSAFE_URLS) {
        await t.test(JSON.stringify(unsafe), async () => {
            const model = structuredClone(base);
            const repo = model.repos[0];
            repo.url = unsafe;
            repo.latestRelease = { kind: "release", name: "v1", tagName: "v1", url: unsafe, publishedAt: null };
            repo.deployments.forEach((d) => { d.url = unsafe; });
            repo.prs.forEach((p) => { p.url = unsafe; });
            repo.issues.forEach((i) => { i.url = unsafe; });
            model.focusItems.forEach((it) => { it.url = unsafe; });
            model.recommendations.forEach((it) => { it.url = unsafe; });

            const client = await bootClient(model);
            for (const id of ["focusList", "workList", "repoGrid"]) {
                for (const href of hrefs(client.el(id).innerHTML)) {
                    assert.fail(`${id} rendered a link for ${JSON.stringify(unsafe)}: ${JSON.stringify(href)}`);
                }
            }
            client.run("openRepoDetail('acme/site')");
            for (const href of hrefs(client.el("detailDrawer").innerHTML)) {
                assert.fail(`repo detail drawer rendered a link for ${JSON.stringify(unsafe)}: ${JSON.stringify(href)}`);
            }

            client.run(`runAct("open-gh", { url: ${JSON.stringify(unsafe)} }, null)`);
            assert.deepEqual(client.opened, []);
        });
    }
});
