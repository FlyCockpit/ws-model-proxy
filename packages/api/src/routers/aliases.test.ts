import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import { modelAliasesRouter } from "./aliases";
import { CALLERS, contextFor, OWNER } from "./lane-c-test-helpers";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

function client(auth = CALLERS.fullAgent()) {
  return createRouterClient(modelAliasesRouter, { context: contextFor(auth) });
}

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError)
      return (error.data as { reason?: string } | undefined)?.reason ?? error.code;
    throw error;
  }
  return undefined;
}

const POOLS = [
  { id: "pool-own", slug: "chat", User: { slug: "me" } },
  { id: "pool-shared", slug: "big", User: { slug: "friend" } },
];

function aliasRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "alias-1",
    name: "gpt-4o",
    poolId: "pool-own",
    apiKeyId: null,
    Pool: { slug: "chat", User: { slug: "me" } },
    ApiKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockReset(db);
  db.pool.findMany.mockResolvedValue(POOLS as never);
  db.$transaction.mockImplementation((async (work: unknown) =>
    typeof work === "function" ? work(db) : undefined) as never);
});

describe("model-name aliases", () => {
  it("lists the caller's aliases with the callable ID and whether they still work", async () => {
    db.modelAlias.findMany.mockResolvedValue([
      aliasRow(),
      aliasRow({
        id: "alias-2",
        name: "claude-sonnet-4-5",
        poolId: "pool-gone",
        Pool: { slug: "old", User: { slug: "ex" } },
      }),
      aliasRow({
        id: "alias-3",
        apiKeyId: "key-1",
        poolId: "pool-shared",
        ApiKey: {
          name: "ci",
          scope: "SELECTED_POOLS",
          revokedAt: null,
          expiresAt: null,
          Pools: [{ poolId: "pool-own" }],
        },
      }),
    ] as never);
    const { aliases } = await client().list({});
    expect(db.modelAlias.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER } }),
    );
    expect(aliases.map((alias) => [alias.name, alias.callableId, alias.usable])).toEqual([
      ["gpt-4o", "me/chat", true],
      ["claude-sonnet-4-5", null, false],
      ["gpt-4o", "friend/big", false],
    ]);
    // Keys are for people: an agent sees the key id, not its name.
    expect(aliases[2]?.apiKeyName).toBeNull();
    const asPerson = await client(CALLERS.person()).list({});
    expect(asPerson.aliases[2]?.apiKeyName).toBe("ci");
  });

  it("an agent sets an alias to a pool it can use, audited, in its own namespace", async () => {
    db.modelAlias.findUnique.mockResolvedValue(null);
    db.modelAlias.count.mockResolvedValue(3);
    db.modelAlias.upsert.mockResolvedValue(aliasRow({ poolId: "pool-shared" }) as never);
    const view = await client().set({ name: "gpt-4o", poolId: "pool-shared", note: "harness" });
    expect(view).toMatchObject({ callableId: "friend/big", usable: true });
    expect(db.modelAlias.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_scopeKey_name: { userId: OWNER, scopeKey: "", name: "gpt-4o" } },
        create: {
          userId: OWNER,
          apiKeyId: null,
          scopeKey: "",
          name: "gpt-4o",
          poolId: "pool-shared",
        },
        update: { poolId: "pool-shared" },
      }),
    );
    expect(db.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: OWNER,
        actor: "AGENT",
        action: "model_alias.set",
        resourceType: "model_alias",
        after: { name: "gpt-4o", poolId: "pool-shared", apiKeyId: null, note: "harness" },
      }),
    });
  });

  it("never points an alias at a pool the caller cannot use", async () => {
    expect(await reasonOf(client().set({ name: "gpt-4o", poolId: "pool-other" }))).toBe(
      "NOT_FOUND",
    );
    expect(db.modelAlias.upsert).not.toHaveBeenCalled();
  });

  it("refuses a name that is a callable ID, a key it cannot use, and past the limit", async () => {
    expect(await reasonOf(client().set({ name: "me/chat", poolId: "pool-own" }))).toBe(
      "alias_shadowed",
    );
    db.apiKey.findFirst.mockResolvedValueOnce(null);
    expect(
      await reasonOf(client().set({ name: "gpt-4o", poolId: "pool-own", apiKeyId: "key-x" })),
    ).toBe("NOT_FOUND");
    expect(db.apiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "key-x",
          userId: OWNER,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
      }),
    );
    db.apiKey.findFirst.mockResolvedValueOnce({ scope: "SELECTED_POOLS", Pools: [] } as never);
    expect(
      await reasonOf(client().set({ name: "gpt-4o", poolId: "pool-own", apiKeyId: "key-1" })),
    ).toBe("alias_key_not_allowed");
    db.modelAlias.findUnique.mockResolvedValue(null);
    db.modelAlias.count.mockResolvedValue(64);
    expect(await reasonOf(client().set({ name: "new-name", poolId: "pool-own" }))).toBe(
      "alias_limit",
    );
    expect(db.modelAlias.upsert).not.toHaveBeenCalled();
  });

  it("refuses names that are variants or direct tests", async () => {
    for (const name of ["gpt-4o:external", "runtime:x:y", "-bad", "a b"])
      expect(await reasonOf(client().set({ name, poolId: "pool-own" }))).toBe("BAD_REQUEST");
  });

  it("deletes only the caller's own alias", async () => {
    db.modelAlias.findFirst.mockResolvedValue(null);
    expect(await reasonOf(client().delete({ aliasId: "alias-x" }))).toBe("NOT_FOUND");
    expect(db.modelAlias.deleteMany).not.toHaveBeenCalled();
    db.modelAlias.findFirst.mockResolvedValue({ id: "alias-1" } as never);
    await client().delete({ aliasId: "alias-1" });
    expect(db.modelAlias.deleteMany).toHaveBeenCalledWith({
      where: { id: "alias-1", userId: OWNER },
    });
  });
});
