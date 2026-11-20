// Resource markdown is sanitized, then several pages copy heading and
// accessibility tags out of that string with a regular expression. A "<"
// inside a quoted attribute survives sanitization, so the copy promotes it
// into markup the browser parses as an event handler.
//
// These tests fail while that promotion is still injected. Run from the
// repository root:
//
//   node --test website/scripts/detail-toc-event-handler.test.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createServer } from "vite";
import { JSDOM } from "jsdom";
import { createMarkdownProcessor, parseFrontmatter } from "@astrojs/markdown-remark";

const website = fileURLToPath(new URL("..", import.meta.url));
const originalCwd = process.cwd();
process.chdir(website);
const server = await createServer({
  root: website,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
after(async () => {
  await server.close();
  process.chdir(originalCwd);
});

const { renderResourceMarkdown } = await server.ssrLoadModule("/src/lib/detail-page.ts");
const { buildDetailToc } = await server.ssrLoadModule("/src/lib/detail-toc.ts");
const { finalizePluginReadme } = await server.ssrLoadModule("/src/lib/plugin-readme.ts");
const { sanitizeHtml } = await server.ssrLoadModule("/src/lib/sanitize-html.ts");
const { enhanceMarkdownA11y } = await server.ssrLoadModule("/src/lib/markdown-a11y.ts");
const { marked } = await server.ssrLoadModule("marked");
const {
  buildArticleSections,
  stripLeadingH1,
  stripRedundantHeadingAnchors,
} = await server.ssrLoadModule("/src/lib/learning-hub-article.ts");

// Same shape as the plugin README regression: an h2 start tag stored in a
// quoted attribute, with the unquoted handler and a following attribute whose
// ">" the HTML parser can treat as the end of the real tag.
const hiddenHeading = [
  "---",
  "description: Example resource",
  "---",
  "",
  '<div title="<h2 onmouseover=alert(1) data-x=x>Heading</h2>">Documentation</div>',
  "",
].join("\n");

const hiddenPre = '<div title="<pre onmouseover=alert(1) data-x=x">Documentation</div>';
const hiddenTable = '<div title="<table onmouseover=alert(1) data-x=x><tr><td>Cell</td></tr></table>">Documentation</div>';

function eventHandlers(html) {
  const document = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  const found = [];
  for (const element of document.body.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      if (name.toLowerCase().startsWith("on")) {
        found.push(`${element.tagName.toLowerCase()} ${name}=${element.getAttribute(name)}`);
      }
    }
  }
  return found;
}

test("agent, instruction, skill, extension, and cookbook pages do not promote an attribute-hidden h2 into an event handler", () => {
  const { markdownHtml } = renderResourceMarkdown(hiddenHeading);
  assert.match(markdownHtml, /Documentation/);
  assert.deepEqual(eventHandlers(markdownHtml), [], "sanitized markdown must not already contain a handler");

  // These pages inject buildDetailToc().html and do not sanitize that string.
  const { html, toc } = buildDetailToc(markdownHtml);
  assert.match(html, /Documentation/);
  assert.deepEqual(eventHandlers(html), []);
  assert.ok(toc.every((item) => !item.label.toLowerCase().includes("onmouseover")));
});

test("plugin pages still sanitize the heading rewrite of the same attribute-hidden h2", () => {
  const { markdownHtml } = renderResourceMarkdown(hiddenHeading);
  const html = finalizePluginReadme(markdownHtml);
  assert.match(html, /Documentation/);
  assert.deepEqual(eventHandlers(html), []);
});

test("a real h2 still receives a table-of-contents id", () => {
  const { markdownHtml } = renderResourceMarkdown("---\ndescription: Example\n---\n\n## Install\n\nHello\n");
  const { html, toc } = buildDetailToc(markdownHtml);
  assert.match(html, /<h2\b[^>]*\bid="install"/);
  assert.deepEqual(toc.map((item) => item.id), ["install"]);
  assert.deepEqual(eventHandlers(html), []);
});

test("skill and cookbook file views do not turn pre or table text inside an attribute into an event handler", () => {
  for (const markdown of [hiddenPre, hiddenTable]) {
    const parsed = marked.parse(markdown, { async: false });
    const sanitized = sanitizeHtml(parsed, {
      rawBase: "https://raw.githubusercontent.com/github/awesome-copilot/main",
      filePath: "skills/example/notes.md",
    });
    assert.deepEqual(eventHandlers(sanitized), [], "sanitized file markdown must not already contain a handler");
    // SkillDetail and CookbookRecipe inject this string with no second sanitize.
    assert.deepEqual(eventHandlers(enhanceMarkdownA11y(sanitized)), []);
    assert.match(sanitized, /Documentation|Cell/);
  }
});

test("learning hub articles do not turn pre or table text inside an attribute into an event handler", async () => {
  // Shiki only rewrites fenced code. The raw HTML still goes through rehype-raw.
  const processor = await createMarkdownProcessor({ syntaxHighlight: false });
  for (const body of [hiddenPre, hiddenTable]) {
    const source = `---\ntitle: Example article\n---\n\n${body}\n`;
    const { content } = parseFrontmatter(source);
    const rendered = await processor.render(content, { frontmatter: { title: "Example article" } });
    const html = stripRedundantHeadingAnchors(
      stripLeadingH1(enhanceMarkdownA11y(sanitizeHtml(rendered.code))),
    );
    const injected = buildArticleSections(html, content)
      .flatMap((section) => section.blocks.map((block) => block.html))
      .join("");
    assert.match(injected, /Documentation|Cell/);
    assert.deepEqual(eventHandlers(injected), []);
  }
});

test("a fenced code block stays keyboard focusable and has no event handler", () => {
  const { markdownHtml } = renderResourceMarkdown("---\ndescription: Example\n---\n\n```\ncode\n```\n");
  assert.match(markdownHtml, /<pre\b[^>]*\btabindex="0"/);
  assert.deepEqual(eventHandlers(markdownHtml), []);
});
