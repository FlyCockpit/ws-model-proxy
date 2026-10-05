import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
// The refusal happens before any procedure reads configuration; the real env
// module would demand DATABASE_URL and the auth secrets.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    SIGNUP_ENABLED: false,
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_MCP_ENABLED: true,
    WMP_MCP_PAT_ALLOW_NO_EXPIRY: true,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
  },
  SIGNUP_ENABLED: false,
}));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { Context } from "../context";
import { appRouter } from "./index";

/** Consent, credential and paid-egress procedures an agent must never reach. */
const HUMAN_ONLY = [
  ["modelApiTokens", "create"],
  ["modelApiTokens", "updateExternalAccess"],
  ["mcpTokens", "create"],
  ["mcpTokens", "updateMine"],
  ["mcpTokens", "revokeMine"],
  ["mcpGrants", "revokeMine"],
  ["cliCredentials", "createToken"],
  ["cliCredentials", "resetTokenIdentity"],
  ["providerManagement", "setAllowDataCollection"],
  ["providerManagement", "createCredential"],
  ["providerManagement", "replaceCredential"],
  ["poolFallbackPreferences", "set"],
  ["poolFallbackPreferences", "clear"],
  ["providerCatalog", "importModel"],
  ["providerCatalog", "setPoolExternalEquivalent"],
  ["inferenceContributions", "offer"],
  ["inferenceContributions", "accept"],
  ["deployments", "confirmPlan"],
  ["deployments", "setNodeGrant"],
  ["deployments", "setAgentsMayPreempt"],
  ["deployments", "deleteConfig"],
] as const;

describe("human-only procedures", () => {
  const agent = createRouterClient(appRouter, {
    context: {
      session: {
        user: {
          id: "owner",
          email: "o@example.test",
          name: "O",
          role: "user",
          twoFactorEnabled: true,
        },
        session: { id: "s", userId: "owner", expiresAt: new Date(Date.now() + 60_000) },
      },
      services: { deploymentActor: { kind: "AGENT", id: "mcp:owner" } },
    } as unknown as Context,
  });

  it.each(HUMAN_ONLY)(
    "refuses %s.%s from an agent context inside the procedure",
    async (router, name) => {
      const procedure = (
        agent as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>
      )[router]?.[name];
      expect(procedure, `${router}.${name}`).toBeTypeOf("function");
      await expect(procedure!({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(vi.mocked(prisma).$transaction).not.toHaveBeenCalled();
    },
  );
});
