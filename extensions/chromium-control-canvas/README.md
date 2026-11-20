# Chromium Control Canvas

A GitHub Copilot canvas that drives a real **headful Chromium** window via Playwright.
The host app's built-in `browser` canvas is WebKit (WKWebView); this gives you actual
Chromium, controllable both from the panel UI and by the agent.

The canvas panel is a control strip (URL bar, back/forward/reload, screenshot). A separate
Chromium window does the real rendering, because you can't embed Chromium inside a WebKit
iframe.

## Files

- `extension.mjs` — the extension: canvas declaration, Playwright launch, a loopback HTTP
  server for the panel, and the agent actions.
- `index.html` — the control strip UI the panel renders.
- `package.json` — declares the `playwright` dependency and `"type": "module"`.
- `copilot-extension.json` — name/version metadata.

## Prerequisites

- **Node.js 20.19 or newer** (the Copilot SDK requires `node ^20.19.0 || >=22.12.0`).
  The extension runs as a Node child process.
- The app's **canvas / UI-extensions experiment enabled**. Without it, the extension
  loads but the canvas never appears in the panel. Enable it in the app's
  Settings → Experiments. (This may not be available to all accounts.)

## Install

Drop this folder at `~/.copilot/extensions/chromium-control-canvas/` (user scope) or in a repo's
`.github/extensions/chromium-control-canvas/` (project scope), then install dependencies and the
Chromium binary from inside the folder you copied:

```sh
# User scope
cd ~/.copilot/extensions/chromium-control-canvas

# Or project scope, from the repository root
cd .github/extensions/chromium-control-canvas

npm install                     # playwright is declared in package.json
npx playwright install chromium # downloads the browser, a few hundred MB
```

Reload extensions in the app, then open the `chromium-control-canvas` canvas.

Note: copying the extension files only places the source. It does **not** run the
commands above or enable the experiment, so those steps are still required on first
setup.

## Attach to your own Chrome

By default the canvas launches the bundled Chromium on a fresh, temporary profile. To use
a Chrome you already have running instead, start it with a debug port and pass `cdpUrl`
when opening the canvas:

```sh
google-chrome --remote-debugging-port=9222   # then open the canvas with cdpUrl: http://localhost:9222
```

In this mode the extension connects over CDP, opens a new isolated browser context in that
Chrome, and only drives that context. Your existing tabs, cookies, and logins in that
browser are not used. The extension never launches or kills your browser; closing the
canvas closes its own context and disconnects.

## Agent actions

- `navigate { url }` — go to a URL or search query (blocklist-guarded).
- `back` / `forward` / `reload` — history navigation.
- `current_url` — current URL and page title.
- `snapshot` — structured list of visible interactive elements, each with a ref.
- `click { ref }` — click the element a ref from the latest snapshot identifies.
- `type { ref, text, submit? }` — fill that input; optionally press Enter.
- `screenshot { fullPage? }` — save a PNG to `artifacts/` and return its path and size.

Anything read from the page (URL, title, element names) is returned to the agent inside an
`untrustedPageContent` object that marks it as page content, not instructions.

`click` and `type` do not accept CSS selectors. A ref is only valid for the snapshot that
minted it, on the same page, and always targets the exact element that snapshot found.
Navigating, reloading, or taking a new snapshot invalidates earlier refs.

## Notes

- Every canvas launch uses a new temporary profile that is deleted when the canvas
  closes, so cookies and logins do not carry over between sessions. Anything you sign in
  to in that window during a session, the agent can act on until the canvas closes.
- Earlier versions kept a persistent profile at
  `$COPILOT_HOME/extensions/chromium-control-canvas/profile`. It is no longer used; delete
  it if it still exists, since it may contain session cookies.
- Raw `evaluate` (arbitrary in-page JS) is intentionally omitted.
- `navigate` is checked against a blocklist, and a request interceptor also blocks
  navigations to blocked hosts that happen via in-page redirects. The shipped
  `BLOCKLIST` entries are illustrative examples, not real coverage — edit the list in
  `extension.mjs` to fit your environment.
- The loopback control server requires a per-launch token (templated into the panel),
  so other pages in your browser can't drive it.
- Typed text (e.g. passwords) is redacted in `audit.log`, and password field values are
  excluded from snapshots.
- Generated at runtime and not part of the source: `node_modules/` in the copied
  extension folder, plus `artifacts/` and `audit.log` under
  `$COPILOT_HOME/extensions/chromium-control-canvas/`.
