import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import {
  type EngineWire,
  type GpuVendor,
  type ModelCapabilityWire,
  type ModelTypeWire,
  RUNTIME_TIMEOUTS_SEC,
  type RuntimeApiWire,
  type RuntimeSpec,
  runtimeSpecKind,
  runtimeSpecSchema,
} from "@ws-model-proxy/api/lib/runtime-spec";

/**
 * The Definition form's model of a runtime spec (`runtimeSpecSchema`). Text inputs hold
 * strings (numbers too, so an empty input means "not set"); `draftToSpec` turns a draft back
 * into a spec and copies the parts the form does not edit (address auth and headers, launch
 * secrets, interactive steps, embedding contracts, transcription profiles, the metrics reader)
 * from the spec the draft was made from, so a round trip through the form changes nothing.
 */

export type RuntimeKind = "ALWAYS_ON" | "STARTABLE";
export type ResourceKind = "none" | "unified" | "cpu" | "discrete";
export const COMMAND_FIELDS = [
  "start",
  "stop",
  "prepare",
  "afterJoin",
  "status",
  "health",
] as const;
export type CommandField = (typeof COMMAND_FIELDS)[number];
export const TIMEOUT_FIELDS = Object.keys(RUNTIME_TIMEOUTS_SEC) as Array<
  keyof typeof RUNTIME_TIMEOUTS_SEC
>;
export type TimeoutField = keyof typeof RUNTIME_TIMEOUTS_SEC;

export type ResourceDraft = {
  kind: ResourceKind;
  memoryGb: string;
  ramGb: string;
  gpuCount: string;
  vramGb: string;
  vendor: "" | GpuVendor;
};
export type CommandDraft = Record<CommandField, string> & {
  timeouts: Record<TimeoutField, string>;
};
export type ModelDraft = {
  id: string;
  /** Off: the node detects the capabilities. */
  declareCapabilities: boolean;
  capabilities: ModelCapabilityWire[];
};
export type SpecDraft = {
  /** False: a service (startable, no models, never proxied). */
  serves: boolean;
  api: RuntimeApiWire;
  engine: EngineWire;
  modelType: ModelTypeWire;
  models: ModelDraft[];
  expandMedia: "auto" | "on" | "off";
  baseUrl: string;
  management: "process" | "service";
  groupSize: string;
  resources: ResourceDraft[];
  commands: CommandDraft[];
  /** Comma- or space-separated. */
  labels: string;
  fixedPort: string;
  fabric: string;
  readiness: { enabled: boolean; path: string; expectedStatus: string; timeoutMs: string };
  health: { intervalMs: string; failureThreshold: string; successThreshold: string };
};

/** What the editor keeps in a form: the draft, the raw JSON tab, and the spec it came from. */
export type SpecEditorValues = {
  tab: "form" | "json";
  draft: SpecDraft;
  json: string;
  /** JSON of the spec the draft was made from (the parts the form does not edit). */
  base: string;
  /** Never edited: carries the issues no input owns. */
  check: string;
};

/** Where an engine listens by default (always-on address suggestion). */
const ENGINE_PORTS: Record<EngineWire, number> = {
  vllm: 8000,
  sglang: 30000,
  llama_cpp: 8080,
  ollama: 11434,
  lm_studio: 1234,
  other: 8000,
};

export function defaultBaseUrl(engine: EngineWire): string {
  return `http://127.0.0.1:${ENGINE_PORTS[engine]}/v1`;
}

function str(value: number | string | undefined): string {
  return value === undefined ? "" : String(value);
}

function emptyTimeouts(): Record<TimeoutField, string> {
  return { prepare: "", start: "", afterJoin: "", stop: "", status: "" };
}

export function emptyCommandDraft(): CommandDraft {
  return {
    start: "",
    stop: "true",
    prepare: "",
    afterJoin: "",
    status: "",
    health: "",
    timeouts: emptyTimeouts(),
  };
}

function resourceDraft(resource: unknown): ResourceDraft {
  const value = (resource ?? {}) as Partial<{
    kind: ResourceKind;
    memoryGb: number;
    ramGb: number;
    gpuCount: number;
    vramGb: number;
    vendor: GpuVendor;
  }>;
  return {
    kind: value.kind ?? "unified",
    memoryGb: str(value.memoryGb),
    ramGb: str(value.ramGb),
    gpuCount: str(value.gpuCount),
    vramGb: str(value.vramGb),
    vendor: value.vendor ?? "",
  };
}

