import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNIFF_HEADER_BYTES } from "./sniff.js";
import { LocalMediaStore, MediaTooLargeError } from "./store.js";

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "media-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalMediaStore.stage", () => {
  it("hashes, sizes, captures the header, and commits retrievable bytes", async () => {
    const store = new LocalMediaStore(root);
    const bytes = Buffer.from("PNG-ish payload for staging");
    const staged = await store.stage(Readable.from([bytes]));

    expect(staged.sizeBytes).toBe(bytes.length);
    expect(staged.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(staged.header.equals(bytes.subarray(0, SNIFF_HEADER_BYTES))).toBe(true);

    await staged.commit("asset-a");
    const object = await store.getStream("asset-a");
    expect(object).not.toBeNull();
    expect((await collect(object!.stream)).equals(bytes)).toBe(true);
  });

  it("captures the header across many small chunks and hashes the whole stream", async () => {
    const store = new LocalMediaStore(root);
    // 4000 bytes fed one byte at a time: header must be assembled across chunk
    // boundaries and the sha256 must cover every byte.
    const total = 4000;
    const full = Buffer.alloc(total);
    for (let i = 0; i < total; i++) full[i] = i % 256;
    const chunks: Buffer[] = [];
    for (let i = 0; i < total; i++) chunks.push(full.subarray(i, i + 1));

    const staged = await store.stage(Readable.from(chunks));

    expect(staged.sizeBytes).toBe(total);
    expect(staged.sha256).toBe(createHash("sha256").update(full).digest("hex"));
    expect(staged.header.length).toBe(SNIFF_HEADER_BYTES);
    expect(staged.header.equals(full.subarray(0, SNIFF_HEADER_BYTES))).toBe(true);
  });

  it("streams a large payload with backpressure and commits it intact", async () => {
    const store = new LocalMediaStore(root);
    // 8 MB across 512 KiB chunks. With proper backpressure the source is paused
    // rather than fully buffered; here we just assert correctness end-to-end.
    const chunk = Buffer.alloc(512 * 1024, 0xab);
    const count = 16;
    const staged = await store.stage(Readable.from(Array.from({ length: count }, () => chunk)));

    expect(staged.sizeBytes).toBe(chunk.length * count);
    const expected = createHash("sha256");
    for (let i = 0; i < count; i++) expected.update(chunk);
    expect(staged.sha256).toBe(expected.digest("hex"));

    await staged.commit("asset-big");
    const object = await store.getStream("asset-big");
    expect(object?.sizeBytes).toBe(chunk.length * count);
  });

  it("aborts and cleans up when the source exceeds maxBytes, leaking no temp file", async () => {
    const store = new LocalMediaStore(root);
    // 300 KiB in 64 KiB chunks against a 128 KiB cap: the cap trips partway.
    const chunk = Buffer.alloc(64 * 1024, 0xcd);
    const source = Readable.from(Array.from({ length: 5 }, () => chunk));

    await expect(store.stage(source, { maxBytes: 128 * 1024 })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );

    // The partially-written temp file was removed by the pipeline teardown.
    const tmpEntries = await readdir(join(root, "tmp")).catch(() => [] as string[]);
    expect(tmpEntries).toEqual([]);
  });

  it("allows a source at exactly maxBytes", async () => {
    const store = new LocalMediaStore(root);
    const bytes = Buffer.alloc(1024, 0xee);
    const staged = await store.stage(Readable.from([bytes]), { maxBytes: 1024 });
    expect(staged.sizeBytes).toBe(1024);
    await staged.discard();
  });

  it("rejects and cleans up the temp file when the source errors mid-stream", async () => {
    const store = new LocalMediaStore(root);
    const boom = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("source exploded"));
      },
    });

    await expect(store.stage(boom)).rejects.toThrow("source exploded");

    // No orphaned temp file left behind.
    const tmpEntries = await readdir(join(root, "tmp")).catch(() => [] as string[]);
    expect(tmpEntries).toEqual([]);
  });

  it("removes the temp file when commit's rename fails", async () => {
    const store = new LocalMediaStore(root);
    const staged = await store.stage(Readable.from([Buffer.from("payload")]));

    // Pre-create the id's final path as a (non-empty) directory so rename onto
    // it fails, standing in for disk-full / permission / cross-device errors.
    const id = "asset-fail";
    const dest = join(root, "objects", id.slice(0, 2), id);
    await mkdir(join(dest, "occupied"), { recursive: true });

    await expect(staged.commit(id)).rejects.toThrow();

    // The staged object is consumed, so discard() is now a no-op — the temp
    // file must have been cleaned up by commit itself, not orphaned under tmp/.
    await staged.discard();
    const tmpEntries = await readdir(join(root, "tmp")).catch(() => [] as string[]);
    expect(tmpEntries).toEqual([]);
  });
});

describe("LocalMediaStore.sweepStaleTmp", () => {
  it("removes stale staging leftovers but keeps fresh in-flight ones", async () => {
    const store = new LocalMediaStore(root);
    const tmpDir = join(root, "tmp");

    // Two staged-but-never-committed temp files (crashed-upload leftovers).
    await store.stage(Readable.from([Buffer.from("old-leftover")]));
    await store.stage(Readable.from([Buffer.from("fresh-inflight")]));

    const entries = await readdir(tmpDir);
    expect(entries.length).toBe(2);

    // Age the first file two hours into the past; leave the second fresh.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(tmpDir, entries[0]!), twoHoursAgo, twoHoursAgo);

    // Sweep files older than one hour.
    const removed = await store.sweepStaleTmp(60 * 60 * 1000);

    expect(removed).toBe(1);
    const survivors = await readdir(tmpDir);
    expect(survivors).toEqual([entries[1]]);
  });

  it("returns 0 when there is no tmp directory yet", async () => {
    const store = new LocalMediaStore(root);
    expect(await store.sweepStaleTmp(60 * 60 * 1000)).toBe(0);
  });
});
