// Spec for the Arcade canvas loopback server started by canvas.open.
//
// Run from the repository root:
//   node --test extensions/arcade-canvas/extension.test.mjs
//
// POST /select-game is the only route that reads a request body. These tests
// fail while that handler appends every chunk into one string. A body larger
// than 64 KiB — the same JSON cap Chronicle Stats uses — must be refused with
// 413 before the client finishes sending it, and the selected game must stay
// unchanged. The same server must pin Host to 127.0.0.1:<port>, reject a
// cross-site Origin, and require the per-instance `token` query parameter from
// the URL returned by open() on every route, including POST /select-game.
// Authorization has to be decided before the body is read.
//
// The agent actions list_games, select_game, and restart_game do not read an
// HTTP body, so they are not part of this spec.

import assert from "node:assert/strict";
import http from "node:http";
import { registerHooks } from "node:module";
import test from "node:test";
const MAX_BODY_BYTES = 64 * 1024;
const SHIM_URL = new URL("./test/copilot-sdk-extension-shim.mjs", import.meta.url).href;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk/extension") {
            return { url: SHIM_URL, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const extensionReady = import("./extension.mjs");

let nextInstance = 0;

function registeredCanvas() {
    const canvases = globalThis.__arcadeCanvasTestJoin?.canvases;
    const canvas = canvases?.find((item) => item.declaration?.id === "arcade-canvas");
    if (!canvas?.open) {
        throw new Error("Arcade canvas was not registered by extension.mjs");
    }
    return canvas;
}

async function openArcade(t, input = { defaultGame: "ninja-runner" }) {
    await extensionReady;
    const canvas = registeredCanvas();
    const params = {
        sessionId: "test-session",
        extensionId: "arcade-canvas",
        canvasId: "arcade-canvas",
        instanceId: `arcade-test-${nextInstance++}`,
        input,
    };
    const opened = await canvas.open(params);
    t.after(async () => {
        await canvas.onClose?.(params);
    });
    const pageUrl = new URL(opened.url);
    return {
        opened,
        pageUrl,
        port: Number(pageUrl.port),
        host: pageUrl.host,
        origin: pageUrl.origin,
        token: pageUrl.searchParams.get("token"),
        initialGame: input.defaultGame,
    };
}

function route(arcade, pathname, { token = arcade.token } = {}) {
    const url = new URL(arcade.pageUrl);
    url.pathname = pathname;
    url.search = "";
    if (token) url.searchParams.set("token", token);
    return `${url.pathname}${url.search}`;
}

function completedRequest(port, { method = "GET", path = "/", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { hostname: "127.0.0.1", port, method, path, headers, agent: false },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            },
        );
        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error(`${method} ${path} timed out`));
        });
        req.on("error", reject);
        if (body === undefined) req.end();
        else req.end(body);
    });
}

// Writes the body only until the server responds. A handler that concatenates
// until the stream ends never responds, because end() is not called.
function postUntilResponse(port, { path, headers, stopAfter, timeoutMs = 1000 }) {
    const chunkSize = 16 * 1024;
    const chunk = Buffer.alloc(chunkSize, 0x61);
    return new Promise((resolve, reject) => {
        let bytesWritten = 0;
        let settled = false;
        const req = http.request(
            {
                hostname: "127.0.0.1",
                port,
                method: "POST",
                path,
                headers,
                agent: false,
            },
            (res) => {
                const chunks = [];
                res.on("data", (part) => chunks.push(part));
                res.on("end", () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({
                        status: res.statusCode,
                        text: Buffer.concat(chunks).toString("utf8"),
                        bytesWritten,
                        ended: false,
                    });
                });
            },
        );
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            req.destroy();
            reject(new Error(
                `no response after writing ${bytesWritten} bytes; the request was left open`,
            ));
        }, timeoutMs);
        req.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        const writeMore = () => {
            if (settled || bytesWritten >= stopAfter) return;
            const remaining = stopAfter - bytesWritten;
            const piece = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
            const ok = req.write(piece);
            bytesWritten += piece.length;
            if (settled || bytesWritten >= stopAfter) return;
            if (ok) writeMore();
            else req.once("drain", writeMore);
        };
        writeMore();
    });
}

function selectHeaders(arcade, extra = {}) {
    return {
        host: arcade.host,
        origin: arcade.origin,
        "content-type": "application/json",
        ...extra,
    };
}

function paddedSelect(gameKey, bytes) {
    const prefix = `{"gameKey":"${gameKey}","pad":"`;
    const suffix = '"}';
    const padLength = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    if (padLength < 0) throw new Error(`cannot pad a body to ${bytes} bytes`);
    const body = `${prefix}${"x".repeat(padLength)}${suffix}`;
    if (Buffer.byteLength(body) !== bytes) throw new Error("padded body has the wrong size");
    return body;
}