function commandDraft(commands: unknown): CommandDraft {
  const value = (commands ?? {}) as Partial<Record<CommandField, string>> & {
    timeoutsSec?: Partial<Record<TimeoutField, number>>;
  };
  const timeouts = emptyTimeouts();
  for (const field of TIMEOUT_FIELDS) timeouts[field] = str(value.timeoutsSec?.[field]);
  return {
    start: value.start ?? "",
    stop: value.stop ?? "",
    prepare: value.prepare ?? "",
    afterJoin: value.afterJoin ?? "",
    status: value.status ?? "",
    health: value.health ?? "",
    timeouts,
  };
}

type LooseSpec = Partial<{
  api: RuntimeApiWire;
  engine: EngineWire;
  modelType: ModelTypeWire;
  models: Array<Partial<{ id: string; capabilities: ModelCapabilityWire[] }>>;
  address: Partial<{ baseUrl: string }>;
  launch: Partial<{
    management: "process" | "service";
    groupSize: number;
    resources: unknown[];
    labels: string[];
    port: { fixed?: number };
    fabric: string;
    commands: unknown[];
    readiness: Partial<{ path: string; expectedStatus: number; timeoutMs: number }>;
    health: Partial<{ intervalMs: number; failureThreshold: number; successThreshold: number }>;
  }>;
  expandMedia: boolean;
}>;

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A draft of any spec-like value (the JSON tab may hold an invalid one). Missing parts get
 * the editor's defaults, so switching kind or tab always has something to show.
 */
export function specToDraft(input: unknown): SpecDraft {
  const spec = asObject(input) as LooseSpec;
  const launch = spec.launch;
  const engine = spec.engine ?? "vllm";
  const serves = spec.address !== undefined || spec.models !== undefined || !launch;
  return {
    serves,
    api: spec.api ?? "openai",
    engine,
    modelType: spec.modelType ?? "llm",
    models: (spec.models ?? []).map((model) => ({
      id: model.id ?? "",
      declareCapabilities: model.capabilities !== undefined,
      capabilities: [...(model.capabilities ?? [])],
    })),
    expandMedia: spec.expandMedia === undefined ? "auto" : spec.expandMedia ? "on" : "off",
    baseUrl: spec.address?.baseUrl ?? defaultBaseUrl(engine),
    management: launch?.management ?? "process",
    groupSize: launch ? str(launch.groupSize) : "1",
    resources: launch
      ? (launch.resources ?? []).map(resourceDraft)
      : [resourceDraft({ kind: "unified", memoryGb: 16 })],
    commands: launch ? (launch.commands ?? []).map(commandDraft) : [emptyCommandDraft()],
    labels: (launch?.labels ?? []).join(", "),
    fixedPort: str(launch?.port?.fixed),
    fabric: launch?.fabric ?? "",
    readiness: launch
      ? {
          enabled: launch.readiness !== undefined,
          path: launch.readiness?.path ?? "/v1/models",
          expectedStatus: str(launch.readiness?.expectedStatus ?? 200),
          timeoutMs: str(launch.readiness?.timeoutMs ?? 900_000),
        }
      : { enabled: true, path: "/v1/models", expectedStatus: "200", timeoutMs: "900000" },
    health: {
      intervalMs: str(launch?.health?.intervalMs ?? 15_000),
      failureThreshold: str(launch?.health?.failureThreshold ?? 3),
      successThreshold: str(launch?.health?.successThreshold ?? 1),
    },
  };
}

/** A number input: empty is "not set"; anything else must read as a number (NaN is refused). */
function num(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value.trim());
}

