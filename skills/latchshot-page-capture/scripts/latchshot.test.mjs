import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');

const storage = new AsyncLocalStorage();

// Names that do not exist in this environment's resolver. Each call returns the
// next address list. `rebind.internal.test` is public on the first lookup and
// link-local after that, so a check that looks the name up again and still
// submits fails. Other names are delegated to the real resolver, including the
// isIP short-circuit in dns.lookup (Node 22.23.4 lib/internal/dns/promises.js).
const SCRIPTED = new Map([
  ['private-name.internal.test', [['169.254.169.254']]],
  ['mixed.internal.test', [['93.184.216.34', '10.0.0.1']]],
  ['rebind.internal.test', [['93.184.216.34'], ['169.254.169.254']]],
  ['ula.internal.test', [['fd12:3456:789a::1']]],
  ['link-local.internal.test', [['fe80::abcd:1']]],
  ['mapped.internal.test', [['::ffff:169.254.169.254']]],
]);

const CAPTURE_URL = 'https://latchshot.fly.dev/v1/render';
const DEMO_URL = 'https://latchshot.fly.dev/api/demo';
const PLACEHOLDER_KEY = 'placeholder';

function normalizeHostname(hostname) {
  let host = String(hostname).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function scriptedAnswers(hostname) {
  const store = storage.getStore();
  if (!store) return null;
  const key = normalizeHostname(hostname);
  const steps = SCRIPTED.get(key);
  if (!steps) return null;
  const seen = (store.resolutions.get(key) ?? 0) + 1;
  store.resolutions.set(key, seen);
  return steps[Math.min(seen, steps.length) - 1];
}

function lookupRequest(options) {
  if (typeof options === 'number') return { all: false, family: options };
  const family = options?.family ?? 0;
  const normalized = family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family;
  return { all: options?.all === true, family: normalized };
}

function filterFamily(addresses, family) {
  if (family !== 4 && family !== 6) return addresses;
  return addresses.filter((address) => isIP(address) === family);
}

function dnsError(code, hostname) {
  const error = new Error(`getaddrinfo ${code} ${hostname}`);
  error.code = code;
  error.syscall = 'getaddrinfo';
  error.hostname = hostname;
  return error;
}

function callbackLookup(real) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    const answers = scriptedAnswers(hostname);
    if (!answers) return real.call(this, hostname, options, callback);
    const request = lookupRequest(options);
    const chosen = filterFamily(answers, request.family);
    if (chosen.length === 0) {
      process.nextTick(callback, dnsError('ENOTFOUND', hostname));
      return {};
    }
    if (request.all) {
      const mapped = chosen.map((address) => ({ address, family: isIP(address) }));
      process.nextTick(callback, null, mapped);
      return {};
    }
    process.nextTick(callback, null, chosen[0], isIP(chosen[0]));
    return {};
  };
}

function promiseLookup(real) {
  return function lookup(hostname, options) {
    const answers = scriptedAnswers(hostname);
    if (!answers) return real.call(this, hostname, options);
    const request = lookupRequest(options);
    if (options && typeof options === 'object' && options.family != null && ![0, 4, 6].includes(options.family)) {
      return real.call(this, hostname, options);
    }
    const chosen = filterFamily(answers, request.family);
    if (chosen.length === 0) return Promise.reject(dnsError('ENOTFOUND', hostname));
    const mapped = chosen.map((address) => ({ address, family: isIP(address) }));
    return Promise.resolve(request.all ? mapped : mapped[0]);
  };
}

function recordsFor(kind, answers) {
  const want = kind === 'AAAA' || kind === 6 ? 6 : kind === 'A' || kind === 4 ? 4 : 0;
  if (want === 0) return answers;
  return answers.filter((address) => isIP(address) === want);
}

