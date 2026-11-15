import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.join(__dirname, "game");
const assetsRoot = path.join(__dirname, "assets");
const indexPath = path.join(gameRoot, "index.html");

const games = [
    { key: "cosmic-rocks", label: "Cosmic Rocks", icon: "☄️" },
    { key: "alien-onslaught", label: "Alien Onslaught", icon: "👾" },
    { key: "galaxy-blaster", label: "Galaxy Blaster", icon: "🚀" },
    { key: "ninja-runner", label: "Ninja Runner", icon: "🥷" },
    { key: "defender", label: "Planet Guardian", icon: "🛡️" },
    { key: "surface-defense", label: "Surface Defense", icon: "🎯" },
];

const gameKeys = new Set(games.map((game) => game.key));
const defaultGame = "ninja-runner";
const canvasBackgroundGames = ["cosmic-rocks", "alien-onslaught", "galaxy-blaster", "defender", "surface-defense"];
const servers = new Map();
const MAX_BODY_BYTES = 64 * 1024;
// The page sets <base href="/t/<token>/game/"> so the game's relative script,
// image, and audio loads carry the instance token in their path.
const tokenPathPattern = /^\/t\/([^/]*)(\/.*)?$/;

function normalizeGameKey(value) {
    return typeof value === "string" && gameKeys.has(value) ? value : defaultGame;
}

function contentType(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".js":
            return "text/javascript; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".png":
            return "image/png";
        case ".webp":
            return "image/webp";
        case ".xml":
            return "application/xml; charset=utf-8";
        case ".mp3":
            return "audio/mpeg";
        case ".ogg":
            return "audio/ogg";
        case ".m4a":
            return "audio/mp4";
        case ".wav":
            return "audio/wav";
        default:
            return "application/octet-stream";
    }
}

function resolveUnder(root, requestPath) {
    const resolved = path.resolve(root, `.${requestPath}`);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new CanvasError("invalid_path", "Requested path is outside the arcade assets.");
    }
    return resolved;
}

function sendJson(res, value) {
    res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(JSON.stringify(value));
}

function sendNotFound(res) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
}

function sendSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(entry, event, data) {
    for (const client of entry.clients) {
        sendSse(client, event, data);
    }
}

