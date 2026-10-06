import { describe, expect, it } from "vitest";
import {
  FILE_BODY_MAX_BYTES,
  FILE_ERROR_CODES,
  FILE_INLINE_TEXT_MAX_BYTES,
  FILE_OPS,
  FILE_WIRE_REASONS,
  fileRejectDetailSchema,
  fileRejectReasonSchema,
  fileResultFrameSchema,
  isMutatingFileOp,
} from "./file-protocol.js";
import { FILE_REJECT_WIRE_REASONS, fileOpFrameSchema, fileRejectedFrameSchema } from "./frames.js";

const OP_ID = "aI2y1_whRmuQtdr_JElukw";
const ETAG = "h:AAAAAAAAAAAAAAAAAAAAAA";

const ARGS: Record<(typeof FILE_OPS)[number], Record<string, unknown>> = {
  read: { path: "/home/me/a.txt", maxLines: 20 },
  stat: { paths: ["/home/me/a.txt"] },
  list: { path: "/home/me" },
  search: { root: "/home/me", pattern: "TODO" },
  edit: { path: "/home/me/a.txt", edits: [{ oldText: "a", newText: "b" }] },
  write: { path: "/home/me/a.txt", ifExists: "replace" },
  rename: { from: "/home/me/a.txt", to: "/home/me/b.txt" },
  mkdir: { path: "/home/me/d" },
  delete: { path: "/home/me/a.txt", expectedEtag: ETAG },
};

function op(name: (typeof FILE_OPS)[number], extra: Record<string, unknown> = {}) {
  return {
    type: "file.op",
    opId: OP_ID,
    op: name,
    args: ARGS[name],
    ...(name === "write" ? { bodyBytes: 3 } : {}),
    ...extra,
  };
}

describe("relay 3.0 file frames", () => {
  it.each(FILE_OPS)("file.op %s is strict at every level and carries no mode or grant", (name) => {
    expect(fileOpFrameSchema.parse(op(name))).toEqual(op(name));
    expect(fileOpFrameSchema.safeParse(op(name, { extra: 1 })).success).toBe(false);
    expect(
      fileOpFrameSchema.safeParse({ ...op(name), args: { ...ARGS[name], extra: 1 } }).success,
    ).toBe(false);
    expect(fileOpFrameSchema.safeParse(op(name, { mode: "unsupervised" })).success).toBe(false);
    expect(fileOpFrameSchema.safeParse(op(name, { readGrant: true })).success).toBe(false);
    expect(fileOpFrameSchema.safeParse({ ...op(name), opId: "short" }).success).toBe(false);
  });

  it("carries write content out of band with a 1 MiB cap", () => {
    const { bodyBytes: _bodyBytes, ...noBody } = op("write");
    expect(fileOpFrameSchema.safeParse(noBody).success).toBe(false);
    expect(
      fileOpFrameSchema.safeParse(op("write", { bodyBytes: FILE_BODY_MAX_BYTES + 1 })).success,
    ).toBe(false);
    expect(
      fileOpFrameSchema.safeParse({ ...op("write"), args: { ...ARGS.write, content: "x" } })
        .success,
    ).toBe(false);
    expect(fileOpFrameSchema.safeParse(op("read", { bodyBytes: 1 })).success).toBe(false);
  });

  it("classifies mutating ops", () => {
    expect(FILE_OPS.filter(isMutatingFileOp)).toEqual([
      "edit",
      "write",
      "rename",
      "mkdir",
      "delete",
    ]);
  });

  it("holds each result to its op, caps inline text and ties dataField to bodyBytes", () => {
    const mkdir = { type: "file.result", opId: OP_ID, op: "mkdir", result: { created: true } };
    expect(fileResultFrameSchema.parse(mkdir)).toEqual(mkdir);
    expect(fileResultFrameSchema.safeParse({ ...mkdir, op: "delete" }).success).toBe(false);
    const list = {
      type: "file.result",
      opId: OP_ID,
      op: "list",
      result: { entries: "a\nb", count: 2, more: null },
    };
    expect(fileResultFrameSchema.safeParse(list).success).toBe(true);
    expect(
      fileResultFrameSchema.safeParse({
        ...list,
        result: { ...list.result, entries: "x".repeat(FILE_INLINE_TEXT_MAX_BYTES + 1) },
      }).success,
    ).toBe(false);
    expect(
      fileResultFrameSchema.safeParse({
        ...list,
        result: { ...list.result, entries: "" },
        dataField: "entries",
        bodyBytes: 70_000,
      }).success,
    ).toBe(true);
    expect(fileResultFrameSchema.safeParse({ ...list, dataField: "entries" }).success).toBe(false);
    expect(
      fileResultFrameSchema.safeParse({ ...list, dataField: "text", bodyBytes: 70_000 }).success,
    ).toBe(false);
  });

  it("accepts only library-shaped etags in results", () => {
    const write = {
      type: "file.result",
      opId: OP_ID,
      op: "write",
      result: { etag: ETAG, size: 3, created: true },
    };
    expect(fileResultFrameSchema.safeParse(write).success).toBe(true);
    expect(
      fileResultFrameSchema.safeParse({ ...write, result: { ...write.result, etag: "free text" } })
        .success,
    ).toBe(false);
  });

  it("rejects with a file error code or a node wire reason, and nothing else", () => {
    expect([...FILE_WIRE_REASONS]).toEqual([...FILE_REJECT_WIRE_REASONS]);
    for (const reason of [...FILE_ERROR_CODES, ...FILE_WIRE_REASONS]) {
      if (reason === "uncertain_outcome") continue;
      expect(
        fileRejectedFrameSchema.safeParse({ type: "file.rejected", opId: OP_ID, reason }).success,
        reason,
      ).toBe(true);
      expect(fileRejectReasonSchema.safeParse(reason).success, reason).toBe(true);
    }
    for (const reason of ["supervised_only", "grant_disabled", "feature_disabled", "nope"]) {
      expect(
        fileRejectedFrameSchema.safeParse({ type: "file.rejected", opId: OP_ID, reason }).success,
        reason,
      ).toBe(false);
    }
  });

  it("requires recovery facts with uncertain_outcome", () => {
    const frame = {
      type: "file.rejected",
      opId: OP_ID,
      reason: "uncertain_outcome",
      detail: { recovery: "/home/me/.a.txt.wsmp-old", kept: ["/home/me/a.txt"] },
    };
    expect(fileRejectedFrameSchema.parse(frame)).toEqual(frame);
    expect(fileRejectedFrameSchema.safeParse({ ...frame, detail: undefined }).success).toBe(false);
    expect(
      fileRejectDetailSchema.safeParse({ recovery: "/a", kept: ["/b"], size: 1 }).success,
    ).toBe(false);
    expect(fileRejectDetailSchema.safeParse({ recovery: "relative", kept: [] }).success).toBe(
      false,
    );
  });
});
