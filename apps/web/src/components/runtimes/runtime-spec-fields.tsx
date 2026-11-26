import {
  ENGINES,
  GPU_VENDORS,
  type GpuVendor,
  MODEL_CAPABILITIES,
  MODEL_TYPES,
  type ModelCapabilityWire,
  RUNTIME_APIS,
  RUNTIME_TIMEOUTS_SEC,
} from "@ws-model-proxy/api/lib/runtime-spec";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { AdvancedSection, FormSection } from "@ws-model-proxy/ui/components/form-page";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { TFunction } from "i18next";
import { Plus, Trash2 } from "lucide-react";
import { type ComponentProps, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LabelledSelect } from "@/components/labelled-select";
import { useRowKeys } from "@/components/runtimes/use-row-keys";
import { SegmentedControl } from "@/components/segmented-control";
import { type FieldGroupOf, withFieldGroup } from "@/hooks/use-app-form";
import { hasToken, msToSeconds, replaceToken, secondsToMs } from "@/lib/runtime-preset-fill";
import {
  COMMAND_FIELDS,
  type CommandField,
  draftToSpec,
  editorValues,
  emptyCommandDraft,
  emptyReservationDraft,
  losslessDraft,
  newEmbeddingDraft,
  parseBase,
  type ResourceDraft,
  type ResourceKind,
  type RuntimeKind,
  type SpecDraft,
  type SpecEditorValues,
  TIMEOUT_FIELDS,
} from "@/lib/runtime-spec-draft";

type ErrorList = Array<{ message?: string } | string | undefined>;
type TextFieldApi = {
  state: { value: string; meta: { errors: ErrorList } };
  handleChange: (value: string) => void;
  handleBlur: () => void;
};

const RESOURCE_KINDS: ResourceKind[] = ["discrete", "unified", "cpu", "none"];
/** Commands a service needs up front (its preset's `fill` is the whole command entry). */
const SERVICE_COMMANDS: readonly CommandField[] = ["stop", "status"];
/** Commands under "More commands" for every runtime. */
const EXTRA_COMMANDS: readonly CommandField[] = ["prepare", "afterJoin", "health"];

function firstError(errors: ErrorList): string | null {
  for (const error of errors) {
    const message = typeof error === "string" ? error : error?.message;
    if (message) return message;
  }
  return null;
}

/** Every error message of a field (the `check` field collects the ones no input owns). */
function AllErrors({ errors }: { errors: ErrorList }) {
  const messages = [
    ...new Set(
      errors
        .map((error) => (typeof error === "string" ? error : error?.message))
        .filter((message): message is string => !!message),
    ),
  ];
  if (messages.length === 0) return null;
  return (
    <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-destructive">
      {messages.map((message) => (
        <li key={message} className="break-words">
          {message}
        </li>
      ))}
    </ul>
  );
}

/** The field's first error, next to it, as the input's description. */
function InlineError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} data-inline-error="" tabIndex={-1} className="text-sm break-words text-destructive">
      {message}
    </p>
  );
}

function describedBy(...ids: Array<string | false | undefined>): string | undefined {
  const list = ids.filter((id): id is string => typeof id === "string");
  return list.length > 0 ? list.join(" ") : undefined;
}

function TextInput({
  id,
  label,
  field,
  hint,
  mono,
  multiline,
  inputMode,
  placeholder,
}: {
  id: string;
  label: string;
  field: TextFieldApi;
  hint?: string;
  mono?: boolean;
  multiline?: boolean;
  inputMode?: "numeric" | "decimal";
  placeholder?: string;
}) {
  const className = mono ? "font-mono text-xs" : undefined;
  const error = firstError(field.state.meta.errors);
  const a11y = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(hint && `${id}-hint`, error !== null && `${id}-error`),
  } as const;
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea
          id={id}
          rows={2}
          spellCheck={false}
          className={className}
          value={field.state.value}
          placeholder={placeholder}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
          {...a11y}
        />
      ) : (
        <Input
          id={id}
          className={cn("h-11", className)}
          autoCapitalize="none"
          spellCheck={false}
          inputMode={inputMode}
          value={field.state.value}
          placeholder={placeholder}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
          {...a11y}
        />
      )}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <InlineError id={`${id}-error`} message={error} />
    </div>
  );
}

/**
 * A duration the spec holds in milliseconds, typed in seconds. What was typed is kept while it
 * still means the field's value, so "1." stays "1." until the next digit; a value set from
 * elsewhere (a preset, the JSON view) shows as seconds. Any error reads as the allowed range.
 */
function SecondsInput({
  id,
  label,
  field,
  rangeError,
}: {
  id: string;
  label: string;
  field: TextFieldApi;
  rangeError: string;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const shown =
    typed !== null && secondsToMs(typed) === field.state.value
      ? typed
      : msToSeconds(field.state.value);
  const error = firstError(field.state.meta.errors) ? rangeError : null;
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="h-11"
        inputMode="decimal"
        autoCapitalize="none"
        spellCheck={false}
        value={shown}
        onBlur={field.handleBlur}
        onChange={(event) => {
          setTyped(event.target.value);
          field.handleChange(secondsToMs(event.target.value));
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <InlineError id={`${id}-error`} message={error} />
    </div>
  );
}

type SelectFieldApi<T extends string> = {
  state: { value: T; meta: { errors: ErrorList } };
  handleChange: (value: T) => void;
};

function SelectInput<T extends string>({
  id,
  label,
  field,
  options,
}: {
  id: string;
  label: string;
  field: SelectFieldApi<T>;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  const error = firstError(field.state.meta.errors);
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <LabelledSelect
        id={id}
        value={field.state.value}
        options={options}
        onValueChange={field.handleChange}
        invalid={error !== null}
        describedBy={error ? `${id}-error` : undefined}
      />
      <InlineError id={`${id}-error`} message={error} />
    </div>
  );
}

/** A discrete block's GPU vendor (empty: any vendor), for rank resources and reservations. */
function GpuVendorField({ id, field }: { id: string; field: SelectFieldApi<"" | GpuVendor> }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <SelectInput
      id={id}
      label={t("dashboard:runtime.specForm.vendor")}
      field={field}
      options={[
        { value: "", label: t("dashboard:runtime.specForm.anyVendor") },
        ...GPU_VENDORS.map((vendor) => ({
          value: vendor,
          label: t(`dashboard:runtime.specForm.vendors.${vendor}`),
        })),
      ]}
    />
  );
}

function CheckRow({
  id,
  label,
  checked,
  onChange,
  errorId,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The id of this box's rendered error, when it has one. */
  errorId?: string;
}) {
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
      />
      <Label htmlFor={id} className="min-w-0 break-words">
        {label}
      </Label>
    </div>
  );
}