async function renderIndex(entry) {
    const html = await readFile(indexPath, "utf8");
    const bootstrap = `<script>
(() => {
  window.__agentArcadeLayoutProfile = "canvas";
  const token = ${JSON.stringify(entry.token)};
  const tokenQuery = "?token=" + encodeURIComponent(token);
  const selectedGame = ${JSON.stringify(entry.selectedGame)};
  const games = ${JSON.stringify(games)};
  const canvasBackgroundGames = ${JSON.stringify(canvasBackgroundGames)};
  let switchingGames = false;
  try {
    localStorage.setItem("agentArcade_pauseKey", "Escape");
    localStorage.setItem("agentArcade_unpauseKey", "Ctrl+Escape");
  } catch {}

  function storeGame(gameKey) {
    try { localStorage.setItem("agentArcade_lastGame", gameKey); } catch {}
  }

  function selectGame(gameKey) {
    if (!games.some((game) => game.key === gameKey)) return;
    storeGame(gameKey);
    applyCanvasBackdrop(gameKey);
    setTimeout(() => applyCanvasBackdrop(gameKey), 150);
    const selector = document.getElementById("game-select");
    if (selector) selector.value = gameKey;
    if (window.__agentArcadeSwitchGame) {
      markSwitchingGame();
      window.__agentArcadeSwitchGame(gameKey);
      return;
    }
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (window.__agentArcadeSwitchGame) {
        clearInterval(timer);
        markSwitchingGame();
        window.__agentArcadeSwitchGame(gameKey);
      } else if (attempts > 40) {
        clearInterval(timer);
      }
    }, 100);
  }

  function applyCanvasBackdrop(gameKey) {
    try {
      const useSpaceBackground = canvasBackgroundGames.includes(gameKey);
      document.body.classList.toggle("canvas-space-background", useSpaceBackground);
      localStorage.setItem("agentArcade_bgDefault_v2", "1");
      localStorage.setItem("agentArcade_bgTransparency", useSpaceBackground ? "0" : "100");
      const scenes = window.__phaserGame?.scene?.scenes ?? [];
      for (const scene of scenes) {
        if (typeof scene.setBackdropAlpha === "function") {
          scene.setBackdropAlpha(useSpaceBackground ? 0 : 100);
        }
        scene._backdrop?.setAlpha?.(useSpaceBackground ? 0 : 1);
      }
    } catch {}
  }

  function isHudOverlayOpen() {
    return document.getElementById("settings-overlay")?.classList.contains("show")
      || document.getElementById("help-overlay")?.classList.contains("show");
  }

  function isTextInput(target) {
    const el = target;
    return !!el?.closest?.("input, textarea, select, [contenteditable='true']");
  }

  function markSwitchingGame() {
    switchingGames = true;
    setTimeout(() => { switchingGames = false; }, 600);
  }

  function pauseCanvas() {
    if (document.body.classList.contains("paused")) return;
    window.__agentArcadePauseScene?.(true);
    document.getElementById("hud")?.classList.add("paused");
    document.body.classList.add("paused");
    document.getElementById("gameover-overlay")?.style.setProperty("display", "none");
    document.getElementById("wave-banner")?.style.setProperty("display", "none");
    document.getElementById("help-overlay")?.classList.remove("show");
    document.getElementById("ready-overlay")?.remove();
  }

  function resumeCanvas() {
    if (!document.body.classList.contains("paused") && !document.getElementById("hud")?.classList.contains("paused")) return;
    if (!switchingGames) {
      window.__agentArcadePauseScene?.(false);
    }
    document.getElementById("hud")?.classList.remove("paused");
    document.body.classList.remove("paused");
    setTimeout(() => document.querySelector("#game canvas")?.focus?.(), 50);
  }

  window.agentArcade = {
    setClickThrough: () => {},
    setPaused: (paused) => paused ? pauseCanvas() : resumeCanvas(),
    onResumeRequest: () => {},
    quitApp: () => {},
    hideApp: () => {},
  };

  function handleCanvasHotkey(event) {
    if (event.__agentArcadeCanvasHandled) return;
    if (event.code !== "Escape" || isTextInput(event.target) || isHudOverlayOpen()) return;
    event.__agentArcadeCanvasHandled = true;
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      resumeCanvas();
      return;
    }
    if (!event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      pauseCanvas();
    }
  }

  window.addEventListener("keydown", handleCanvasHotkey, true);
  document.addEventListener("keydown", handleCanvasHotkey, true);

  document.getElementById("resume-btn")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    resumeCanvas();
  }, true);

  document.getElementById("game-select")?.addEventListener("change", (event) => {
    markSwitchingGame();
    fetch("/select-game" + tokenQuery, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameKey: event.target.value }),
    }).then((response) => {
      if (!response.ok) throw new Error("Could not save the selected game");
    }).catch((error) => console.error("Game selection failed:", error));
  }, true);

  storeGame(selectedGame);
  applyCanvasBackdrop(selectedGame);
  setTimeout(() => selectGame(selectedGame), 300);
  setTimeout(() => applyCanvasBackdrop(selectedGame), 800);

  const style = document.createElement("style");
  style.textContent = \`
    html, body, body.paused, #game {
      background-color: #02040d !important;
    }
    body.canvas-space-background,
    body.canvas-space-background.paused,
    body.canvas-space-background #game {
      background-image:
        radial-gradient(circle at 50% 35%, rgba(18, 34, 88, 0.35), rgba(2, 4, 13, 0.18) 42%, rgba(2, 4, 13, 0.78) 100%),
        url('../assets/canvas-background.webp') !important;
      background-position: center, center !important;
      background-repeat: no-repeat, no-repeat !important;
      background-size: cover, cover !important;
    }
    canvas { background: transparent !important; }
    #bg-transparency { display: none !important; }
    #bg-transparency-value::before { content: 'Canvas backdrop'; }
    #bg-transparency-value { font-size: 0 !important; }
    #bg-transparency-value::before { font-size: 12px !important; }
    #hud { top: 12px !important; max-width: calc(100vw - 32px); gap: 12px !important; transform: translateX(-50%); transform-origin: top center; }
    #minimize-btn, #close-btn, #drag-handle { display: none !important; }
    #update-banner { display: none !important; }
    @media (max-width: 760px) {
      #hud { left: 12px !important; right: 12px !important; transform: none !important; justify-content: center; flex-wrap: wrap; white-space: normal !important; }
      .hud-divider, .hud-spacer { display: none !important; }
    }
  \`;
  document.head.appendChild(style);

  window.__agentArcadeCanvasSelectGame = selectGame;
  window.__agentArcadeCanvasGames = games;

  const events = new EventSource("/events" + tokenQuery);
  events.addEventListener("selectGame", (event) => {
    try { selectGame(JSON.parse(event.data).gameKey); } catch {}
  });
  events.addEventListener("reload", () => window.location.reload());
})();
</script>`;
    const base = `<base href="/t/${encodeURIComponent(entry.token)}/game/">\n  <link rel="icon" href="../favicon.ico">`;
    return html
        .replace("<head>", `<head>\n  ${base}`)
        .replace('<script src="./hud.js"></script>', `${bootstrap}\n  <script src="./hud.js"></script>`);
}

