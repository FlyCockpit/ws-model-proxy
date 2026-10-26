import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import {
  authoredRuntimeSpecSchema,
  type EngineWire,
  type GpuVendor,
  type ModelCapabilityWire,
  type ModelTypeWire,
  RUNTIME_TIMEOUTS_SEC,
  type RuntimeApiWire,
  type RuntimeSpec,
  runtimeSpecKind,
} from "@ws-model-proxy/api/lib/runtime-spec";

import { specIssueText } from "./spec-issue-text";

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
/** One `launch.reservations` entry: memory held on another node chosen by its labels. */
export type ReservationDraft = {
  /** Comma- or space-separated. */
  labels: string;
  resource: ResourceDraft;
};
export type CommandDraft = Record<CommandField, string> & {
  timeouts: Record<TimeoutField, string>;
  /** The base spec's command entry this one came from (its interactive steps), or -1. */
  baseIndex: number;
};
export type ModelDraft = {
  id: string;
  /** Off: the node detects the capabilities. */
  declareCapabilities: boolean;
  capabilities: ModelCapabilityWire[];
  /** The base spec's model this one came from (its contract and profile), or -1. */
  baseIndex: number;
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
  /** Single-node only (`launch.reservations`). */
  reservations: ReservationDraft[];
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
    baseIndex: -1,
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

/** JSON text with object keys sorted (compares two plain JSON values). */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    member && typeof member === "object" && !Array.isArray(member)
      ? Object.fromEntries(
          Object.entries(member as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : member,
  );
}

/**
 * A written resource entry as the form's fields. An entry the fields cannot hold exactly (not an
 * object, a number written as text, a field its kind does not have, an unknown kind or field)
 * throws, like any other shape the form cannot show: the editor keeps the JSON tab and its text
 * with an error, and nothing is saved from a rewritten value (`{"kind":"none","memoryGb":100}`
 * never becomes `{"kind":"none"}`, `"100"` never becomes 100).
 */
function authoredResourceDraft(resource: unknown, what: string): ResourceDraft {
  if (typeof resource !== "object" || resource === null || Array.isArray(resource))
    throw new TypeError(`${what} is not an object`);
  const draft = resourceDraft(resource);
  if (sortedJson(resourceFromDraft(draft)) !== sortedJson(resource))
    throw new TypeError(`${what} holds a value the form would change`);
  return draft;
}

function commandDraft(commands: unknown, baseIndex: number): CommandDraft {
  const value = (commands ?? {}) as Partial<Record<CommandField, string>> & {
    timeoutsSec?: Partial<Record<TimeoutField, number>>;
  };
  // An argv command has no text field: the form cannot show it (the editor keeps the JSON tab).
  for (const field of COMMAND_FIELDS)
    if (value[field] !== undefined && typeof value[field] !== "string")
      throw new TypeError(`commands.${field} is not text`);
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
    baseIndex,
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
    /** Any shape (the JSON tab's): read with checks. */
    reservations: unknown;
    commands: unknown[];
    readiness: Partial<{ path: string; expectedStatus: number; timeoutMs: number }>;
    health: Partial<{ intervalMs: number; failureThreshold: number; successThreshold: number }>;
  }>;
  expandMedia: boolean;
}>;

/**
 * Labels as the form's text field (comma-separated). A label the field cannot hold as one label
 * (empty, or with a comma or whitespace, which the field would split into several) throws, like
 * any other shape the form cannot show: the editor keeps the JSON tab and its text with an error,
 * and nothing is saved from a rewritten value (`["worker,other"]` never becomes two labels).
 */
function labelsDraft(value: unknown, what: string): string {
  if (value === undefined) return "";
  if (!Array.isArray(value) || !value.every((label) => typeof label === "string"))
    throw new TypeError(`${what} are not a list of text`);
  if (value.some((label: string) => label === "" || /[\s,]/.test(label)))
    throw new TypeError(`${what} hold a label the form would split or drop`);
  return value.join(", ");
}

/**
 * `launch.reservations` as the form's rows. A shape the form cannot show without losing part
 * of it (not a list, an entry that is not an object, labels that are not a list of text,
 * resources the form's fields cannot hold exactly) throws: the editor then keeps the JSON tab and its text
 * with an error (the switch's catch), instead of dropping what was written.
 */
function reservationDrafts(value: unknown): SpecDraft["reservations"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("launch.reservations is not a list");
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new TypeError("a reservation is not an object");
    const labels = labelsDraft(Reflect.get(entry, "labels"), "a reservation's labels");
    const resources: unknown = Reflect.get(entry, "resources");
    return {
      labels,
      resource:
        resources === undefined
          ? resourceDraft({ kind: "unified" })
          : authoredResourceDraft(resources, "a reservation's resources"),
    };
  });
}

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
    models: (spec.models ?? []).map((model, baseIndex) => ({
      baseIndex,
      id: model.id ?? "",
      declareCapabilities: model.capabilities !== undefined,
      capabilities: [...(model.capabilities ?? [])],
    })),
    expandMedia: spec.expandMedia === undefined ? "auto" : spec.expandMedia ? "on" : "off",
    baseUrl: spec.address?.baseUrl ?? defaultBaseUrl(engine),
    management: launch?.management ?? "process",
    groupSize: launch ? str(launch.groupSize) : "1",
    resources: launch
      ? (launch.resources ?? []).map((resource) =>
          authoredResourceDraft(resource, "a launch.resources entry"),
        )
      : [resourceDraft({ kind: "unified", memoryGb: 16 })],
    commands: launch
      ? (launch.commands ?? []).map((commands, index) => commandDraft(commands, index))
      : [emptyCommandDraft()],
    labels: labelsDraft(launch?.labels, "launch.labels"),
    fixedPort: str(launch?.port?.fixed),
    fabric: launch?.fabric ?? "",
    reservations: reservationDrafts(launch?.reservations),
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
  const text = value.trim();
  if (text === "") return undefined;
  // Plain decimals only: `Number` would also read 0x10, 1e3 or 0b1.
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

