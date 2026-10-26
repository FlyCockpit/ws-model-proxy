import { RUNTIME_PRESET_LIST } from "@ws-model-proxy/api/lib/runtime-presets";
import { runtimeSpecSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { describe, expect, it } from "vitest";

import {
  draftPathOf,
  draftToSpec,
  editorValues,
  losslessDraft,
  parseBase,
  readSpecEditor,
  sameSpec,
  specToDraft,
  switchEditorKind,
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

  it("keeps a launch's shell through the form", () => {
    const spec = {
      ...SPECS.vllm,
      launch: { ...(SPECS.vllm.launch as Record<string, unknown>), shell: "pwsh" },
    };
    expect(losslessDraft(spec, "STARTABLE")).not.toBeNull();
  });

  it.each(RUNTIME_PRESET_LIST.map((preset) => [preset.id, preset] as const))(
    "creates the %s preset unchanged from the form",
    (_id, preset) => {
      const reading = readSpecEditor(editorValues(preset.spec), preset.kind, MESSAGES);
      expect(reading.ok).toBe(true);
      if (!reading.ok) return;
      expect(reading.spec).toEqual(preset.spec);
    },
  );

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

  it("keeps a model's contract with that model when another one is removed", () => {
    const values = editorValues({
      ...SPECS.multiNode,
      models: [{ id: "first" }, ...SPECS.multiNode.models],
    });
    values.draft.models.splice(0, 1);
    const reading = readSpecEditor(values, "STARTABLE", MESSAGES);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.spec.models).toEqual(SPECS.multiNode.models);
  });

  it("copies a shared command's interactive steps to every node when split per node", () => {
    const shared = {
      ...SPECS.multiNode,
      launch: { ...SPECS.multiNode.launch, commands: [SPECS.multiNode.launch.commands[0]] },
    };
    const values = editorValues(shared);
    const [first] = values.draft.commands;
    values.draft.commands = [first, { ...first, timeouts: { ...first.timeouts } }];
    const spec = draftToSpec(values.draft, parseBase(values.base), "STARTABLE") as {
      launch: { commands: Array<{ interactive?: unknown }> };
    };
    expect(spec.launch.commands.map((commands) => commands.interactive)).toEqual([
      { prepare: true },
      { prepare: true },
    ]);
  });

  it("drops a fabric left over from several nodes, and reads only plain decimals", () => {
    const values = editorValues(SPECS.multiNode);
    values.draft.groupSize = "1";
    values.draft.resources = values.draft.resources.slice(0, 1);
    values.draft.commands = values.draft.commands.slice(0, 1);
    const spec = draftToSpec(values.draft, parseBase(values.base), "STARTABLE") as {
      launch: { fabric?: string };
    };
    expect(spec.launch.fabric).toBeUndefined();
    values.draft.fixedPort = "0x2328";
    const reading = readSpecEditor(values, "STARTABLE", MESSAGES);
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.issues.map((issue) => issue.path.join("."))).toContain("draft.fixedPort");
  });

  it("maps spec paths to draft paths", () => {
    expect(draftPathOf(["launch", "port", "fixed"])).toEqual(["fixedPort"]);
    expect(draftPathOf(["launch", "resources", 1, "vramGb"])).toEqual(["resources", 1, "vramGb"]);
    expect(draftPathOf(["launch", "readiness"])).toEqual(["readiness", "enabled"]);
    expect(draftPathOf(["address", "auth", "env"])).toBeNull();
    expect(draftPathOf([])).toBeNull();
    expect(draftPathOf(["launch", "reservations"])).toEqual(["reservations"]);
    expect(draftPathOf(["launch", "reservations", 0, "labels"])).toEqual([
      "reservations",
      0,
      "labels",
    ]);
    expect(draftPathOf(["launch", "reservations", 1, "resources", "memoryGb"])).toEqual([
      "reservations",
      1,
      "resource",
      "memoryGb",
    ]);
    expect(draftPathOf(["launch", "reservations", 0, "resources", "vendor"])).toEqual([
      "reservations",
      0,
      "resource",
      "vendor",
    ]);
  });

  it("round-trips a discrete reservation's GPU vendor", () => {
    const spec = {
      launch: {
        management: "service",
        groupSize: 1,
        resources: [{ kind: "unified", memoryGb: 100 }],
        labels: ["ds-head"],
        reservations: [
          {
            labels: ["ds-worker"],
            resources: { kind: "discrete", gpuCount: 2, vramGb: 80, vendor: "nvidia" },
          },
        ],
        commands: [{ start: "up", stop: "down", status: "check" }],
        health: HEALTH,
      },
    };
    expect(runtimeSpecSchema.safeParse(spec).success).toBe(true);
    const draft = losslessDraft(spec, "STARTABLE");
    expect(draft?.reservations[0]?.resource.vendor).toBe("nvidia");
    if (!draft) return;
    expect(draftToSpec(draft, spec, "STARTABLE")).toEqual(spec);
    // Back to "any vendor": the key is dropped, not written empty.
    const [reservation] = draft.reservations;
    const anyVendor = draftToSpec(
      {
        ...draft,
        reservations: [{ ...reservation, resource: { ...reservation.resource, vendor: "" } }],
      },
      spec,
      "STARTABLE",
    );
    expect(anyVendor.launch?.reservations).toEqual([
      { labels: ["ds-worker"], resources: { kind: "discrete", gpuCount: 2, vramGb: 80 } },
    ]);
  });

  it("round-trips reservations, edits them, and points their issues at their inputs", () => {
    const spec = {
      launch: {
        management: "service",
        groupSize: 1,
        resources: [{ kind: "unified", memoryGb: 100 }],
        labels: ["ds-head"],
        reservations: [
          { labels: ["ds-worker"], resources: { kind: "unified", memoryGb: 100 } },
          { labels: ["ds-worker", "rack-b"], resources: { kind: "cpu", ramGb: 8 } },
        ],
        commands: [{ start: "up", stop: "down", status: "check" }],
        health: HEALTH,
      },
    };
    expect(runtimeSpecSchema.safeParse(spec).success).toBe(true);
    const draft = specToDraft(spec);
    expect(draft.reservations.map((reservation) => reservation.labels)).toEqual([
      "ds-worker",
      "ds-worker, rack-b",
    ]);
    expect(draftToSpec(draft, spec, "STARTABLE")).toEqual(spec);
    // Removing every reservation drops the field; an empty list as written stays.
    expect(
      (draftToSpec({ ...draft, reservations: [] }, spec, "STARTABLE").launch as object) ?? {},
    ).not.toHaveProperty("reservations");
    const empty = { launch: { ...spec.launch, reservations: [] } };
    expect(draftToSpec(specToDraft(empty), empty, "STARTABLE")).toEqual(empty);
    // A reservation without labels on a group: both issues land on their inputs.
    const values = editorValues(spec);
    values.draft = {
      ...values.draft,
      groupSize: "2",
      reservations: [{ ...values.draft.reservations[0], labels: "" }] as typeof draft.reservations,
    };
    const reading = readSpecEditor(values, "STARTABLE", MESSAGES);
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    const paths = reading.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("draft.reservations");
    expect(paths).toContain("draft.reservations.0.labels");
  });
});

