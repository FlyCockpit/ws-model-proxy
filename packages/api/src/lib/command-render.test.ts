import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fraction,
  gpuIds,
  NODE_LOCAL_PLACEHOLDERS,
  positiveDecimal,
  renderStepCommand,
  type StepCommandPhase,
  substitute,
} from "./command-render";
import { type RuntimeSpec, runtimeSpecSchema } from "./runtime-spec";
import { type StepIntent, stepJobPlaceholders } from "./step-intent";

const repoRoot = join(import.meta.dirname, "../../../..");
type Vectors = {
  values: Record<string, string>;
  substitute: Array<{
    text: string;
    values?: Record<string, string>;
    rendered?: string;
    missing?: string;
  }>;
  gpuIds: { valid: string[]; invalid: string[] };
  positiveDecimal: { valid: string[]; invalid: string[] };
  fraction: { valid: string[]; invalid: string[] };
  jobs: {
    nodeValues: Record<string, string>;
    cases: Array<{
      name: string;
      groupSize: number;
      rank: number;
      nnodes: number;
      phase: string;
      interactive: boolean;
      commands: Array<Record<string, unknown>>;
      placeholders: Record<string, string | number>;
      command?: string;
      refused?: string;
      serverAmbiguous?: boolean;
    }>;
  };
};
const vectors = JSON.parse(
  readFileSync(
    join(repoRoot, "apps/cli/tests/fixtures/relay-3.0/rules/command-render.json"),
    "utf8",
  ),
) as Vectors;

describe("shared render vectors (render.rs checks the same file)", () => {
  it("substitutes exactly as the node does", () => {
    expect(vectors.substitute.length).toBeGreaterThanOrEqual(20);
    for (const vector of vectors.substitute) {
      const values = new Map(Object.entries({ ...vectors.values, ...vector.values }));
      const result = substitute(vector.text, values);
      if (vector.rendered !== undefined)
        expect(result, vector.text).toEqual({
          ok: true,
          text: vector.rendered,
          nodeFills: [],
          kept: [],
        });
      else expect(result, vector.text).toEqual({ ok: false, missing: vector.missing });
    }
  });

  it("renders whole jobs as the node does (the node's own values fill nodeFills)", () => {
    const { nodeValues, cases } = vectors.jobs;
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const job of cases) {
      const launch: Record<string, unknown> = {
        management: "service",
        groupSize: job.groupSize,
        resources: [{ kind: "none" }],
        labels: [],
        commands: job.commands.map((entry) => ({
          stop: "pkill -f {{port}}",
          status: "true",
          ...entry,
        })),
        readiness: { path: "/health", expectedStatus: 200, timeoutMs: 60000 },
        health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
        ...(job.groupSize > 1 ? { fabric: "qsfp" } : {}),
      };
      const jobSpec = runtimeSpecSchema.parse({
        api: "openai",
        engine: "vllm",
        modelType: "llm",
        models: [{ id: "m" }],
        launch,
      });
      const { head_addr: headAddr, ...placeholders } = job.placeholders;
      const jobIntent = intent({
        rank: job.rank,
        nnodes: job.nnodes,
        fabricId: job.nnodes > 1 ? "fab1" : null,
        interactive: job.interactive,
        port: Number(job.placeholders.port),
        placeholders,
      });
      const result = renderStepCommand({
        spec: jobSpec,
        phase: job.phase.toUpperCase() as StepCommandPhase,
        intent: jobIntent,
        placeholders: stepJobPlaceholders(
          jobIntent,
          typeof headAddr === "string" ? headAddr : null,
        ),
        fabricName: "qsfp",
      });
      const nodeOnly = job.refused?.replace(/^placeholders\./, "");
      // The server sees the refusal itself unless only the node knows the value is missing.
      if (
        job.refused !== undefined &&
        (result.state === "refused" ||
          !(NODE_LOCAL_PLACEHOLDERS as readonly (string | undefined)[]).includes(nodeOnly))
      ) {
        expect(result, job.name).toEqual({ state: "refused", field: job.refused });
        continue;
      }
      if (job.serverAmbiguous) {
        expect(result, job.name).toEqual({ state: "unavailable", reason: "node_fill_ambiguous" });
        continue;
      }
      if (result.state !== "ready") throw new Error(`${job.name}: ${JSON.stringify(result)}`);
      // What the node runs: each node-local value it has, else it refuses.
      let text = result.text;
      const missing = result.nodeFills.find((name) => nodeValues[name] === undefined);
      if (job.refused !== undefined) {
        // Only the node knows it lacks this value: the server shows it to be filled there.
        expect(missing, job.name).toBe(nodeOnly);
        continue;
      }
      expect(missing, job.name).toBeUndefined();
      for (const name of result.nodeFills)
        text = text.split(`{{${name}}}`).join(nodeValues[name] ?? "");
      expect(text, job.name).toBe(job.command);
    }
    // A node-local value the node does not have: the server shows it, the node refuses.
    const rdma = cases.find((job) => job.refused === "placeholders.fabric_rdma_device");
    expect(rdma).toBeDefined();
  });

  it("types values exactly as the node does", () => {
    const checks = [
      ["gpuIds", gpuIds],
      ["positiveDecimal", positiveDecimal],
      ["fraction", fraction],
    ] as const;
    for (const [key, check] of checks) {
      for (const value of vectors[key].valid) expect(check(value), `${key} ${value}`).toBe(true);
      for (const value of vectors[key].invalid) expect(check(value), `${key} ${value}`).toBe(false);
    }
  });
});

