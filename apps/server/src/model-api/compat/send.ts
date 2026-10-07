/**
 * The request path's use of the compatibility policy: load a launch's profile, apply the policy
 * to a built request (body and headers), and decide what an engine 400 means. Everything but
 * the profile load is pure; the request path owns retries, telemetry and responses.
 */
import {
  type CompatEndpoint,
  compatEndpointForFamily,
  type LearnedFix,
  type RequestCompat,
} from "@ws-model-proxy/api/lib/request-compat";
import type { EngineValue } from "../resolve.js";
import { parseEngineRejection, upstreamErrorExcerpt } from "./engine-errors.js";
import { type LaunchKey, loadRequestProfile } from "./profile-store.js";
import { applyRequestCompat, type CompatRefusal, planCompatRetry } from "./request-policy.js";
import {
  createSseNormalizer,
  type NormalizedSurface,
  normalizeJsonBody,
  type UsageEstimate,
} from "./response-normalize.js";
import {
  acceptedFor,
  compatRequestHeaders,
  learnedFor,
  normalizeOptions,
  type ProxyExtras,
  proxyExtras,
  type RuntimeCompat,
} from "./runtime-compat.js";

export type CompatLaunch = { key: LaunchKey; runtime: RuntimeCompat };

/** The compatibility view of the launch an instance runs. */
export async function compatLaunchFor(
  instance: {
    runtimeId: string;
    launchHash: string;
    engine: EngineValue | null;
    requestCompat: RequestCompat;
  },
  ownerUserId: string,
): Promise<CompatLaunch> {
  const key = {
    userId: ownerUserId,
    runtimeId: instance.runtimeId,
    launchHash: instance.launchHash,
  };
  const profile = await loadRequestProfile(key);
  return {
    key,
    runtime: {
      compat: instance.requestCompat,
      engine: instance.engine,
      accepted: profile.accepted,
      learned: profile.learned,
    },
  };
}

/** Fixes learned during this request, not yet visible through the profile cache. */
export type CompatExtra = { fixes: LearnedFix[]; stripHeaders: string[] };

export type CompatSendReport = { dropped: string[]; rewrites: string[]; headers: string[] };

type Built<B> = { headers: Headers; body: Uint8Array | B };

function jsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Applies the launch's policy to a built request. Only JSON bodies of request endpoints change;
 * streamed bodies (uploads) and other endpoints only get the header policy.
 */
export function applyCompatToBuilt<B>(input: {
  launch: CompatLaunch;
  family: string;
  built: Built<B>;
  clientHeaders: Headers;
  extra?: CompatExtra;
}):
  | { ok: true; built: Built<B>; report: CompatSendReport }
  | { ok: false; refusal: CompatRefusal } {
  const runtime: RuntimeCompat = input.extra
    ? {
        ...input.launch.runtime,
        learned: {
          ...input.launch.runtime.learned,
          stripHeaders: [...input.launch.runtime.learned.stripHeaders, ...input.extra.stripHeaders],
        },
      }
    : input.launch.runtime;
  const headerResult = compatRequestHeaders({
    base: input.built.headers,
    client: input.clientHeaders,
    runtime,
  });
  const report: CompatSendReport = { dropped: [], rewrites: [], headers: headerResult.stripped };
  const endpoint = compatEndpointForFamily(input.family);
  const body = input.built.body;
  if (!endpoint || !(body instanceof Uint8Array))
    return { ok: true, built: { headers: headerResult.headers, body }, report };
  const parsed = jsonObject(body);
  if (!parsed) return { ok: true, built: { headers: headerResult.headers, body }, report };
  const result = applyRequestCompat({
    endpoint,
    body: parsed,
    compat: runtime.compat,
    accepted: acceptedFor(runtime, endpoint),
    learned: [...learnedFor(runtime, endpoint), ...(input.extra?.fixes ?? [])],
  });
  if (!result.ok) return result;
  report.dropped = result.report.dropped;
  report.rewrites = result.report.rewrites;
  const changed = report.dropped.length > 0 || report.rewrites.length > 0;
  const headers = headerResult.headers;
  if (changed) headers.delete("content-length");
  return {
    ok: true,
    built: {
      headers,
      body: changed ? new TextEncoder().encode(JSON.stringify(result.body)) : body,
    },
    report,
  };
}

export type CompatRetryDecision =
  | { kind: "learn"; endpoint: CompatEndpoint; fix: LearnedFix }
  | { kind: "header"; name: string }
  | { kind: "refuse"; refusal: CompatRefusal };