async function streamFile(res, filePath) {
    const fileStat = await stat(filePath).catch(() => undefined);
    if (!fileStat?.isFile()) {
        sendNotFound(res);
        return;
    }

    res.writeHead(200, {
        "content-type": contentType(filePath),
        "cache-control": "no-cache",
    });
    const stream = createReadStream(filePath);
    stream.on("error", () => {
        if (!res.headersSent) {
            sendNotFound(res);
        } else {
            res.destroy();
        }
    });
    stream.pipe(res);
}

function sendRefusal(res, status, message) {
    res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
    });
    res.end(message);
}

// Resolves undefined once the body exceeds `limit`, leaving the rest unread so
// the connection can be closed after the 413 instead of draining it.
function readLimitedBody(req, limit) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limit) {
            resolve(undefined);
            return;
        }
        const chunks = [];
        let size = 0;
        const cleanup = () => {
            req.off("data", onData);
            req.off("end", onEnd);
            req.off("error", onError);
            req.off("close", onClose);
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size > limit) {
                cleanup();
                req.pause();
                resolve(undefined);
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = () => {
            cleanup();
            resolve(Buffer.concat(chunks));
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => {
            cleanup();
            reject(new Error("Request closed before the body was complete"));
        };
        req.on("data", onData);
        req.on("end", onEnd);
        req.on("error", onError);
        req.on("close", onClose);
    });
}

function tokenMatches(expected, supplied) {
    if (typeof supplied !== "string") return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(entry, req, suppliedTokens) {
    if (req.headers.host !== entry.host) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== entry.origin) return false;
    return suppliedTokens.length > 0 && suppliedTokens.every((value) => tokenMatches(entry.token, value));
}

async function handleSelectGame(entry, req, res) {
    const body = await readLimitedBody(req, MAX_BODY_BYTES);
    if (body === undefined) {
        sendRefusal(res, 413, "Request body is too large");
        return;
    }
    let input;
    try {
        input = JSON.parse(body.toString("utf8"));
    } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Invalid JSON request body");
        return;
    }
    if (!input || typeof input !== "object" || Array.isArray(input) || !gameKeys.has(input.gameKey)) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Expected a valid gameKey");
        return;
    }
    entry.selectedGame = input.gameKey;
    broadcast(entry, "selectGame", { gameKey: entry.selectedGame });
    sendJson(res, { selectedGame: entry.selectedGame });
}

