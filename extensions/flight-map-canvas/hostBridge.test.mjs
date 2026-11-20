import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function loadHostBridge() {
  const sandbox = {
    acquireVsCodeApi() {
      return { postMessage() {} };
    },
    window: {
      addEventListener(_type, handler) {
        sandbox.window.handler = handler;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(new URL("./game/hostBridge.js", import.meta.url), "utf8"),
    sandbox,
  );
  return sandbox;
}

function dispatch(sandbox, command, extra) {
  sandbox.window.handler({ data: { command, ...extra } });
}

test("dispatches a registered command and ignores prototype and unknown names", () => {
  const sandbox = loadHostBridge();
  const seen = [];
  sandbox.HostBridge.on("flyTo", (message) => {
    seen.push(message.destination);
  });
  sandbox.HostBridge.on("constructor", "not-a-function");
  sandbox.HostBridge.on(Object.prototype, () => seen.push("bad-name"));

  dispatch(sandbox, "flyTo", { destination: "LHR" });
  dispatch(sandbox, "constructor");
  dispatch(sandbox, "toString");
  dispatch(sandbox, "__proto__");
  dispatch(sandbox, "hasOwnProperty");
  dispatch(sandbox, "valueOf");
  dispatch(sandbox, "unknown");

  assert.deepEqual(seen, ["LHR"]);
});

test("ignores a command name that is not a string", () => {
  const sandbox = loadHostBridge();
  let called = false;
  sandbox.HostBridge.on("jobStatus", () => {
    called = true;
  });
  sandbox.window.handler({ data: { command: { toString() { throw new Error("coerced"); } } } });
  sandbox.window.handler({ data: {} });
  sandbox.window.handler({ data: null });
  assert.equal(called, false);
});