function installResolve(target, name, kind, mode) {
  const real = target[name];
  target[name] = function resolve(hostname, options, callback) {
    if (mode === 'callback' && typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    const answers = scriptedAnswers(hostname);
    if (!answers) return real.apply(this, arguments);
    const records = recordsFor(kind, answers);
    const payload = options?.ttl ? records.map((address) => ({ address, ttl: 0 })) : records;
    const error = records.length === 0 ? dnsError('ENODATA', hostname) : null;
    if (mode === 'callback') {
      process.nextTick(callback, error, error ? undefined : payload);
      return undefined;
    }
    return error ? Promise.reject(error) : Promise.resolve(payload);
  };
}

function installResolveType(target, mode) {
  const real = target.resolve;
  target.resolve = function resolve(hostname, rrtype, callback) {
    if (mode === 'callback' && typeof rrtype === 'function') {
      callback = rrtype;
      rrtype = undefined;
    }
    const answers = scriptedAnswers(hostname);
    if (!answers) return real.apply(this, arguments);
    const kind = String(rrtype || 'A').toUpperCase();
    if (kind !== 'A' && kind !== 'AAAA') return real.apply(this, arguments);
    const records = recordsFor(kind, answers);
    const error = records.length === 0 ? dnsError('ENODATA', hostname) : null;
    if (mode === 'callback') {
      process.nextTick(callback, error, error ? undefined : records);
      return undefined;
    }
    return error ? Promise.reject(error) : Promise.resolve(records);
  };
}

dns.lookup = callbackLookup(dns.lookup);
dnsPromises.lookup = promiseLookup(dnsPromises.lookup);
for (const [target, mode] of [[dns, 'callback'], [dnsPromises, 'promise'], [dns.Resolver.prototype, 'callback'], [dnsPromises.Resolver.prototype, 'promise']]) {
  installResolve(target, 'resolve4', 'A', mode);
  installResolve(target, 'resolve6', 'AAAA', mode);
  installResolveType(target, mode);
}

function noteMutation(name, path) {
  const store = storage.getStore();
  if (!store?.record || typeof path !== 'string') return;
  if (path === store.dir || path.startsWith(`${store.dir}/`)) {
    store.mutations.push(`${name} ${path}`);
  }
}

function wrapPath(target, name, pathIndex = 0) {
  const real = target[name];
  if (typeof real !== 'function') return;
  target[name] = function wrapped(...args) {
    noteMutation(name, args[pathIndex]);
    return real.apply(this, args);
  };
}

for (const name of ['mkdir', 'open', 'rm', 'unlink', 'writeFile', 'appendFile', 'copyFile', 'truncate', 'symlink']) {
  wrapPath(fsPromises, name);
  wrapPath(fs, `${name}Sync`);
}
const realRename = fsPromises.rename;
fsPromises.rename = function rename(from, to, ...rest) {
  noteMutation('rename', from);
  noteMutation('rename', to);
  return realRename.call(this, from, to, ...rest);
};
const realRenameSync = fs.renameSync;
fs.renameSync = function renameSync(from, to) {
  noteMutation('renameSync', from);
  noteMutation('renameSync', to);
  return realRenameSync.call(this, from, to);
};

const realFetch = globalThis.fetch;
globalThis.fetch = function fetch(url, init) {
  const store = storage.getStore();
  if (store?.fetchImpl) return store.fetchImpl(url, init);
  return realFetch.call(this, url, init);
};

const { run } = await import('./latchshot.mjs');

function artifact(format) {
  if (format === 'png') return Buffer.from('89504e470d0a1a0a', 'hex');
  if (format === 'pdf') return Buffer.from('%PDF-1.7\n');
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

function contentType(format) {
  if (format === 'png') return 'image/png';
  if (format === 'pdf') return 'application/pdf';
  return 'image/jpeg';
}

function summarize(requests) {
  return requests.map((request) => {
    let url = request.body;
    try {
      url = JSON.parse(request.body).url;
    } catch {
      // Keep the raw body when it is not the JSON payload.
    }
    return { endpoint: String(request.endpoint), method: request.method, url };
  });
}

async function exercise({ command, url, allowQuery = false, format, env }) {
  const dir = await mkdtemp(join(tmpdir(), 'latchshot-private-url-'));
  const outputFormat = command === 'demo' ? 'jpeg' : format ?? 'png';
  const extension = outputFormat === 'jpeg' ? '.jpg' : outputFormat === 'pdf' ? '.pdf' : '.png';
  const output = join(dir, `page${extension}`);
  const requests = [];
  const mutations = [];
  const resolutions = new Map();
  const fetchImpl = async (endpoint, init) => {
    requests.push({
      endpoint,
      method: init?.method,
      body: init?.body,
    });
    return new Response(artifact(outputFormat), {
      status: 200,
      headers: { 'content-type': contentType(outputFormat) },
    });
  };
  const store = { dir, record: true, requests, mutations, resolutions, fetchImpl };
  const argv = [command, '--url', url, '--output', output];
  if (allowQuery) argv.push('--allow-query');
  let code = 0;
  let stderr = '';
  try {
    code = await storage.run(store, () => run(argv, {
      env,
      fetchImpl,
      stdout: () => {},
      stderr: (line) => {
        stderr += line;
      },
    }));
  } finally {
    store.record = false;
  }
  const entries = await readdir(dir);
  await rm(dir, { recursive: true, force: true });
  return { code, stderr, requests, mutations, entries, output };
}

const blocked = [
  { url: 'http://127.0.0.1/' },
  { url: 'https://127.0.0.1/' },
  { url: 'http://127.0.0.1:443/' },
  { url: 'https://127.0.0.1:80/' },
  { url: 'http://127.0.0.0/' },
  { url: 'http://127.255.255.255/' },
  { url: 'http://2130706433/' },
  { url: 'http://0x7f000001/' },
  { url: 'http://0177.0.0.1/' },
  { url: 'http://127.1/' },
  { url: 'http://169.254.169.254/' },
  { url: 'https://169.254.169.254/' },
  { url: 'http://169.254.169.254/latest/meta-data/' },
  { url: 'http://169.254.169.254:443/' },
  { url: 'http://169.254.169.254.' },
  { url: 'http://2852039166/' },
  { url: 'http://0xa9fea9fe/' },
  { url: 'http://0251.0376.0251.0376/' },
  { url: 'http://10.0.0.1/' },
  { url: 'http://10.255.255.255/' },
  { url: 'http://167772161/' },
  { url: 'http://192.168.0.1/' },
  { url: 'http://192.168.255.255/' },
  { url: 'http://3232235521/' },
  { url: 'http://172.16.0.1/' },
  { url: 'http://172.31.255.255/' },
  { url: 'http://2886729729/' },
  { url: 'http://[::1]/' },
  { url: 'https://[::1]/' },
  { url: 'http://[::1]:443/' },
  { url: 'http://[0:0:0:0:0:0:0:1]/' },
  { url: 'http://[fe80::]/' },
  { url: 'http://[febf::1]/' },
  { url: 'http://[fc00::]/' },
  { url: 'http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/' },
  { url: 'http://[::ffff:127.0.0.1]/' },
  { url: 'http://[::ffff:169.254.169.254]/' },
  { url: 'http://[::ffff:10.0.0.1]/' },
  { url: 'http://[::ffff:192.168.0.1]/' },
  { url: 'http://[::ffff:172.16.0.1]/' },
  { url: 'http://[::ffff:a9fe:a9fe]/' },
  { url: 'http://localhost/' },
  { url: 'http://localhost./' },
  { url: 'http://LOCALHOST/admin' },
  { url: 'http://private-name.internal.test/' },
  { url: 'http://private-name.internal.test./' },
  { url: 'http://mixed.internal.test/' },
  { url: 'http://rebind.internal.test/' },
  { url: 'http://ula.internal.test/' },
  { url: 'http://link-local.internal.test/' },
  { url: 'http://mapped.internal.test/' },
  { url: 'http://10.1.2.3/latest/meta-data?page=1', allowQuery: true },
  { url: 'http://169.254.169.254/latest/meta-data/', format: 'pdf' },
];

const allowed = [
  { url: 'https://example.com/' },
  { url: 'https://example.com/docs' },
  { url: 'https://example.com/?page=1', allowQuery: true },
  { url: 'http://8.8.8.8/' },
  { url: 'http://[::ffff:8.8.8.8]/' },
  { url: 'https://172.15.255.255/' },
  { url: 'https://172.32.0.1/' },
  { url: 'http://11.0.0.1/' },
  { url: 'http://192.169.1.1/' },
  { url: 'http://1.2.3.4/' },
];

function envFor(command) {
  return command === 'capture' ? { LATCHSHOT_API_KEY: PLACEHOLDER_KEY } : {};
}

for (const command of ['capture', 'demo']) {
  for (const target of blocked) {
    if (target.format === 'pdf' && command === 'demo') continue;
    const label = [target.url, target.allowQuery ? '--allow-query' : '', target.format ? `format=${target.format}` : '']
      .filter(Boolean)
      .join(' ');
    test(`${command} refuses ${label} before any request or file write`, async () => {
      const result = await exercise({
        command,
        url: target.url,
        allowQuery: target.allowQuery,
        format: target.format,
        env: envFor(command),
      });
      assert.deepEqual(summarize(result.requests), [], result.stderr);
      assert.deepEqual(result.mutations, []);
      assert.deepEqual(result.entries, []);
      assert.notEqual(result.code, 0);
    });
  }

  for (const target of allowed) {
    test(`${command} still submits public ${target.url}`, async () => {
      const result = await exercise({
        command,
        url: target.url,
        allowQuery: target.allowQuery,
        env: envFor(command),
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(summarize(result.requests), [{
        endpoint: command === 'capture' ? CAPTURE_URL : DEMO_URL,
        method: 'POST',
        url: new URL(target.url).href,
      }]);
      assert.equal(result.entries.length, 1);
    });
  }
}

test('capture refuses a private target when the query was explicitly allowed', async () => {
  const result = await exercise({
    command: 'capture',
    url: 'http://192.168.1.20/admin?page=1',
    allowQuery: true,
    env: envFor('capture'),
  });
  assert.deepEqual(summarize(result.requests), []);
  assert.deepEqual(result.mutations, []);
  assert.notEqual(result.code, 0);
});

test('demo refuses a private target with no API key in the environment', async () => {
  const result = await exercise({
    command: 'demo',
    url: 'http://169.254.169.254/latest/meta-data/',
    env: {},
  });
  assert.deepEqual(summarize(result.requests), [], result.stderr);
  assert.deepEqual(result.mutations, []);
  assert.notEqual(result.code, 0);
});

test('a public query is still rejected until --allow-query is passed', async () => {
  const result = await exercise({
    command: 'demo',
    url: 'https://example.com/?page=1',
    env: {},
  });
  assert.deepEqual(summarize(result.requests), []);
  assert.notEqual(result.code, 0);
});

test('scripted rebinding lookup is public once, then link-local', async () => {
  const resolutions = new Map();
  const seen = await storage.run({ resolutions }, async () => {
    const first = await dnsPromises.lookup('rebind.internal.test', { all: true });
    const second = await dnsPromises.lookup('rebind.internal.test', { all: true });
    return [first, second];
  });
  assert.deepEqual(seen[0], [{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(seen[1], [{ address: '169.254.169.254', family: 4 }]);
});

test('localhost still resolves to loopback through the real resolver', async () => {
  const addresses = await dnsPromises.lookup('localhost', { all: true });
  assert.ok(addresses.some((entry) => entry.address === '127.0.0.1' || entry.address === '::1'));
});
