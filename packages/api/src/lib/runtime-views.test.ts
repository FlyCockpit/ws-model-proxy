import type { Prisma } from "@ws-model-proxy/db";
import { describe, expect, it } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import { runtimeSpecSchema } from "./runtime-spec";
import { loadStepVersions, type StepRow, type StepViewContext, stepView } from "./runtime-views";
import type { StepIntent } from "./step-intent";

const HASH = "b".repeat(64);

function spec(groupSize: number, start: string, interactive = true) {
  return runtimeSpecSchema.parse({
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: "m" }],
    launch: {
      management: "service",
      groupSize,
      resources: [{ kind: "none" }],
      labels: [],
      commands: [
        {
          start,
          stop: "pkill -f {{port}}",
          status: "true",
          ...(interactive ? { interactive: { start: true } } : {}),
        },
      ],
      readiness: { path: "/health", expectedStatus: 200, timeoutMs: 60000 },
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
      ...(groupSize > 1 ? { fabric: "qsfp" } : {}),
    },
  });
}

function intent(overrides: Partial<StepIntent> = {}): StepIntent {
  return {
    operationId: "op1",
    runtimeId: "rt1",
    launchVersionId: "ver1",
    launchHash: HASH,
    rank: 0,
    nnodes: 1,
    handle: "i-abcdefabcdef",
    unitName: "wsmp-rt-i-abcdefabcdef-0.service",
    port: 30001,
    distPort: null,
    fabricId: null,
    placeholders: { port: 30001 },
    timeoutMs: 60_000,
    interactive: true,
    ...overrides,
  };
}

function step(value: unknown, rank = 0): StepRow {
  return {
    id: "step1",
    rank,
    phase: "START",
    state: "AWAITING_OPERATOR",
    attempts: 1,
    errorCode: null,
    intent: value as StepRow["intent"],
    operatorTerminalId: null,
    updatedAt: new Date("2026-10-06T12:00:00Z"),
    headAddr: null,
  };
}

function context(overrides: Partial<StepViewContext> = {}): StepViewContext {
  return {
    launchVersionId: "ver1",
    spec: spec(1, "sudo serve --port {{port}}"),
    launchHash: HASH,
    author: "USER",
    versions: new Map(),
    fabric: null,
    headNodeId: "node-a",
    ...overrides,
  };
}

describe("stepView rendered command", () => {
  it("renders an interactive step from its intent and names the author", () => {
    const view = stepView(step(intent()), context());
    expect(view).toMatchObject({
      command: "sudo serve --port {{port}}",
      commandAuthor: "user",
      rendered: { state: "ready", text: "sudo serve --port 30001", nodeFills: [] },
      headAddr: null,
    });
  });

  it("shows the head_addr dispatch sends, and leaves the node's own fabric values", () => {
    const multi = context({
      spec: spec(2, "serve --host {{fabric_ip}} --head {{head_addr}} --rank {{node_rank}}"),
      fabric: {
        id: "fab1",
        name: "qsfp",
        Members: [
          { nodeId: "node-b", ip: "10.0.0.6" },
          { nodeId: "node-a", ip: "10.0.0.5" },
        ],
      },
    });
    const view = stepView(step(intent({ rank: 1, nnodes: 2, fabricId: "fab1" }), 1), multi);
    expect(view.headAddr).toBe("10.0.0.5");
    expect(view.rendered).toEqual({
      state: "ready",
      text: "serve --host {{fabric_ip}} --head 10.0.0.5 --rank 1",
      nodeFills: ["fabric_ip"],
    });
    // The head has no address on the step's fabric (or the fabric changed): nothing is guessed.
    expect(
      stepView(step(intent({ rank: 1, nnodes: 2, fabricId: "fab2" }), 1), multi).rendered,
    ).toEqual({ state: "unavailable", reason: "head_addr" });
    expect(
      stepView(step(intent({ rank: 1, nnodes: 2, fabricId: "fab1" }), 1), {
        ...multi,
        headNodeId: "node-c",
      }).rendered,
    ).toEqual({ state: "unavailable", reason: "head_addr" });
  });

  it("shows no command when the step names another spec, or its intent is unreadable", () => {
    // A version that is not known here (gone, or not loaded): nothing is shown, never the
    // instance's own version's text or author.
    expect(stepView(step(intent({ launchVersionId: "ver0" })), context())).toMatchObject({
      command: null,
      commandAuthor: null,
      rendered: { state: "unavailable", reason: "version" },
    });
    expect(stepView(step(intent({ launchHash: "c".repeat(64) })), context())).toMatchObject({
      interactive: true,
      command: null,
      commandAuthor: null,
      rendered: { state: "unavailable", reason: "version" },
    });
    expect(stepView(step({}), context())).toMatchObject({
      interactive: true,
      command: null,
      commandAuthor: null,
      rendered: { state: "unavailable", reason: "intent" },
    });
    expect(stepView(step(intent({ rank: 1 })), context()).rendered).toEqual({
      state: "unavailable",
      reason: "intent",
    });
  });

  it("says when the node would refuse the job", () => {
    const view = stepView(step(intent()), context({ spec: spec(1, "serve {{fabric_ip}}") }));
    expect(view.rendered).toEqual({ state: "refused", field: "placeholders.fabric_ip" });
  });

  it("renders nothing for steps no person answers (the intent decides, as at dispatch)", () => {
    const view = stepView(step(intent({ interactive: false })), context());
    expect(view).toMatchObject({ interactive: false, rendered: null, headAddr: null });
    const unreadable = stepView(step({}), context({ spec: spec(1, "serve {{port}}", false) }));
    expect(unreadable).toMatchObject({ interactive: false, rendered: null });
  });
});

