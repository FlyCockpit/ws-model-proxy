import { runtimeSpecSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { describe, expect, it } from "vitest";

import {
  draftPathOf,
  draftToSpec,
  editorValues,
  readSpecEditor,
  sameSpec,
  specToDraft,
} from "./runtime-spec-draft";

const HEALTH = { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 };
const MESSAGES = { notJson: "not json", wrongKind: "wrong kind" };

const SPECS = {
  vllm: {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: "Qwen/Qwen3-8B" }],
    launch: {
      management: "process",
      groupSize: 1,
      resources: [{ kind: "discrete", gpuCount: 1, vramGb: 24 }],
      labels: [],
      commands: [{ start: "vllm serve x --host 127.0.0.1 --port {{port}}", stop: "true" }],
      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 900_000 },
      health: HEALTH,
    },
  },
  multiNode: {
    api: "openai",
    engine: "sglang",
    modelType: "embeddings",
    models: [
      {
        id: "e5",
        capabilities: ["embedding"],
        embeddingContract: {
          model: "e5",
          revision: "r1",
          dimensions: 1024,
          normalization: "l2",
          vectorSpace: "e5-v1",
        },
      },
    ],
    launch: {
      management: "service",
      groupSize: 2,
      resources: [
        { kind: "discrete", gpuCount: 8, vramGb: 80, ramGb: 512, vendor: "nvidia" },
        { kind: "cpu", ramGb: 0.5 },
      ],
      labels: ["dgx", "ib"],
      fabric: "ib0",
      secrets: ["WSMP_SECRET_HF"],
      commands: [
        {
          start: "systemctl start a",
          stop: "systemctl stop a",
          status: "systemctl is-active a",
          prepare: "pull",
          interactive: { prepare: true },
          timeoutsSec: { prepare: 7200, stop: 30 },
        },
        { start: "b", stop: "c", status: "d", health: "e", timeoutsSec: {} },
      ],
      readiness: { path: "/health", expectedStatus: 204, timeoutMs: 60_000 },
      health: HEALTH,
    },
    metricsReader: { kind: "builtin" },
    expandMedia: false,
  },
  service: {
    launch: {
      management: "service",
      groupSize: 1,
      resources: [{ kind: "none" }],
      labels: [],
      port: { fixed: 9000 },
      commands: [{ start: "systemctl start s", stop: "systemctl stop s", status: "x" }],
      health: HEALTH,
    },
  },
  alwaysOn: {
    api: "anthropic",
    engine: "other",
    modelType: "llm",
    address: {
      baseUrl: "http://127.0.0.1:9000/v1",
      auth: { mode: "bearer", env: "WSMP_SECRET_KEY" },
      headers: [{ name: "X-Org", env: "WSMP_SECRET_ORG" }],
    },
    expandMedia: true,
  },
} as const;

describe("runtime spec draft", () => {
  it.each(Object.entries(SPECS))("round-trips %s unchanged", (name, spec) => {
    expect(runtimeSpecSchema.safeParse(spec).success).toBe(true);
    const kind = name === "alwaysOn" ? "ALWAYS_ON" : "STARTABLE";
    const back = draftToSpec(specToDraft(spec), spec as unknown as Record<string, unknown>, kind);
    expect(back).toEqual(spec);
    expect(sameSpec(back, spec)).toBe(true);
  });

  it("writes form edits into the spec, timeouts per command included", () => {
    const values = editorValues(SPECS.vllm);
    values.draft.commands[0].timeouts.start = "1200";
    values.draft.commands[0].status = "curl -f localhost:{{port}}";
    values.draft.models[0].id = "Qwen/Qwen3-32B";
    values.draft.labels = "gpu, big";
    const reading = readSpecEditor(values, "STARTABLE", MESSAGES);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.spec.models?.[0]?.id).toBe("Qwen/Qwen3-32B");
    expect(reading.spec.launch?.labels).toEqual(["gpu", "big"]);
    expect(reading.spec.launch?.commands[0]).toMatchObject({
      status: "curl -f localhost:{{port}}",
      timeoutsSec: { start: 1200 },
    });
  });

  it("switches an engine preset to an always-on address", () => {
    const values = editorValues(SPECS.vllm);
    const reading = readSpecEditor(values, "ALWAYS_ON", MESSAGES);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.spec.launch).toBeUndefined();
    expect(reading.spec.address).toEqual({ baseUrl: "http://127.0.0.1:8000/v1" });
    expect(reading.spec.models).toEqual([{ id: "Qwen/Qwen3-8B" }]);
  });

  it("points spec issues at the input that owns them", () => {
    const values = editorValues(SPECS.vllm);
    values.draft.commands[0].start = " ";
    values.draft.commands[0].timeouts.stop = "999999";
    values.draft.groupSize = "";
    const reading = readSpecEditor(values, "STARTABLE", MESSAGES);
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    const paths = reading.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("draft.commands.0.start");
    expect(paths).toContain("draft.commands.0.timeouts.stop");
    expect(paths).toContain("draft.groupSize");
  });

  it("reads the JSON tab and refuses the other kind", () => {
    const values = { ...editorValues(SPECS.service), tab: "json" as const };
    expect(readSpecEditor(values, "STARTABLE", MESSAGES).ok).toBe(true);
    expect(readSpecEditor(values, "ALWAYS_ON", MESSAGES)).toEqual({
      ok: false,
      issues: [{ path: ["json"], message: "wrong kind" }],
    });
    expect(readSpecEditor({ ...values, json: "{" }, "STARTABLE", MESSAGES)).toEqual({
      ok: false,
      issues: [{ path: ["json"], message: "not json" }],
    });
  });

  it("maps spec paths to draft paths", () => {
    expect(draftPathOf(["launch", "port", "fixed"])).toEqual(["fixedPort"]);
    expect(draftPathOf(["launch", "resources", 1, "vramGb"])).toEqual(["resources", 1, "vramGb"]);
    expect(draftPathOf(["launch", "readiness"])).toEqual(["readiness", "enabled"]);
    expect(draftPathOf(["address", "auth", "env"])).toBeNull();
    expect(draftPathOf([])).toBeNull();
  });
});
