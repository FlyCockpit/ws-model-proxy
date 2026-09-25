import { DELETION_CONFLICT_REASONS } from "@ws-model-proxy/config/deletion-conflict";
import { describe, expect, it } from "vitest";

import enErrors from "../locales/en-US/errors.json";
import esErrors from "../locales/es-MX/errors.json";
import {
  type DeletionEntity,
  deletionConflictMessageKey,
  deletionConflictReason,
  friendly,
} from "./friendly-error";

const ENTITIES: DeletionEntity[] = [
  "user",
  "cliDevice",
  "endpoint",
  "discoveredModel",
  "pool",
  "poolMember",
  "capacity",
];

function conflict(data?: unknown, message = "raw server message") {
  return { status: 409, code: "CONFLICT", message, data };
}

function lookup(bundle: unknown, key: string): unknown {
  const path = key.replace(/^errors:/, "").split(".");
  return path.reduce<unknown>(
    (node, part) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
    bundle,
  );
}

describe("deletionConflictReason", () => {
  it("reads every structured reason from a CONFLICT", () => {
    for (const reason of DELETION_CONFLICT_REASONS) {
      expect(deletionConflictReason(conflict({ reason }))).toBe(reason);
    }
  });

  it("ignores unknown reasons, missing data, and non-CONFLICT errors", () => {
    expect(deletionConflictReason(conflict())).toBeNull();
    expect(deletionConflictReason(conflict({ reason: "something_else" }))).toBeNull();
    expect(
      deletionConflictReason({ status: 400, code: "BAD_REQUEST", data: { reason: "not_stale" } }),
    ).toBeNull();
    expect(deletionConflictReason(null)).toBeNull();
  });

  it("never infers a reason from the message", () => {
    expect(
      deletionConflictReason(
        conflict(undefined, "This item still has requests in flight. Retry once they finish."),
      ),
    ).toBeNull();
  });
});

describe("deletionConflictMessageKey", () => {
  it("maps retained history to the entity's own off-switch copy", () => {
    for (const entity of ENTITIES) {
      expect(deletionConflictMessageKey(conflict({ reason: "retained_history" }), entity)).toBe(
        `errors:deletionConflict.retainedHistory.${entity}`,
      );
    }
  });

  it("maps pending and other reasons to entity-neutral copy", () => {
    const expected = {
      delete_pending: "errors:deletionConflict.deletePending",
      delete_contended: "errors:deletionConflict.deleteContended",
      still_attached: "errors:deletionConflict.stillAttached",
      not_stale: "errors:deletionConflict.notStale",
      deletion_in_progress: "errors:deletionConflict.deletionInProgress",
    };
    for (const [reason, key] of Object.entries(expected)) {
      expect(deletionConflictMessageKey(conflict({ reason }), "pool")).toBe(key);
    }
  });

  it("returns null for a CONFLICT without a known reason, which keeps the generic copy", () => {
    const error = conflict({ reason: "slug_taken" });
    expect(deletionConflictMessageKey(error, "pool")).toBeNull();
    expect(friendly(error)).toBe("That conflicts with an existing record.");
  });

  it("has the same deletion-conflict keys in both locale bundles", () => {
    expect(Object.keys(esErrors.deletionConflict).sort()).toEqual(
      Object.keys(enErrors.deletionConflict).sort(),
    );
    expect(Object.keys(esErrors.deletionConflict.retainedHistory).sort()).toEqual(
      Object.keys(enErrors.deletionConflict.retainedHistory).sort(),
    );
  });

  it("has copy in both locale bundles for every reason and entity", () => {
    const keys = new Set<string>();
    for (const reason of DELETION_CONFLICT_REASONS) {
      for (const entity of ENTITIES) {
        const key = deletionConflictMessageKey(conflict({ reason }), entity);
        if (key) keys.add(key);
      }
    }
    for (const key of keys) {
      expect(typeof lookup(enErrors, key), `en-US ${key}`).toBe("string");
      expect(typeof lookup(esErrors, key), `es-MX ${key}`).toBe("string");
    }
  });
});

describe("friendly", () => {
  it("keeps the generic CONFLICT copy even when a deletion reason is present", () => {
    expect(friendly(conflict({ reason: "retained_history" }))).toBe(
      "That conflicts with an existing record.",
    );
  });
});
