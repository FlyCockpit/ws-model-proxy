import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_PROTOCOL_VERSION,
  type DeploymentJob,
  deploymentJobFrameBytes,
  deploymentJobNeedsOperator,
  deploymentOperatorResultStatus,
  deploymentOperatorSupported,
} from "./deployment-protocol";

const intent: Parameters<typeof deploymentJobFrameBytes>[0] = {
  type: "deployment.job",
  instanceId: "instance",
  revisionId: "revision",
  rank: 0,
  action: "start",
  attachment: "llm",
  engine: "vllm",
  management: "externalService",
  command: "sudo systemctl start model",
  stopCommand: "sudo systemctl stop model",
  statusCommand: "systemctl is-active --quiet model",
  healthCommand: null,
  timeoutMs: 60_000,
  unitName: "wsmp-i-instance-r0",
  port: 30000,
  endpointSlug: "inst-model",
  models: ["model"],
  contextWindow: null,
  readiness: { path: "/health", expectedStatus: 200 },
  health: { intervalMs: 30_000, failureThreshold: 3, successThreshold: 1 },
};

describe("deployment protocol version", () => {
  it("is 2.4 only", () => {
    expect(DEPLOYMENT_PROTOCOL_VERSION).toBe("2.4");
  });

  it("allows interactive jobs only on 2.4 with deployments and deploymentOperator", () => {
    const node = { protocolVersion: "2.4", deployments: true, deploymentOperator: true };
    expect(deploymentOperatorSupported(node)).toBe(true);
    for (const protocolVersion of ["2.3", "2.5", "2.11", "2.4.0", null])
      expect(deploymentOperatorSupported({ ...node, protocolVersion })).toBe(false);
    expect(deploymentOperatorSupported({ ...node, deployments: false })).toBe(false);
    expect(deploymentOperatorSupported({ ...node, deploymentOperator: null })).toBe(false);
    expect(deploymentOperatorSupported({ protocolVersion: "2.4" })).toBe(false);
  });
});

describe("interactive job and result fields", () => {
  it("needs an operator-capable node for any interactive field", () => {
    expect(deploymentJobNeedsOperator({})).toBe(false);
    expect(deploymentJobNeedsOperator({ interactive: true })).toBe(true);
    expect(deploymentJobNeedsOperator({ stopInteractive: true })).toBe(true);
    expect(
      deploymentJobNeedsOperator({
        operator: { terminalId: "A".repeat(22), commandAuthor: "unknown" },
      }),
    ).toBe(true);
  });

  it("classifies the operator progress statuses", () => {
    for (const status of ["awaiting_operator", "operator_running", "operator_closed"] as const)
      expect(deploymentOperatorResultStatus(status)).toBe(true);
    for (const status of ["succeeded", "failed", "running"] as const)
      expect(deploymentOperatorResultStatus(status)).toBe(false);
  });

  it("bounds an interactive job's frame including its operator terminal", () => {
    const plain = deploymentJobFrameBytes(intent) ?? 0;
    const interactive = deploymentJobFrameBytes({ ...intent, interactive: true }) ?? 0;
    const terminal =
      JSON.stringify({ operator: { terminalId: "A".repeat(22), commandAuthor: "unknown" } })
        .length - 2;
    // `,"interactive":true` plus `,"operator":{...}`.
    expect(interactive).toBe(plain + ',"interactive":true'.length + 1 + terminal);
    const job: DeploymentJob = {
      ...intent,
      interactive: true,
      stepId: "s".repeat(64),
      intentHash: "0".repeat(64),
      ownerEpoch: `${"0".repeat(36)}:${"9".repeat(16)}`,
      actor: "AGENT",
      humanApproved: false,
      operator: { terminalId: "AAECAwQFBgcICQoLDA0ODw", commandAuthor: "unknown" },
    };
    expect(new TextEncoder().encode(JSON.stringify(job)).byteLength).toBe(interactive);
  });
});