/** A form section named by its title, so screen readers list it among the page's regions. */
function NamedSection({ title, ...props }: ComponentProps<typeof FormSection> & { title: string }) {
  return <FormSection aria-label={title} title={title} {...props} />;
}

/** Where the page's own parts go among the editor's sections. */
export type RuntimeSpecSlots = {
  /** Essential fields of the page (name, node), first. */
  basics?: ReactNode;
  /** The page's always-on/startable choice, inside "How it runs". */
  howItRuns?: ReactNode;
  /** One-line summary of `howItRuns` (the kind). */
  howItRunsSummary?: string;
  /** The page's own Advanced section(s), first among them (slug and note). */
  advanced?: ReactNode;
};

/**
 * The runtime definition editor: a form over `runtimeSpecSchema` and the raw JSON, under one
 * key of a form made with `useAppForm`. The form part puts the few fields a starting point
 * leaves to the person up front (model, start command, size; address and engine for a server
 * already running; the commands of a service) and every other part in a collapsed Advanced
 * section that says what it holds. The JSON view is the expert escape hatch. Switching views
 * converts between them; parts the form has no inputs for are kept (`runtime-spec-draft.ts`).
 */
// react-doctor-disable-next-line react-doctor/only-export-components -- withFieldGroup returns the component itself (React Doctor does not take a customHOCs setting)
export const RuntimeSpecFields = withFieldGroup({
  defaultValues: editorValues({}) as SpecEditorValues,
  props: {} as { kind: RuntimeKind; idPrefix: string } & RuntimeSpecSlots,
  render: function RuntimeSpecFieldsRender({ group, kind, idPrefix, ...slots }) {
    const { t } = useTranslation(["dashboard"]);
    const [switchError, setSwitchError] = useState(false);
    const id = (name: string) => `${idPrefix}-${name}`;

    const showJson = () => {
      const spec = draftToSpec(
        group.getFieldValue("draft"),
        parseBase(group.getFieldValue("base")),
        kind,
      );
      group.setFieldValue("json", JSON.stringify(spec, null, 2));
      group.setFieldValue("tab", "json");
    };
    const showForm = () => {
      const json = group.getFieldValue("json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        setSwitchError(true);
        return;
      }
      // Converted before anything changes, and only when the form keeps the JSON exactly
      // (`losslessDraft`): anything it would drop or change (an unknown key, a shape the form
      // cannot show, a part it would fill in) keeps the JSON tab and its text, with an error.
      const draft = losslessDraft(parsed, kind);
      if (!draft) {
        setSwitchError(true);
        return;
      }
      setSwitchError(false);
      group.setFieldValue("base", json);
      group.setFieldValue("draft", draft);
      group.setFieldValue("tab", "form");
    };

    return (
      <div className="flex min-w-0 flex-col gap-8">
        <group.Subscribe selector={(state) => state.values.tab}>
          {(tab) =>
            tab === "json" ? (
              <>
                {slots.basics}
                <group.Field name="json">
                  {(field) => (
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor={id("json")}>{t("dashboard:runtime.form.spec")}</Label>
                      <Textarea
                        id={id("json")}
                        rows={22}
                        spellCheck={false}
                        className="font-mono text-base md:text-xs"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={field.state.meta.errors.length > 0 || undefined}
                        aria-describedby={id("json-hint")}
                      />
                      <p id={id("json-hint")} className="text-xs text-muted-foreground">
                        {t("dashboard:runtime.form.specHint")}
                      </p>
                      <AllErrors errors={field.state.meta.errors} />
                    </div>
                  )}
                </group.Field>
                {slots.advanced || slots.howItRuns ? (
                  // Margins, not a gap: stacked Advanced sections join into one ruled list.
                  <div className="min-w-0 space-y-8">
                    {slots.advanced}
                    {slots.howItRuns ? (
                      <AdvancedSection
                        gridClassName="lg:grid-cols-1"
                        title={t("dashboard:runtime.specForm.sections.howItRuns")}
                        summary={slots.howItRunsSummary}
                      >
                        {slots.howItRuns}
                      </AdvancedSection>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <DraftSections group={group} kind={kind} id={id} slots={slots} />
            )
          }
        </group.Subscribe>
        <group.Field name="check">
          {(field) => <AllErrors errors={field.state.meta.errors} />}
        </group.Field>
        <group.Subscribe selector={(state) => state.values.tab}>
          {(tab) => (
            <div
              id={id("view")}
              tabIndex={-1}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-dashed p-4"
            >
              <p className="text-sm font-medium">{t("dashboard:runtime.specForm.view")}</p>
              <p className="text-xs text-muted-foreground">
                {t("dashboard:runtime.specForm.viewHint")}
              </p>
              <SegmentedControl
                ariaLabel={t("dashboard:runtime.specForm.view")}
                value={tab}
                onChange={(next) => (next === "json" ? showJson() : showForm())}
                items={[
                  { value: "form", label: t("dashboard:runtime.specForm.formTab") },
                  { value: "json", label: t("dashboard:runtime.specForm.jsonTab") },
                ]}
              />
              {switchError ? (
                <p role="alert" className="text-sm text-destructive">
                  {t("dashboard:runtime.specForm.fixJsonFirst")}
                </p>
              ) : null}
              {tab === "form" ? (
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:runtime.specForm.kept")}
                </p>
              ) : null}
            </div>
          )}
        </group.Subscribe>
      </div>
    );
  },
});

type Group = FieldGroupOf<SpecEditorValues>;
type Ids = (name: string) => string;

function groupSizeOf(value: string): number {
  const size = Number(value);
  return Number.isInteger(size) && size >= 1 && size <= 64 ? size : 1;
}

function DraftSections({
  group,
  kind,
  id,
  slots,
}: {
  group: Group;
  kind: RuntimeKind;
  id: Ids;
  slots: RuntimeSpecSlots;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <group.Subscribe selector={(state) => state.values.draft}>
      {(draft) => {
        const serves = kind === "ALWAYS_ON" || draft.serves;
        const startable = kind === "STARTABLE";
        const service = draft.management === "service";
        return (
          <>
            <div className="flex min-w-0 flex-col gap-8">
              {slots.basics}
              {kind === "ALWAYS_ON" ? (
                <NamedSection
                  id={id("server")}
                  title={t("dashboard:runtime.specForm.sections.server")}
                  description={t("dashboard:runtime.specForm.addressHint")}
                >
                  <group.Field name="draft.baseUrl">
                    {(field) => (
                      <TextInput
                        id={id("base-url")}
                        label={t("dashboard:runtime.specForm.baseUrl")}
                        field={field}
                        mono
                        placeholder="http://127.0.0.1:8000/v1"
                      />
                    )}
                  </group.Field>
                  <EngineField group={group} id={id} />
                </NamedSection>
              ) : null}
              {startable && serves ? (
                <NamedSection
                  gridClassName="lg:grid-cols-1"
                  id={id("model")}
                  title={t("dashboard:runtime.specForm.sections.model")}
                  description={t("dashboard:runtime.specForm.sections.modelHint")}
                >
                  <ModelList group={group} id={id} />
                </NamedSection>
              ) : null}
              {startable ? (
                <NamedSection
                  gridClassName="lg:grid-cols-1"
                  id={id("commands")}
                  title={
                    serves
                      ? t("dashboard:runtime.specForm.sections.start")
                      : t("dashboard:runtime.specForm.commands")
                  }
                  description={t("dashboard:runtime.specForm.commandsHint")}
                >
                  <CommandRows
                    group={group}
                    id={id}
                    commands={draft.commands}
                    fields={service || !serves ? ["start", ...SERVICE_COMMANDS] : ["start"]}
                    optional={[]}
                  />
                  <group.Field name="draft.commands" mode="array">
                    {(field) => (
                      <InlineError
                        id={id("commands-error")}
                        message={firstError(field.state.meta.errors)}
                      />
                    )}
                  </group.Field>
                </NamedSection>
              ) : null}
              {startable && serves ? (
                <NamedSection
                  gridClassName="lg:grid-cols-1"
                  id={id("size")}
                  title={t("dashboard:runtime.specForm.sections.size")}
                  description={t("dashboard:runtime.specForm.resourcesHint")}
                >
                  <ResourceRows group={group} id={id} resources={draft.resources} />
                </NamedSection>
              ) : null}
            </div>
            {/* Margins, not a gap: stacked Advanced sections join into one ruled list. */}
            <div className="min-w-0 space-y-8">
              <div className="min-w-0 space-y-1">
                <h2 className="text-base font-semibold">
                  {t("dashboard:runtime.specForm.sections.advanced")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("dashboard:runtime.specForm.sections.advancedHint")}
                </p>
              </div>
              {slots.advanced}
              {slots.howItRuns || startable ? (
                <AdvancedSection
                  gridClassName="lg:grid-cols-1"
                  title={t("dashboard:runtime.specForm.sections.howItRuns")}
                  summary={[
                    slots.howItRunsSummary,
                    startable
                      ? draft.serves
                        ? t("dashboard:runtime.specForm.serves")
                        : t("dashboard:runtime.specForm.service")
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {slots.howItRuns}
                  {startable ? (
                    <group.Field name="draft.serves">
                      {(field) => (
                        <div className="min-w-0 space-y-1.5">
                          <p className="text-sm font-medium">
                            {t("dashboard:runtime.specForm.servesLabel")}
                          </p>
                          <SegmentedControl
                            ariaLabel={t("dashboard:runtime.specForm.servesLabel")}
                            value={field.state.value ? "serves" : "service"}
                            onChange={(next) => field.handleChange(next === "serves")}
                            items={[
                              { value: "serves", label: t("dashboard:runtime.specForm.serves") },
                              { value: "service", label: t("dashboard:runtime.specForm.service") },
                            ]}
                          />
                        </div>
                      )}
                    </group.Field>
                  ) : null}
                </AdvancedSection>
              ) : null}
              {serves ? <ServingDetails group={group} kind={kind} id={id} draft={draft} /> : null}
              {startable && !serves ? (
                <AdvancedSection
                  gridClassName="lg:grid-cols-1"
                  title={t("dashboard:runtime.specForm.sections.size")}
                  summary={resourceSummary(t, draft.resources)}
                >
                  <ResourceRows group={group} id={id} resources={draft.resources} />
                </AdvancedSection>
              ) : null}
              {startable ? (
                <MoreCommands group={group} id={id} draft={draft} upFront={service || !serves} />
              ) : null}
              {startable ? <LaunchDetails group={group} id={id} draft={draft} /> : null}
              {startable ? <Reservations group={group} id={id} draft={draft} /> : null}
              {startable ? <Readiness group={group} id={id} draft={draft} /> : null}
              {startable ? <Health group={group} id={id} draft={draft} /> : null}
            </div>
          </>
        );
      }}
    </group.Subscribe>
  );
}

function resourceSummary(
  t: TFunction<readonly ["dashboard"]>,
  resources: readonly ResourceDraft[],
): string {
  const [first] = resources;
  if (!first) return t("dashboard:runtime.specForm.resourceKinds.none");
  const one = (resource: ResourceDraft) => {
    switch (resource.kind) {
      case "discrete":
        return t("dashboard:runtime.specForm.summary.gpus", {
          count: Number(resource.gpuCount) || 0,
          vram: resource.vramGb || "?",
        });
      case "unified":
        return t("dashboard:runtime.specForm.summary.unified", {
          memory: resource.memoryGb || "?",
        });
      case "cpu":
        return t("dashboard:runtime.specForm.summary.cpu", { ram: resource.ramGb || "?" });
      default:
        return t("dashboard:runtime.specForm.resourceKinds.none");
    }
  };
  return resources.length > 1
    ? t("dashboard:runtime.specForm.summary.perNode", { count: resources.length })
    : one(first);
}

function EngineField({ group, id }: { group: Group; id: Ids }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <group.Field name="draft.engine">
      {(field) => (
        <SelectInput
          id={id("engine")}
          label={t("dashboard:runtime.specForm.engine")}
          field={field}
          options={ENGINES.map((engine) => ({
            value: engine,
            label: t(`dashboard:runtime.specForm.engines.${engine}`),
          }))}
        />
      )}
    </group.Field>
  );
}

/**
 * What a model ID's rename starts from: the ID the commands and the embedding contract name, and
 * their state then. `written` is the commands as the rename last left them, and `lastId` the ID
 * it last wrote: a command edited by hand since starts a new rename from there.
 */
type RenameBase = {
  id: string;
  commands: SpecDraft["commands"];
  embedding: { model: string; vectorSpace: string };
  written: SpecDraft["commands"];
  /** The embedding contract's model and vector space as the rename last left them. */
  writtenEmbedding: { model: string; vectorSpace: string };
  lastId: string;
};

function renameBaseOf(group: Group, index: number, id: string): RenameBase {
  const embedding = group.getFieldValue(`draft.models[${index}].embedding`);
  const commands = group.getFieldValue("draft.commands");
  const contract = { model: embedding.model, vectorSpace: embedding.vectorSpace };
  return {
    id,
    commands,
    embedding: contract,
    written: commands,
    writtenEmbedding: contract,
    lastId: id,
  };
}

/** Whether nothing the rename keeps in step was changed by hand since it last wrote. */
function renameStillOpen(group: Group, index: number, base: RenameBase): boolean {
  const embedding = group.getFieldValue(`draft.models[${index}].embedding`);
  return (
    group.getFieldValue("draft.commands") === base.written &&
    embedding.model === base.writtenEmbedding.model &&
    embedding.vectorSpace === base.writtenEmbedding.vectorSpace
  );
}

/**
 * A model ID being renamed: the commands (a preset's start command names the model) and the
 * model's embedding contract follow, wherever they named the ID the rename started from as a
 * whole word. Every keystroke is applied to that starting state, never to the last keystroke's
 * result, so an in-between value that equals another model's ID cannot capture its mentions.
 */
function followModelId(group: Group, index: number, base: RenameBase, to: string) {
  const from = base.id;
  if (base.commands.some((command) => COMMAND_FIELDS.some((name) => hasToken(command[name], from))))
    group.setFieldValue(
      "draft.commands",
      base.commands.map((command) => {
        const next = { ...command, timeouts: { ...command.timeouts } };
        for (const name of COMMAND_FIELDS) next[name] = replaceToken(command[name], from, to);
        return next;
      }),
    );
  if (base.embedding.model === from)
    group.setFieldValue(`draft.models[${index}].embedding.model`, to);
  if (base.embedding.vectorSpace === from)
    group.setFieldValue(`draft.models[${index}].embedding.vectorSpace`, to);
}

/** The served model IDs (add and remove), each with its embedding contract when it has one. */
function ModelList({ group, id, discovered }: { group: Group; id: Ids; discovered?: boolean }) {
  const { t } = useTranslation(["dashboard"]);
  const rowKeys = useRowKeys("model-");
  // Per row, the state a rename started from (taken at its first keystroke, dropped on blur):
  // clearing the input and typing a new ID still updates the commands.
  const renames = useRef<Record<number, RenameBase>>({});
  return (
    <group.Field name="draft.models" mode="array">
      {(models) => (
        <div className="flex min-w-0 flex-col gap-3">
          {discovered ? (
            <p className="text-xs text-muted-foreground">
              {t("dashboard:runtime.specForm.modelsDiscovered")}
            </p>
          ) : null}
          {models.state.value.map((model, index) => (
            <div key={rowKeys.key(index)} className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 items-end gap-2">
                <div className="min-w-0 flex-1">
                  <group.Field name={`draft.models[${index}].id`}>
                    {(field) => (
                      <group.Subscribe
                        selector={(state) =>
                          state.values.draft.commands.some((command) =>
                            COMMAND_FIELDS.some((name) =>
                              hasToken(command[name], field.state.value),
                            ),
                          )
                        }
                      >
                        {(inCommands) => (
                          <TextInput
                            id={id(`model-${index}`)}
                            label={t("dashboard:runtime.specForm.modelId")}
                            hint={
                              inCommands
                                ? t("dashboard:runtime.specForm.modelIdFollows")
                                : undefined
                            }
                            field={{
                              state: field.state,
                              handleBlur: () => {
                                // An ID left empty keeps its rename open for the next edit.
                                if (field.state.value.trim() !== "") delete renames.current[index];
                                field.handleBlur();
                              },
                              handleChange: (next: string) => {
                                const open = renames.current[index];
                                const base =
                                  open && renameStillOpen(group, index, open)
                                    ? open
                                    : renameBaseOf(group, index, open?.lastId ?? field.state.value);
                                field.handleChange(next);
                                if (next.trim() !== "") {
                                  followModelId(group, index, base, next);
                                  const embedding = group.getFieldValue(
                                    `draft.models[${index}].embedding`,
                                  );
                                  base.written = group.getFieldValue("draft.commands");
                                  base.writtenEmbedding = {
                                    model: embedding.model,
                                    vectorSpace: embedding.vectorSpace,
                                  };
                                  base.lastId = next;
                                }
                                renames.current[index] = base;
                              },
                            }}
                            mono
                          />
                        )}
                      </group.Subscribe>
                    )}
                  </group.Field>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-touch"
                  aria-label={t("dashboard:runtime.specForm.removeModel")}
                  onClick={() => {
                    rowKeys.remove(models.state.value.length, index);
                    renames.current = {};
                    models.removeValue(index);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              {model.hasEmbedding ? <EmbeddingFields group={group} id={id} index={index} /> : null}
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() =>
                models.pushValue({
                  id: "",
                  hasEmbedding: false,
                  embedding: newEmbeddingDraft(""),
                  declareCapabilities: false,
                  capabilities: [],
                  baseIndex: -1,
                })
              }
            >
              <Plus aria-hidden="true" />
              {t("dashboard:runtime.specForm.addModel")}
            </Button>
          </div>
          <InlineError id={id("models-error")} message={firstError(models.state.meta.errors)} />
        </div>
      )}
    </group.Field>
  );
}

/** A model's embedding contract: what its vectors mean, so clients never mix vector spaces. */
function EmbeddingFields({ group, id, index }: { group: Group; id: Ids; index: number }) {
  const { t } = useTranslation(["dashboard"]);
  const base = `draft.models[${index}].embedding` as const;
  return (
    <fieldset className="grid min-w-0 gap-4 rounded-lg border p-3 lg:grid-cols-2">
      <legend className="px-1 text-sm font-medium">
        {t("dashboard:runtime.specForm.embedding.title")}
      </legend>
      <div className="min-w-0 lg:col-span-2">
        <p className="text-xs text-muted-foreground">
          {t("dashboard:runtime.specForm.embedding.hint")}
        </p>
      </div>
      <group.Field name={`${base}.revision`}>
        {(field) => (
          <TextInput
            id={id(`model-${index}-embedding-revision`)}
            label={t("dashboard:runtime.specForm.embedding.revision")}
            hint={t("dashboard:runtime.specForm.embedding.revisionHint")}
            field={field}
            mono
          />
        )}
      </group.Field>
      <group.Field name={`${base}.dimensions`}>
        {(field) => (
          <TextInput
            id={id(`model-${index}-embedding-dimensions`)}
            label={t("dashboard:runtime.specForm.embedding.dimensions")}
            field={field}
            inputMode="numeric"
          />
        )}
      </group.Field>
      <group.Field name={`${base}.model`}>
        {(field) => (
          <TextInput
            id={id(`model-${index}-embedding-model`)}
            label={t("dashboard:runtime.specForm.embedding.model")}
            field={field}
            mono
          />
        )}
      </group.Field>
      <group.Field name={`${base}.vectorSpace`}>
        {(field) => (
          <TextInput
            id={id(`model-${index}-embedding-space`)}
            label={t("dashboard:runtime.specForm.embedding.vectorSpace")}
            hint={t("dashboard:runtime.specForm.embedding.vectorSpaceHint")}
            field={field}
            mono
          />
        )}
      </group.Field>
      <group.Field name={`${base}.normalization`}>
        {(field) => (
          <SelectInput
            id={id(`model-${index}-embedding-normalization`)}
            label={t("dashboard:runtime.specForm.embedding.normalization")}
            field={field}
            options={(["l2", "none"] as const).map((value) => ({
              value,
              label: t(`dashboard:runtime.specForm.embedding.normalizations.${value}`),
            }))}
          />
        )}
      </group.Field>
    </fieldset>
  );
}

/** "Every node" for one entry, "Node n" when there is one per node of the group. */
function RankTitle({ index, total }: { index: number; total: number }) {
  const { t } = useTranslation(["dashboard"]);
  if (total === 1) return null;
  return (
    <p className="text-sm font-medium">
      {t("dashboard:runtime.specForm.rank", { number: index + 1 })}
    </p>
  );
}

function rankBox(total: number) {
  return total > 1
    ? "flex min-w-0 flex-col gap-4 rounded-lg border p-3"
    : "flex min-w-0 flex-col gap-4";
}

/** Some commands of every rank entry (one shared entry, or one per node). */
function CommandRows({
  group,
  id,
  commands,
  fields,
  optional,
}: {
  group: Group;
  id: Ids;
  commands: SpecDraft["commands"];
  fields: readonly CommandField[];
  optional: readonly CommandField[];
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <>
      {commands.map((_, index) => (
        // Positional keys: rows are ranks (row i is rank i), never removed one by one
        <div key={index} className={rankBox(commands.length)}>
          <RankTitle index={index} total={commands.length} />
          {fields.map((name) => (
            <group.Field key={name} name={`draft.commands[${index}].${name}`}>
              {(field) => (
                <TextInput
                  id={id(`command-${index}-${name}`)}
                  label={t(`dashboard:runtime.specForm.commandFields.${name}`)}
                  hint={
                    optional.includes(name) ? t("dashboard:runtime.specForm.optional") : undefined
                  }
                  field={field}
                  mono
                  multiline
                />
              )}
            </group.Field>
          ))}
        </div>
      ))}
    </>
  );
}

/** The path of one resource draft: a rank's entry, or a reservation's resource. */
type ResourcePath = `draft.resources[${number}]` | `draft.reservations[${number}].resource`;

/**
 * One resource's inputs (its kind and what that kind holds), for rank resources and
 * reservations. `idPrefix` names the inputs (`resource-0`, `reservation-1`).
 */
function ResourceFields({
  group,
  id,
  path,
  idPrefix,
  kind,
}: {
  group: Group;
  id: Ids;
  path: ResourcePath;
  idPrefix: string;
  kind: ResourceKind;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <>
      <group.Field name={`${path}.kind`}>
        {(field) => (
          <SelectInput
            id={id(`${idPrefix}-kind`)}
            label={t("dashboard:runtime.specForm.resourceKind")}
            field={field}
            options={RESOURCE_KINDS.map((option) => ({
              value: option,
              label: t(`dashboard:runtime.specForm.resourceKinds.${option}`),
            }))}
          />
        )}
      </group.Field>
      {kind === "unified" ? (
        <group.Field name={`${path}.memoryGb`}>
          {(field) => (
            <TextInput
              id={id(`${idPrefix}-memory`)}
              label={t("dashboard:runtime.specForm.memoryGb")}
              field={field}
              inputMode="decimal"
            />
          )}
        </group.Field>
      ) : null}
      {kind === "discrete" ? (
        <>
          <group.Field name={`${path}.gpuCount`}>
            {(field) => (
              <TextInput
                id={id(`${idPrefix}-gpus`)}
                label={t("dashboard:runtime.specForm.gpuCount")}
                field={field}
                inputMode="numeric"
              />
            )}
          </group.Field>
          <group.Field name={`${path}.vramGb`}>
            {(field) => (
              <TextInput
                id={id(`${idPrefix}-vram`)}
                label={t("dashboard:runtime.specForm.vramGb")}
                field={field}
                inputMode="decimal"
              />
            )}
          </group.Field>
          <group.Field name={`${path}.vendor`}>
            {(field) => <GpuVendorField id={id(`${idPrefix}-vendor`)} field={field} />}
          </group.Field>
        </>
      ) : null}
      {kind === "cpu" || kind === "discrete" ? (
        <group.Field name={`${path}.ramGb`}>
          {(field) => (
            <TextInput
              id={id(`${idPrefix}-ram`)}
              label={t("dashboard:runtime.specForm.ramGb")}
              hint={kind === "discrete" ? t("dashboard:runtime.specForm.optional") : undefined}
              field={field}
              inputMode="decimal"
            />
          )}
        </group.Field>
      ) : null}
    </>
  );
}

function ResourceRows({
  group,
  id,
  resources,
}: {
  group: Group;
  id: Ids;
  resources: readonly ResourceDraft[];
}) {
  return (
    <group.Field name="draft.resources" mode="array">
      {(field) => (
        <>
          {resources.map((resource, index) => (
            // Positional keys: rows are ranks (row i is rank i), never removed one by one
            <div key={index} className={rankBox(resources.length)}>
              <RankTitle index={index} total={resources.length} />
              <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <ResourceFields
                  group={group}
                  id={id}
                  path={`draft.resources[${index}]`}
                  idPrefix={`resource-${index}`}
                  kind={resource.kind}
                />
              </div>
            </div>
          ))}
          <InlineError id={id("resources-error")} message={firstError(field.state.meta.errors)} />
        </>
      )}
    </group.Field>
  );
}

function ServingDetails({
  group,
  kind,
  id,
  draft,
}: {
  group: Group;
  kind: RuntimeKind;
  id: Ids;
  draft: SpecDraft;
}) {
  const { t } = useTranslation(["dashboard"]);
  const declared = draft.models.some((model) => model.declareCapabilities);
  const summary = [
    t(`dashboard:runtime.specForm.apis.${draft.api}`),
    kind === "STARTABLE" ? t(`dashboard:runtime.specForm.engines.${draft.engine}`) : undefined,
    t(`dashboard:runtime.specForm.modelTypes.${draft.modelType}`),
    kind === "ALWAYS_ON"
      ? draft.models.length === 0
        ? t("dashboard:runtime.specForm.summary.modelsDiscovered")
        : t("dashboard:runtime.specForm.summary.models", { count: draft.models.length })
      : undefined,
    t("dashboard:runtime.specForm.summary.media", {
      value: t(`dashboard:runtime.specForm.expandMediaValues.${draft.expandMedia}`),
    }),
    declared
      ? t("dashboard:runtime.specForm.summary.capabilitiesDeclared")
      : t("dashboard:runtime.specForm.summary.capabilitiesDetected"),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AdvancedSection
      gridClassName="lg:grid-cols-1"
      title={t("dashboard:runtime.specForm.sections.serving")}
      summary={summary}
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {kind === "STARTABLE" ? <EngineField group={group} id={id} /> : null}
        <group.Field name="draft.api">
          {(field) => (
            <SelectInput
              id={id("api")}
              label={t("dashboard:runtime.specForm.api")}
              field={field}
              options={RUNTIME_APIS.map((api) => ({
                value: api,
                label: t(`dashboard:runtime.specForm.apis.${api}`),
              }))}
            />
          )}
        </group.Field>
        <group.Field name="draft.modelType">
          {(field) => (
            <SelectInput
              id={id("model-type")}
              label={t("dashboard:runtime.specForm.modelType")}
              field={field}
              options={MODEL_TYPES.map((type) => ({
                value: type,
                label: t(`dashboard:runtime.specForm.modelTypes.${type}`),
              }))}
            />
          )}
        </group.Field>
        <group.Field name="draft.expandMedia">
          {(field) => (
            <SelectInput
              id={id("expand-media")}
              label={t("dashboard:runtime.specForm.expandMedia")}
              field={field}
              options={(["auto", "on", "off"] as const).map((value) => ({
                value,
                label: t(`dashboard:runtime.specForm.expandMediaValues.${value}`),
              }))}
            />
          )}
        </group.Field>
      </div>
      {kind === "ALWAYS_ON" ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-medium">{t("dashboard:runtime.specForm.models")}</p>
          <ModelList group={group} id={id} discovered />
        </div>
      ) : null}
      {draft.modelType === "embeddings" ? (
        <EmbeddingToggles group={group} draft={draft} id={id} />
      ) : null}
      {draft.modelType === "transcription" ? (
        <p
          id={id("transcription")}
          tabIndex={-1}
          className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"
        >
          {t("dashboard:runtime.specForm.transcriptionKept")}
        </p>
      ) : null}
      {draft.models.map((model, index) => (
        <group.Field
          key={`${index}-${model.baseIndex}`}
          name={`draft.models[${index}].declareCapabilities`}
        >
          {(declare) => (
            <div className="flex min-w-0 flex-col gap-1">
              <CheckRow
                id={id(`model-${index}-declare`)}
                label={t("dashboard:runtime.specForm.declareCapabilitiesOf", {
                  model:
                    model.id || t("dashboard:runtime.specForm.modelNumber", { number: index + 1 }),
                })}
                checked={declare.state.value}
                onChange={declare.handleChange}
              />
              {declare.state.value ? (
                <group.Field name={`draft.models[${index}].capabilities`}>
                  {(field) => (
                    <CapabilityChecks
                      idBase={id(`model-${index}-cap`)}
                      value={field.state.value}
                      onChange={field.handleChange}
                    />
                  )}
                </group.Field>
              ) : null}
            </div>
          )}
        </group.Field>
      ))}
    </AdvancedSection>
  );
}

/** Add or drop a model's embedding contract (an embeddings runtime should state one). */
function EmbeddingToggles({ group, draft, id }: { group: Group; draft: SpecDraft; id: Ids }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <>
      {draft.models.map((model, index) => (
        <div
          // Positional keys: one toggle per model row, in row order
          key={index}
          className="flex min-w-0 flex-wrap items-center justify-between gap-2"
        >
          <p className="min-w-0 text-sm break-words">
            {model.hasEmbedding
              ? t("dashboard:runtime.specForm.embedding.has", { model: model.id })
              : t("dashboard:runtime.specForm.embedding.none", { model: model.id })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            id={id(`model-${index}-embedding-toggle`)}
            onClick={() => {
              if (!model.hasEmbedding && model.embedding.model === "")
                group.setFieldValue(
                  `draft.models[${index}].embedding`,
                  newEmbeddingDraft(model.id),
                );
              group.setFieldValue(`draft.models[${index}].hasEmbedding`, !model.hasEmbedding);
            }}
          >
            {model.hasEmbedding
              ? t("dashboard:runtime.specForm.embedding.remove")
              : t("dashboard:runtime.specForm.embedding.add")}
          </Button>
        </div>
      ))}
    </>
  );
}

export function CapabilityChecks({
  idBase,
  value,
  onChange,
}: {
  idBase: string;
  value: readonly ModelCapabilityWire[];
  onChange: (next: ModelCapabilityWire[]) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="grid min-w-0 gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
      {MODEL_CAPABILITIES.map((capability) => (
        <CheckRow
          key={capability}
          id={`${idBase}-${capability}`}
          label={t(`dashboard:runtime.capabilities.values.${capability}`)}
          checked={value.includes(capability)}
          onChange={(checked) =>
            onChange(
              checked
                ? MODEL_CAPABILITIES.filter((item) => item === capability || value.includes(item))
                : value.filter((item) => item !== capability),
            )
          }
        />
      ))}
    </div>
  );
}

/** Stop and status (when not up front), prepare, after-join and health, and every timeout. */
function MoreCommands({
  group,
  id,
  draft,
  upFront,
}: {
  group: Group;
  id: Ids;
  draft: SpecDraft;
  /** Stop and status are already shown up front (a service). */
  upFront: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const fields: CommandField[] = [...(upFront ? [] : SERVICE_COMMANDS), ...EXTRA_COMMANDS];
  const set = fields.filter((name) =>
    draft.commands.some((command) => command[name].trim() !== "" && command[name] !== "true"),
  );
  const custom = draft.commands.some((command) =>
    TIMEOUT_FIELDS.some((name) => command.timeouts[name].trim() !== ""),
  );
  const summary = [
    set.length === 0
      ? t("dashboard:runtime.specForm.summary.moreCommandsNone")
      : t("dashboard:runtime.specForm.summary.moreCommandsSet", {
          names: set
            .map((name) => t(`dashboard:runtime.specForm.commandFields.${name}`))
            .join(", "),
        }),
    custom
      ? t("dashboard:runtime.specForm.summary.timeoutsCustom")
      : t("dashboard:runtime.specForm.summary.timeoutsDefault"),
  ].join(" · ");
  return (
    <AdvancedSection
      gridClassName="lg:grid-cols-1"
      title={t("dashboard:runtime.specForm.sections.moreCommands")}
      summary={summary}
    >
      {draft.commands.map((_, index) => (
        // Positional keys: rows are ranks (row i is rank i), never removed one by one
        <div key={index} className={rankBox(draft.commands.length)}>
          <RankTitle index={index} total={draft.commands.length} />
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {fields.map((name) => (
              <group.Field key={name} name={`draft.commands[${index}].${name}`}>
                {(field) => (
                  <TextInput
                    id={id(`command-${index}-${name}`)}
                    label={t(`dashboard:runtime.specForm.commandFields.${name}`)}
                    hint={t(`dashboard:runtime.specForm.commandHints.${name}`)}
                    field={field}
                    mono
                    multiline
                  />
                )}
              </group.Field>
            ))}
          </div>
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium">{t("dashboard:runtime.specForm.timeouts")}</p>
            <p className="text-xs text-muted-foreground">
              {t("dashboard:runtime.specForm.timeoutsHint")}
            </p>
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-5">
              {TIMEOUT_FIELDS.map((name) => (
                <group.Field key={name} name={`draft.commands[${index}].timeouts.${name}`}>
                  {(field) => (
                    <TextInput
                      id={id(`command-${index}-timeout-${name}`)}
                      label={t(`dashboard:runtime.specForm.commandFields.${name}`)}
                      field={field}
                      inputMode="numeric"
                      placeholder={String(RUNTIME_TIMEOUTS_SEC[name].default)}
                    />
                  )}
                </group.Field>
              ))}
            </div>
          </div>
        </div>
      ))}
    </AdvancedSection>
  );
}

function LaunchDetails({ group, id, draft }: { group: Group; id: Ids; draft: SpecDraft }) {
  const { t } = useTranslation(["dashboard"]);
  const groupSize = groupSizeOf(draft.groupSize);
  const labels = draft.labels.split(/[\s,]+/).filter(Boolean);
  const summary = [
    draft.management === "service"
      ? t("dashboard:runtime.specForm.summary.managedService")
      : t("dashboard:runtime.specForm.summary.managedProcess"),
    t("dashboard:runtime.specForm.summary.groupSize", { count: groupSize }),
    labels.length === 0
      ? t("dashboard:runtime.specForm.summary.anyNode")
      : t("dashboard:runtime.specForm.summary.labels", { labels: labels.join(", ") }),
    draft.fixedPort.trim() === ""
      ? t("dashboard:runtime.specForm.summary.freePort")
      : t("dashboard:runtime.specForm.summary.port", { port: draft.fixedPort.trim() }),
  ].join(" · ");
  return (
    <AdvancedSection
      gridClassName="lg:grid-cols-1"
      title={t("dashboard:runtime.specForm.sections.launch")}
      summary={summary}
    >
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <group.Field name="draft.management">
          {(field) => (
            <SelectInput
              id={id("management")}
              label={t("dashboard:runtime.specForm.management")}
              field={field}
              options={[
                { value: "process", label: t("dashboard:runtime.specForm.process") },
                { value: "service", label: t("dashboard:runtime.specForm.serviceUnit") },
              ]}
            />
          )}
        </group.Field>
        <group.Field name="draft.groupSize">
          {(field) => (
            <TextInput
              id={id("group-size")}
              label={t("dashboard:runtime.specForm.groupSize")}
              hint={t("dashboard:runtime.specForm.groupSizeHint")}
              field={field}
              inputMode="numeric"
            />
          )}
        </group.Field>
        <group.Field name="draft.labels">
          {(field) => (
            <TextInput
              id={id("labels")}
              label={t("dashboard:runtime.specForm.labels")}
              hint={t("dashboard:runtime.specForm.labelsHint")}
              field={field}
              mono
            />
          )}
        </group.Field>
        <group.Field name="draft.fixedPort">
          {(field) => (
            <TextInput
              id={id("fixed-port")}
              label={t("dashboard:runtime.specForm.fixedPort")}
              hint={t("dashboard:runtime.specForm.fixedPortHint")}
              field={field}
              inputMode="numeric"
            />
          )}
        </group.Field>
        {draft.groupSize.trim() !== "1" ? (
          <group.Field name="draft.fabric">
            {(field) => (
              <TextInput
                id={id("fabric")}
                label={t("dashboard:runtime.specForm.fabric")}
                hint={t("dashboard:runtime.specForm.fabricHint")}
                field={field}
                mono
              />
            )}
          </group.Field>
        ) : null}
      </div>
      {groupSize > 1 || draft.resources.length > 1 || draft.commands.length > 1 ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-medium">{t("dashboard:runtime.specForm.perRankTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("dashboard:runtime.specForm.perRankHint")}
          </p>
          <div className="flex min-w-0 flex-wrap gap-2">
            <PerRankToggle
              label={t("dashboard:runtime.specForm.perRankSize")}
              count={draft.resources.length}
              groupSize={groupSize}
              onSplit={() => {
                const [first] = draft.resources;
                if (!first) return;
                group.setFieldValue(
                  "draft.resources",
                  Array.from({ length: groupSize }, () => ({ ...first })),
                );
              }}
              onJoin={() => group.setFieldValue("draft.resources", draft.resources.slice(0, 1))}
            />
            <PerRankToggle
              label={t("dashboard:runtime.specForm.perRankCommands")}
              count={draft.commands.length}
              groupSize={groupSize}
              onSplit={() => {
                const [first = emptyCommandDraft()] = draft.commands;
                group.setFieldValue(
                  "draft.commands",
                  Array.from({ length: groupSize }, () => ({
                    ...first,
                    timeouts: { ...first.timeouts },
                  })),
                );
              }}
              onJoin={() => group.setFieldValue("draft.commands", draft.commands.slice(0, 1))}
            />
          </div>
        </div>
      ) : null}
    </AdvancedSection>
  );
}

/** Per-rank entries: one shared entry, or one per node once the group has several. */
function PerRankToggle({
  label,
  count,
  groupSize,
  onSplit,
  onJoin,
}: {
  label: string;
  count: number;
  groupSize: number;
  onSplit: () => void;
  onJoin: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  if (count > 1)
    return (
      <Button type="button" variant="outline" size="touch" onClick={onJoin}>
        {t("dashboard:runtime.specForm.sameForEveryRankOf", { what: label })}
      </Button>
    );
  if (groupSize > 1)
    return (
      <Button type="button" variant="outline" size="touch" onClick={onSplit}>
        {t("dashboard:runtime.specForm.perRankOf", { what: label })}
      </Button>
    );
  return null;
}

/**
 * `launch.reservations`: memory a single-node runtime holds on other nodes (its launcher starts
 * work there itself). Each names labels and what it holds; nothing runs there from wsmp.
 */
function Reservations({ group, id, draft }: { group: Group; id: Ids; draft: SpecDraft }) {
  const { t } = useTranslation(["dashboard"]);
  const rowKeys = useRowKeys("reservation-");
  const summary =
    draft.reservations.length === 0
      ? t("dashboard:runtime.specForm.summary.reservationsNone")
      : t("dashboard:runtime.specForm.summary.reservations", {
          count: draft.reservations.length,
        });
  return (
    <AdvancedSection
      gridClassName="lg:grid-cols-1"
      title={t("dashboard:runtime.specForm.reservations")}
      summary={summary}
    >
      <p className="text-xs text-muted-foreground">
        {t("dashboard:runtime.specForm.reservationsHint")}
      </p>
      <group.Field name="draft.reservations" mode="array">
        {(reservations) => (
          <>
            {reservations.state.value.map((reservation, index) => (
              <div
                key={rowKeys.key(index)}
                className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {t("dashboard:runtime.specForm.reservation", { number: index + 1 })}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:runtime.specForm.removeReservation", {
                      number: index + 1,
                    })}
                    onClick={() => {
                      rowKeys.remove(reservations.state.value.length, index);
                      reservations.removeValue(index);
                    }}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <group.Field name={`draft.reservations[${index}].labels`}>
                    {(field) => (
                      <TextInput
                        id={id(`reservation-${index}-labels`)}
                        label={t("dashboard:runtime.specForm.labels")}
                        hint={t("dashboard:runtime.specForm.reservationLabelsHint")}
                        field={field}
                        mono
                      />
                    )}
                  </group.Field>
                  <ResourceFields
                    group={group}
                    id={id}
                    path={`draft.reservations[${index}].resource`}
                    idPrefix={`reservation-${index}`}
                    kind={reservation.resource.kind}
                  />
                </div>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="touch"
                onClick={() => reservations.pushValue(emptyReservationDraft())}
              >
                <Plus aria-hidden="true" className="size-4" />
                {t("dashboard:runtime.specForm.addReservation")}
              </Button>
            </div>
            <InlineError
              id={id("reservations-error")}
              message={firstError(reservations.state.meta.errors)}
            />
          </>
        )}
      </group.Field>
    </AdvancedSection>
  );
}

function Readiness({ group, id, draft }: { group: Group; id: Ids; draft: SpecDraft }) {
  const { t } = useTranslation(["dashboard"]);
  const { readiness } = draft;
  const summary = readiness.enabled
    ? t("dashboard:runtime.specForm.summary.readiness", {
        path: readiness.path || "/",
        status: readiness.expectedStatus || "200",
        seconds: msToSeconds(readiness.timeoutMs) || "?",
      })
    : t("dashboard:runtime.specForm.summary.readinessOff");
  return (
    <AdvancedSection
      gridClassName="lg:grid-cols-1"
      title={t("dashboard:runtime.specForm.readiness")}
      summary={summary}
    >
      <group.Field name="draft.readiness.enabled">
        {(field) => (
          <>
            <CheckRow
              id={id("readiness")}
              label={t("dashboard:runtime.specForm.readinessEnabled")}
              checked={field.state.value}
              onChange={field.handleChange}
              errorId={firstError(field.state.meta.errors) ? id("readiness-error") : undefined}
            />
            <InlineError id={id("readiness-error")} message={firstError(field.state.meta.errors)} />
            {field.state.value ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-3">
                <group.Field name="draft.readiness.path">
                  {(path) => (
                    <TextInput
                      id={id("readiness-path")}
                      label={t("dashboard:runtime.specForm.readinessPath")}
                      field={path}
                      mono
                    />
                  )}
                </group.Field>
                <group.Field name="draft.readiness.expectedStatus">
                  {(status) => (
                    <TextInput
                      id={id("readiness-status")}
                      label={t("dashboard:runtime.specForm.readinessStatus")}
                      field={status}
                      inputMode="numeric"
                    />
                  )}
                </group.Field>
                <group.Field name="draft.readiness.timeoutMs">
                  {(timeout) => (
                    <SecondsInput
                      id={id("readiness-timeout")}
                      label={t("dashboard:runtime.specForm.readinessTimeout")}
                      field={timeout}
                      rangeError={t("dashboard:runtime.specForm.readinessTimeoutRange")}
                    />
                  )}
                </group.Field>
              </div>
            ) : null}
          </>
        )}
      </group.Field>
    </AdvancedSection>
  );
}

function Health({ group, id, draft }: { group: Group; id: Ids; draft: SpecDraft }) {
  const { t } = useTranslation(["dashboard"]);
  const { health } = draft;
  const summary = t("dashboard:runtime.specForm.summary.health", {
    seconds: msToSeconds(health.intervalMs) || "?",
    failures: health.failureThreshold || "?",
    successes: health.successThreshold || "?",
  });
  return (
    <AdvancedSection
      gridClassName="lg:grid-cols-1"
      title={t("dashboard:runtime.specForm.health")}
      summary={summary}
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-3">
        <group.Field name="draft.health.intervalMs">
          {(field) => (
            <SecondsInput
              id={id("health-intervalMs")}
              label={t("dashboard:runtime.specForm.healthFields.intervalMs")}
              field={field}
              rangeError={t("dashboard:runtime.specForm.healthIntervalRange")}
            />
          )}
        </group.Field>
        {(["failureThreshold", "successThreshold"] as const).map((key) => (
          <group.Field key={key} name={`draft.health.${key}`}>
            {(field) => (
              <TextInput
                id={id(`health-${key}`)}
                label={t(`dashboard:runtime.specForm.healthFields.${key}`)}
                field={field}
                inputMode="numeric"
              />
            )}
          </group.Field>
        ))}
      </div>
    </AdvancedSection>
  );
}