function assertUnauthorized(status, message) {
    assert.ok(status === 401 || status === 403, message ?? `expected 401 or 403, got ${status}`);
}

async function selectedGame(arcade) {
    const response = await completedRequest(arcade.port, {
        method: "GET",
        path: route(arcade, "/state"),
        headers: { host: arcade.host },
    });
    assert.equal(response.status, 200);
    return JSON.parse(response.text).selectedGame;
}

test("open binds a loopback server and a small select-game body still switches games", async (t) => {
    const arcade = await openArcade(t);
    assert.equal(arcade.pageUrl.hostname, "127.0.0.1");
    assert.equal(arcade.host, `127.0.0.1:${arcade.port}`);
    assert.equal(await selectedGame(arcade), "ninja-runner");

    const response = await completedRequest(arcade.port, {
        method: "POST",
        path: route(arcade, "/select-game"),
        headers: selectHeaders(arcade),
        body: JSON.stringify({ gameKey: "defender" }),
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).selectedGame, "defender");
    assert.equal(await selectedGame(arcade), "defender");
});

test("an invalid body under the limit is refused and does not switch games", async (t) => {
    const arcade = await openArcade(t);
    const response = await completedRequest(arcade.port, {
        method: "POST",
        path: route(arcade, "/select-game"),
        headers: selectHeaders(arcade, { "content-type": "text/plain" }),
        body: "not-json",
    });
    assert.equal(response.status, 400);
    assert.equal(await selectedGame(arcade), arcade.initialGame);
});

test("a finished body over 64 KiB is rejected and does not switch games", async (t) => {
    const arcade = await openArcade(t);
    const over = paddedSelect("defender", MAX_BODY_BYTES + 1);
    const response = await completedRequest(arcade.port, {
        method: "POST",
        path: route(arcade, "/select-game"),
        headers: selectHeaders(arcade),
        body: over,
    });
    assert.equal(response.status, 413);
    assert.equal(await selectedGame(arcade), arcade.initialGame);

    const atLimit = await completedRequest(arcade.port, {
        method: "POST",
        path: route(arcade, "/select-game"),
        headers: selectHeaders(arcade, { "content-type": "text/plain" }),
        body: Buffer.alloc(MAX_BODY_BYTES, 0x61),
    });
    assert.ok(atLimit.status === 400 || atLimit.status === 413, `status ${atLimit.status}`);
    assert.equal(await selectedGame(arcade), arcade.initialGame);
});

test("POST /select-game refuses an oversized chunked body before the client finishes it", async (t) => {
    const arcade = await openArcade(t);
    const cases = [
        { "content-type": "application/json" },
        { "content-type": "text/plain" },
        {},
    ];
    for (const extra of cases) {
        const response = await postUntilResponse(arcade.port, {
            path: route(arcade, "/select-game"),
            headers: { host: arcade.host, origin: arcade.origin, ...extra },
            stopAfter: MAX_BODY_BYTES + 32 * 1024,
        });
        assert.equal(response.status, 413);
        assert.equal(response.ended, false);
        assert.ok(
            response.bytesWritten <= MAX_BODY_BYTES + 32 * 1024,
            `server kept reading: ${response.bytesWritten} bytes`,
        );
        assert.equal(await selectedGame(arcade), arcade.initialGame);
    }
});

test("a missing or wrong token is rejected before the body is read and changes nothing", async (t) => {
    const arcade = await openArcade(t);
    assert.match(arcade.token ?? "", /^[A-Za-z0-9_-]{22,}$/);

    const missing = await postUntilResponse(arcade.port, {
        path: "/select-game",
        headers: selectHeaders(arcade),
        stopAfter: 0,
    });
    assertUnauthorized(missing.status);
    assert.equal(missing.ended, false);

    const wrong = await postUntilResponse(arcade.port, {
        path: route(arcade, "/select-game", { token: "incorrect-token-value" }),
        headers: selectHeaders(arcade),
        stopAfter: 0,
    });
    assertUnauthorized(wrong.status);

    const applied = await completedRequest(arcade.port, {
        method: "POST",
        path: "/select-game",
        headers: selectHeaders(arcade),
        body: JSON.stringify({ gameKey: "defender" }),
    });
    assertUnauthorized(applied.status);
    assert.equal(await selectedGame(arcade), arcade.initialGame);
});

