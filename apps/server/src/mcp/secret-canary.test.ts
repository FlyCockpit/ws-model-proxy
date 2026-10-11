import {
  type AuthInfo,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ProcedureInvoker } from "./tools";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://mcp-canary-test", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { MCP_TOOLS, SENSITIVE_INPUT_PROCEDURES } = await import("@ws-model-proxy/api/contracts");
const { default: prisma } = await import("@ws-model-proxy/db");
const { createMcpTransport } = await import("./handler");
const { bindMcpToolDispatch } = await import("./tool-dispatch");
const { runMcpTool, toolInputIsSensitive } = await import("./tools");
const { testDispatch } = await import("./tools.test-helper");

/**
 * Secret canary (security review): a unique value sent through every path of every sensitive
 * tool (`sensitiveInput` or a procedure in SENSITIVE_INPUT_PROCEDURES) never shows up in a
 * result, an error body, a log line or an audit write.
 */
const CANARY = `canary-${crypto.randomUUID()}`;

const SENSITIVE_TOOLS = MCP_TOOLS.filter((contract) => toolInputIsSensitive(contract));

let consoleSpies: MockInstance[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});
afterEach(() => vi.restoreAllMocks());

/** Everything the canary must never reach: results, log calls and audit writes. */
function leaked(...results: unknown[]): boolean {
  const auditWrites = [
    vi.mocked(prisma.nodeAuditEvent.create).mock.calls,
    vi.mocked(prisma.nodeAuditEvent.createMany).mock.calls,
    vi.mocked(prisma.auditEvent.create).mock.calls,
    vi.mocked(prisma.auditEvent.createMany).mock.calls,
  ];
  const logged = consoleSpies.map((spy) => spy.mock.calls);
  return JSON.stringify([results, logged, auditWrites]).includes(CANARY);
}

const valid = { nodeId: "node-1", name: "WSMP_SECRET_HF_TOKEN", value: CANARY };

describe("secret canary", () => {
  it("covers exactly the sensitive tools and procedures", () => {
    expect(SENSITIVE_TOOLS.map((contract) => contract.name)).toEqual(["node_secret_set"]);
    // The detector itself sees a leak in a result and in a log line.
    expect(leaked({ text: `x${CANARY}` })).toBe(true);
    console.warn(CANARY);
    expect(leaked()).toBe(true);
    for (const path of SENSITIVE_INPUT_PROCEDURES)
      expect(
        SENSITIVE_TOOLS.some((contract) => contract.procedures.includes(path)),
        path,
      ).toBe(true);
  });

  for (const contract of SENSITIVE_TOOLS) {
    describe(contract.name, () => {
      const dispatch = () => testDispatch("FULL");

      it("a valid call (through the bound stub procedure and a stand-in) never echoes it", async () => {
        const viaRouter = await runMcpTool(contract, { dispatch: dispatch(), args: valid });
        const seen: unknown[] = [];
        const viaStandIn = await runMcpTool(contract, {
          dispatch: dispatch(),
          args: valid,
          invoke: async (_path, input) => {
            seen.push(input);
            return { name: input.name, updatedAt: "2026-10-06T00:00:00.000Z" };
          },
        });
        expect(viaStandIn.isError).toBeFalsy();
        // The value reaches the procedure (that is the point) and nothing else.
        expect(JSON.stringify(seen)).toContain(CANARY);
        expect(leaked(viaRouter, viaStandIn)).toBe(false);
      });

      it.each([
        ["a value over 16 KiB", { ...valid, value: CANARY.repeat(600) }],
        ["an extra key", { ...valid, extra: CANARY }],
        ["a bad name", { ...valid, name: "HOME" }],
        ["a bad name carrying the canary", { ...valid, name: CANARY }],
        ["a non-string value", { ...valid, value: { nested: CANARY } }],
      ])("a call refused for %s never echoes it", async (_label, args) => {
        const result = await runMcpTool(contract, { dispatch: dispatch(), args });
        expect(result.isError).toBe(true);
        expect(leaked(result)).toBe(false);
      });

      it.each([
        ["an Error", () => new Error(`boom ${CANARY}`)],
        ["an unknown ORPCError", () => new ORPCError("TEAPOT", { message: CANARY })],
        ["a BAD_REQUEST", () => new ORPCError("BAD_REQUEST", { message: CANARY })],
        [
          "a refusal whose message carries it",
          () =>
            new ORPCError("FORBIDDEN", {
              message: `refused ${CANARY}`,
              data: { reason: "secret_needs_node", subjectId: "node-1" },
            }),
        ],
      ])("a procedure throwing %s never echoes it", async (_label, makeError) => {
        const invoke: ProcedureInvoker = async () => {
          throw makeError();
        };
        const result = await runMcpTool(contract, { dispatch: dispatch(), args: valid, invoke });
        expect(result.isError).toBe(true);
        expect(leaked(result)).toBe(false);
      });

      it("the MCP wire body of a call never carries it", async () => {
        const authInfo: AuthInfo = { token: "t", clientId: "c", scopes: ["mcp:read", "mcp:write"] };
        bindMcpToolDispatch(authInfo, dispatch());
        const bodies: string[] = [];
        for (const args of [valid, { ...valid, extra: CANARY }, { ...valid, name: CANARY }]) {
          const response = await createMcpTransport().fetch(
            new Request("http://proxy.example.com/mcp", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "mcp-method": "tools/call",
                "mcp-name": contract.name,
                "mcp-protocol-version": "2026-07-28",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: contract.name,
                  arguments: args,
                  _meta: {
                    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
                    [CLIENT_INFO_META_KEY]: { name: "canary", version: "0" },
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                  },
                },
              }),
            }),
            { authInfo },
          );
          bodies.push(await response.text());
        }
        expect(bodies.every((body) => body.includes('"jsonrpc"'))).toBe(true);
        expect(leaked(bodies)).toBe(false);
      });
    });
  }
});
