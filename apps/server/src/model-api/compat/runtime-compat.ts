/**
 * The compatibility view of one runtime version the request path reads: its setting, what the
 * engine accepts (description) and what was learned from its 400s; plus the derived header
 * policy and the gates on fields the proxy adds itself. Pure.
 */
import {
  type AcceptedNode,
  type AcceptedProfile,
  COMPAT_HEADERS,
  type CompatEndpoint,
  emptyLearnedProfile,
  type LearnedFix,
  type LearnedProfile,
  MAX_LEARNED_FIXES_PER_ENDPOINT,
  type RequestCompat,
} from "@ws-model-proxy/api/lib/request-compat";
import type { EngineValue } from "../resolve.js";
import type { NormalizeOptions } from "./response-normalize.js";

export type RuntimeCompat = {
  compat: RequestCompat;
  engine: EngineValue | null;
  accepted: AcceptedProfile | null;
  learned: LearnedProfile;
};

export const NO_RUNTIME_COMPAT: RuntimeCompat = {
  compat: {},
  engine: null,
  accepted: null,
  learned: emptyLearnedProfile(),
};

export function acceptedFor(runtime: RuntimeCompat, endpoint: CompatEndpoint): AcceptedNode | null {
  return runtime.accepted?.endpoints[endpoint] ?? null;
}

export function learnedFor(runtime: RuntimeCompat, endpoint: CompatEndpoint): LearnedFix[] {
  return runtime.learned.fixes[endpoint] ?? [];
}

/**
 * The client headers the engine receives: the protocol's own allowlist (`base`), then per
 * header the runtime's `forward` (copied from the client) or `strip`, then the headers learned
 * from the engine's 400s (unless the runtime forwards them). Credentials never pass here: only
 * {@link COMPAT_HEADERS} are considered and none of them carries one.
 */
export function compatRequestHeaders(input: {
  base: Headers;
  client: Headers;
  runtime: RuntimeCompat;
}): { headers: Headers; stripped: string[] } {
  const headers = new Headers(input.base);
  const stripped: string[] = [];
  const policy = input.runtime.compat.headers ?? {};
  for (const name of COMPAT_HEADERS) {
    const mode = policy[name];
    if (mode === "forward") {
      const value = input.client.get(name);
      if (value !== null) headers.set(name, value);
      continue;
    }
    const learned = input.runtime.learned.stripHeaders.includes(name);
    if ((mode === "strip" || learned) && headers.has(name)) {
      headers.delete(name);
      stripped.push(name);
    }
  }
  return { headers, stripped };
}

/** Engines known to accept the field (their OpenAI-compatible servers do). */
const STREAM_USAGE_ENGINES = new Set<EngineValue>([
  "VLLM",
  "SGLANG",
  "LLAMA_CPP",
  "OLLAMA",
  "LM_STUDIO",
]);
const TOP_K_ENGINES = new Set<EngineValue>(["VLLM", "SGLANG", "LLAMA_CPP"]);

function described(runtime: RuntimeCompat, key: string): boolean | null {
  const chat = acceptedFor(runtime, "chat.completions");
  if (!chat?.p) return null;
  return key in chat.p || chat.o === 1;
}

function learnedDrop(runtime: RuntimeCompat, path: string): boolean {
  return learnedFor(runtime, "chat.completions").some(
    (fix) => fix.kind === "drop" && (fix.path === path || path.startsWith(`${fix.path}.`)),
  );
}

export type ProxyExtras = {
  /** Ask adapted Chat streams for `stream_options.include_usage`. */
  streamUsage: boolean;
  /** Render Anthropic `top_k` for Chat engines. */
  topK: boolean;
};

/**
 * Fields the proxy adds itself, gated by the runtime: the operator's explicit choice, else the
 * engine's description, else what was learned, else the engine kind (unknown engines: off).
 */
export function proxyExtras(runtime: RuntimeCompat): ProxyExtras {
  const explicit = runtime.compat.extras ?? {};
  const engine = runtime.engine ?? "OTHER";
  const streamUsage =
    explicit.streamUsage ??
    (learnedDrop(runtime, "stream_options.include_usage")
      ? false
      : (described(runtime, "stream_options") ?? STREAM_USAGE_ENGINES.has(engine)));
  const topK =
    explicit.topK ??
    (learnedDrop(runtime, "top_k")
      ? false
      : (described(runtime, "top_k") ?? TOP_K_ENGINES.has(engine)));
  return { streamUsage, topK };
}

export function normalizeOptions(runtime: RuntimeCompat): NormalizeOptions {
  return {
    reasoningField: runtime.compat.response?.reasoningField ?? "auto",
    stripNonStandard: runtime.compat.response?.stripNonStandard ?? false,
  };
}

/** The learned profile with one more fix (deduplicated, bounded); null when already known. */
export function withLearnedFix(
  learned: LearnedProfile,
  endpoint: CompatEndpoint,
  fix: LearnedFix,
): LearnedProfile | null {
  const fixes = learned.fixes[endpoint] ?? [];
  const same = (other: LearnedFix) => JSON.stringify(other) === JSON.stringify(fix);
  if (fixes.some(same) || fixes.length >= MAX_LEARNED_FIXES_PER_ENDPOINT) return null;
  return { ...learned, fixes: { ...learned.fixes, [endpoint]: [...fixes, fix] } };
}

export function withLearnedHeader(learned: LearnedProfile, name: string): LearnedProfile | null {
  if (learned.stripHeaders.includes(name) || learned.stripHeaders.length >= 16) return null;
  return { ...learned, stripHeaders: [...learned.stripHeaders, name] };
}