test("the token from one canvas does not authorize another canvas", async (t) => {
    const first = await openArcade(t);
    const second = await openArcade(t, { defaultGame: "cosmic-rocks" });
    assert.match(first.token ?? "", /^[A-Za-z0-9_-]{22,}$/);
    assert.match(second.token ?? "", /^[A-Za-z0-9_-]{22,}$/);
    assert.notEqual(first.token, second.token);

    const response = await completedRequest(second.port, {
        method: "POST",
        path: route(second, "/select-game", { token: first.token }),
        headers: selectHeaders(second),
        body: JSON.stringify({ gameKey: "defender" }),
    });
    assertUnauthorized(response.status);
    assert.equal(await selectedGame(second), "cosmic-rocks");
    assert.equal(await selectedGame(first), "ninja-runner");
});

test("a foreign Host or Origin is rejected before the body is read", async (t) => {
    const arcade = await openArcade(t);
    const bodies = [
        { host: "evil.example" },
        { host: `evil.example:${arcade.port}` },
        { host: `127.0.0.1:${arcade.port + 1}` },
        { host: `localhost:${arcade.port}` },
        { host: arcade.host, origin: "http://evil.example" },
        { host: arcade.host, origin: "null" },
        { host: arcade.host, origin: `http://127.0.0.1:${arcade.port + 1}` },
    ];
    for (const headers of bodies) {
        const response = await postUntilResponse(arcade.port, {
            path: route(arcade, "/select-game"),
            headers: { ...selectHeaders(arcade), ...headers },
            stopAfter: 0,
        });
        assertUnauthorized(response.status, `${JSON.stringify(headers)} -> ${response.status}`);
        assert.equal(response.ended, false);
    }

    const finished = await completedRequest(arcade.port, {
        method: "POST",
        path: route(arcade, "/select-game"),
        headers: selectHeaders(arcade, { host: "evil.example" }),
        body: JSON.stringify({ gameKey: "defender" }),
    });
    assertUnauthorized(finished.status);
    assert.equal(await selectedGame(arcade), arcade.initialGame);
});

test("every route requires the instance token and the loopback Host", async (t) => {
    const arcade = await openArcade(t);
    const paths = [
        "/",
        "/index.html",
        "/game",
        "/game/",
        "/state",
        "/events",
        "/favicon.ico",
        "/hud.js",
        "/assets/icon.png",
        "/select-game",
    ];
    for (const pathname of paths) {
        const anonymous = await completedRequest(arcade.port, {
            method: pathname === "/select-game" ? "POST" : "GET",
            path: pathname,
            headers: { host: arcade.host },
            body: pathname === "/select-game" ? "{}" : undefined,
        });
        assertUnauthorized(anonymous.status, `${pathname} without a token -> ${anonymous.status}`);

        const foreignHost = await completedRequest(arcade.port, {
            method: "GET",
            path: route(arcade, pathname === "/select-game" ? "/state" : pathname),
            headers: { host: "evil.example" },
        });
        assertUnauthorized(foreignHost.status, `${pathname} with a foreign host -> ${foreignHost.status}`);
    }

    const page = await completedRequest(arcade.port, {
        method: "GET",
        path: route(arcade, "/"),
        headers: { host: arcade.host },
    });
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.match(page.text, /\/select-game/);
    assert.match(page.text, /\/events/);
    assert.match(page.text, /token/);
    const pageSendsOpenToken = page.text.includes(arcade.token)
        || /location\.(search|href)|URLSearchParams/.test(page.text);
    assert.equal(pageSendsOpenToken, true);

    const state = await completedRequest(arcade.port, {
        method: "GET",
        path: route(arcade, "/state"),
        headers: { host: arcade.host, origin: arcade.origin },
    });
    assert.equal(state.status, 200);
    assert.equal(JSON.parse(state.text).selectedGame, arcade.initialGame);

    const events = await new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: "127.0.0.1",
                port: arcade.port,
                method: "GET",
                path: route(arcade, "/events"),
                headers: { host: arcade.host },
                agent: false,
            },
            (res) => {
                resolve({ status: res.statusCode, headers: res.headers, req });
            },
        );
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error("/events timed out"));
        });
        req.on("error", reject);
        req.end();
    });
    assert.equal(events.status, 200);
    assert.match(events.headers["content-type"], /^text\/event-stream/);
    events.req.destroy();

    const script = await completedRequest(arcade.port, {
        method: "GET",
        path: route(arcade, "/hud.js"),
        headers: { host: arcade.host },
    });
    assert.equal(script.status, 200);
    assert.match(script.headers["content-type"], /^text\/javascript/);

    const icon = await completedRequest(arcade.port, {
        method: "GET",
        path: route(arcade, "/assets/icon.png"),
        headers: { host: arcade.host },
    });
    assert.equal(icon.status, 200);
    assert.equal(icon.headers["content-type"], "image/png");
});
