import { isCanonicalBase64Url16 } from "@ws-model-proxy/config/deployment-job-wire";
import type { Prisma } from "@ws-model-proxy/db";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import {
  deploymentCommandSource,
  deploymentOperatorCommandAuthor,
  mintDeploymentOperator,
  renderDeploymentGroup,
} from "./deployment-service";
import { type DeploymentVariant, deploymentVariantSchema } from "./deployment-spec";

type Revision = { revision: number; editorKind: "USER" | "AGENT" | "SCHEDULE"; spec: unknown };

const START = "sudo systemctl start fixture.service";
const STOP = "sudo systemctl stop fixture.service";

function variant(commands: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return deploymentVariantSchema.parse({
    key: "default",
    engine: "vllm",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 64 }],
    commands: [commands],
    readiness: { path: "/health", timeoutMs: 600_000 },
    models: ["fixture/model"],
    attachment: { type: "llm", poolId: "pool" },
    hardConcurrencyLimit: 4,
    contextWindow: 32768,
    ...extra,
  });
}

function spec(start: string, stop = STOP) {
  return {
    variants: [
      variant({
        management: "externalService",
        start,
        stop,
        status: "systemctl is-active --quiet fixture.service",
        interactive: { start: true, stop: true },
      }),
    ],
  };
}

/** A transaction stand-in holding one recipe's revisions (the last one is the instance's). */
function tx(revisions: Revision[]) {
  const current = revisions.at(-1);
  return {
    deploymentConfigRevision: {
      findUnique: vi.fn(async () =>
        current ? { configId: "config", revision: current.revision, spec: current.spec } : null,
      ),
      findMany: vi.fn(async () => [...revisions].reverse()),
    },
  } as unknown as Prisma.TransactionClient;
}

const instance = { revisionId: "revision", variantKey: "default" };
const start = { rank: 0, action: "start" as const };
const stop = { rank: 0, action: "stop" as const };

describe("operator command authorship", () => {
  it("is the person's only when a person saved that exact text first and no agent ever did", async () => {
    expect(
      await deploymentOperatorCommandAuthor(
        tx([{ revision: 1, editorKind: "USER", spec: spec(START) }]),
        instance,
        start,
      ),
    ).toBe("user");
    // A person re-saving an agent's text does not launder it.
    expect(
      await deploymentOperatorCommandAuthor(
        tx([
          { revision: 1, editorKind: "AGENT", spec: spec(START) },
          { revision: 2, editorKind: "USER", spec: spec(START) },
        ]),
        instance,
        start,
      ),
    ).toBe("agent");
    // Judged per command text: the person's start stays theirs while the agent's stop is the
    // agent's, as long as no agent-saved revision ever held the start text.
    const person = tx([
      { revision: 1, editorKind: "USER", spec: spec(START, "sudo /usr/local/bin/agent-stop") },
    ]);
    expect(await deploymentOperatorCommandAuthor(person, instance, start)).toBe("user");
    const mixed = tx([
      { revision: 1, editorKind: "AGENT", spec: spec("sudo agent-start", STOP) },
      { revision: 2, editorKind: "USER", spec: spec(START, STOP) },
    ]);
    expect(await deploymentOperatorCommandAuthor(mixed, instance, start)).toBe("user");
    expect(await deploymentOperatorCommandAuthor(mixed, instance, stop)).toBe("agent");
    // The chunk-1 rule is conservative: an agent-saved revision that kept the person's text
    // marks it as the agent's too.
    const resaved = tx([
      { revision: 1, editorKind: "USER", spec: spec(START) },
      { revision: 2, editorKind: "AGENT", spec: spec(START, "sudo /usr/local/bin/agent-stop") },
    ]);
    expect(await deploymentOperatorCommandAuthor(resaved, instance, start)).toBe("agent");
  });

  it("is unknown whenever a person's authorship cannot be shown", async () => {
    // A scheduled save first held the text.
    expect(
      await deploymentOperatorCommandAuthor(
        tx([{ revision: 1, editorKind: "SCHEDULE", spec: spec(START) }]),
        instance,
        start,
      ),
    ).toBe("unknown");
    // An unreadable revision in the history may have been an agent's.
    expect(
      await deploymentOperatorCommandAuthor(
        tx([
          { revision: 1, editorKind: "AGENT", spec: { variants: "broken" } },
          { revision: 2, editorKind: "USER", spec: spec(START) },
        ]),
        instance,
        start,
      ),
    ).toBe("unknown");
    // A history longer than the scan may hide the first author.
    expect(
      await deploymentOperatorCommandAuthor(
        tx(
          Array.from({ length: 1024 }, (_, index) => ({
            revision: index + 1,
            editorKind: "USER" as const,
            spec: spec(START),
          })),
        ),
        instance,
        start,
      ),
    ).toBe("unknown");
    // Missing revision, variant or command.
    expect(await deploymentOperatorCommandAuthor(tx([]), instance, start)).toBe("unknown");
    expect(
      await deploymentOperatorCommandAuthor(
        tx([{ revision: 1, editorKind: "USER", spec: spec(START) }]),
        { ...instance, variantKey: "other" },
        start,
      ),
    ).toBe("unknown");
    expect(
      await deploymentOperatorCommandAuthor(
        tx([{ revision: 1, editorKind: "USER", spec: spec(START) }]),
        instance,
        { rank: 0, action: "readiness" },
      ),
    ).toBe("unknown");
  });

  it("mints a fresh canonical terminal id per dispatch", async () => {
    const revisions = tx([{ revision: 1, editorKind: "USER", spec: spec(START) }]);
    const first = await mintDeploymentOperator(revisions, instance, start);
    const second = await mintDeploymentOperator(revisions, instance, start);
    expect(first.commandAuthor).toBe("user");
    expect(isCanonicalBase64Url16(first.terminalId)).toBe(true);
    expect(first.terminalId).not.toBe(second.terminalId);
  });
});