describe("stepView of a step that names another version (a restart's earlier launch)", () => {
  const OLD_HASH = "c".repeat(64);
  const old = {
    spec: spec(1, "sudo old-serve --port {{port}}"),
    launchHash: OLD_HASH,
    author: "AGENT" as const,
  };
  const stop = (value: StepIntent, overrides: Partial<StepRow> = {}): StepRow => ({
    ...step(value),
    phase: "STOP",
    ...overrides,
  });

  it("shows the named version's command and author, never the successor's", () => {
    const named = stepView(
      stop(intent({ launchVersionId: "ver0", launchHash: OLD_HASH })),
      context({ versions: new Map([["ver0", old]]) }),
    );
    expect(named).toMatchObject({ command: "pkill -f {{port}}", commandAuthor: "agent" });
    // Same launch, another author: the author is the named version's.
    const sameLaunch = stepView(
      stop(intent({ launchVersionId: "ver0" })),
      context({ versions: new Map([["ver0", { ...old, launchHash: HASH }]]) }),
    );
    expect(sameLaunch).toMatchObject({ commandAuthor: "agent" });
    // An interactive start of that version renders from its spec.
    expect(
      stepView(
        step(intent({ launchVersionId: "ver0", launchHash: OLD_HASH })),
        context({ versions: new Map([["ver0", old]]) }),
      ).rendered,
    ).toEqual({ state: "ready", text: "sudo old-serve --port 30001", nodeFills: [] });
  });

  it("previews a stop with the head address its launch was dispatched with", () => {
    const multiSpec = spec(2, "serve --head {{head_addr}}");
    const interactiveStop = runtimeSpecSchema.parse({
      ...multiSpec,
      launch: {
        ...multiSpec.launch,
        commands: [
          {
            start: "serve --head {{head_addr}}",
            stop: "stop --head {{head_addr}}",
            status: "true",
            interactive: { stop: true },
          },
        ],
      },
    });
    // The head's node left the fabric since: dispatch sends the stored address, and so does the
    // preview.
    const view = stepView(
      stop(intent({ rank: 1, nnodes: 2, fabricId: "fab1" }), { rank: 1, headAddr: "10.0.0.9" }),
      context({ spec: interactiveStop, fabric: { id: "fab1", name: "qsfp", Members: [] } }),
    );
    expect(view.headAddr).toBe("10.0.0.9");
    expect(view.rendered).toMatchObject({ state: "ready", text: "stop --head 10.0.0.9" });
  });
});

describe("loadStepVersions", () => {
  it("reads the other versions steps name in one owner-scoped query, none when there are none", async () => {
    const db = mockDeep<Prisma.TransactionClient>();
    db.runtimeVersion.findMany.mockResolvedValue([
      { id: "ver0", spec: spec(1, "old"), launchHash: "c".repeat(64), editor: "AGENT" },
    ] as never);
    const rows = [
      {
        launchVersionId: "ver1",
        Steps: [{ intent: intent() }, { intent: intent({ launchVersionId: "ver0" }) }],
      },
      { launchVersionId: "ver2", Steps: [{ intent: intent({ launchVersionId: "ver0" }) }] },
    ];
    const versions = await loadStepVersions(db, "u-1", rows);
    expect(versions.get("ver0")).toMatchObject({ launchHash: "c".repeat(64), author: "AGENT" });
    expect(db.runtimeVersion.findMany).toHaveBeenCalledTimes(1);
    expect(db.runtimeVersion.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: ["ver0"] }, Runtime: { userId: "u-1" } },
    });
    db.runtimeVersion.findMany.mockClear();
    expect(
      (
        await loadStepVersions(db, "u-1", [
          { launchVersionId: "ver1", Steps: [{ intent: intent() }] },
        ])
      ).size,
    ).toBe(0);
    expect(db.runtimeVersion.findMany).not.toHaveBeenCalled();
  });
});