describe("node-local placeholders", () => {
  it("stay visible as {{name}} and are listed once, never guessed", () => {
    const result = substitute(
      "--host {{fabric_ip}} --if {{fabric_iface}} {{fabric_ip}} {{port}}",
      new Map([["port", "30001"]]),
      new Set(["fabric_ip", "fabric_iface", "fabric_rdma_device"]),
    );
    expect(result).toEqual({
      ok: true,
      text: "--host {{fabric_ip}} --if {{fabric_iface}} {{fabric_ip}} 30001",
      nodeFills: ["fabric_ip", "fabric_iface"],
      kept: ["fabric_ip", "fabric_iface", "fabric_ip"],
    });
  });

  it("are missing without the node's fabric (single-node jobs)", () => {
    expect(substitute("{{fabric_ip}}", new Map())).toEqual({ ok: false, missing: "fabric_ip" });
  });
});

function spec(commands: Record<string, unknown>, groupSize = 1, extra: object = {}): RuntimeSpec {
  return runtimeSpecSchema.parse({
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: "m" }],
    launch: {
      management: "process",
      groupSize,
      resources: [{ kind: "none" }],
      labels: [],
      commands: [{ stop: "pkill -f {{port}}", ...commands }],
      readiness: { path: "/health", expectedStatus: 200, timeoutMs: 60000 },
      health: { intervalMs: 30000, failureThreshold: 3, successThreshold: 1 },
      ...(groupSize > 1 ? { fabric: "qsfp" } : {}),
      ...extra,
    },
  });
}

function intent(overrides: Partial<StepIntent> = {}): StepIntent {
  return {
    operationId: "op1",
    runtimeId: "rt1",
    launchVersionId: "vr1",
    launchHash: "a".repeat(64),
    rank: 0,
    nnodes: 1,
    handle: "i-abcdefabcdef",
    unitName: "wsmp-rt-i-abcdefabcdef-0.service",
    port: 30001,
    distPort: null,
    fabricId: null,
    placeholders: { port: 30001, gpu_ids: "0,1", memory_gb: "64" },
    timeoutMs: 60_000,
    interactive: false,
    ...overrides,
  };
}

function render(
  s: RuntimeSpec,
  i: StepIntent,
  options: { phase?: StepCommandPhase; headAddr?: string | null; fabricName?: string } = {},
) {
  return renderStepCommand({
    spec: s,
    phase: options.phase ?? "START",
    intent: i,
    placeholders: stepJobPlaceholders(i, options.headAddr ?? null),
    fabricName: options.fabricName ?? null,
  });
}

