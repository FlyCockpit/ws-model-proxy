import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  COMPAT_ENDPOINT_PATHS,
  COMPAT_ENDPOINTS,
  COMPAT_HEADERS,
  COMPAT_ROLES,
  type CompatEndpoint,
  type CompatHeader,
  defaultPathProblem,
  type HeaderMode,
  isFieldKey,
  isSemanticPath,
  MAX_REWRITE_RULES,
  parseFieldPath,
  REASONING_FIELD_MODES,
  type ReasoningFieldMode,
  type RequestCompat,
  type RewriteRule,
  renameTargetProblem,
  requestCompatSchema,
  rewriteRuleSchema,
  rulePathProblem,
  SEMANTIC_EQUIVALENTS,
  SEMANTIC_FIELDS,
  UNKNOWN_FIELD_POLICIES,
  type UnknownFieldPolicy,
} from "@ws-model-proxy/api/lib/request-compat";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import type { TFunction } from "i18next";
import { Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;
type Role = (typeof COMPAT_ROLES)[number];
type Tri = "auto" | "on" | "off";
const TRI: readonly Tri[] = ["auto", "on", "off"];
const MAX_ALLOW_DROP = 16;
const K = "dashboard:runtime.compat";

/** The setting as the editor holds it: "auto" and empty lists mean "leave it out". */
type Draft = {
  unknownFieldPolicy: UnknownFieldPolicy;
  allowDrop: string[];
  rules: RewriteRule[];
  headers: Partial<Record<CompatHeader, HeaderMode>>;
  streamUsage: Tri;
  topK: Tri;
  reasoningField: ReasoningFieldMode;
  stripNonStandard: boolean;
};

function triOf(value: boolean | undefined): Tri {
  if (value === undefined) return "auto";
  return value ? "on" : "off";
}

function boolOf(value: Tri): boolean | undefined {
  return value === "auto" ? undefined : value === "on";
}

function draftOf(compat: RequestCompat): Draft {
  return {
    unknownFieldPolicy: compat.unknownFieldPolicy ?? "auto",
    allowDrop: compat.allowDropSemanticFields ?? [],
    rules: compat.rewriteRules ?? [],
    headers: compat.headers ?? {},
    streamUsage: triOf(compat.extras?.streamUsage),
    topK: triOf(compat.extras?.topK),
    reasoningField: compat.response?.reasoningField ?? "auto",
    stripNonStandard: compat.response?.stripNonStandard ?? false,
  };
}

function compatOf(draft: Draft): RequestCompat {
  const compat: RequestCompat = {};
  if (draft.unknownFieldPolicy !== "auto") compat.unknownFieldPolicy = draft.unknownFieldPolicy;
  if (draft.allowDrop.length > 0) compat.allowDropSemanticFields = draft.allowDrop;
  if (draft.rules.length > 0) compat.rewriteRules = draft.rules;
  const headers: Partial<Record<CompatHeader, HeaderMode>> = {};
  for (const header of COMPAT_HEADERS) {
    const mode = draft.headers[header];
    if (mode) headers[header] = mode;
  }
  if (Object.keys(headers).length > 0) compat.headers = headers;
  const streamUsage = boolOf(draft.streamUsage);
  const topK = boolOf(draft.topK);
  if (streamUsage !== undefined || topK !== undefined)
    compat.extras = {
      ...(streamUsage === undefined ? {} : { streamUsage }),
      ...(topK === undefined ? {} : { topK }),
    };
  if (draft.reasoningField !== "auto" || draft.stripNonStandard)
    compat.response = {
      ...(draft.reasoningField === "auto" ? {} : { reasoningField: draft.reasoningField }),
      ...(draft.stripNonStandard ? { stripNonStandard: true } : {}),
    };
  return compat;
}

// ── Validation, with localized reasons (the schema's own messages are for agents) ──

type ProblemKey =
  | "pathSyntax"
  | "pathForbidden"
  | "defaultForbidden"
  | "keySyntax"
  | "renameTarget"
  | "defaultValue"
  | "number"
  | "clampBounds"
  | "clampOrder"
  | "semantic"
  | "duplicate"
  | "invalid";

function pathProblem(path: string): ProblemKey | null {
  if (!parseFieldPath(path)) return "pathSyntax";
  return rulePathProblem(path) ? "pathForbidden" : null;
}

function sameMeaning(path: string, to: string): boolean {
  return Object.values(SEMANTIC_EQUIVALENTS).some(
    (map) => map !== undefined && Object.hasOwn(map, path) && map[path] === to,
  );
}

/** A drop or rename that hides a semantic field the setting does not allow losing. */
function needsAllowDrop(rule: RewriteRule, allowDrop: readonly string[]): boolean {
  if (rule.op !== "drop" && rule.op !== "rename") return false;
  if (!isSemanticPath(rule.path) || allowDrop.includes(rule.path)) return false;
  return !(rule.op === "rename" && sameMeaning(rule.path, rule.to));
}

type RuleValues = {
  op: RewriteRule["op"];
  endpoint: CompatEndpoint | "";
  path: string;
  to: string;
  value: string;
  min: string;
  max: string;
  from: Role;
  toRole: Role;
};
type RuleIssue = { field: keyof RuleValues; key: ProblemKey };

/** Empty: not given; null: not a number. */
function numberOf(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** `true`, `false`, `null` and numbers are read as such; anything else is text. */
function defaultValueOf(text: string): string | number | boolean | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed !== "" && /^[-+.\deE]+$/.test(trimmed) && Number.isFinite(Number(trimmed)))
    return Number(trimmed);
  return trimmed.length <= 128 && /^[A-Za-z0-9 _.,:;=+@-]*$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The rule the add form describes, or why not. Without `context` only the rule itself is
 * checked; with it, also whether the setting allows it (semantic drops, duplicates).
 */
function readRule(
  values: RuleValues,
  context: { allowDrop: readonly string[]; existing: readonly RewriteRule[] } | null,
): { rule: RewriteRule | null; issues: RuleIssue[] } {
  const scope = values.endpoint === "" ? {} : { endpoint: values.endpoint };
  const path = values.path.trim();
  const issues: RuleIssue[] = [];
  let rule: RewriteRule | null = null;
  if (values.op === "mapRole") {
    rule = { op: "mapRole", ...scope, from: values.from, to: values.toRole };
  } else {
    const pathKey = pathProblem(path);
    if (pathKey) issues.push({ field: "path", key: pathKey });
    if (values.op === "drop") {
      rule = { op: "drop", ...scope, path };
    } else if (values.op === "rename") {
      const to = values.to.trim();
      if (!isFieldKey(to)) issues.push({ field: "to", key: "keySyntax" });
      else if (!pathKey && renameTargetProblem(path, to))
        issues.push({ field: "to", key: "renameTarget" });
      rule = { op: "rename", ...scope, path, to };
    } else if (values.op === "default") {
      if (!pathKey && defaultPathProblem(path))
        issues.push({ field: "path", key: "defaultForbidden" });
      const value = defaultValueOf(values.value);
      if (value === undefined) issues.push({ field: "value", key: "defaultValue" });
      else rule = { op: "default", ...scope, path, value };
    } else {
      const min = numberOf(values.min);
      const max = numberOf(values.max);
      if (min === null) issues.push({ field: "min", key: "number" });
      if (max === null) issues.push({ field: "max", key: "number" });
      if (min === undefined && max === undefined) issues.push({ field: "min", key: "clampBounds" });
      else if (typeof min === "number" && typeof max === "number" && min > max)
        issues.push({ field: "max", key: "clampOrder" });
      rule = {
        op: "clamp",
        ...scope,
        path,
        ...(typeof min === "number" ? { min } : {}),
        ...(typeof max === "number" ? { max } : {}),
      };
    }
  }
  if (rule && issues.length === 0 && context && needsAllowDrop(rule, context.allowDrop))
    issues.push({ field: "path", key: "semantic" });
  if (issues.length > 0) return { rule: null, issues };
  const parsed = rewriteRuleSchema.safeParse(rule);
  if (!parsed.success) return { rule: null, issues: [{ field: "op", key: "invalid" }] };
  const json = JSON.stringify(parsed.data);
  if (context?.existing.some((other) => JSON.stringify(other) === json))
    return { rule: null, issues: [{ field: "op", key: "duplicate" }] };
  return { rule: parsed.data, issues: [] };
}

type SaveErrors = {
  rules: Record<number, string>;
  allowDrop: Record<number, string>;
  general: string;
};

function saveErrorsOf(issues: readonly z.core.$ZodIssue[], draft: Draft, t: TFunction): SaveErrors {
  const errors: SaveErrors = { rules: {}, allowDrop: {}, general: t(`${K}.errors.fixBelow`) };
  for (const issue of issues) {
    const [section, index] = issue.path;
    if (section === "rewriteRules" && typeof index === "number") {
      const rule = draft.rules[index];
      const key = rule && needsAllowDrop(rule, draft.allowDrop) ? "semantic" : "invalid";
      errors.rules[index] = t(`${K}.errors.${key}`);
    } else if (section === "allowDropSemanticFields" && typeof index === "number") {
      errors.allowDrop[index] = t(
        `${K}.errors.${pathProblem(draft.allowDrop[index] ?? "") ?? "invalid"}`,
      );
    } else {
      errors.general = t(`${K}.errors.invalid`);
    }
  }
  return errors;
}

function describeRule(rule: RewriteRule, t: TFunction): string {
  switch (rule.op) {
    case "rename":
      return t(`${K}.describe.rename`, { path: rule.path, to: rule.to });
    case "drop":
      return t(`${K}.describe.drop`, { path: rule.path });
    case "default":
      return t(`${K}.describe.default`, { path: rule.path, value: JSON.stringify(rule.value) });
    case "clamp":
      if (rule.min !== undefined && rule.max !== undefined)
        return t(`${K}.describe.clampBoth`, { path: rule.path, min: rule.min, max: rule.max });
      if (rule.min !== undefined)
        return t(`${K}.describe.clampMin`, { path: rule.path, min: rule.min });
      return t(`${K}.describe.clampMax`, { path: rule.path, max: rule.max });
    case "mapRole":
      return t(`${K}.describe.mapRole`, { from: rule.from, to: rule.to });
  }
}

function useCompatUpdate(runtimeId: string) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.runtimes.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const save = async (compat: RequestCompat | null) => {
    try {
      const result = await update.mutateAsync({ runtimeId, compat });
      await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
      toast.success(
        t("dashboard:runtime.savedVersion", {
          version: result.version.version,
          live: result.adoptedLive.length,
          restart: result.needsRestart.length,
        }),
      );
      return true;
    } catch (error) {
      toast.error(refusalText(error));
      return false;
    }
  };
  return { save, pending: update.isPending };
}

