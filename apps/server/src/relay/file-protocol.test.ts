import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FILE_ERROR_CODES,
  FILE_OPS,
  FILE_WIRE_REASONS,
  fileCancelFrameSchema,
  fileOpFrameSchema,
  fileOpResultSchema,
  fileRejectDetailSchema,
  fileRejectedFrameSchema,
  fileSpawnSpecSchema,
  supervisedFileRejectReasonSchema,
} from "./file-protocol.js";
import {
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  type RelayServerControlMessage,
} from "./protocol.js";

const FIXTURE_DIR = new URL("../../../cli/tests/fixtures/relay-2.8/", import.meta.url);

function vector(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as Record<
    string,
    unknown
  >;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const OP_ID = "AAECAwQFBgcICQoLDA0ODw";

describe("relay 2.8 file frames: server to CLI", () => {
  it.each(FILE_OPS)(
    "file.op %s: the schema accepts the vector and the server encodes it identically",
    (op) => {
      const frame = vector(`file-op-${op}`);
      expect(fileOpFrameSchema.parse(frame)).toEqual(frame);
      const message = frame as unknown as RelayServerControlMessage;
      expect(JSON.parse(encodeRelayServerControlMessage(message))).toEqual(frame);
    },
  );

  it("encodes file.cancel", () => {
    const frame = vector("file-cancel");
    expect(fileCancelFrameSchema.parse(frame)).toEqual(frame);
    expect(JSON.parse(encodeRelayServerControlMessage(frame as never))).toEqual(frame);
  });

  it("rejects extra fields at every level of file.op", () => {
    for (const op of FILE_OPS) {
      const base = vector(`file-op-${op}`);
      const topLevel = { ...clone(base), extra: 1 };
      expect(() => fileOpFrameSchema.parse(topLevel), `${op} top`).toThrow();
      const args = clone(base) as { args: Record<string, unknown> };
      args.args.extra = 1;
      expect(() => fileOpFrameSchema.parse(args), `${op} args`).toThrow();
    }
    const edit = clone(vector("file-op-edit")) as {
      args: { edits: Array<Record<string, unknown>> };
    };
    edit.args.edits[0] = { ...edit.args.edits[0], extra: true };
    expect(() => fileOpFrameSchema.parse(edit)).toThrow();
  });

  it("rejects missing required fields", () => {
    const required: Record<string, string[]> = {
      read: ["path"],
      stat: ["paths"],
      list: ["path"],
      search: ["root", "pattern"],
      edit: ["path", "edits"],
      write: ["path"],
      rename: ["from", "to"],
      mkdir: ["path"],
      delete: ["path"],
    };
    for (const [op, fields] of Object.entries(required)) {
      for (const field of fields) {
        const frame = clone(vector(`file-op-${op}`)) as { args: Record<string, unknown> };
        delete frame.args[field];
        expect(() => fileOpFrameSchema.parse(frame), `${op}.${field}`).toThrow();
      }
      const noId = clone(vector(`file-op-${op}`));
      delete noId.opId;
      expect(() => fileOpFrameSchema.parse(noId), `${op} opId`).toThrow();
    }
  });

  it("carries write content out of band: no content in args, bodyBytes required, 1 MiB cap", () => {
    const write = clone(vector("file-op-write")) as {
      args: Record<string, unknown>;
      bodyBytes?: number;
    };
    expect(write.bodyBytes).toBe(812);
    expect(() =>
      fileOpFrameSchema.parse({ ...write, args: { ...write.args, content: "x" } }),
    ).toThrow();
    const noBody = { ...write };
    delete noBody.bodyBytes;
    expect(() => fileOpFrameSchema.parse(noBody)).toThrow();
    expect(() => fileOpFrameSchema.parse({ ...write, bodyBytes: 1024 * 1024 + 1 })).toThrow();
    expect(fileOpFrameSchema.parse({ ...write, bodyBytes: 0 })).toMatchObject({ bodyBytes: 0 });
    // Only a write carries bodyBytes.
    expect(() => fileOpFrameSchema.parse({ ...vector("file-op-read"), bodyBytes: 1 })).toThrow();
  });

  it("rejects out-of-range and malformed argument values", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["read", { path: "" }],
      ["read", { path: "a\0b" }],
      ["read", { path: "x".repeat(4097) }],
      ["read", { path: "~/a", maxLines: 2001 }],
      ["read", { path: "~/a", maxBytes: 131073 }],
      ["read", { path: "~/a", startLine: 1.5 }],
      ["stat", { paths: [] }],
      ["stat", { paths: Array.from({ length: 51 }, () => "~/a") }],
      ["list", { path: "~/a", depth: 5 }],
      ["list", { path: "~/a", maxEntries: 2001 }],
      ["search", { root: "~/a", pattern: "" }],
      ["search", { root: "~/a", pattern: "x", mode: "glob" }],
      ["search", { root: "~/a", pattern: "x", contextLines: 4 }],
      ["edit", { path: "~/a", edits: [] }],
      [
        "edit",
        { path: "~/a", edits: Array.from({ length: 21 }, () => ({ newText: "x", oldText: "y" })) },
      ],
      ["edit", { path: "~/a", reason: "r".repeat(501), edits: [{ oldText: "a", newText: "b" }] }],
      ["write", { path: "~/a", mode: "u+x" }],
      ["write", { path: "~/a", ifExists: "append" }],
      ["mkdir", { path: "~/a", mode: "9999" }],
      ["delete", { path: "~/a", expectedEtag: "" }],
    ];
    for (const [op, args] of bad) {
      const frame: Record<string, unknown> = {
        type: "file.op",
        mode: "unsupervised",
        readGrant: false,
        opId: OP_ID,
        op,
        args,
      };
      if (op === "write") frame.bodyBytes = 1;
      expect(
        () => fileOpFrameSchema.parse(frame),
        `${op} ${JSON.stringify(args).slice(0, 40)}`,
      ).toThrow();
    }
    expect(() => fileOpFrameSchema.parse({ ...vector("file-op-read"), opId: "short" })).toThrow();
    expect(() => fileOpFrameSchema.parse({ ...vector("file-op-read"), op: "chmod" })).toThrow();
  });

  it("frames the binary file.body metadata like the other binary frames", () => {
    const metadata = vector("file-body-metadata") as { type: "file.body"; opId: string };
    const body = new TextEncoder().encode("hello");
    const frame = encodeRelayBinaryFrame(metadata, body);
    const parsed = parseRelayBinaryFrame(frame);
    expect(parsed.metadata).toEqual(metadata);
    expect(Buffer.from(parsed.body).toString()).toBe("hello");
    expect(() => encodeRelayBinaryFrame(metadata, new Uint8Array(1024 * 1024 + 1))).toThrow(
      "Binary body chunk exceeds 1 MiB.",
    );
    expect(() => encodeRelayBinaryFrame({ ...metadata, extra: 1 } as never, body)).not.toThrow();
    expect(() =>
      parseRelayBinaryFrame(encodeRelayBinaryFrame({ ...metadata, extra: 1 } as never, body)),
    ).toThrow();
  });
});

