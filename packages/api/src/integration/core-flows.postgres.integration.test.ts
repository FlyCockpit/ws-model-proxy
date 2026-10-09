/**
 * Core flows against real PostgreSQL with the schema hardening applied (part of the preview
 * gate: `pnpm test:postgres`). The mocked unit tests cannot see the hardening triggers (graph
 * write fences, shape and transition checks), so this walks the main write paths through the
 * real procedures, on the shared (unfenced) client, as a person and as an agent:
 *
 *   enrollment code → exchange → node definition (labels, hardware, fabric) → runtime create
 *   → pool with a member → profile save → apply preview/apply → runtime start/stop → deletes.
 *
 * Fixtures that stand in for the relay (the node's hello sets trust and connection) use the
 * fixture client, which carries the deploy bypass marker. Writes that answer "retry" (a
 * server-side lock or statement bound passed on a loaded machine) are retried as callers do
 * (./retry-answers.ts).
 */
import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import type { RuntimeSpec } from "../lib/runtime-spec";
import type { NodeEnrollRequest } from "../nodes/enroll-exchange";
import { retryAnswers, untilAnswered } from "./retry-answers";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const IDENTITY_KEY = `B${"A".repeat(84)}QA`;

const SPEC: RuntimeSpec = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "qwen" }],
  launch: {
    management: "process",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 16 }],
    labels: [],
    commands: [{ start: "vllm serve qwen --host 127.0.0.1 --port {{port}}", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
};

type Modules = {
  fixtures: ReturnType<typeof createFixturePrismaClient>;
  appRouter: typeof import("../routers/index")["appRouter"];
  enroll: typeof import("../nodes/enroll-exchange");
};

integration("core flows on PostgreSQL with the schema hardening", () => {
  let modules: Modules | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  let user: { id: string; email: string; name: string };

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    // CI sets these; a local run gets test-only values (never a real deployment's).
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [router, enroll] = await Promise.all([
      import("../routers/index"),
      import("../nodes/enroll-exchange"),
    ]);
    modules = {
      fixtures: createFixturePrismaClient(databaseUrl),
      appRouter: router.appRouter,
      enroll,
    };
    user = await modules.fixtures.user.create({
      data: {
        name: "Core flows",
        email: `core-${suffix}@example.test`,
        emailVerified: true,
        slug: `core-${suffix}`,
      },
      select: { id: true, email: true, name: true },
    });
  });

  afterAll(async () => {
    await modules?.fixtures.$disconnect();
  });

  function client(auth: CallerAuth) {
    const session = {
      user: { ...user, role: "user", emailVerified: true, twoFactorEnabled: false },
      session: { id: `s-${suffix}`, userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
    } as Session;
    const context: Context = { auth, session };
    if (!modules) throw new Error("modules unavailable");
    return createRouterClient(modules.appRouter, { context, interceptors: [retryAnswers] });
  }
  /** The node's exchange, retried while it answers `rate_limited` (the code took no use). */
  function exchange(request: NodeEnrollRequest) {
    if (!modules) throw new Error("modules unavailable");
    const { exchangeEnrollmentCode } = modules.enroll;
    return untilAnswered(
      () => exchangeEnrollmentCode(request),
      (outcome) => !outcome.response.ok && outcome.response.error === "rate_limited",
    );
  }
  const person = (): CallerAuth => ({
    kind: "cookie_session",
    userId: user.id,
    sessionId: `s-${suffix}`,
    csrfVerified: true,
  });

  it("walks enroll → node → runtime → pool → profile → start/stop → deletes", async () => {
    if (!modules) throw new Error("modules unavailable");
    const me = client(person());

    // ── Enrollment: a person mints a code, the node exchanges it ──
    const minted = await me.nodes.enrollmentCodes.create({ labels: ["gpu"] });
    expect(minted.installCommand).toContain(minted.secret);
    const enrolled = await exchange({
      code: minted.secret,
      identityPublicKey: IDENTITY_KEY,
      slug: `desk-${suffix}`,
      replaceConfirmed: false,
    });
    // A refusal names its reason (and retry hint) in the failure.
    if (!enrolled.response.ok)
      expect.fail(`enrollment refused: ${JSON.stringify(enrolled.response)}`);
    expect(enrolled.response.removeAfterOfflineMs).toBeNull();
    const nodeId = enrolled.response.nodeId;
    // A second exchange of the single-use code is refused by name.
    const again = await exchange({
      code: minted.secret,
      identityPublicKey: IDENTITY_KEY,
      slug: `desk2-${suffix}`,
      replaceConfirmed: false,
    });
    expect(again.response).toMatchObject({ ok: false, error: "used" });
    // A code never takes over an existing node, not even with its (public) identity key.
    const second = await me.nodes.enrollmentCodes.create({});
    const relogin = await exchange({
      code: second.secret,
      identityPublicKey: IDENTITY_KEY,
      slug: `desk-${suffix}`,
      replaceConfirmed: false,
    });
    expect(relogin.response).toMatchObject({ ok: false, error: "slug_taken" });
    expect(relogin.revokedCredentialIds).toEqual([]);
    // A Replace code (the person's approval for this node) moves it to a new identity.
    const replace = await me.nodes.enrollmentCodes.create({ replaceNodeId: nodeId });
    const unconfirmed = await exchange({
      code: replace.secret,
      identityPublicKey: IDENTITY_KEY,
      slug: `ignored-${suffix}`,
      replaceConfirmed: false,
    });
    expect(unconfirmed.response).toMatchObject({
      ok: false,
      error: "replace_confirmation_required",
      replaces: { slug: `desk-${suffix}` },
    });
    const replaced = await exchange({
      code: replace.secret,
      identityPublicKey: IDENTITY_KEY,
      slug: `ignored-${suffix}`,
      replaceConfirmed: true,
    });
    expect(replaced.response).toMatchObject({
      ok: true,
      nodeId,
      replaced: { slug: `desk-${suffix}` },
      removeAfterOfflineMs: null,
    });
    expect(replaced.revokedCredentialIds).toHaveLength(1);

    // The relay hello (stand-in): Full control, online.
    await modules.fixtures.node.update({
      where: { id: nodeId },
      data: { trust: "FULL", trustChangedAt: new Date(), connection: "ONLINE" },
    });

    // ── Node definition: labels, hardware, a fabric ──
    const updated = await me.nodes.update({
      nodeId,
      labels: ["gpu", "lab"],
      hardware: { kind: "unified", memoryGb: 128 },
      fabrics: [{ name: `qsfp-${suffix}`, ip: "10.20.0.5" }],
    });
    expect(updated.id).toBe(nodeId);

    // ── Runtime, pool, member ──
    const runtime = await me.runtimes.create({
      slug: `qwen-${suffix}`,
      name: "Qwen",
      kind: "STARTABLE",
      spec: SPEC,
    });
    const runtimeId = runtime.runtime.id;
    const pool = await me.pools.create({
      slug: `pool-${suffix}`,
      name: "Pool",
      type: "LLM",
      members: [{ runtimeId, model: "qwen" }],
    });
    expect(pool.members).toHaveLength(1);

    // ── Profile save, preview, apply ──
    const profile = await me.profiles.save({
      slug: `day-${suffix}`,
      name: "Day",
      nodeIds: [nodeId],
      items: [{ runtimeId, count: 1 }],
    });
    const preview = await me.profiles.apply({ profileId: profile.id, preview: true });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    expect(preview.preview.refusals).toEqual([]);
    expect(preview.preview.starts).toHaveLength(1);
    const applied = await me.profiles.apply({
      profileId: profile.id,
      fingerprint: preview.preview.fingerprint,
    });
    expect(applied.mode).toBe("applied");

    // ── Runtime start (preview + confirm) and stop ──
    const startPreview = await me.runtimes.start({ runtimeId, nodeIds: [nodeId], preview: true });
    if (startPreview.mode !== "preview") throw new Error("expected a start preview");
    const started = await me.runtimes.start({
      runtimeId,
      nodeIds: [nodeId],
      fingerprint: startPreview.preview.fingerprint,
    });
    expect(started.mode).toBe("applied");
    await me.runtimes.stop({ runtimeId });
    const instances = await modules.fixtures.runtimeInstance.findMany({
      where: { runtimeId },
      select: { desiredState: true },
    });
    expect(instances.length).toBeGreaterThan(0);
    expect(instances.every((instance) => instance.desiredState === "STOPPED")).toBe(true);

    // ── Deletes through the fenced paths ──
    await me.profiles.delete({ profileId: profile.id });
    await me.pools.delete({ poolId: pool.id, confirm: "DELETE" });
    const deleted = await me.nodes.delete({ nodeId });
    expect(deleted.deleted).toBe(true);
  });

  it("records an OAuth agent's writes by its grant", async () => {
    if (!modules) throw new Error("modules unavailable");
    const grant = await modules.fixtures.mcpGrant.create({
      data: { userId: user.id, clientId: `client-${suffix}`, referenceId: suffix, level: "FULL" },
      select: { id: true },
    });
    const agent = client({
      kind: "oauth_access_token",
      userId: user.id,
      grantId: grant.id,
      level: "FULL",
    });
    const runtime = await agent.runtimes.create({
      slug: `agent-${suffix}`,
      name: "Agent's",
      kind: "STARTABLE",
      spec: SPEC,
    });
    const version = await modules.fixtures.runtimeVersion.findFirstOrThrow({
      where: { runtimeId: runtime.runtime.id },
      select: { editor: true, agentTokenId: true, mcpGrantId: true },
    });
    expect(version).toEqual({ editor: "AGENT", agentTokenId: null, mcpGrantId: grant.id });
  });
});
