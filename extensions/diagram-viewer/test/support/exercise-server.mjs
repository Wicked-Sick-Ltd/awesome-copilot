import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../extension.mjs",
);

const CASES = {
  "get-root-empty-host": { method: "GET", target: "/", host: "" },
  "get-root-bracket-host": { method: "GET", target: "/", host: "[" },
  "get-events-bracket-dot-host": { method: "GET", target: "/events", host: "[." },
  "get-state-closing-bracket-host": { method: "GET", target: "/api/state", host: "]" },
  "post-click-oversized-port-host": { method: "POST", target: "/api/click", host: "example.com:99999" },
  "post-back-alpha-port-host": { method: "POST", target: "/api/back", host: "example.com:abc" },
  "get-unknown-empty-host": { method: "GET", target: "/no-such", host: "" },
  "get-root-absolute-invalid-target": { method: "GET", target: "http://[", host: undefined },
  "get-root-triple-slash-target": { method: "GET", target: "///", host: undefined },
  "get-root-backslash-target": { method: "GET", target: "/\\", host: undefined },
  "control-canonical-host-without-token": {
    method: "GET",
    target: "/",
    host: undefined,
    accept: [403],
  },
};

const caseName = process.argv[2];
const spec = CASES[caseName];
if (!spec) {
  console.error(`Unknown case ${caseName}`);
  process.exit(2);
}

let boundPort;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function listenPatched(...args) {
  const server = this;
  const patched = args.map((arg) => {
    if (typeof arg !== "function") return arg;
    return (...cbArgs) => {
      boundPort = server.address().port;
      return arg.apply(this, cbArgs);
    };
  });
  return originalListen.apply(this, patched);
};

await import(pathToFileURL(extensionPath).href);
if (!boundPort) {
  console.error("extension server did not listen");
  process.exit(2);
}

const canonicalHost = `127.0.0.1:${boundPort}`;
const attackHost = spec.host === undefined ? canonicalHost : spec.host;
const accept = spec.accept ?? [400, 403];

function request({ method, target, host }) {
  return new Promise((resolve) => {
    const socket = net.connect(boundPort, "127.0.0.1");
    let raw = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => {
      finish({ error: "timeout", raw: raw.toString("latin1").slice(0, 300) });
    });
    socket.on("error", (error) => {
      finish({ error: error.code || error.message });
    });
    socket.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      const text = raw.toString("latin1");
      const splitAt = text.indexOf("\r\n\r\n");
      if (splitAt === -1) return;
      const header = text.slice(0, splitAt);
      const status = Number(header.split("\r\n")[0].split(" ")[1]);
      const lengthMatch = header.match(/content-length:\s*(\d+)/i);
      const bodyStart = splitAt + 4;
      if (lengthMatch) {
        const length = Number(lengthMatch[1]);
        if (raw.length >= Buffer.byteLength(text.slice(0, bodyStart), "latin1") + length) {
          finish({
            status,
            header,
            body: text.slice(bodyStart, bodyStart + length),
          });
        }
        return;
      }
      finish({ status, header, body: text.slice(bodyStart) });
    });
    socket.on("close", () => {
      finish({ error: "closed", raw: raw.toString("latin1").slice(0, 300) });
    });
    const head = [
      `${method} ${target} HTTP/1.1`,
      `Host: ${host}`,
      "Connection: close",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    socket.end(head);
  });
}

function refused(response, allowed) {
  if (!response || response.error) return false;
  if (!allowed.includes(response.status)) return false;
  const type = /content-type:\s*([^\r]+)/i.exec(response.header || "");
  if (type && /text\/html/i.test(type[1])) return false;
  if (response.body && response.body.includes("Diagram Explorer")) return false;
  return true;
}

const attack = await request({ method: spec.method, target: spec.target, host: attackHost });
await new Promise((resolve) => setTimeout(resolve, 300));
const followUp = await request({ method: "GET", target: "/", host: canonicalHost });

const ok = refused(attack, accept) && refused(followUp, [403]);
process.stdout.write(`${JSON.stringify({
  ok,
  attack: attack.error ? { error: attack.error } : { status: attack.status },
  followUp: followUp.error ? { error: followUp.error } : { status: followUp.status },
})}\n`);
process.exit(ok ? 0 : 2);
