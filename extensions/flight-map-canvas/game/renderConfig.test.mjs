import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./renderConfig.js", import.meta.url), "utf8");

function loadRenderConfig(injectedConfig) {
  const context = {
    HostBridge: {
      getInjectedConfig: () => injectedConfig,
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.RenderConfig.load();
  return context.RenderConfig;
}

test("load ignores prototype-polluting configuration keys", () => {
  const injected = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"map":{"tileSize":64}}',
  );
  const renderConfig = loadRenderConfig(injected);

  assert.equal(renderConfig.get().map.tileSize, 64);
  assert.equal(renderConfig.get().polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test("set rejects prototype-polluting paths", () => {
  const renderConfig = loadRenderConfig({});

  assert.throws(
    () => renderConfig.set("__proto__.polluted", true),
    /Unsafe configuration path/,
  );
  assert.throws(
    () => renderConfig.set("constructor.prototype.polluted", true),
    /Unsafe configuration path/,
  );
  assert.equal({}.polluted, undefined);
});