describe("deploymentCommandSource", () => {
  const nodes = [0, 1].map((index) => ({
    id: `node-${index}`,
    online: true,
    protocolVersion: "2.11",
    allowDeployments: true,
    reportedDeployments: true,
    mode: "UNSUPERVISED" as const,
    localMode: "UNSUPERVISED" as const,
    execution: "systemd+linger",
    labels: [],
    info: {
      nodeKind: "unified" as const,
      memoryTotalMiB: 128 * 1024,
      interfaces: [{ name: "eth0", addresses: [`10.0.0.${index + 1}`] }],
    },
    budgets: {
      usableMemoryGb: 120,
      usableRamGb: null,
      usableVramGb: {},
      usableMemoryGbDefault: false,
      usableRamGbDefault: false,
      usableVramGbDefaults: {},
    },
    portStart: 30000,
    portEnd: 30999,
  }));

  it("names the command field each rendered step runs, as admission picks it", () => {
    const head = {
      management: "externalService",
      prepare: "sudo prepare-head",
      start: "sudo start-head",
      afterJoin: "sudo after-join-head",
      stop: STOP,
      status: "check",
      interactive: { prepare: true, afterJoin: true, stop: true },
    };
    const worker = {
      management: "externalService",
      start: "sudo start-worker",
      stop: STOP,
      status: "check",
      interactive: { start: true },
    };
    const multi: DeploymentVariant = variant(head, {
      groupSize: 2,
      iface: "eth0",
      resources: [
        { kind: "unified", memoryGb: 64 },
        { kind: "unified", memoryGb: 64 },
      ],
      commands: [head, worker],
    });
    const ranks = renderDeploymentGroup(
      multi,
      { id: "instance", revisionId: "revision", endpointSlug: "inst-fixture-a1b2c3d4e5f6" },
      [0, 1].map((rank) => ({
        nodeId: `node-${rank}`,
        rank,
        group: 0,
        resources: { kind: "unified" as const, memoryGb: 64, ramGb: 0, gpus: [] },
        port: 30001 + rank,
        distPort: rank === 0 ? 30100 : null,
      })),
      nodes,
    );
    for (const { placement, steps } of ranks)
      for (const step of steps) {
        const source = deploymentCommandSource(multi, placement.rank, step.phase);
        if (step.phase === "readiness") expect(source).toBeNull();
        else {
          // The source's interactive flag is exactly the rendered step's.
          const commands = multi.commands[placement.rank] as Record<string, unknown> & {
            interactive?: Record<string, boolean>;
          };
          expect(source && commands.interactive?.[source] === true).toBe(
            step.intent.interactive === true,
          );
        }
      }
    expect(deploymentCommandSource(multi, 0, "start")).toBe("afterJoin");
    expect(deploymentCommandSource(multi, 0, "prepare")).toBe("prepare");
    expect(deploymentCommandSource(multi, 1, "start")).toBe("start");
    expect(deploymentCommandSource(multi, 1, "stop")).toBe("stop");
    expect(deploymentCommandSource(multi, 0, "health")).toBeNull();
  });
});
