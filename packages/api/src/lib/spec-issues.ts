/**
 * Copy for the custom issues of the runtime and node definition schemas (`runtime-spec.ts`,
 * `transcription-profile.ts`). `message` is this English text, which the API and MCP return;
 * `params.i18n` names the web app's localized copy (`validation:runtimeSpec.<id>`), which takes
 * the same values as `{{name}}` placeholders. Never rename an id without the locale bundles.
 */
export const RUNTIME_SPEC_ISSUES = {
  textUnicode: "Text must be valid Unicode.",
  textHidden: "Text must not contain control or bidirectional formatting characters.",
  textTooLong: "Text must be at most {maxBytes} bytes.",
  textPadded: "Text must not be blank or have leading or trailing spaces.",
  numberNotCanonical: "Use a whole number or a decimal between 0.000001 and 1e15.",
  commandBlank: "Command must not be blank.",
  unknownPlaceholder: "Unknown placeholder {placeholder}.",
  modelIdPadded: "Model ids must not be blank or have leading or trailing spaces.",
  modelIdMultiline: "Model ids must be a single line.",
  routeInvalid:
    "A route must start with a single / and contain no .., //, ?, #, backslash or encoded . or /.",
  labelsUnique: "Labels must be unique.",
  urlInvalid: "Expected an http(s) URL.",
  urlScheme: "Only http and https are allowed.",
  urlExtras: "No user info, query or fragment.",
  urlHost: "The host must be localhost or an IP literal.",
  urlNormalize: "Write the address as {normalized}.",
  urlPrefix: "The API prefix must be a plain path.",
  authHeader: "A header name is required exactly for mode header.",
  gibRange: "0 < GiB ≤ 1e6.",
  perNodeEntries: "Provide one entry for every rank or exactly one per rank.",
  fabricSingleNode: "Only a multi-node runtime names a fabric.",
  fixedPortGroup: "A fixed port needs groupSize 1.",
  secretTwice: "Name each secret once.",
  serviceStatus: "Service runtimes need a status command (exit 0 alive, exit 3 stopped).",
  interactiveStatus: "Interactive commands need a status command.",
  statusNeverStopped:
    'A status command exits 0 while running and 3 once stopped; this one never says stopped, so a stop could never be proven. For example: systemctl is-active --quiet <unit>, or out=$(docker compose ps --status running -q) || exit 1; [ -n "$out" ] || exit 3.',
  interactiveService: "An interactive start or afterJoin needs management service.",
  interactiveCommand: "An interactive {field} needs a {field} command.",
  labelsMax16: "At most 16 labels.",
  specTooLarge: "A runtime definition is at most {maxBytes} bytes as canonical JSON.",
  addressOrLaunch: "A runtime has exactly one of address (always-on) or launch (startable).",
  servingFields: "A runtime that serves models declares api, engine and modelType.",
  serviceFields: "A service (no models) has no api, engine or modelType.",
  serviceExtras: "A service has no metrics reader or media expansion.",
  servingReadiness: "A runtime that serves models needs an HTTP readiness check.",
  serviceReadiness: "A service needs an HTTP readiness check or a status/health command per rank.",
  duplicateId: "Duplicate id.",
  embeddingModelType: "Embedding contracts need modelType embeddings.",
  transcriptionModelType: "A transcription profile needs modelType transcription.",
  anthropicLlm: "Anthropic runtimes serve LLMs only.",
  segmentedMaxSeconds: "The segmented adapter allows at most {maxSeconds} seconds per turn.",
  metricsPerCommand: "At most 16 metrics per command.",
  metricNamesUnique: "Metric command names must be unique.",
  metricCommandsTooLarge: "Node metric commands are at most {maxBytes} bytes together.",
  fabricIp: "Expected the node's IP address on this fabric (e.g. 10.0.0.5 or fd00::5).",
  fabricOnce: "A node joins each fabric once.",
  fabricSelfIp: "memberIps includes selfIp.",
  portRangeReversed: "The port range must not be reversed.",
  gpuUnifiedVram: "A unified GPU shares system memory: omit vramGb.",
  gpuDiscreteVram: "A discrete GPU needs vramGb (or unified: true when it shares system memory).",
  gpusMax: "At most 256 GPUs.",
} as const;
export type RuntimeSpecIssueId = keyof typeof RUNTIME_SPEC_ISSUES;

type IssueValues = Readonly<Record<string, string | number>>;

/** The English text of an issue, with `{name}` filled from `values`. */
export function specIssueMessage(id: RuntimeSpecIssueId, values: IssueValues = {}): string {
  return RUNTIME_SPEC_ISSUES[id].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values[name] ?? ""),
  );
}

/** `message` and `params` for a zod refinement or `ctx.addIssue` (see the module comment). */
export function specIssue(id: RuntimeSpecIssueId, values: IssueValues = {}) {
  return { message: specIssueMessage(id, values), params: { ...values, i18n: id } };
}
