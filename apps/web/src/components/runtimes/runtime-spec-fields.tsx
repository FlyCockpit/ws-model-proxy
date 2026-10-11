import {
  ENGINES,
  GPU_VENDORS,
  MODEL_CAPABILITIES,
  MODEL_TYPES,
  type ModelCapabilityWire,
  RUNTIME_APIS,
  RUNTIME_TIMEOUTS_SEC,
} from "@ws-model-proxy/api/lib/runtime-spec";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import { SegmentedControl } from "@/components/segmented-control";
import { type FieldGroupOf, withFieldGroup } from "@/hooks/use-app-form";
import {
  COMMAND_FIELDS,
  type CommandField,
  draftToSpec,
  editorValues,
  emptyCommandDraft,
  parseBase,
  type ResourceKind,
  type RuntimeKind,
  type SpecEditorValues,
  specToDraft,
  TIMEOUT_FIELDS,
} from "@/lib/runtime-spec-draft";

type ErrorList = Array<{ message?: string } | string | undefined>;
type TextFieldApi = {
  state: { value: string; meta: { errors: ErrorList } };
  handleChange: (value: string) => void;
  handleBlur: () => void;
};

const RESOURCE_KINDS: ResourceKind[] = ["discrete", "unified", "cpu", "none"];
const REQUIRED_COMMANDS: readonly CommandField[] = ["start", "stop"];

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
    <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
      {messages.map((message) => (
        <li key={message} className="break-words">
          {message}
        </li>
      ))}
    </ul>
  );
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
        />
      ) : (
        <Input
          id={id}
          className={`h-11 ${className ?? ""}`}
          autoCapitalize="none"
          spellCheck={false}
          inputMode={inputMode}
          value={field.state.value}
          placeholder={placeholder}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
        />
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <FieldErrors field={field} />
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function CheckRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

/**
 * The runtime definition editor: a form over `runtimeSpecSchema` (models, address or launch,
 * resources, commands with per-command timeouts, readiness, health) and the raw JSON, under one
 * key of a form made with `useAppForm`. Switching tabs converts between them; parts the form has
 * no inputs for are kept (see `runtime-spec-draft.ts`).
 */
export const RuntimeSpecFields = withFieldGroup({
  defaultValues: editorValues({}) as SpecEditorValues,
  props: {} as { kind: RuntimeKind; idPrefix: string },
  render: function RuntimeSpecFieldsRender({ group, kind, idPrefix }) {
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
      setSwitchError(false);
      group.setFieldValue("base", json);
      group.setFieldValue("draft", specToDraft(parsed));
      group.setFieldValue("tab", "form");
    };

    return (
      <div className="flex min-w-0 flex-col gap-4">
        <group.Subscribe selector={(state) => state.values.tab}>
          {(tab) => (
            <>
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
                <p className="text-sm text-destructive">
                  {t("dashboard:runtime.specForm.fixJsonFirst")}
                </p>
              ) : null}
              {tab === "json" ? (
                <group.Field name="json">
                  {(field) => (
                    <div className="space-y-1.5">
                      <Label htmlFor={id("json")}>{t("dashboard:runtime.form.spec")}</Label>
                      <Textarea
                        id={id("json")}
                        rows={22}
                        spellCheck={false}
                        className="font-mono text-xs"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("dashboard:runtime.form.specHint")}
                      </p>
                      <AllErrors errors={field.state.meta.errors} />
                    </div>
                  )}
                </group.Field>
              ) : (
                <DraftSections group={group} kind={kind} id={id} />
              )}
            </>
          )}
        </group.Subscribe>
        <group.Field name="check">
          {(field) => <AllErrors errors={field.state.meta.errors} />}
        </group.Field>
      </div>
    );
  },
});

type Group = FieldGroupOf<SpecEditorValues>;

function DraftSections({
  group,
  kind,
  id,
}: {
  group: Group;
  kind: RuntimeKind;
  id: (name: string) => string;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <group.Subscribe selector={(state) => kind === "ALWAYS_ON" || state.values.draft.serves}>
      {(serves) => (
        <div className="flex min-w-0 flex-col gap-4">
          {kind === "STARTABLE" ? (
            <group.Field name="draft.serves">
              {(field) => (
                <SegmentedControl
                  ariaLabel={t("dashboard:runtime.specForm.servesLabel")}
                  value={field.state.value ? "serves" : "service"}
                  onChange={(next) => field.handleChange(next === "serves")}
                  items={[
                    { value: "serves", label: t("dashboard:runtime.specForm.serves") },
                    { value: "service", label: t("dashboard:runtime.specForm.service") },
                  ]}
                />
              )}
            </group.Field>
          ) : null}
          {serves ? <ModelsSection group={group} kind={kind} id={id} /> : null}
          {kind === "ALWAYS_ON" ? (
            <Section
              title={t("dashboard:runtime.specForm.address")}
              hint={t("dashboard:runtime.specForm.addressHint")}
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
            </Section>
          ) : (
            <LaunchSections group={group} id={id} />
          )}
          <p className="text-xs text-muted-foreground">{t("dashboard:runtime.specForm.kept")}</p>
        </div>
      )}
    </group.Subscribe>
  );
}

