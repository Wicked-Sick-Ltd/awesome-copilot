// Stand-in for the Copilot CLI process the SDK spawns.
// Speaks the Content-Length JSON-RPC framing the SDK 1.0.34 client uses
// (vscode-jsonrpc / copilot._jsonrpc) and records the session the recipe
// actually creates. Permission decisions are whatever the real SDK handler
// sends back; this process does not decide them.

import fs from "node:fs";

const logPath = process.env.FAKE_RUNTIME_LOG;
const markerPath = process.env.FAKE_RUNTIME_MARKER;
const authorizedUrl = process.env.FAKE_RUNTIME_AUTHORIZED_URL ?? "";
const intruderUrl = "http://127.0.0.1/secret";

fs.writeFileSync(markerPath, "started\n");
function record(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  process.stdout.write(header);
  process.stdout.write(body);
}

let buffer = Buffer.alloc(0);
let sessionId = "";
let permissionsStarted = false;
let permissionIndex = 0;
let waitingRequestId = "";
let permissionTimer = null;

function permissionRequests() {
  return [
    {
      requestId: "perm-navigate-authorized",
      permissionRequest: {
        kind: "mcp",
        readOnly: false,
        serverName: "playwright",
        toolName: "browser_navigate",
        toolTitle: "Navigate to a URL",
        args: { url: authorizedUrl },
      },
    },
    {
      requestId: "perm-navigate-loopback",
      permissionRequest: {
        kind: "mcp",
        readOnly: false,
        serverName: "playwright",
        toolName: "browser_navigate",
        toolTitle: "Navigate to a URL",
        args: { url: intruderUrl },
      },
    },
    {
      requestId: "perm-shell",
      permissionRequest: {
        kind: "shell",
        canOfferSessionApproval: false,
        commands: [{ identifier: "cat", readOnly: true }],
        fullCommandText: "cat /etc/passwd",
        hasWriteFileRedirection: false,
        intention: "read a local file",
        possiblePaths: ["/etc/passwd"],
        possibleUrls: [],
      },
    },
    {
      requestId: "perm-read",
      permissionRequest: {
        kind: "read",
        path: "/etc/passwd",
        intention: "read a local file",
      },
    },
    {
      requestId: "perm-unsafe-tool",
      permissionRequest: {
        kind: "mcp",
        readOnly: false,
        serverName: "playwright",
        toolName: "browser_run_code_unsafe",
        toolTitle: "Run Playwright code",
        args: { code: "async (page) => page.content()" },
      },
    },
  ];
}

function emitIdle() {
  writeMessage({
    jsonrpc: "2.0",
    method: "session.event",
    params: {
      sessionId,
      event: { type: "session.idle", data: {} },
    },
  });
}

function emitNextPermission() {
  if (permissionTimer) {
    clearTimeout(permissionTimer);
    permissionTimer = null;
  }
  const requests = permissionRequests();
  if (permissionIndex >= requests.length) {
    waitingRequestId = "";
    emitIdle();
    return;
  }
  const item = requests[permissionIndex];
  waitingRequestId = item.requestId;
  writeMessage({
    jsonrpc: "2.0",
    method: "session.event",
    params: {
      sessionId,
      event: { type: "permission.requested", data: item },
    },
  });
  permissionTimer = setTimeout(() => {
    if (waitingRequestId !== item.requestId) {
      return;
    }
    record({
      method: "session.permissions.handlePendingPermissionRequest",
      params: {
        requestId: item.requestId,
        result: { kind: "no-decision" },
      },
    });
    permissionIndex += 1;
    emitNextPermission();
  }, 3000);
}

function reply(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function handle(message) {
  if (message.id === undefined || message.method === undefined) {
    record({ notification: message.method ?? null });
    return;
  }
  const params = message.params ?? {};
  record({ method: message.method, params });

  if (message.method === "connect" || message.method === "ping") {
    reply(message.id, { protocolVersion: 3 });
    return;
  }
  if (message.method === "session.create") {
    sessionId = params.sessionId;
    reply(message.id, {
      sessionId,
      workspacePath: process.cwd(),
      capabilities: {},
    });
    return;
  }
  if (message.method === "session.send") {
    reply(message.id, { messageId: `msg-${permissionIndex}` });
    if (!permissionsStarted) {
      permissionsStarted = true;
      permissionIndex = 0;
      emitNextPermission();
    } else {
      emitIdle();
    }
    return;
  }
  if (message.method === "session.permissions.handlePendingPermissionRequest") {
    reply(message.id, {});
    if (params.requestId === waitingRequestId) {
      permissionIndex += 1;
      emitNextPermission();
    }
    return;
  }
  if (message.method === "session.detach") {
    reply(message.id, { success: true });
    return;
  }
  reply(message.id, {});
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      record({ error: "missing Content-Length", header });
      process.exit(1);
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) {
      return;
    }
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