async function handleRequest(entry, req, res) {
    const requestUrl = new URL(req.url ?? "/", entry.origin);
    const suppliedTokens = requestUrl.searchParams.getAll("token");
    let pathname = requestUrl.pathname;
    const scoped = tokenPathPattern.exec(pathname);
    if (scoped) {
        suppliedTokens.push(scoped[1]);
        pathname = scoped[2] ?? "/";
    }
    if (!isAuthorized(entry, req, suppliedTokens)) {
        sendRefusal(res, 403, "This request is not authorized for this canvas.");
        return;
    }

    if (pathname === "/events") {
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        entry.clients.add(res);
        sendSse(res, "selectGame", { gameKey: entry.selectedGame });
        req.on("close", () => entry.clients.delete(res));
        return;
    }

    if (pathname === "/state") {
        sendJson(res, { games, selectedGame: entry.selectedGame });
        return;
    }

    if (pathname === "/favicon.ico") {
        await streamFile(res, path.join(assetsRoot, "icon.png"));
        return;
    }

    if (pathname === "/select-game" && req.method === "POST") {
        await handleSelectGame(entry, req, res);
        return;
    }

    try {
        if (pathname === "/" || pathname === "/index.html" || pathname === "/game" || pathname === "/game/") {
            res.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-cache",
                "referrer-policy": "no-referrer",
            });
            res.end(await renderIndex(entry));
            return;
        }

        const staticPath = pathname.startsWith("/assets/")
            ? resolveUnder(assetsRoot, pathname.slice("/assets".length))
            : resolveUnder(gameRoot, pathname.startsWith("/game/") ? pathname.slice("/game".length) : pathname);
        await streamFile(res, staticPath);
    } catch (error) {
        if (error instanceof CanvasError) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end(error.message);
            return;
        }
        throw error;
    }
}

async function startServer(instanceId, selectedGame) {
    const entry = {
        clients: new Set(),
        selectedGame,
        server: undefined,
        token: randomBytes(32).toString("base64url"),
        host: undefined,
        origin: undefined,
        url: undefined,
    };
    const server = createServer((req, res) => {
        handleRequest(entry, req, res).catch((error) => {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            res.end(error instanceof Error ? error.message : "Arcade canvas server error");
        });
    });
    entry.server = server;

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.host = `127.0.0.1:${port}`;
    entry.origin = `http://${entry.host}`;
    entry.url = `${entry.origin}/?token=${encodeURIComponent(entry.token)}`;
    servers.set(instanceId, entry);
    return entry;
}

function getOpenEntry(instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) {
        throw new CanvasError("arcade_not_open", "Open the Arcade canvas before invoking this action.");
    }
    return entry;
}

await joinSession({
    canvases: [
        createCanvas({
            id: "arcade-canvas",
            displayName: "Agent Arcade",
            description: "A retro arcade canvas with six mini-games for waiting while agents work.",
            inputSchema: {
                type: "object",
                properties: {
                    defaultGame: {
                        type: "string",
                        enum: games.map((game) => game.key),
                        description: "Game to show first.",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "list_games",
                    description: "List the mini-games available in the arcade canvas.",
                    handler: (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        return {
                            games,
                            selectedGame: entry?.selectedGame ?? defaultGame,
                        };
                    },
                },
                {
                    name: "select_game",
                    description: "Switch the open arcade canvas to a specific mini-game.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            gameKey: {
                                type: "string",
                                enum: games.map((game) => game.key),
                            },
                        },
                        required: ["gameKey"],
                        additionalProperties: false,
                    },
                    handler: (ctx) => {
                        const entry = getOpenEntry(ctx.instanceId);
                        entry.selectedGame = normalizeGameKey(ctx.input?.gameKey);
                        broadcast(entry, "selectGame", { gameKey: entry.selectedGame });
                        return {
                            selectedGame: entry.selectedGame,
                        };
                    },
                },
                {
                    name: "restart_game",
                    description: "Reload the open arcade canvas to restart the selected game.",
                    handler: (ctx) => {
                        const entry = getOpenEntry(ctx.instanceId);
                        broadcast(entry, "reload", {});
                        return {
                            selectedGame: entry.selectedGame,
                        };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, normalizeGameKey(ctx.input?.defaultGame));
                } else if (ctx.input?.defaultGame) {
                    entry.selectedGame = normalizeGameKey(ctx.input.defaultGame);
                    broadcast(entry, "selectGame", { gameKey: entry.selectedGame });
                }
                return {
                    title: "Agent Arcade",
                    status: games.find((game) => game.key === entry.selectedGame)?.label ?? "Ready",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) return;

                servers.delete(ctx.instanceId);
                for (const client of entry.clients) {
                    client.end();
                }
                await new Promise((resolve) => entry.server.close(() => resolve()));
            },
        }),
    ],
});
