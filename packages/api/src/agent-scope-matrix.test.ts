import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import { assertContractAgentScope } from "./contract-procedure";
import { apiContract, flattenContract, MCP_TOOLS } from "./contracts";
import {
  AGENT_SCOPE_OF_TOOL,
  AGENT_SCOPES,
  type AgentScope,
  ALL_AGENT_SCOPES,
  agentToolAllowed,
} from "./contracts/agent-scopes";
import type { CallerAuth } from "./contracts/auth-context";

const procedures = flattenContract(apiContract).filter(
  ([, contract]) => contract.access === "agent",
);
const scopeSets: readonly (readonly AgentScope[])[] = [
  ["read"],
  ...AGENT_SCOPES.filter((scope) => scope !== "read").map((scope) => ["read", scope] as const),
  ALL_AGENT_SCOPES,
];
describe("central MCP tool × credential scope matrix", () => {
  for (const scopes of scopeSets)
    for (const kind of ["agent_token", "oauth_access_token"] as const) {
      it(`${kind} with ${scopes.join(", ")} admits exactly procedures of tools in scope`, () => {
        const auth: CallerAuth =
          kind === "agent_token"
            ? { kind, userId: "owner", agentTokenId: "t", access: { scopes, nodeIds: null } }
            : { kind, userId: "owner", grantId: "g", access: { scopes, nodeIds: null } };
        const allowedPaths = new Set(
          MCP_TOOLS.filter((tool) => scopes.includes(AGENT_SCOPE_OF_TOOL[tool.name])).flatMap(
            (tool) => tool.procedures,
          ),
        );
        for (const tool of MCP_TOOLS) {
          expect(agentToolAllowed(auth.access, tool.name), tool.name).toBe(
            scopes.includes(AGENT_SCOPE_OF_TOOL[tool.name]),
          );
          expect(tool.scope, tool.name).toBe(AGENT_SCOPE_OF_TOOL[tool.name]);
        }
        for (const [path, contract] of procedures) {
          const check = () => assertContractAgentScope(contract, auth);
          if (allowedPaths.has(path)) expect(check, path).not.toThrow();
          else expect(check, path).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
        }
      });
    }
  it("does not restrict the person's session to agent scopes", () => {
    for (const [, contract] of procedures)
      expect(() =>
        assertContractAgentScope(contract, {
          kind: "cookie_session",
          userId: "owner",
          sessionId: "s",
          csrfVerified: true,
        }),
      ).not.toThrow();
  });
});
