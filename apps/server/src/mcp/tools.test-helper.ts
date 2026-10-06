/**
 * Test fixtures for the MCP tool tests: a verified dispatch for a READ or FULL credential.
 * (Tests must mock `@ws-model-proxy/db` and the env modules before importing tools.ts.)
 */
import { createMcpContext, type McpLevel, type McpSessionUser } from "./context";
import type { McpToolDispatch } from "./tool-dispatch";

export const TEST_USER: McpSessionUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
  slug: "test-user-slug",
  role: "user",
  locale: "en-US",
  banned: null,
  banReason: null,
  banExpires: null,
  twoFactorEnabled: true,
  operationalAlerts: true,
};

export function testDispatch(
  level: McpLevel,
  options: { signal?: AbortSignal; tokenId?: string } = {},
): McpToolDispatch {
  const credential = {
    kind: "agent_token" as const,
    tokenId: options.tokenId ?? "token-1",
    level,
    expiresAt: null,
  };
  return {
    orpcContext: createMcpContext({
      user: TEST_USER,
      credential,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      now: new Date("2026-10-06T00:00:00Z"),
      services: undefined,
    }),
    requestId: "req-test",
    ...(options.signal ? { signal: options.signal } : {}),
    credential,
  };
}