/** Drops undefined members so the spec hashes and compares like the stored one. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

function optionalText(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

function resourceFromDraft(draft: ResourceDraft): unknown {
  switch (draft.kind) {
    case "none":
      return { kind: "none" };
    case "unified":
      return compact({ kind: "unified", memoryGb: num(draft.memoryGb) });
    case "cpu":
      return compact({ kind: "cpu", ramGb: num(draft.ramGb) });
    case "discrete":
      return compact({
        kind: "discrete",
        gpuCount: num(draft.gpuCount),
        vramGb: num(draft.vramGb),
        ramGb: num(draft.ramGb),
        vendor: draft.vendor === "" ? undefined : draft.vendor,
      });
  }
}

function commandsFromDraft(draft: CommandDraft, base: Record<string, unknown>): unknown {
  const timeouts = compact(
    Object.fromEntries(TIMEOUT_FIELDS.map((field) => [field, num(draft.timeouts[field])])),
  );
  return compact({
    start: draft.start,
    stop: draft.stop,
    prepare: optionalText(draft.prepare),
    afterJoin: optionalText(draft.afterJoin),
    status: optionalText(draft.status),
    health: optionalText(draft.health),
    interactive: base.interactive,
    // An empty `timeoutsSec: {}` stays as written (it is part of the launch hash).
    timeoutsSec:
      Object.keys(timeouts).length > 0
        ? timeouts
        : Object.keys(asObject(base.timeoutsSec)).length === 0 && base.timeoutsSec !== undefined
          ? {}
          : undefined,
  });
}

/** Parses the base JSON; anything unreadable counts as an empty spec. */
export function parseBase(base: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(base));
  } catch {
    return {};
  }
}

/**
 * The spec a draft describes, for a runtime of `kind`. Not validated: run it through
 * `runtimeSpecSchema` (see `specEditorIssues`).
 */
export function draftToSpec(draft: SpecDraft, base: Record<string, unknown>, kind: RuntimeKind) {
  const serves = kind === "ALWAYS_ON" || draft.serves;
  const baseModels = Array.isArray(base.models) ? base.models.map(asObject) : [];
  const baseAddress = asObject(base.address);
  const baseLaunch = asObject(base.launch);
  const baseCommands = Array.isArray(baseLaunch.commands) ? baseLaunch.commands.map(asObject) : [];
  const labels = draft.labels.split(/[\s,]+/).filter((label) => label !== "");
  const models =
    serves && (kind === "STARTABLE" || draft.models.length > 0)
      ? draft.models.map((model, index) =>
          compact({
            id: model.id,
            capabilities: model.declareCapabilities ? [...model.capabilities] : undefined,
            embeddingContract: baseModels[index]?.embeddingContract,
            transcription: baseModels[index]?.transcription,
          }),
        )
      : undefined;
  return compact({
    api: serves ? draft.api : undefined,
    engine: serves ? draft.engine : undefined,
    modelType: serves ? draft.modelType : undefined,
    models,
    address:
      kind === "ALWAYS_ON"
        ? compact({
            baseUrl: draft.baseUrl,
            auth: baseAddress.auth,
            headers: baseAddress.headers,
          })
        : undefined,
    launch:
      kind === "STARTABLE"
        ? compact({
            management: draft.management,
            groupSize: num(draft.groupSize),
            resources: draft.resources.map(resourceFromDraft),
            labels,
            port: draft.fixedPort.trim() === "" ? undefined : { fixed: num(draft.fixedPort) },
            fabric: optionalText(draft.fabric),
            commands: draft.commands.map((commands, index) =>
              commandsFromDraft(commands, baseCommands[index] ?? {}),
            ),
            secrets: baseLaunch.secrets,
            readiness: draft.readiness.enabled
              ? {
                  path: draft.readiness.path,
                  expectedStatus: num(draft.readiness.expectedStatus),
                  timeoutMs: num(draft.readiness.timeoutMs),
                }
              : undefined,
            health: {
              intervalMs: num(draft.health.intervalMs),
              failureThreshold: num(draft.health.failureThreshold),
              successThreshold: num(draft.health.successThreshold),
            },
          })
        : undefined,
    metricsReader: serves ? base.metricsReader : undefined,
    expandMedia: serves && draft.expandMedia !== "auto" ? draft.expandMedia === "on" : undefined,
  });
}

/** Editor values for a spec (the JSON tab is pretty-printed). */
export function editorValues(spec: unknown): SpecEditorValues {
  const json = JSON.stringify(spec, null, 2);
  return { tab: "form", draft: specToDraft(spec), json, base: json, check: "" };
}

export type EditorIssue = { path: Array<string | number>; message: string };