describe("JSON the form cannot read", () => {
  it("refuses reservations the form cannot show instead of dropping them", () => {
    for (const reservations of [
      {},
      { labels: ["worker"], resources: { kind: "unified", memoryGb: 100 } },
      "x",
      null,
      [null],
      [{ labels: "worker" }],
      [{ labels: [1] }],
      [{ labels: ["worker"], resources: "big" }],
    ])
      expect(() => specToDraft({ launch: { groupSize: 1, reservations } })).toThrow(TypeError);
    // Readable shapes still convert (missing labels show empty; validation names them).
    expect(specToDraft({ launch: { groupSize: 1 } }).reservations).toEqual([]);
    expect(specToDraft({ launch: { groupSize: 1, reservations: [{}] } }).reservations).toEqual([
      expect.objectContaining({ labels: "" }),
    ]);
    expect(
      specToDraft({
        launch: {
          groupSize: 1,
          reservations: [{ labels: ["a", "b"], resources: { kind: "unified", memoryGb: 8 } }],
        },
      }).reservations,
    ).toEqual([expect.objectContaining({ labels: "a, b" })]);
  });

  it("refuses labels the form would split or drop instead of rewriting them (F10)", () => {
    for (const labels of [["worker,other"], ["worker other"], ["worker\tother"], [""]]) {
      expect(() => specToDraft({ launch: { groupSize: 1, reservations: [{ labels }] } })).toThrow(
        TypeError,
      );
      expect(() => specToDraft({ launch: { groupSize: 1, labels } })).toThrow(TypeError);
    }
    // The JSON tab keeps exactly what was written.
    const json = JSON.stringify({
      launch: { groupSize: 1, reservations: [{ labels: ["worker,other"] }] },
    });
    const values = { tab: "json" as const, draft: specToDraft({}), json, base: json, check: "" };
    expect(switchEditorKind(values, "STARTABLE")).toBe(values);
    // Control: ordinary labels still convert, one label each.
    expect(specToDraft({ launch: { groupSize: 1, labels: ["gpu", "big-mem"] } }).labels).toBe(
      "gpu, big-mem",
    );
  });

  it("keeps the JSON tab when switching kind with unreadable reservations", () => {
    const json = JSON.stringify({ launch: { groupSize: 1, reservations: { labels: ["w"] } } });
    const values = { tab: "json" as const, draft: specToDraft({}), json, base: json, check: "" };
    expect(switchEditorKind(values, "ALWAYS_ON")).toBe(values);
  });

  it("keeps the JSON tab as written when switching kind with an unreadable shape", () => {
    const json = JSON.stringify({ models: {}, launch: { groupSize: 1 } });
    const values = { tab: "json" as const, draft: specToDraft({}), json, base: json, check: "" };
    expect(switchEditorKind(values, "ALWAYS_ON")).toBe(values);
  });
});