function ModelsSection({
  group,
  kind,
  id,
}: {
  group: Group;
  kind: RuntimeKind;
  id: (name: string) => string;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Section title={t("dashboard:runtime.specForm.serving")}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <group.Field name="draft.api">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={id("api")}>{t("dashboard:runtime.specForm.api")}</Label>
              <NativeSelect
                id={id("api")}
                value={field.state.value}
                onChange={(event) =>
                  field.handleChange(event.target.value as (typeof RUNTIME_APIS)[number])
                }
              >
                {RUNTIME_APIS.map((api) => (
                  <option key={api} value={api}>
                    {t(`dashboard:runtime.specForm.apis.${api}`)}
                  </option>
                ))}
              </NativeSelect>
              <FieldErrors field={field} />
            </div>
          )}
        </group.Field>
        <group.Field name="draft.engine">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={id("engine")}>{t("dashboard:runtime.specForm.engine")}</Label>
              <NativeSelect
                id={id("engine")}
                value={field.state.value}
                onChange={(event) =>
                  field.handleChange(event.target.value as (typeof ENGINES)[number])
                }
              >
                {ENGINES.map((engine) => (
                  <option key={engine} value={engine}>
                    {t(`dashboard:runtime.specForm.engines.${engine}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </group.Field>
        <group.Field name="draft.modelType">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={id("model-type")}>{t("dashboard:runtime.specForm.modelType")}</Label>
              <NativeSelect
                id={id("model-type")}
                value={field.state.value}
                onChange={(event) =>
                  field.handleChange(event.target.value as (typeof MODEL_TYPES)[number])
                }
              >
                {MODEL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`dashboard:runtime.specForm.modelTypes.${type}`)}
                  </option>
                ))}
              </NativeSelect>
              <FieldErrors field={field} />
            </div>
          )}
        </group.Field>
      </div>
      <group.Field name="draft.models" mode="array">
        {(models) => (
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-sm font-medium">{t("dashboard:runtime.specForm.models")}</p>
            {kind === "ALWAYS_ON" ? (
              <p className="text-xs text-muted-foreground">
                {t("dashboard:runtime.specForm.modelsDiscovered")}
              </p>
            ) : null}
            {models.state.value.map((_, index) => (
              <div key={index} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
                <div className="flex min-w-0 items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <group.Field name={`draft.models[${index}].id`}>
                      {(field) => (
                        <TextInput
                          id={id(`model-${index}`)}
                          label={t("dashboard:runtime.specForm.modelId")}
                          field={field}
                          mono
                        />
                      )}
                    </group.Field>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:runtime.specForm.removeModel")}
                    onClick={() => models.removeValue(index)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <group.Field name={`draft.models[${index}].declareCapabilities`}>
                  {(declare) => (
                    <>
                      <CheckRow
                        id={id(`model-${index}-declare`)}
                        label={t("dashboard:runtime.specForm.declareCapabilities")}
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
                    </>
                  )}
                </group.Field>
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
            <FieldErrors field={models} />
          </div>
        )}
      </group.Field>
      <group.Field name="draft.expandMedia">
        {(field) => (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={id("expand-media")}>
              {t("dashboard:runtime.specForm.expandMedia")}
            </Label>
            <NativeSelect
              id={id("expand-media")}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value as "auto" | "on" | "off")}
            >
              {(["auto", "on", "off"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`dashboard:runtime.specForm.expandMediaValues.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </group.Field>
    </Section>
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
    <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
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

function LaunchSections({ group, id }: { group: Group; id: (name: string) => string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <>
      <Section title={t("dashboard:runtime.specForm.launch")}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <group.Field name="draft.management">
            {(field) => (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={id("management")}>
                  {t("dashboard:runtime.specForm.management")}
                </Label>
                <NativeSelect
                  id={id("management")}
                  value={field.state.value}
                  onChange={(event) =>
                    field.handleChange(event.target.value as "process" | "service")
                  }
                >
                  <option value="process">{t("dashboard:runtime.specForm.process")}</option>
                  <option value="service">{t("dashboard:runtime.specForm.serviceUnit")}</option>
                </NativeSelect>
                <FieldErrors field={field} />
              </div>
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
          <group.Subscribe selector={(state) => state.values.draft.groupSize.trim() !== "1"}>
            {(multiNode) =>
              multiNode ? (
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
              ) : null
            }
          </group.Subscribe>
        </div>
      </Section>
      <ResourcesSection group={group} id={id} />
      <CommandsSection group={group} id={id} />
      <Section title={t("dashboard:runtime.specForm.readiness")}>
        <group.Field name="draft.readiness.enabled">
          {(field) => (
            <>
              <CheckRow
                id={id("readiness")}
                label={t("dashboard:runtime.specForm.readinessEnabled")}
                checked={field.state.value}
                onChange={field.handleChange}
              />
              <FieldErrors field={field} />
              {field.state.value ? (
                <div className="grid min-w-0 gap-3 sm:grid-cols-3">
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
                      <TextInput
                        id={id("readiness-timeout")}
                        label={t("dashboard:runtime.specForm.readinessTimeout")}
                        field={timeout}
                        inputMode="numeric"
                      />
                    )}
                  </group.Field>
                </div>
              ) : null}
            </>
          )}
        </group.Field>
      </Section>
      <Section title={t("dashboard:runtime.specForm.health")}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          {(["intervalMs", "failureThreshold", "successThreshold"] as const).map((key) => (
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
      </Section>
    </>
  );
}

/** "Every rank" for one entry, "Rank n" when there is one per rank. */
function RankTitle({ index, total }: { index: number; total: number }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <p className="text-sm font-medium">
      {total === 1
        ? t("dashboard:runtime.specForm.everyRank")
        : t("dashboard:runtime.specForm.rank", { number: index + 1 })}
    </p>
  );
}

/** Per-rank entries: one shared entry, or one per rank once the group has several. */
function PerRankToggle({
  count,
  groupSize,
  onSplit,
  onJoin,
}: {
  count: number;
  groupSize: number;
  onSplit: () => void;
  onJoin: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  if (count > 1)
    return (
      <div>
        <Button type="button" variant="outline" size="touch" onClick={onJoin}>
          {t("dashboard:runtime.specForm.sameForEveryRank")}
        </Button>
      </div>
    );
  if (groupSize > 1)
    return (
      <div>
        <Button type="button" variant="outline" size="touch" onClick={onSplit}>
          {t("dashboard:runtime.specForm.perRank")}
        </Button>
      </div>
    );
  return null;
}

function groupSizeOf(value: string): number {
  const size = Number(value);
  return Number.isInteger(size) && size >= 1 && size <= 64 ? size : 1;
}

function ResourcesSection({ group, id }: { group: Group; id: (name: string) => string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Section
      title={t("dashboard:runtime.specForm.resources")}
      hint={t("dashboard:runtime.specForm.resourcesHint")}
    >
      <group.Field name="draft.resources" mode="array">
        {(resources) => (
          <>
            {resources.state.value.map((resource, index) => (
              <div key={index} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
                <RankTitle index={index} total={resources.state.value.length} />
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <group.Field name={`draft.resources[${index}].kind`}>
                    {(field) => (
                      <div className="min-w-0 space-y-1.5">
                        <Label htmlFor={id(`resource-${index}-kind`)}>
                          {t("dashboard:runtime.specForm.resourceKind")}
                        </Label>
                        <NativeSelect
                          id={id(`resource-${index}-kind`)}
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value as ResourceKind)
                          }
                        >
                          {RESOURCE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {t(`dashboard:runtime.specForm.resourceKinds.${kind}`)}
                            </option>
                          ))}
                        </NativeSelect>
                        <FieldErrors field={field} />
                      </div>
                    )}
                  </group.Field>
                  {resource.kind === "unified" ? (
                    <group.Field name={`draft.resources[${index}].memoryGb`}>
                      {(field) => (
                        <TextInput
                          id={id(`resource-${index}-memory`)}
                          label={t("dashboard:runtime.specForm.memoryGb")}
                          field={field}
                          inputMode="decimal"
                        />
                      )}
                    </group.Field>
                  ) : null}
                  {resource.kind === "discrete" ? (
                    <>
                      <group.Field name={`draft.resources[${index}].gpuCount`}>
                        {(field) => (
                          <TextInput
                            id={id(`resource-${index}-gpus`)}
                            label={t("dashboard:runtime.specForm.gpuCount")}
                            field={field}
                            inputMode="numeric"
                          />
                        )}
                      </group.Field>
                      <group.Field name={`draft.resources[${index}].vramGb`}>
                        {(field) => (
                          <TextInput
                            id={id(`resource-${index}-vram`)}
                            label={t("dashboard:runtime.specForm.vramGb")}
                            field={field}
                            inputMode="decimal"
                          />
                        )}
                      </group.Field>
                      <group.Field name={`draft.resources[${index}].vendor`}>
                        {(field) => (
                          <div className="min-w-0 space-y-1.5">
                            <Label htmlFor={id(`resource-${index}-vendor`)}>
                              {t("dashboard:runtime.specForm.vendor")}
                            </Label>
                            <NativeSelect
                              id={id(`resource-${index}-vendor`)}
                              value={field.state.value}
                              onChange={(event) =>
                                field.handleChange(
                                  event.target.value as "" | (typeof GPU_VENDORS)[number],
                                )
                              }
                            >
                              <option value="">{t("dashboard:runtime.specForm.anyVendor")}</option>
                              {GPU_VENDORS.map((vendor) => (
                                <option key={vendor} value={vendor}>
                                  {t(`dashboard:runtime.specForm.vendors.${vendor}`)}
                                </option>
                              ))}
                            </NativeSelect>
                          </div>
                        )}
                      </group.Field>
                    </>
                  ) : null}
                  {resource.kind === "cpu" || resource.kind === "discrete" ? (
                    <group.Field name={`draft.resources[${index}].ramGb`}>
                      {(field) => (
                        <TextInput
                          id={id(`resource-${index}-ram`)}
                          label={t("dashboard:runtime.specForm.ramGb")}
                          hint={
                            resource.kind === "discrete"
                              ? t("dashboard:runtime.specForm.optional")
                              : undefined
                          }
                          field={field}
                          inputMode="decimal"
                        />
                      )}
                    </group.Field>
                  ) : null}
                </div>
              </div>
            ))}
            <group.Subscribe selector={(state) => groupSizeOf(state.values.draft.groupSize)}>
              {(groupSize) => (
                <PerRankToggle
                  count={resources.state.value.length}
                  groupSize={groupSize}
                  onSplit={() => {
                    const [first] = resources.state.value;
                    resources.handleChange(Array.from({ length: groupSize }, () => ({ ...first })));
                  }}
                  onJoin={() => resources.handleChange(resources.state.value.slice(0, 1))}
                />
              )}
            </group.Subscribe>
            <FieldErrors field={resources} />
          </>
        )}
      </group.Field>
    </Section>
  );
}

function CommandsSection({ group, id }: { group: Group; id: (name: string) => string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Section
      title={t("dashboard:runtime.specForm.commands")}
      hint={t("dashboard:runtime.specForm.commandsHint")}
    >
      <group.Field name="draft.commands" mode="array">
        {(commands) => (
          <>
            {commands.state.value.map((_, index) => (
              <div key={index} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
                <RankTitle index={index} total={commands.state.value.length} />
                {COMMAND_FIELDS.map((name) => (
                  <group.Field key={name} name={`draft.commands[${index}].${name}`}>
                    {(field) => (
                      <TextInput
                        id={id(`command-${index}-${name}`)}
                        label={t(`dashboard:runtime.specForm.commandFields.${name}`)}
                        hint={
                          REQUIRED_COMMANDS.includes(name)
                            ? undefined
                            : t("dashboard:runtime.specForm.optional")
                        }
                        field={field}
                        mono
                        multiline
                      />
                    )}
                  </group.Field>
                ))}
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
            <group.Subscribe selector={(state) => groupSizeOf(state.values.draft.groupSize)}>
              {(groupSize) => (
                <PerRankToggle
                  count={commands.state.value.length}
                  groupSize={groupSize}
                  onSplit={() => {
                    const [first = emptyCommandDraft()] = commands.state.value;
                    commands.handleChange(
                      Array.from({ length: groupSize }, () => ({
                        ...first,
                        timeouts: { ...first.timeouts },
                      })),
                    );
                  }}
                  onJoin={() => commands.handleChange(commands.state.value.slice(0, 1))}
                />
              )}
            </group.Subscribe>
            <FieldErrors field={commands} />
          </>
        )}
      </group.Field>
    </Section>
  );
}
