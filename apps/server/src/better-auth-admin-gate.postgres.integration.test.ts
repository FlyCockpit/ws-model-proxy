/** Real Better Auth + the server gate; only the owned disposable PostgreSQL runner enables it. */
import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;
const origin = "https://impersonation.example.test";
type Jar = Map<string, string>;

integration("saved admin restoration (Better Auth + PostgreSQL)", () => {
  let auth: typeof import("@ws-model-proxy/auth")["auth"];
  let prisma: typeof import("@ws-model-proxy/db")["default"];
  let fixtures: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  const app = new Hono();
  const userIds: string[] = [];
  const password = `Disposable-${randomUUID()}`;
  let passwordHash: string;
  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "development";
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
    process.env.BETTER_AUTH_URL = origin;
    process.env.WMP_MCP_ENABLED = "false";
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    fixtures = createFixturePrismaClient(databaseUrl);
    prisma = (await import("@ws-model-proxy/db")).default;
    auth = (await import("@ws-model-proxy/auth")).auth;
    // Better Auth caches its test-mode detection when the dependency loads.
    // Enable the production origin check in this Vitest harness; no guard is disabled.
    const context = await auth.$context;
    expect(context.skipCSRFCheck).toBe(false);
    context.skipOriginCheck = false;
    const { betterAuthAdminGate } = await import("./better-auth-admin-gate");
    const { handlePasswordAuthRequest } = await import(
      "@ws-model-proxy/auth/password-auth-handler"
    );
    app.use("/api/auth/admin/*", betterAuthAdminGate);
    app.on(["GET", "POST"], "/api/auth/*", (c) => {
      const headers = new Headers(c.req.raw.headers);
      headers.delete("authorization");
      return handlePasswordAuthRequest(auth, new Request(c.req.raw, { headers }));
    });
    passwordHash = await (await auth.$context).password.hash(password);
  });
  afterAll(async () => {
    if (!fixtures) return;
    try {
      await fixtures.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await Promise.all([fixtures.$disconnect(), prisma.$disconnect()]);
    }
  });

  const cookies = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const request = (path: string, jar: Jar, body = {}, extraHeaders = {}) =>
    app.request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: cookies(jar),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  const apply = (jar: Jar, response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
  };
  const session = async (jar: Jar) => {
    const current = await auth.api.getSession({ headers: new Headers({ cookie: cookies(jar) }) });
    if (!current) throw new Error("fixture session unavailable");
    return current;
  };
  async function fixture(role = "user") {
    const id = `imp-${randomUUID()}`;
    userIds.push(id);
    return fixtures.user.create({
      data: {
        id,
        name: "Impersonation fixture",
        email: `${id}@example.test`,
        emailVerified: true,
        role,
        accounts: { create: { accountId: id, providerId: "credential", password: passwordHash } },
      },
    });
  }
  async function begin() {
    const actor = await fixture("admin");
    const target = await fixture();
    const jar: Jar = new Map();
    const signin = await request("/sign-in/email", jar, { email: actor.email, password });
    expect(signin.status).toBe(200);
    apply(jar, signin);
    const original = await session(jar);
    const impersonate = await request("/admin/impersonate-user", jar, { userId: target.id });
    expect(impersonate.status).toBe(200);
    apply(jar, impersonate);
    const impersonated = await session(jar);
    expect(impersonated.user.id).toBe(target.id);
    expect(impersonated.session.impersonatedBy).toBe(actor.id);
    return { actor, target, original, impersonated, jar };
  }
  type Flow = Awaited<ReturnType<typeof begin>>;
  async function refused(flow: Flow) {
    const response = await request("/admin/stop-impersonating", flow.jar);
    expect([401, 403]).toContain(response.status);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(
      await fixtures.session.findUnique({ where: { id: flow.impersonated.session.id } }),
    ).not.toBeNull();
    expect((await session(flow.jar)).user.id).toBe(flow.target.id);
  }

  it("restores the live original admin and keeps every other management path strict", async () => {
    const flow = await begin();
    expect((await request("/admin/list-users", flow.jar)).status).toBe(403);
    const response = await request(
      "/admin/stop-impersonating",
      flow.jar,
      {},
      { "x-expected-user": flow.target.id },
    );
    expect(response.status).toBe(200);
    apply(flow.jar, response);
    const restored = await session(flow.jar);
    expect(restored.user.id).toBe(flow.actor.id);
    expect(restored.user.role).toBe("admin");
    expect(restored.session.id).toBe(flow.original.session.id);
    expect(restored.session.impersonatedBy).toBeNull();
    expect(
      await fixtures.session.findUnique({ where: { id: flow.impersonated.session.id } }),
    ).toBeNull();
    expect([...flow.jar.keys()].some((key) => key.endsWith(".admin_session"))).toBe(false);
  });

  it.each(["expired", "derived", "revoked", "mismatched-binding"])(
    "refuses a %s saved admin session",
    async (state) => {
      const flow = await begin();
      if (state === "revoked")
        await fixtures.session.delete({ where: { id: flow.original.session.id } });
      else if (state === "mismatched-binding") {
        const other = await fixture("admin");
        await fixtures.session.update({
          where: { id: flow.impersonated.session.id },
          data: { impersonatedBy: other.id },
        });
      } else
        await fixtures.session.update({
          where: { id: flow.original.session.id },
          data:
            state === "expired" ? { expiresAt: new Date(0) } : { impersonatedBy: flow.target.id },
        });
      await refused(flow);
    },
  );

  it.each(["demoted", "unverified", "banned", "deletion-pending"])(
    "refuses a %s actor even with a live saved session",
    async (state) => {
      const flow = await begin();
      await fixtures.user.update({
        where: { id: flow.actor.id },
        data:
          state === "demoted"
            ? { role: "user" }
            : state === "unverified"
              ? { emailVerified: false }
              : state === "banned"
                ? { banned: true }
                : { deletionRequestedAt: new Date() },
      });
      await refused(flow);
    },
  );

  it.each(["missing", "tampered", "unrelated", "duplicate", "quoted-duplicate"])(
    "refuses %s saved cookies",
    async (state) => {
      const flow = await begin();
      const savedName = (await auth.$context).createAuthCookie("admin_session").name;
      const saved = flow.jar.get(savedName);
      expect(saved).toBeTruthy();
      if (state === "missing") flow.jar.delete(savedName);
      else if (state === "tampered") flow.jar.set(savedName, `${saved}tampered`);
      else if (state === "unrelated")
        flow.jar.set(savedName, (await begin()).jar.get(savedName) ?? "");
      else {
        const prefix = state === "duplicate" ? `${savedName}=${saved}` : `${savedName}="${saved}X`;
        const response = await request(
          "/admin/stop-impersonating",
          flow.jar,
          {},
          { cookie: `${prefix}; ${cookies(flow.jar)}` },
        );
        expect(response.status).toBe(401);
        expect(response.headers.getSetCookie()).toHaveLength(0);
        expect(
          await fixtures.session.findUnique({ where: { id: flow.impersonated.session.id } }),
        ).not.toBeNull();
        return;
      }
      await refused(flow);
    },
  );
  it("preserves Better Auth's foreign-origin refusal", async () => {
    const flow = await begin();
    const response = await request(
      "/admin/stop-impersonating",
      flow.jar,
      {},
      { origin: "https://untrusted.example.test" },
    );
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(
      await fixtures.session.findUnique({ where: { id: flow.impersonated.session.id } }),
    ).not.toBeNull();
  });

  it("refuses a revoked target session", async () => {
    const flow = await begin();
    await fixtures.session.delete({ where: { id: flow.impersonated.session.id } });
    const response = await request("/admin/stop-impersonating", flow.jar);
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(
      await fixtures.session.findUnique({ where: { id: flow.impersonated.session.id } }),
    ).toBeNull();
  });

  it("checks forced 2FA on the original actor", async () => {
    const flow = await begin();
    const previous = await fixtures.appSetting.findUnique({ where: { key: "force2fa" } });
    const { invalidateForceTwoFactorPolicyCache } = await import(
      "@ws-model-proxy/auth/force-two-factor-policy"
    );
    try {
      await fixtures.appSetting.upsert({
        where: { key: "force2fa" },
        create: { key: "force2fa", value: "true" },
        update: { value: "true" },
      });
      invalidateForceTwoFactorPolicyCache();
      await refused(flow);
    } finally {
      if (previous)
        await fixtures.appSetting.update({
          where: { key: "force2fa" },
          data: { value: previous.value },
        });
      else await fixtures.appSetting.deleteMany({ where: { key: "force2fa" } });
      invalidateForceTwoFactorPolicyCache();
    }
  });
});