/** Drops undefined members so the spec hashes and compares like the stored one. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

function splitLabels(value: string): string[] {
  return value.split(/[\s,]+/).filter((label) => label !== "");
}

/** A new reservation in the form: 16 GiB of unified memory on a node with the given labels. */
export function emptyReservationDraft(): ReservationDraft {
  return { labels: "", resource: resourceDraft({ kind: "unified", memoryGb: 16 }) };
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
    // A process runtime may leave stop out (the node stops the rank itself).
    stop: optionalText(draft.stop),
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
  const labels = splitLabels(draft.labels);
  const models =
    serves && (kind === "STARTABLE" || draft.models.length > 0)
      ? draft.models.map((model) =>
          compact({
            id: model.id,
            capabilities: model.declareCapabilities ? [...model.capabilities] : undefined,
            embeddingContract: baseModels[model.baseIndex]?.embeddingContract,
            transcription: baseModels[model.baseIndex]?.transcription,
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
            // The form shows a fabric only for several nodes; a leftover one is dropped.
            fabric: draft.groupSize.trim() === "1" ? undefined : optionalText(draft.fabric),
            reservations:
              draft.reservations.length > 0
                ? draft.reservations.map((reservation) => ({
                    labels: splitLabels(reservation.labels),
                    resources: resourceFromDraft(reservation.resource),
                  }))
                : // An empty list stays as written (round trips change nothing).
                  Array.isArray(baseLaunch.reservations) && baseLaunch.reservations.length === 0
                  ? []
                  : undefined,
            commands: draft.commands.map((commands) =>
              commandsFromDraft(commands, baseCommands[commands.baseIndex] ?? {}),
            ),
            // The form has no shell field: the written one is kept.
            shell: baseLaunch.shell,
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

/**
 * The form's draft of a spec only when the form keeps it exactly: the spec the draft describes
 * (`draftToSpec` over the spec itself as the base) is the spec as written, canonically. Else
 * null: something would be dropped or changed (an unknown key, a value written as text, a
 * shape the fields cannot hold, a part missing that the form would fill in, the other kind),
 * so the editor stays on the JSON tab and nothing is saved from a rewritten value. A value the
 * conversion cannot handle at all (a number where a command or fabric goes) throws in either
 * direction; that is "not representable" too, never an error out of the editor.
 */
export function losslessDraft(spec: unknown, kind: RuntimeKind): SpecDraft | null {
  try {
    const draft = specToDraft(spec);
    return sameSpec(draftToSpec(draft, asObject(spec), kind), spec) ? draft : null;
  } catch {
    return null;
  }
}

/**
 * Editor values for a spec (the JSON tab is pretty-printed). With `kind` (an existing
 * definition), a spec the form cannot keep exactly (`losslessDraft`) opens on the JSON tab.
 */
export function editorValues(spec: unknown, kind?: RuntimeKind): SpecEditorValues {
  const json = JSON.stringify(spec, null, 2);
  if (kind !== undefined) {
    const draft = losslessDraft(spec, kind);
    if (!draft) {
      let fallback: SpecDraft;
      try {
        fallback = specToDraft(spec);
      } catch {
        fallback = specToDraft({});
      }
      return { tab: "json", draft: fallback, json, base: json, check: "" };
    }
    return { tab: "form", draft, json, base: json, check: "" };
  }
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
  if (field === "reservations") {
    if (typeof index !== "number") return ["reservations"];
    if (sub === "labels") return ["reservations", index, "labels"];
    if (sub === "resources")
      return typeof leaf === "string" && leaf !== "kind"
        ? ["reservations", index, "resource", leaf]
        : ["reservations", index, "resource", "kind"];
    return ["reservations"];
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
  const parsed = authoredRuntimeSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const where = issue.path.join(".");
        const text = specIssueText(issue);
        if (values.tab === "json")
          return { path: ["json"], message: where ? `${where}: ${text}` : text };
        const draftPath = draftPathOf(issue.path);
        return draftPath
          ? { path: ["draft", ...draftPath], message: text }
          : { path: ["check"], message: where ? `${where}: ${text}` : text };
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
  // A shape the form cannot read (valid JSON, wrong types) stays as written, like bad JSON.
  let draft: SpecDraft;
  try {
    draft = specToDraft(base);
  } catch {
    return values;
  }
  return {
    ...values,
    draft,
    base: values.json,
    json: JSON.stringify(draftToSpec(draft, base, kind), null, 2),
  };
}
