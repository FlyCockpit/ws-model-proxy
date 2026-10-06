import { describe, expect, it, vi } from "vitest";

// No database in unit tests: the real env module would demand DATABASE_URL.
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));
vi.mock("@ws-model-proxy/db", async () => ({
  default: {},
  Prisma: (await import("../../../../packages/db/prisma/generated/client")).Prisma,
}));

async function freshLedger() {
  vi.resetModules();
  return (await import("./cache-affinity-residency.js")).beginAffinityReset;
}

describe("affinity reset observation ledger", () => {
  it("caps one owner at a quarter of the ledger without refusing other owners", async () => {
    const begin = await freshLedger();
    const heldByA = Array.from({ length: 1024 }, (_, index) =>
      begin("device-a", `slug-${index}`, "owner-a"),
    );
    expect(() => begin("device-a", "one-more", "owner-a")).toThrow("reset observation capacity");
    // Re-entering a key the owner already holds is not a new ledger entry.
    const again = begin("device-a", "slug-0", "owner-a");
    const heldByB = begin("device-b", "slug", "owner-b");

    // Releasing the re-entry keeps the key; releasing the original frees a slot.
    again();
    expect(() => begin("device-a", "one-more", "owner-a")).toThrow();
    heldByA[0]?.();
    const freed = begin("device-a", "one-more", "owner-a");

    for (const release of [...heldByA, heldByB, freed]) release();
  });

  it("still refuses once the process-wide ledger is full", async () => {
    const begin = await freshLedger();
    const held = Array.from({ length: 4096 }, (_, index) =>
      begin(`device-${index}`, "slug", `owner-${index % 4}`),
    );
    expect(() => begin("device-new", "slug", "owner-new")).toThrow("reset observation capacity");
    for (const release of held) release();
    const after = begin("device-new", "slug", "owner-new");
    after();
  });
});