describe("relay 2.8 file frames: CLI to server", () => {
  const RESULT_OPS = FILE_OPS;

  it.each(RESULT_OPS)("file.result %s: accepted as encoded by the CLI", (op) => {
    const frame = vector(`file-result-${op}`);
    expect(parseRelayClientControlFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it("accepts the unchanged read result and the spilled read result", () => {
    for (const name of ["file-result-read-unchanged", "file-result-read-spilled"]) {
      const frame = vector(name);
      expect(parseRelayClientControlFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });

  it("accepts the file.rejected vectors", () => {
    for (const name of [
      "file-rejected-conflict",
      "file-rejected-bad-frame",
      "file-rejected-match-count",
      "file-rejected-grant-disabled",
    ]) {
      const frame = vector(name);
      expect(parseRelayClientControlFrame(JSON.stringify(frame))).toEqual(frame);
    }
  });

  it("accepts every reason the CLI dispatcher can emit, and nothing else", () => {
    // Both sets are compared with the Rust source itself (parsed, not copied) in
    // src/mcp/file-error-parity.test.ts.
    for (const reason of [...FILE_ERROR_CODES, ...FILE_WIRE_REASONS]) {
      // `uncertain_outcome` is only valid with its recovery facts (pinned below)
      const detail =
        reason === "uncertain_outcome"
          ? {
              recovery: "/w/.wsmp-recover-a1b2c3d4e5",
              kept: ["/w/.wsmp-recover-a1b2c3d4e5/slot-1"],
            }
          : undefined;
      const frame = { type: "file.rejected", opId: OP_ID, reason, ...(detail ? { detail } : {}) };
      expect(parseRelayClientControlFrame(JSON.stringify(frame)), reason).toEqual(frame);
    }
    for (const reason of ["explode", "grantDisabled", "feature_disabled ", "GRANT_DISABLED"]) {
      expect(
        fileRejectedFrameSchema.safeParse({ type: "file.rejected", opId: OP_ID, reason }).success,
        reason,
      ).toBe(false);
    }
  });

  it("rejects extra and missing fields in every file.result", () => {
    for (const op of RESULT_OPS) {
      const frame = vector(`file-result-${op}`) as { result: Record<string, unknown> };
      const extraResult = clone(frame);
      extraResult.result.leak = "x";
      expect(
        () => parseRelayClientControlFrame(JSON.stringify(extraResult)),
        `${op} extra result field`,
      ).toThrow();
      expect(
        () => parseRelayClientControlFrame(JSON.stringify({ ...frame, extra: 1 })),
        `${op} extra`,
      ).toThrow();
      const noResult = clone(frame) as Record<string, unknown>;
      delete noResult.result;
      expect(
        () => parseRelayClientControlFrame(JSON.stringify(noResult)),
        `${op} result`,
      ).toThrow();
      const noOp = clone(frame) as Record<string, unknown>;
      delete noOp.op;
      expect(() => parseRelayClientControlFrame(JSON.stringify(noOp)), `${op} op`).toThrow();
    }
    // A required result field missing, per op.
    const required: Record<string, string> = {
      list: "count",
      search: "scannedFiles",
      edit: "previousEtag",
      write: "created",
      mkdir: "created",
      delete: "type",
      stat: "entries",
      rename: "etag",
    };
    for (const [op, field] of Object.entries(required)) {
      const frame = clone(vector(`file-result-${op}`)) as { result: Record<string, unknown> };
      delete frame.result[field];
      expect(() => parseRelayClientControlFrame(JSON.stringify(frame)), `${op}.${field}`).toThrow();
    }
    const read = clone(vector("file-result-read")) as { result: Record<string, unknown> };
    delete read.result.redactions;
    expect(() => parseRelayClientControlFrame(JSON.stringify(read))).toThrow();
  });

  it("holds the op and the result to each other", () => {
    const frame = clone(vector("file-result-mkdir")) as { op: string };
    frame.op = "delete";
    expect(() => parseRelayClientControlFrame(JSON.stringify(frame))).toThrow();
  });

  it("caps inline text at 48 KiB and ties dataField to bodyBytes and the op", () => {
    const list = clone(vector("file-result-list")) as { result: { entries: string } };
    list.result.entries = "x".repeat(48 * 1024);
    expect(() => parseRelayClientControlFrame(JSON.stringify(list))).not.toThrow();
    // The 64 KiB control frame cap also applies; a 48 KiB + 1 field is refused by the text cap.
    list.result.entries = "x".repeat(48 * 1024 + 1);
    expect(() => parseRelayClientControlFrame(JSON.stringify(list))).toThrow();
    const multibyte = clone(vector("file-result-list")) as { result: { entries: string } };
    multibyte.result.entries = "é".repeat(24 * 1024 + 1);
    expect(() => parseRelayClientControlFrame(JSON.stringify(multibyte))).toThrow();

    const spilled = clone(vector("file-result-read-spilled")) as Record<string, unknown>;
    expect(() =>
      parseRelayClientControlFrame(JSON.stringify({ ...spilled, dataField: "diff" })),
    ).toThrow();
    const noField = { ...spilled };
    delete noField.dataField;
    expect(() => parseRelayClientControlFrame(JSON.stringify(noField))).toThrow();
    const noBytes = { ...spilled };
    delete noBytes.bodyBytes;
    expect(() => parseRelayClientControlFrame(JSON.stringify(noBytes))).toThrow();
    const stat = clone(vector("file-result-stat")) as Record<string, unknown>;
    expect(() =>
      parseRelayClientControlFrame(JSON.stringify({ ...stat, dataField: "text", bodyBytes: 10 })),
    ).toThrow();
  });

  it("refuses unknown rejection reasons, extra detail keys and missing fields", () => {
    const rejected = vector("file-rejected-conflict") as { detail: Record<string, unknown> };
    expect(() =>
      parseRelayClientControlFrame(JSON.stringify({ ...rejected, reason: "explode" })),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(JSON.stringify({ ...rejected, detail: { leak: "x" } })),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(JSON.stringify({ ...rejected, extra: true })),
    ).toThrow();
    const noReason = clone(rejected) as Record<string, unknown>;
    delete noReason.reason;
    expect(() => parseRelayClientControlFrame(JSON.stringify(noReason))).toThrow();
    const noId = clone(rejected) as Record<string, unknown>;
    delete noId.opId;
    expect(() => parseRelayClientControlFrame(JSON.stringify(noId))).toThrow();
  });

  it("accepts only library-shaped etags in results and rejection details", () => {
    const base = clone(vector("file-result-edit")) as { result: Record<string, unknown> };
    for (const bad of [
      "h:short",
      "x:AAAAAAAAAAAAAAAAAAAAAA",
      "wsmp_cli_secretsecretsecretsecret",
      "h:AAAAAAAAAAAAAAAAAAAAA!",
    ]) {
      const frame = clone(base);
      frame.result.etag = bad;
      expect(() => parseRelayClientControlFrame(JSON.stringify(frame)), bad).toThrow();
      const rejected = { ...clone(vector("file-rejected-conflict")), detail: { currentEtag: bad } };
      expect(() => parseRelayClientControlFrame(JSON.stringify(rejected)), bad).toThrow();
    }
    const weak = clone(base);
    weak.result.etag = "w:AAAAAAAAAAAAAAAAAAAAAA";
    expect(() => parseRelayClientControlFrame(JSON.stringify(weak))).not.toThrow();
  });

  it("frames file.data metadata", () => {
    const metadata = vector("file-data-metadata") as { type: "file.data"; opId: string };
    const frame = encodeRelayBinaryFrame(metadata, new Uint8Array(70_000));
    const parsed = parseRelayBinaryFrame(frame);
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.body.byteLength).toBe(70_000);
  });
});

describe("relay 2.8 supervised-file strict schema", () => {
  it.each(FILE_ERROR_CODES)("accepts the shared file error code %s after a keypress", (code) => {
    const frame = { type: "supervised.done", commandId: OP_ID, review: false, fileError: { code } };
    expect(parseRelayClientControlFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it.each(["replaced", "gone"])(
    "keeps %s as a conflict detail, outside the error-code set",
    (currentEtag) => {
      const frame = {
        type: "file.rejected",
        opId: OP_ID,
        reason: "conflict",
        detail: { currentEtag },
      };
      expect(parseRelayClientControlFrame(JSON.stringify(frame))).toEqual(frame);
      expect(() =>
        parseRelayClientControlFrame(JSON.stringify({ ...frame, reason: currentEtag })),
      ).toThrow();
      expect(() =>
        parseRelayClientControlFrame(
          JSON.stringify({
            type: "supervised.done",
            commandId: OP_ID,
            review: false,
            fileError: { code: currentEtag },
          }),
        ),
      ).toThrow();
    },
  );

  it("accepts the file term.spawn payload and supervised.done fileResult vectors", () => {
    const spawn = vector("file-term-spawn") as {
      fileOp: unknown;
      kind: string;
    };
    expect(spawn.kind).toBe("file");
    expect(fileSpawnSpecSchema.parse(spawn.fileOp)).toEqual(spawn.fileOp);
    expect(JSON.parse(encodeRelayServerControlMessage(spawn as never))).toEqual(spawn);
    const done = vector("file-supervised-done");
    expect(parseRelayClientControlFrame(JSON.stringify(done))).toEqual(done);
    const badDone = { ...done, fileResult: { op: "mkdir", result: { created: true, leak: 1 } } };
    expect(() => parseRelayClientControlFrame(JSON.stringify(badDone))).toThrow();
    expect(() => fileSpawnSpecSchema.parse({ op: "edit", args: { path: "~/a" } })).toThrow();
  });

  const fixtures = readdirSync(FIXTURE_DIR).filter(
    (name) =>
      (name.startsWith("file-term-spawn-") || name.startsWith("file-supervised-done-")) &&
      name.endsWith(".json"),
  );
  it.each(fixtures)("strict cross-language fixture %s", (name) => {
    const frame = vector(name.slice(0, -5));
    const parse = () =>
      name.startsWith("file-term-spawn-")
        ? JSON.parse(encodeRelayServerControlMessage(frame as never))
        : parseRelayClientControlFrame(JSON.stringify(frame));
    if (name.includes("-reject-")) expect(parse).toThrow();
    else expect(parse()).toEqual(frame);
  });

  it.each([
    { kind: "forged", fileOp: undefined },
    { kind: "command", fileOp: { op: "mkdir", args: { path: "~/a" } } },
    { kind: "file", bodyBytes: 1 },
    { kind: "file", cwd: "/tmp" },
    { kind: "file", diff: "forged" },
  ])("refuses forged/inconsistent spawn fields %j", (extra) => {
    expect(() =>
      encodeRelayServerControlMessage({ ...vector("file-term-spawn"), ...extra } as never),
    ).toThrow();
  });

  it.each(["edit", "write", "rename", "mkdir", "delete"])(
    "rejects extra fields at every supervised %s level",
    (op) => {
      const spawn =
        op === "edit"
          ? vector("file-term-spawn")
          : op === "mkdir"
            ? vector("file-term-spawn-mkdir")
            : vector(`file-term-spawn-${op}`);
      const fileOp = spawn.fileOp as { op: string; args: Record<string, unknown> };
      for (const invalid of [
        { ...spawn, fileOp: { ...fileOp, extra: "forged" } },
        { ...spawn, fileOp: { ...fileOp, args: { ...fileOp.args, extra: "forged" } } },
      ])
        expect(() => encodeRelayServerControlMessage(invalid as never)).toThrow();
      const done =
        op === "mkdir" ? vector("file-supervised-done") : vector(`file-supervised-done-${op}`);
      const fileResult = done.fileResult as { op: string; result: Record<string, unknown> };
      for (const invalid of [
        { ...done, fileResult: { ...fileResult, extra: "forged" } },
        {
          ...done,
          fileResult: { ...fileResult, result: { ...fileResult.result, extra: "forged" } },
        },
        {
          ...done,
          fileResult: {
            ...fileResult,
            result: {
              ...fileResult.result,
              recovered: ["/workspace/.wsmp-recover-a1b2c3d4e5/slot-1"],
            },
          },
        },
        { ...done, review: true },
        { ...done, exitCode: 0 },
        { ...done, signal: "TERM" },
        { ...done, outputBytes: 4 },
      ])
        expect(() => parseRelayClientControlFrame(JSON.stringify(invalid))).toThrow();
      if (op === "edit" || op === "write")
        expect(() =>
          parseRelayClientControlFrame(
            JSON.stringify({
              ...done,
              fileResult: { ...fileResult, result: { ...fileResult.result, diff: "forged" } },
            }),
          ),
        ).toThrow();
    },
  );

  it("caps the entire supervised control frame before dispatch", () => {
    const spawn = vector("file-term-spawn");
    expect(() =>
      encodeRelayServerControlMessage({
        ...spawn,
        fileOp: {
          op: "edit",
          args: { path: "~/a", edits: [{ oldText: "a", newText: "x".repeat(64 * 1024) }] },
        },
      } as never),
    ).toThrow("JSON control frame exceeds 64 KiB.");
  });

  it("has a fixture for every documented file frame", () => {
    const names = readdirSync(FIXTURE_DIR).filter((name) => name.startsWith("file-"));
    for (const op of FILE_OPS) {
      expect(names).toContain(`file-op-${op}.json`);
      expect(names).toContain(`file-result-${op}.json`);
    }
    expect(names).toEqual(
      expect.arrayContaining(["file-cancel.json", "file-rejected-conflict.json"]),
    );
  });
});

describe("supervised file pre-display rejection contract", () => {
  it("admits special_file for request-text special-tree refusals", () => {
    expect(supervisedFileRejectReasonSchema.parse("special_file")).toBe("special_file");
  });

  it("matches the CLI's closed list exactly", () => {
    const rust = readFileSync(new URL("../../../cli/src/sessions.rs", import.meta.url), "utf8");
    const table = rust.match(
      /const SUPERVISED_FILE_REJECT_REASONS: &[\s\S]*?= &\[([\s\S]*?)\];/,
    )?.[1];
    expect(table).toBeDefined();
    const reasons = [...(table ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(reasons).toEqual(supervisedFileRejectReasonSchema.options);
    for (const reason of reasons) {
      expect(supervisedFileRejectReasonSchema.parse(reason)).toBe(reason);
    }
  });

  it.each([
    "bad_cwd",
    "io_error",
    "not_found",
    "not_a_file",
    "not_a_dir",
    "binary_file",
    "exists",
    "conflict",
    "match_count",
    "no_match",
    "hard_linked",
    "owner_mismatch",
    "setuid",
    "timeout",
    "cancelled",
    "uncertain_outcome",
    "future_internal_error",
  ])("rejects %s without widening the schema", (code) => {
    expect(supervisedFileRejectReasonSchema.safeParse(code).success).toBe(false);
  });
});

describe("file compensation recovery contract", () => {
  const recovery = "/workspace/.wsmp-recover-a1b2c3d4e5";
  const detail = { recovery, kept: [`${recovery}/slot-1`] };

  it("accepts uncertain_outcome with bounded, absolute recovery facts", () => {
    const frame = { type: "file.rejected", opId: OP_ID, reason: "uncertain_outcome", detail };
    expect(fileRejectedFrameSchema.parse(frame)).toEqual(frame);
    expect(parseRelayClientControlFrame(JSON.stringify(frame))).toEqual(frame);
    for (const bad of [
      { ...detail, extra: true },
      { ...detail, recovery: "relative" },
      { ...detail, recovery: `/${"x".repeat(8192)}` },
      { ...detail, kept: ["relative"] },
      { ...detail, kept: ["/x\0y"] },
      { ...detail, kept: Array(5).fill("/x") },
      { recovery },
      { kept: [] },
    ])
      expect(fileRejectDetailSchema.safeParse(bad).success).toBe(false);
    expect(fileRejectedFrameSchema.safeParse({ ...frame, detail: undefined }).success).toBe(false);
  });

  it.each(["edit", "write", "rename"])(
    "accepts recovered on %s and rejects unbounded/relative paths",
    (op) => {
      const frame = vector(`file-result-${op}`) as { result: Record<string, unknown> };
      const result = { ...frame.result, recovered: detail.kept };
      expect(fileOpResultSchema.parse({ op, result })).toEqual({ op, result });
      for (const recovered of [
        ["relative"],
        ["/x\0y"],
        Array(5).fill("/x"),
        [`/${"x".repeat(8192)}`],
      ]) {
        expect(fileOpResultSchema.safeParse({ op, result: { ...result, recovered } }).success).toBe(
          false,
        );
      }
    },
  );
});

describe("file permission frame inputs", () => {
  it("requires explicit mode and grant intent and rejects malformed values", () => {
    const valid = vector("file-op-read");
    for (const field of ["mode", "readGrant"]) {
      const absent = { ...valid };
      delete absent[field];
      expect(() => fileOpFrameSchema.parse(absent)).toThrow();
    }
    for (const patch of [
      { mode: "on" },
      { mode: null },
      { mode: { mode: "unsupervised" } },
      { readGrant: "true" },
      { readGrant: null },
      { readGrant: 1 },
    ]) {
      expect(() => fileOpFrameSchema.parse({ ...valid, ...patch })).toThrow();
    }
    expect(fileOpFrameSchema.parse({ ...valid, mode: "off", readGrant: true })).toMatchObject({
      mode: "off",
      readGrant: true,
    });
  });
});