describe("lossless form conversion (F10 class)", () => {
  it.each(Object.entries(SPECS))("converts %s to the form exactly", (name, spec) => {
    const kind = name === "alwaysOn" ? "ALWAYS_ON" : "STARTABLE";
    expect(losslessDraft(spec, kind)).not.toBeNull();
    expect(editorValues(spec, kind).tab).toBe("form");
  });

  it.each(RUNTIME_PRESET_LIST.map((preset) => [preset.id, preset] as const))(
    "converts the %s preset to the form exactly",
    (_id, preset) => {
      expect(losslessDraft(preset.spec, preset.kind)).not.toBeNull();
    },
  );

  const launch = SPECS.vllm.launch;
  it.each([
    [
      "an unknown key in a reservation entry",
      {
        ...SPECS.vllm,
        launch: {
          ...launch,
          reservations: [{ labels: ["w"], resources: { kind: "none" }, memoryGb: 100 }],
        },
      },
    ],
    ["an unknown launch key", { ...SPECS.vllm, launch: { ...launch, replicas: 2 } }],
    ["an unknown top-level key", { ...SPECS.vllm, note: "x" }],
    ["an unknown model key", { ...SPECS.vllm, models: [{ id: "m", weight: 2 }] }],
    [
      "an unknown command key",
      { ...SPECS.vllm, launch: { ...launch, commands: [{ start: "s", stop: "t", restart: "r" }] } },
    ],
    [
      "an argv command",
      { ...SPECS.vllm, launch: { ...launch, commands: [{ start: ["vllm", "serve"], stop: "t" }] } },
    ],
    ["a number written as text", { ...SPECS.vllm, launch: { ...launch, groupSize: "1" } }],
    ["a part the form fills in", { ...SPECS.vllm, launch: { ...launch, labels: undefined } }],
    ["the other kind", SPECS.alwaysOn],
  ])("keeps the JSON tab for %s (nothing dropped or changed)", (_name, spec) => {
    expect(losslessDraft(JSON.parse(JSON.stringify(spec)), "STARTABLE")).toBeNull();
    const values = editorValues(JSON.parse(JSON.stringify(spec)), "STARTABLE");
    expect(values.tab).toBe("json");
    expect(JSON.parse(values.json)).toEqual(JSON.parse(JSON.stringify(spec)));
  });
});

describe("JSON the conversion cannot handle at all (R6-B-1)", () => {
  const vllm = SPECS.vllm.launch;
  const multi = SPECS.multiNode.launch;
  it.each([
    [
      "a numeric stop",
      { ...SPECS.vllm, launch: { ...vllm, commands: [{ start: "run", stop: 7 }] } },
    ],
    [
      "a numeric prepare",
      { ...SPECS.vllm, launch: { ...vllm, commands: [{ start: "run", prepare: 7 }] } },
    ],
    [
      "a numeric stop of a service",
      {
        ...SPECS.service,
        launch: { ...SPECS.service.launch, commands: [{ start: "up", stop: 7, status: "s" }] },
      },
    ],
    ["a numeric fabric", { ...SPECS.multiNode, launch: { ...multi, fabric: 7 } }],
    ["an object fabric", { ...SPECS.multiNode, launch: { ...multi, fabric: { name: "ib" } } }],
  ])("keeps the JSON tab without throwing for %s", (_name, spec) => {
    const raw = JSON.parse(JSON.stringify(spec));
    expect(() => losslessDraft(raw, "STARTABLE")).not.toThrow();
    expect(losslessDraft(raw, "STARTABLE")).toBeNull();
    const values = editorValues(raw, "STARTABLE");
    expect(values.tab).toBe("json");
    expect(JSON.parse(values.json)).toEqual(raw);
  });

  it("still converts the well-typed neighbours to the form", () => {
    for (const spec of [
      { ...SPECS.vllm, launch: { ...vllm, commands: [{ start: "run", stop: "7" }] } },
      { ...SPECS.multiNode, launch: { ...multi, fabric: "ib1" } },
    ])
      expect(losslessDraft(JSON.parse(JSON.stringify(spec)), "STARTABLE")).not.toBeNull();
  });
});