const DRAFT_FIELDS: Record<string, string> = {
  api: "api",
  engine: "engine",
  modelType: "modelType",
  expandMedia: "expandMedia",
};
const LAUNCH_FIELDS: Record<string, string> = {
  management: "management",
  groupSize: "groupSize",
  labels: "labels",
  port: "fixedPort",
  fabric: "fabric",
  resources: "resources",
  commands: "commands",
};

/** The draft input a spec issue belongs to, or null when no input owns it. */
export function draftPathOf(path: ReadonlyArray<PropertyKey>): Array<string | number> | null {
  const [head, ...rest] = path.map((segment) =>
    typeof segment === "symbol" ? String(segment) : segment,
  );
  if (typeof head === "string" && DRAFT_FIELDS[head]) return [DRAFT_FIELDS[head]];
  if (head === "models") {
    const [index, field] = rest;
    if (typeof index !== "number") return ["models"];
    if (field === "id") return ["models", index, "id"];
    if (field === "capabilities") return ["models", index, "capabilities"];
    return null;
  }
  if (head === "address") return rest[0] === "baseUrl" ? ["baseUrl"] : null;
  if (head !== "launch") return null;
  const [field, index, sub, leaf] = rest;
  if (field === "resources" && typeof index === "number") {
    return typeof sub === "string" && sub !== "kind"
      ? ["resources", index, sub]
      : ["resources", index, "kind"];
  }
  if (field === "commands" && typeof index === "number") {
    if (sub === "timeoutsSec" && typeof leaf === "string")
      return ["commands", index, "timeouts", leaf];
    if (typeof sub === "string" && (COMMAND_FIELDS as readonly string[]).includes(sub))
      return ["commands", index, sub];
    return null;
  }
  if (field === "readiness") {
    return typeof index === "string" && ["path", "expectedStatus", "timeoutMs"].includes(index)
      ? ["readiness", index]
      : ["readiness", "enabled"];
  }
  if (field === "health" && typeof index === "string") return ["health", index];
  if (typeof field === "string" && LAUNCH_FIELDS[field]) return [LAUNCH_FIELDS[field]];
  return null;
}

export type SpecReading = { ok: true; spec: RuntimeSpec } | { ok: false; issues: EditorIssue[] };

/**
 * Reads the editor (the tab it shows) as a spec of `kind`. Issues carry editor paths
 * (`draft.commands[0].start`, `json`, or `check` for issues no input owns).
 */
export function readSpecEditor(
  values: SpecEditorValues,
  kind: RuntimeKind,
  messages: { notJson: string; wrongKind: string },
): SpecReading {
  let candidate: unknown;
  if (values.tab === "json") {
    try {
      candidate = JSON.parse(values.json);
    } catch {
      return { ok: false, issues: [{ path: ["json"], message: messages.notJson }] };
    }
  } else {
    candidate = draftToSpec(values.draft, parseBase(values.base), kind);
  }
  const parsed = runtimeSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const where = issue.path.join(".");
        if (values.tab === "json")
          return { path: ["json"], message: where ? `${where}: ${issue.message}` : issue.message };
        const draftPath = draftPathOf(issue.path);
        return draftPath
          ? { path: ["draft", ...draftPath], message: issue.message }
          : { path: ["check"], message: where ? `${where}: ${issue.message}` : issue.message };
      }),
    };
  }
  const want = kind === "ALWAYS_ON" ? "always_on" : "startable";
  if (runtimeSpecKind(parsed.data) !== want)
    return {
      ok: false,
      issues: [{ path: [values.tab === "json" ? "json" : "check"], message: messages.wrongKind }],
    };
  return { ok: true, spec: parsed.data };
}

/** Same definition (canonical JSON), so an edit keeps the launch hash. */
export function sameSpec(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * The editor after the runtime's kind changes (New runtime): the JSON tab is rewritten for
 * the new kind when it parses, so it never keeps showing the other kind's definition.
 */
export function switchEditorKind(values: SpecEditorValues, kind: RuntimeKind): SpecEditorValues {
  if (values.tab === "form") return values;
  let parsed: unknown;
  try {
    parsed = JSON.parse(values.json);
  } catch {
    return values;
  }
  const base = asObject(parsed);
  const draft = specToDraft(base);
  return {
    ...values,
    draft,
    base: values.json,
    json: JSON.stringify(draftToSpec(draft, base, kind), null, 2),
  };
}