// ── The card ──

/**
 * Request compatibility of a runtime: edits the whole setting locally, then saves it as one new
 * version. Key it by the current version id so a new version starts a fresh edit.
 */
export function RequestCompatCard({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const saved = compatOf(draftOf(runtime.current.compat));
  const [draft, setDraft] = useState(() => draftOf(runtime.current.compat));
  const [errors, setErrors] = useState<SaveErrors | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const { save, pending } = useCompatUpdate(runtime.id);
  const policyName = useId();
  const next = compatOf(draft);
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const automatic = Object.keys(saved).length === 0;

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t(`${K}.title`)}</CardTitle>
        <CardDescription>{t(`${K}.hint`)}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">
        <Section title={t(`${K}.policy.label`)} hint={t(`${K}.policy.hint`)}>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="sr-only">{t(`${K}.policy.label`)}</legend>
            {UNKNOWN_FIELD_POLICIES.map((policy) => (
              <label
                key={policy}
                className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary"
              >
                <input
                  type="radio"
                  name={policyName}
                  value={policy}
                  checked={draft.unknownFieldPolicy === policy}
                  onChange={() => edit({ unknownFieldPolicy: policy })}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {t(`${K}.policy.options.${policy}`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`${K}.policy.help.${policy}`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </Section>

        <Section title={t(`${K}.allowDrop.label`)} hint={t(`${K}.allowDrop.hint`)}>
          {draft.allowDrop.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(`${K}.allowDrop.empty`)}</p>
          ) : (
            <ul className="flex min-w-0 flex-wrap gap-2">
              {draft.allowDrop.map((path, index) => (
                <li key={path} className="flex min-w-0 max-w-full flex-col">
                  <span className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/50 pl-2">
                    <code className="min-w-0 break-all font-mono text-xs">{path}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-touch"
                      aria-label={t(`${K}.allowDrop.remove`, { path })}
                      onClick={() =>
                        edit({ allowDrop: draft.allowDrop.filter((other) => other !== path) })
                      }
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </span>
                  {errors?.allowDrop[index] ? (
                    <span className="text-sm text-destructive">{errors.allowDrop[index]}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {draft.allowDrop.length < MAX_ALLOW_DROP ? (
            <AddPathForm
              existing={draft.allowDrop}
              onAdd={(path) => edit({ allowDrop: [...draft.allowDrop, path] })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t(`${K}.allowDrop.limit`)}</p>
          )}
        </Section>

        <Section title={t(`${K}.rules.label`)} hint={t(`${K}.rules.hint`)}>
          {draft.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(`${K}.rules.empty`)}</p>
          ) : (
            <ol className="flex min-w-0 flex-col gap-2">
              {draft.rules.map((rule, index) => (
                <li
                  // Rules are unique within a setting (adding a duplicate is refused).
                  key={JSON.stringify(rule)}
                  className="flex min-w-0 items-start gap-2 rounded-md border p-2 pl-3"
                >
                  <div className="min-w-0 flex-1 py-1.5">
                    <p className="break-words font-mono text-sm">{describeRule(rule, t)}</p>
                    <p className="text-xs text-muted-foreground">
                      {rule.endpoint
                        ? t(`${K}.rules.onlyEndpoint`, {
                            endpoint: COMPAT_ENDPOINT_PATHS[rule.endpoint],
                          })
                        : t(`${K}.rules.everyEndpoint`)}
                    </p>
                    {errors?.rules[index] ? (
                      <p className="text-sm text-destructive">{errors.rules[index]}</p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t(`${K}.rules.remove`, { rule: describeRule(rule, t) })}
                    onClick={() => edit({ rules: draft.rules.filter((_, at) => at !== index) })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ol>
          )}
          {draft.rules.length < MAX_REWRITE_RULES ? (
            <AddRuleForm
              allowDrop={draft.allowDrop}
              existing={draft.rules}
              onAdd={(rule) => edit({ rules: [...draft.rules, rule] })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(`${K}.rules.limit`, { max: MAX_REWRITE_RULES })}
            </p>
          )}
        </Section>

        <Section title={t(`${K}.headers.label`)} hint={t(`${K}.headers.hint`)}>
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
            {COMPAT_HEADERS.map((header) => (
              <li key={header} className="min-w-0 space-y-1.5">
                <Label htmlFor={`compat-header-${header}`} className="font-mono">
                  {header}
                </Label>
                <NativeSelect
                  id={`compat-header-${header}`}
                  value={draft.headers[header] ?? "auto"}
                  onChange={(event) => {
                    const mode = event.target.value;
                    const headers = { ...draft.headers };
                    if (mode === "forward" || mode === "strip") headers[header] = mode;
                    else delete headers[header];
                    edit({ headers });
                  }}
                >
                  <option value="auto">{t(`${K}.headers.auto`)}</option>
                  <option value="forward">{t(`${K}.headers.forward`)}</option>
                  <option value="strip">{t(`${K}.headers.strip`)}</option>
                </NativeSelect>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t(`${K}.extras.label`)} hint={t(`${K}.extras.hint`)}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {(["streamUsage", "topK"] as const).map((extra) => (
              <div key={extra} className="min-w-0 space-y-1.5">
                <Label htmlFor={`compat-extra-${extra}`}>{t(`${K}.extras.${extra}`)}</Label>
                <NativeSelect
                  id={`compat-extra-${extra}`}
                  value={draft[extra]}
                  onChange={(event) => {
                    const value = TRI.find((option) => option === event.target.value);
                    if (value) edit({ [extra]: value });
                  }}
                >
                  {TRI.map((option) => (
                    <option key={option} value={option}>
                      {t(`${K}.extras.options.${option}`)}
                    </option>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">{t(`${K}.extras.help.${extra}`)}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title={t(`${K}.response.label`)} hint={t(`${K}.response.hint`)}>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="compat-reasoning">{t(`${K}.response.reasoningField`)}</Label>
            <NativeSelect
              id="compat-reasoning"
              value={draft.reasoningField}
              onChange={(event) => {
                const value = REASONING_FIELD_MODES.find((mode) => mode === event.target.value);
                if (value) edit({ reasoningField: value });
              }}
            >
              {REASONING_FIELD_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`${K}.response.reasoning.${mode}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex min-h-11 min-w-0 items-start gap-3 pt-2">
            <Checkbox
              id="compat-strip-non-standard"
              className="mt-0.5"
              checked={draft.stripNonStandard}
              onCheckedChange={(checked) => edit({ stripNonStandard: checked === true })}
            />
            <div className="min-w-0">
              <Label htmlFor="compat-strip-non-standard">
                {t(`${K}.response.stripNonStandard`)}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(`${K}.response.stripNonStandardHint`)}
              </p>
            </div>
          </div>
        </Section>

        <div className="flex min-w-0 flex-col gap-2 pt-4">
          {errors ? (
            <p role="alert" className="text-sm text-destructive">
              {errors.general}
            </p>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              size="touch"
              disabled={!dirty || pending}
              onClick={async () => {
                const parsed = requestCompatSchema.safeParse(next);
                if (!parsed.success) {
                  setErrors(saveErrorsOf(parsed.error.issues, draft, t));
                  return;
                }
                await save(parsed.data);
              }}
            >
              {pending ? t("common:actions.saving") : t(`${K}.save`)}
            </Button>
            {dirty ? (
              <Button
                type="button"
                size="touch"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setDraft(draftOf(runtime.current.compat));
                  setErrors(null);
                }}
              >
                {t(`${K}.discard`)}
              </Button>
            ) : null}
            {automatic ? null : (
              <Button
                type="button"
                size="touch"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmReset(true)}
              >
                {t(`${K}.reset`)}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {automatic ? t(`${K}.isAutomatic`) : t(`${K}.isCustom`)}
          </p>
        </div>
      </CardContent>
      <ConfirmAction
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t(`${K}.resetTitle`)}
        description={t(`${K}.resetHint`)}
        confirmLabel={t(`${K}.reset`)}
        pendingLabel={t("common:actions.saving")}
        isPending={pending}
        onConfirm={async () => {
          if (await save(null)) setConfirmReset(false);
        }}
      />
    </Card>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 py-4 first:pt-0">
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function AddPathForm({
  existing,
  onAdd,
}: {
  existing: readonly string[];
  onAdd: (path: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const listId = useId();
  const form = useForm({
    defaultValues: { path: "" },
    validators: {
      onSubmit: z.object({
        path: z.string().superRefine((raw, ctx) => {
          const path = raw.trim();
          const key = pathProblem(path) ?? (existing.includes(path) ? "duplicate" : null);
          if (key) ctx.addIssue({ code: "custom", message: t(`${K}.errors.${key}`) });
        }),
      }),
    },
    onSubmit: ({ value }) => {
      onAdd(value.path.trim());
      form.reset();
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="path">
        {(field) => (
          <>
            <Label htmlFor="compat-allow-drop">{t(`${K}.allowDrop.path`)}</Label>
            <div className="flex min-w-0 gap-2">
              <Input
                id="compat-allow-drop"
                className="h-11 min-w-0 flex-1 font-mono"
                list={listId}
                autoComplete="off"
                spellCheck={false}
                placeholder="response_format"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <Button type="submit" size="touch" variant="outline">
                <Plus aria-hidden="true" />
                {t(`${K}.allowDrop.add`)}
              </Button>
            </div>
            <datalist id={listId}>
              {SEMANTIC_FIELDS.filter((path) => !existing.includes(path)).map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
            <FieldErrors field={field} />
          </>
        )}
      </form.Field>
    </form>
  );
}

const RULE_DEFAULTS: RuleValues = {
  op: "drop",
  endpoint: "",
  path: "",
  to: "",
  value: "",
  min: "",
  max: "",
  from: "developer",
  toRole: "system",
};

const RULE_OPS: readonly RewriteRule["op"][] = ["rename", "drop", "default", "clamp", "mapRole"];

function AddRuleForm({
  allowDrop,
  existing,
  onAdd,
}: {
  allowDrop: readonly string[];
  existing: readonly RewriteRule[];
  onAdd: (rule: RewriteRule) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const roleSchema = z.enum(COMPAT_ROLES);
  // What the rest of the setting refuses (a semantic drop, a duplicate). Kept apart from the
  // form's validation because it changes outside the form; shown only while the setting is
  // the one it was found against.
  const context = { allowDrop, existing };
  const contextKey = JSON.stringify(context);
  const [refused, setRefused] = useState<{ message: string; contextKey: string } | null>(null);
  const refusal = refused?.contextKey === contextKey ? refused.message : null;
  const form = useForm({
    defaultValues: RULE_DEFAULTS,
    validators: {
      onSubmit: z
        .object({
          op: z.enum(RULE_OPS),
          endpoint: z.union([z.enum(COMPAT_ENDPOINTS), z.literal("")]),
          path: z.string(),
          to: z.string(),
          value: z.string(),
          min: z.string(),
          max: z.string(),
          from: roleSchema,
          toRole: roleSchema,
        })
        .superRefine((values, ctx) => {
          for (const issue of readRule(values, null).issues)
            ctx.addIssue({
              code: "custom",
              path: [issue.field],
              message: t(`${K}.errors.${issue.key}`),
            });
        }),
    },
    listeners: { onChange: () => setRefused(null) },
    onSubmit: ({ value }) => {
      const { rule, issues } = readRule(value, context);
      const issue = issues[0];
      if (issue) {
        setRefused({ message: t(`${K}.errors.${issue.key}`), contextKey });
        return;
      }
      if (!rule) return;
      setRefused(null);
      onAdd(rule);
      form.reset({ ...RULE_DEFAULTS, op: value.op, endpoint: value.endpoint });
    },
  });
  const textField = (
    name: "path" | "to" | "value" | "min" | "max",
    options: { mono?: boolean; hint?: string; placeholder?: string; decimal?: boolean },
  ) => (
    <form.Field name={name}>
      {(field) => (
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`compat-rule-${name}`}>{t(`${K}.rules.${name}`)}</Label>
          <Input
            id={`compat-rule-${name}`}
            className={options.mono ? "h-11 font-mono" : "h-11"}
            autoComplete="off"
            spellCheck={false}
            inputMode={options.decimal ? "decimal" : undefined}
            placeholder={options.placeholder}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
          />
          {options.hint ? <p className="text-xs text-muted-foreground">{options.hint}</p> : null}
          <FieldErrors field={field} />
        </div>
      )}
    </form.Field>
  );
  return (
    <form
      className="flex min-w-0 flex-col gap-3 rounded-md border border-dashed p-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <p className="text-sm font-medium">{t(`${K}.rules.add`)}</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <form.Field name="op">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="compat-rule-op">{t(`${K}.rules.op`)}</Label>
              <NativeSelect
                id="compat-rule-op"
                value={field.state.value}
                onChange={(event) => {
                  const op = RULE_OPS.find((option) => option === event.target.value);
                  if (op) field.handleChange(op);
                }}
              >
                {RULE_OPS.map((op) => (
                  <option key={op} value={op}>
                    {t(`${K}.rules.ops.${op}`)}
                  </option>
                ))}
              </NativeSelect>
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="endpoint">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="compat-rule-endpoint">{t(`${K}.rules.endpoint`)}</Label>
              <NativeSelect
                id="compat-rule-endpoint"
                value={field.state.value}
                onChange={(event) =>
                  field.handleChange(
                    COMPAT_ENDPOINTS.find((endpoint) => endpoint === event.target.value) ?? "",
                  )
                }
              >
                <option value="">{t(`${K}.rules.everyEndpoint`)}</option>
                {COMPAT_ENDPOINTS.map((endpoint) => (
                  <option key={endpoint} value={endpoint}>
                    {COMPAT_ENDPOINT_PATHS[endpoint]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => state.values.op}>
        {(op) =>
          op === "mapRole" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {(["from", "toRole"] as const).map((name) => (
                <form.Field key={name} name={name}>
                  {(field) => (
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor={`compat-rule-${name}`}>{t(`${K}.rules.${name}`)}</Label>
                      <NativeSelect
                        id={`compat-rule-${name}`}
                        value={field.state.value}
                        onChange={(event) => {
                          const role = COMPAT_ROLES.find((option) => option === event.target.value);
                          if (role) field.handleChange(role);
                        }}
                      >
                        {COMPAT_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  )}
                </form.Field>
              ))}
            </div>
          ) : (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {textField("path", { mono: true, placeholder: "messages[].cache_control" })}
              {op === "rename" ? textField("to", { mono: true, placeholder: "max_tokens" }) : null}
              {op === "default"
                ? textField("value", {
                    mono: true,
                    hint: t(`${K}.rules.valueHint`),
                    placeholder: "true",
                  })
                : null}
              {op === "clamp" ? (
                <>
                  {textField("min", { decimal: true })}
                  {textField("max", { decimal: true })}
                </>
              ) : null}
            </div>
          )
        }
      </form.Subscribe>
      {refusal ? <p className="text-sm text-destructive">{refusal}</p> : null}
      <Button type="submit" size="touch" variant="outline" className="self-start">
        <Plus aria-hidden="true" />
        {t(`${K}.rules.addButton`)}
      </Button>
    </form>
  );
}