describe("renderStepCommand", () => {
  it("renders the phase's command from the job's values, raw", () => {
    const s = spec({
      start: "sudo CUDA_VISIBLE_DEVICES={{gpu_ids}} serve --port {{port}} --mem {{memory_gb}}",
      prepare: "sudo apt-get install -y x # rank {{node_rank}} of {{nnodes}}",
    });
    expect(render(s, intent())).toEqual({
      state: "ready",
      text: "sudo CUDA_VISIBLE_DEVICES=0,1 serve --port 30001 --mem 64",
      nodeFills: [],
    });
    expect(render(s, intent(), { phase: "PREPARE" })).toEqual({
      state: "ready",
      text: "sudo apt-get install -y x # rank 0 of 1",
      nodeFills: [],
    });
    expect(render(s, intent(), { phase: "STOP" })).toEqual({
      state: "ready",
      text: "pkill -f 30001",
      nodeFills: [],
    });
  });

  it("renders a multi-node step with the dispatch's head_addr and leaves the node's fabric values", () => {
    const s = spec(
      {
        start:
          "serve --host {{fabric_ip}} --head {{head_addr}}:{{dist_port}} --ib {{fabric_rdma_device}} --rank {{node_rank}}",
      },
      2,
    );
    const i = intent({
      rank: 1,
      nnodes: 2,
      fabricId: "fab1",
      distPort: 30002,
      placeholders: { port: 30001, dist_port: 30002 },
    });
    expect(render(s, i, { headAddr: "10.0.0.5", fabricName: "qsfp" })).toEqual({
      state: "ready",
      text: "serve --host {{fabric_ip}} --head 10.0.0.5:30002 --ib {{fabric_rdma_device}} --rank 1",
      nodeFills: ["fabric_ip", "fabric_rdma_device"],
    });
    // Without the head's address the job would carry none: the node refuses it.
    expect(render(s, i, { fabricName: "qsfp" })).toEqual({ state: "refused", field: "fabricId" });
    // A definition pinned to another fabric is refused.
    expect(render(s, i, { headAddr: "10.0.0.5", fabricName: "eth" })).toEqual({
      state: "refused",
      field: "fabricId",
    });
    expect(render(s, i, { headAddr: "127.0.0.1", fabricName: "qsfp" })).toEqual({
      state: "refused",
      field: "placeholders.head_addr",
    });
  });

  it("refuses what the node refuses: absent values, bad values, other commands", () => {
    expect(render(spec({ start: "serve --host {{fabric_ip}}" }), intent())).toEqual({
      state: "refused",
      field: "placeholders.fabric_ip",
    });
    expect(render(spec({ start: "serve {{vram_gb}}" }), intent())).toEqual({
      state: "refused",
      field: "placeholders.vram_gb",
    });
    expect(
      render(spec({ start: "serve" }), intent({ placeholders: { port: 30001, gpu_ids: "1,1" } })),
    ).toEqual({ state: "refused", field: "placeholders.gpu_ids" });
    expect(
      render(spec({ start: "serve" }), intent({ placeholders: { port: 30001, memory_gb: "0" } })),
    ).toEqual({ state: "refused", field: "placeholders.memory_gb" });
    // The node renders stop, status and health with every job: one that fails refuses it.
    expect(render(spec({ start: "serve", status: "check {{vram_gb}}" }), intent())).toEqual({
      state: "refused",
      field: "placeholders.vram_gb",
    });
    expect(render(spec({ start: "serve" }), intent({ nnodes: 2 }))).toEqual({
      state: "refused",
      field: "nnodes",
    });
    expect(
      render(spec({ start: "serve" }, 1, { port: { fixed: 8000 } }), intent({ port: 30001 })),
    ).toEqual({ state: "refused", field: "placeholders.port" });
  });

  it("refuses a command the values push past the size limit", () => {
    const start = `serve ${"{{gpu_ids}}".repeat(300)}`;
    const many = Array.from({ length: 64 }, (_, n) => String(n)).join(",");
    expect(
      render(spec({ start }), intent({ placeholders: { port: 30001, gpu_ids: many } })),
    ).toEqual({ state: "refused", field: "command" });
  });
});