/**
 * What an engine's 4xx to a request this proxy built means for compatibility: a fix to learn
 * and retry with once, a semantic field to refuse clearly, or nothing (the answer passes on).
 */
export function compatRetryDecision(input: {
  launch: CompatLaunch;
  family: string;
  status: number;
  errorText: string;
  sentBody: Uint8Array | null;
  sentHeaders: Headers;
}): CompatRetryDecision | null {
  const endpoint = compatEndpointForFamily(input.family);
  if (!endpoint || !input.sentBody) return null;
  const requestBody = jsonObject(input.sentBody);
  if (!requestBody) return null;
  const rejection = parseEngineRejection({
    status: input.status,
    bodyText: input.errorText,
    requestBody,
    requestHeaders: input.sentHeaders,
  });
  if (!rejection) return null;
  const plan = planCompatRetry({
    endpoint,
    compat: input.launch.runtime.compat,
    rejection,
    excerpt: upstreamErrorExcerpt(input.errorText),
  });
  if (!plan) return null;
  if (plan.action === "refuse") return { kind: "refuse", refusal: plan.refusal };
  if (plan.action === "stripHeader") return { kind: "header", name: plan.name };
  return { kind: "learn", endpoint, fix: plan.fix };
}

export function launchKeyString(launch: CompatLaunch): string {
  return `${launch.key.runtimeId}:${launch.key.launchHash}`;
}

/** The proxy-added extras a member's runtime allows (undefined without a runtime). */
export function compatExtrasFor(launch: CompatLaunch | undefined): ProxyExtras | undefined {
  return launch ? proxyExtras(launch.runtime) : undefined;
}

/** What compatibility did to one request, across its attempts (names only). */
export type CompatTrace = {
  dropped: Set<string>;
  rewrites: Set<string>;
  headers: Set<string>;
  retried: boolean;
};

export function newCompatTrace(): CompatTrace {
  return { dropped: new Set(), rewrites: new Set(), headers: new Set(), retried: false };
}

export function addCompatReport(trace: CompatTrace, report: CompatSendReport): void {
  for (const path of report.dropped) trace.dropped.add(path);
  for (const rewrite of report.rewrites) trace.rewrites.add(rewrite);
  for (const header of report.headers) trace.headers.add(header);
}

/** The `compat` metadata column value of a request (null when nothing changed). */
export function compatTraceData(
  trace: CompatTrace,
): { dropped: string[]; rewrites: string[]; headers: string[]; retried: boolean } | null {
  if (
    trace.dropped.size === 0 &&
    trace.rewrites.size === 0 &&
    trace.headers.size === 0 &&
    !trace.retried
  )
    return null;
  return {
    dropped: [...trace.dropped].sort().slice(0, 32),
    rewrites: [...trace.rewrites].sort().slice(0, 32),
    headers: [...trace.headers].sort(),
    retried: trace.retried,
  };
}

const MAX_NORMALIZED_JSON_BYTES = 8 * 1024 * 1024;

function normalizedSurface(family: string): NormalizedSurface | null {
  if (family === "chat.completions") return "openai-chat";
  if (family === "messages") return "anthropic-messages";
  return null;
}

/**
 * A natively forwarded success body shaped toward the caller's protocol (finish reasons,
 * reasoning field, thinking signatures, missing Anthropic usage). Other families and bodies
 * pass unchanged; a JSON body larger than the bound passes unchanged too.
 */
export function normalizeNativeResponse(input: {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  family: string;
  launch: CompatLaunch;
  estimate: UsageEstimate | null;
}): ReadableStream<Uint8Array> {
  const surface = normalizedSurface(input.family);
  if (!surface) return input.body;
  const options = normalizeOptions(input.launch.runtime);
  const type = input.contentType?.toLowerCase() ?? "";
  if (type.startsWith("text/event-stream"))
    return input.body.pipeThrough(createSseNormalizer(surface, options, input.estimate));
  if (!type.startsWith("application/json")) return input.body;
  const reader = input.body.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
          size += next.value.byteLength;
          if (size > MAX_NORMALIZED_JSON_BYTES) {
            // Too large to reshape: the rest streams through as it came.
            for (const chunk of chunks) controller.enqueue(chunk);
            while (true) {
              const rest = await reader.read();
              if (rest.done) break;
              controller.enqueue(rest.value);
            }
            controller.close();
            return;
          }
        }
        const whole = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          whole.set(chunk, offset);
          offset += chunk.byteLength;
        }
        controller.enqueue(normalizeJsonBody(whole, surface, options, input.estimate));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
