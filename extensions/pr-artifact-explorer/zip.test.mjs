import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { analyzeArtifact } from "./detector.mjs";
import { readEntryPrefix, readZipEntry, readZipIndex } from "./zip.mjs";

const PREFIX_BYTES = 8 * 1024;
const OVERSIZED_MEMBER_BYTES = 256 * 1024 * 1024;
const ALLOCATION_BUDGET_BYTES = 1024 * 1024;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Writes a single-entry ZIP. `padding` extends the member's compressed data
// with a sparse hole so the declared compressed size can be large without
// costing real disk space.
async function writeZip(t, { name, content, method = 8, padding = 0, uncompressedSize }) {
  const dir = await mkdtemp(join(tmpdir(), "pr-artifact-zip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = join(dir, "artifact.zip");
  const payload = method === 8 ? deflateRawSync(content) : content;
  const nameBytes = Buffer.from(name, "utf8");
  const compressedSize = payload.length + padding;
  const declaredSize = uncompressedSize ?? content.length;
  const checksum = crc32(content);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const centralRecord = Buffer.concat([central, nameBytes]);

  const centralOffset = local.length + nameBytes.length + compressedSize;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  const handle = await open(zipPath, "w");
  try {
    const head = Buffer.concat([local, nameBytes, payload]);
    await handle.write(head, 0, head.length, 0);
    const tail = Buffer.concat([centralRecord, eocd]);
    await handle.write(tail, 0, tail.length, centralOffset);
  } finally {
    await handle.close();
  }
  return zipPath;
}

async function largestAllocationDuring(operation) {
  const originals = {
    alloc: Buffer.alloc,
    allocUnsafe: Buffer.allocUnsafe,
    allocUnsafeSlow: Buffer.allocUnsafeSlow,
  };
  let largest = 0;
  for (const [key, original] of Object.entries(originals)) {
    Buffer[key] = function (size, ...rest) {
      if (typeof size === "number" && size > largest) largest = size;
      return original.call(this, size, ...rest);
    };
  }
  let outcome;
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  } finally {
    Object.assign(Buffer, originals);
  }
  return { ...outcome, largest };
}

function castContent() {
  const header = JSON.stringify({ version: 2, width: 80, height: 24 });
  return Buffer.from(`${header}\n[0.1, "o", "hello"]\n`, "utf8");
}

test("indexing a recording-named deflate entry does not buffer its whole compressed member", async (t) => {
  const zipPath = await writeZip(t, {
    name: "session.log",
    content: castContent(),
    padding: OVERSIZED_MEMBER_BYTES,
  });
  const index = await readZipIndex(zipPath);
  const [entry] = index.entries;
  assert.ok(entry.uncompressedSize <= 8 * 1024 * 1024);
  assert.ok(entry.compressedSize > OVERSIZED_MEMBER_BYTES);

  const { value, error, largest } = await largestAllocationDuring(() =>
    analyzeArtifact(index, (candidate) => readEntryPrefix(zipPath, candidate, PREFIX_BYTES)),
  );
  assert.ifError(error);
  assert.ok(
    largest <= ALLOCATION_BUDGET_BYTES,
    `prefix probe allocated ${largest.toLocaleString()} bytes`,
  );
  assert.equal(value.primary?.kind, "asciinema");
});

test("inline previews do not buffer an oversized deflate member", async (t) => {
  const content = Buffer.from("preview text\n");
  const zipPath = await writeZip(t, {
    name: "notes.txt",
    content,
    padding: OVERSIZED_MEMBER_BYTES,
  });
  const [entry] = (await readZipIndex(zipPath)).entries;

  const { value, error, largest } = await largestAllocationDuring(() =>
    readZipEntry(zipPath, entry, 4 * 1024 * 1024),
  );
  assert.ok(
    largest <= ALLOCATION_BUDGET_BYTES,
    `inline preview allocated ${largest.toLocaleString()} bytes`,
  );
  assert.ifError(error);
  assert.deepEqual(value, content);
});

test("inline previews reject stored members whose sizes disagree before reading them", async (t) => {
  const zipPath = await writeZip(t, {
    name: "notes.txt",
    content: Buffer.from("x"),
    method: 0,
    padding: OVERSIZED_MEMBER_BYTES,
    uncompressedSize: 1,
  });
  const [entry] = (await readZipIndex(zipPath)).entries;

  const { error, largest } = await largestAllocationDuring(() =>
    readZipEntry(zipPath, entry, 4 * 1024 * 1024),
  );
  assert.match(String(error?.message), /size check failed/);
  assert.ok(
    largest <= ALLOCATION_BUDGET_BYTES,
    `stored preview allocated ${largest.toLocaleString()} bytes`,
  );
});

test("inline previews round-trip deflate and stored entries", async (t) => {
  const content = Buffer.from("line of text\n".repeat(5_000));
  for (const method of [0, 8]) {
    const zipPath = await writeZip(t, { name: "log.txt", content, method });
    const [entry] = (await readZipIndex(zipPath)).entries;
    assert.deepEqual(await readZipEntry(zipPath, entry, 4 * 1024 * 1024), content);
  }
});

test("inline previews reject deflate data that inflates past the declared size", async (t) => {
  const content = Buffer.from("a".repeat(10_000));
  const zipPath = await writeZip(t, { name: "log.txt", content, uncompressedSize: 100 });
  const [entry] = (await readZipIndex(zipPath)).entries;
  await assert.rejects(
    readZipEntry(zipPath, entry, 4 * 1024 * 1024),
    /decompressed past declared size/,
  );
});

test("inline previews reject entries with a corrupted checksum", async (t) => {
  const zipPath = await writeZip(t, { name: "log.txt", content: Buffer.from("hello") });
  const [entry] = (await readZipIndex(zipPath)).entries;
  await assert.rejects(
    readZipEntry(zipPath, { ...entry, crc32: (entry.crc32 ^ 1) >>> 0 }, 1024),
    /checksum failed/,
  );
});

test("entry prefixes stop at the requested length for deflate and stored entries", async (t) => {
  const content = Buffer.from("0123456789".repeat(5_000));
  for (const method of [0, 8]) {
    const zipPath = await writeZip(t, { name: "session.cast", content, method });
    const [entry] = (await readZipIndex(zipPath)).entries;
    assert.deepEqual(await readEntryPrefix(zipPath, entry, PREFIX_BYTES), content.subarray(0, PREFIX_BYTES));
    assert.deepEqual(await readEntryPrefix(zipPath, entry, content.length * 2), content);
  }
});
