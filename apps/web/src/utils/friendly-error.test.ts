import { DELETION_CONFLICT_REASONS } from "@ws-model-proxy/config/deletion-conflict";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
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

function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyTree(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("friendly", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("keeps the generic CONFLICT copy for retained history without an entity", () => {
    expect(friendly(conflict({ reason: "retained_history" }))).toBe(
      "That conflicts with an existing record.",
    );
  });

  it("gives an entity-neutral deletion reason its specific copy without an entity", () => {
    expect(friendly(conflict({ reason: "delete_pending" }))).toBe(
      enErrors.deletionConflict.deletePending,
    );
    expect(friendly(conflict({ reason: "deletion_in_progress" }))).toBe(
      enErrors.deletionConflict.deletionInProgress,
    );
  });

  it("maps every code and status to its errors.friendly copy, never the message", () => {
    const cases: Array<[unknown, string]> = [
      [{ code: "UNAUTHORIZED", message: "raw" }, enErrors.friendly.unauthorized],
      [{ status: 401 }, enErrors.friendly.unauthorized],
      [{ code: "FORBIDDEN", message: "raw" }, enErrors.friendly.forbidden],
      [{ code: "NOT_FOUND", message: "raw" }, enErrors.friendly.notFound],
      [{ status: 404 }, enErrors.friendly.notFound],
      [conflict(), enErrors.friendly.conflict],
      [{ code: "BAD_REQUEST", message: "raw" }, enErrors.friendly.badRequest],
      [{ code: "INTERNAL_SERVER_ERROR", message: "raw" }, enErrors.friendly.serverError],
      [{ status: 503 }, enErrors.friendly.serverError],
      [{ code: "TOO_MANY_REQUESTS" }, enErrors.friendly.rateLimited],
      [{ code: "SOMETHING_ELSE", message: "raw" }, enErrors.friendly.generic],
      [null, enErrors.friendly.generic],
    ];
    for (const [error, expected] of cases) expect(friendly(error)).toBe(expected);
    expect(friendly({ status: 429, data: { retryAfter: 30 } })).toBe(
      "Too many attempts. Try again in 30 seconds.",
    );
    expect(friendly({ status: 429, data: { retryAfter: 1 } })).toBe(
      "Too many attempts. Try again in 1 second.",
    );
  });

  it("uses the caller's fallback only where no code maps", () => {
    expect(friendly({ code: "SOMETHING_ELSE" }, "ctx")).toBe("ctx");
    expect(friendly({ code: "INTERNAL_SERVER_ERROR" }, "ctx")).toBe("ctx");
    expect(friendly({ code: "NOT_FOUND" }, "ctx")).toBe(enErrors.friendly.notFound);
  });

  it("localizes every copy in es-MX, with no English left", async () => {
    i18n.addResourceBundle("es-MX", "errors", esErrors, true, true);
    await i18n.changeLanguage("es-MX");
    expect(friendly({ code: "BAD_REQUEST" })).toBe(esErrors.friendly.badRequest);
    expect(friendly({ code: "NOT_FOUND" })).toBe(esErrors.friendly.notFound);
    expect(friendly({ status: 429, data: { retryAfter: 5 } })).toBe(
      "Demasiados intentos. Inténtalo de nuevo en 5 segundos.",
    );
    expect(friendly(null)).toBe(esErrors.friendly.generic);
    for (const key of keyTree(enErrors.friendly)) {
      const en = lookup(enErrors, `errors:friendly.${key}`);
      const es = lookup(esErrors, `errors:friendly.${key}`);
      expect(typeof es, key).toBe("string");
      expect(es, key).not.toBe(en);
    }
  });

  it("has the same friendly keys in both locale bundles", () => {
    expect(keyTree(esErrors.friendly).sort()).toEqual(keyTree(enErrors.friendly).sort());
  });

  it("maps Better Auth user-deletion codes to the dashboard's deletion copy", () => {
    const pending = { status: 409, code: "USER_DELETION_PENDING", message: "raw" };
    const retained = { status: 409, code: "RETAINED_HISTORY", message: "raw" };
    const signIn = { status: 403, code: "USER_DELETION_PENDING", message: "raw" };
    expect(deletionConflictReason(pending)).toBe("deletion_in_progress");
    expect(deletionConflictReason(retained)).toBe("retained_history");
    // Not a CONFLICT: no deletion conflict, but the copy still says why.
    expect(deletionConflictReason(signIn)).toBeNull();
    expect(deletionConflictMessageKey(pending, "user")).toBe(
      "errors:deletionConflict.deletionInProgress",
    );
    expect(deletionConflictMessageKey(retained, "user")).toBe(
      "errors:deletionConflict.retainedHistory.user",
    );
    expect(friendly(pending)).toBe(enErrors.deletionConflict.deletionInProgress);
    expect(friendly(signIn)).toBe(enErrors.deletionConflict.deletionInProgress);
    expect(friendly(retained)).toBe(enErrors.deletionConflict.retainedHistory.user);
    // Inherited property names are not codes.
    expect(friendly({ status: 409, code: "toString" })).toBe(enErrors.friendly.conflict);
  });
});
