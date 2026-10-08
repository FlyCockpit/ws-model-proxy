import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type MetricsReader,
  metricsReaderSchema,
  READER_SIGNALS,
  type ReaderSignal,
  type RuntimeSpec,
} from "@ws-model-proxy/api/lib/runtime-spec";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import {
  draftToReader,
  nextFreeSignal,
  READER_PRESET_VALUES,
  READER_PRESETS,
  type ReaderAggregate,
  type ReaderDraft,
  type ReaderKind,
  type ReaderPresetId,
  readerToDraft,
} from "@/lib/metrics-reader-draft";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

const KINDS: ReaderKind[] = ["none", "builtin", "route", "command"];
const AGGREGATES: ReaderAggregate[] = ["", "sum", "max", "first"];

type ReaderValues = ReaderDraft & { check: string };

/** Reader issues at the input that owns them (`map[2].series`), or `check`. */
function readerIssues(values: ReaderValues, base: MetricsReader | undefined) {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  values.map.forEach((row, index) => {
    if (values.map.findIndex((other) => other.signal === row.signal) !== index)
      issues.push({ path: ["map", index, "signal"], message: "duplicate" });
  });
  const parsed = metricsReaderSchema.optional().safeParse(draftToReader(values, base));
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const [head, signal, field] = issue.path;
      const row = values.map.findIndex((item) => item.signal === signal);
      if (head === "map" && row >= 0 && typeof field === "string")
        issues.push({ path: ["map", row, field], message: issue.message });
      else if (typeof head === "string" && head !== "map" && head !== "kind")
        issues.push({ path: [head], message: issue.message });
      else
        issues.push({
          path: ["check"],
          message: `${issue.path.join(".") || "metricsReader"}: ${issue.message}`,
        });
    }
  return issues;
}

/**
 * The runtime's metrics reader (`spec.metricsReader`): the engine's own, or a route or command
 * whose output maps to load signals. A preset fills the form; saving writes a new version of
 * the definition (a new launch: running instances use it after a restart).
 */
export function MetricsReaderCard({
  runtimeId,
  spec,
  readOnly,
}: {
  runtimeId: string;
  spec: RuntimeSpec;
  readOnly: boolean;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<"" | ReaderPresetId>("");
  const update = useMutation({
    ...orpc.runtimes.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const base = spec.metricsReader;
  const schema = z.custom<ReaderValues>().superRefine((values, ctx) => {
    for (const issue of readerIssues(values, base))
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message:
          issue.message === "duplicate" ? t("dashboard:runtime.reader.duplicate") : issue.message,
      });
  });
  const form = useForm({
    defaultValues: { ...readerToDraft(base), check: "" } as ReaderValues,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const reader = metricsReaderSchema.optional().parse(draftToReader(value, base));
      const { metricsReader: _old, ...rest } = spec;
      try {
        const result = await update.mutateAsync({
          runtimeId,
          spec: reader ? { ...rest, metricsReader: reader } : rest,
          note: t("dashboard:runtime.reader.note"),
        });
        await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
        toast.success(
          t("dashboard:runtime.savedVersion", {
            version: result.version.version,
            live: result.adoptedLive.length,
            restart: result.needsRestart.length,
          }),
        );
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  const textField = (
    name: "route" | "countRoute" | "command" | "intervalSecs",
    id: string,
    label: string,
    hint?: string,
    options: { mono?: boolean; inputMode?: "numeric" } = {},
  ) => {
    const { mono, inputMode } = options;
    return (
      <form.Field name={name}>
        {(field) => (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={id}>{label}</Label>
            <Input
              id={id}
              className={mono ? "h-11 font-mono text-xs" : "h-11"}
              autoCapitalize="none"
              spellCheck={false}
              inputMode={inputMode}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            <FieldErrors field={field} />
          </div>
        )}
      </form.Field>
    );
  };
  const readerSource = (kind: "route" | "command") => {
    return (
      <>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {kind === "route" ? (
            <>
              {textField(
                "route",
                "reader-route",
                t("dashboard:runtime.reader.route"),
                t("dashboard:runtime.reader.routeHint"),
                { mono: true },
              )}
              {textField(
                "countRoute",
                "reader-count-route",
                t("dashboard:runtime.reader.countRoute"),
                t("dashboard:runtime.reader.countRouteHint"),
                { mono: true },
              )}
            </>
          ) : (
            textField(
              "command",
              "reader-command",
              t("dashboard:runtime.reader.command"),
              t("dashboard:runtime.reader.commandHint"),
              { mono: true },
            )
          )}
          <form.Field name="format">
            {(field) => (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="reader-format">{t("dashboard:runtime.reader.format")}</Label>
                <NativeSelect
                  id="reader-format"
                  value={field.state.value}
                  onChange={(event) =>
                    field.handleChange(event.target.value as "json" | "prometheus")
                  }
                >
                  <option value="prometheus">
                    {t("dashboard:runtime.reader.formats.prometheus")}
                  </option>
                  <option value="json">{t("dashboard:runtime.reader.formats.json")}</option>
                </NativeSelect>
              </div>
            )}
          </form.Field>
          {textField(
            "intervalSecs",
            "reader-interval",
            t("dashboard:runtime.reader.interval"),
            t("dashboard:runtime.reader.intervalHint"),
            { inputMode: "numeric" },
          )}
        </div>
        <form.Field name="map" mode="array">
          {(map) => (
            <div className="flex min-w-0 flex-col gap-3">
              <p className="text-sm font-medium">{t("dashboard:runtime.reader.map")}</p>
              <p className="text-xs text-muted-foreground">
                {t("dashboard:runtime.reader.mapHint")}
              </p>
              {map.state.value.map((_, index) => (
                <div
                  key={index}
                  className="grid min-w-0 gap-3 rounded-lg border p-3 sm:grid-cols-2"
                >
                  <form.Field name={`map[${index}].signal`}>
                    {(field) => (
                      <div className="min-w-0 space-y-1.5">
                        <Label htmlFor={`reader-map-${index}-signal`}>
                          {t("dashboard:runtime.reader.signal")}
                        </Label>
                        <NativeSelect
                          id={`reader-map-${index}-signal`}
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value as ReaderSignal)
                          }
                        >
                          {READER_SIGNALS.map((signal) => (
                            <option key={signal} value={signal}>
                              {signal}
                            </option>
                          ))}
                        </NativeSelect>
                        <FieldErrors field={field} />
                      </div>
                    )}
                  </form.Field>
                  {(["series", "divideBy", "scale"] as const).map((name) => (
                    <form.Field key={name} name={`map[${index}].${name}`}>
                      {(field) => (
                        <div className="min-w-0 space-y-1.5">
                          <Label htmlFor={`reader-map-${index}-${name}`}>
                            {t(`dashboard:runtime.reader.fields.${name}`)}
                          </Label>
                          <Input
                            id={`reader-map-${index}-${name}`}
                            className="h-11 font-mono text-xs"
                            autoCapitalize="none"
                            spellCheck={false}
                            inputMode={name === "scale" ? "decimal" : undefined}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                          <FieldErrors field={field} />
                        </div>
                      )}
                    </form.Field>
                  ))}
                  <form.Field name={`map[${index}].aggregate`}>
                    {(field) => (
                      <div className="min-w-0 space-y-1.5">
                        <Label htmlFor={`reader-map-${index}-aggregate`}>
                          {t("dashboard:runtime.reader.fields.aggregate")}
                        </Label>
                        <NativeSelect
                          id={`reader-map-${index}-aggregate`}
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value as ReaderAggregate)
                          }
                        >
                          {AGGREGATES.map((aggregate) => (
                            <option key={aggregate} value={aggregate}>
                              {t(`dashboard:runtime.reader.aggregates.${aggregate || "default"}`)}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    )}
                  </form.Field>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="touch"
                      onClick={() => map.removeValue(index)}
                    >
                      <Trash2 aria-hidden="true" />
                      {t("dashboard:runtime.reader.removeSignal")}
                    </Button>
                  </div>
                </div>
              ))}
              {nextFreeSignal(map.state.value) ? (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    onClick={() => {
                      const signal = nextFreeSignal(map.state.value);
                      if (signal)
                        map.pushValue({
                          signal,
                          series: "",
                          aggregate: "",
                          scale: "",
                          divideBy: "",
                        });
                    }}
                  >
                    <Plus aria-hidden="true" />
                    {t("dashboard:runtime.reader.addSignal")}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </form.Field>
      </>
    );
  };
  const applyPreset = (id: "" | ReaderPresetId) => {
    setPreset(id);
    if (id === "") return;
    const draft = readerToDraft(READER_PRESET_VALUES[id]);
    for (const key of Object.keys(draft) as Array<keyof ReaderDraft>)
      form.setFieldValue(key, draft[key]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:runtime.reader.title")}</CardTitle>
        <CardDescription>
          {readOnly ? t("dashboard:runtime.reader.readOnly") : t("dashboard:runtime.reader.hint")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="reader-preset">{t("dashboard:runtime.reader.preset")}</Label>
              <NativeSelect
                id="reader-preset"
                value={preset}
                onChange={(event) => applyPreset(event.target.value as "" | ReaderPresetId)}
              >
                <option value="">{t("dashboard:runtime.reader.pickPreset")}</option>
                {READER_PRESETS.map((id) => (
                  <option key={id} value={id}>
                    {t(`dashboard:runtime.reader.presets.${id}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <form.Field name="kind">
              {(field) => (
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor="reader-kind">{t("dashboard:runtime.reader.kind")}</Label>
                  <NativeSelect
                    id="reader-kind"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value as ReaderKind)}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`dashboard:runtime.reader.kinds.${kind}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )}
            </form.Field>
            <form.Subscribe selector={(state) => state.values.kind}>
              {(kind) => (kind === "route" || kind === "command" ? readerSource(kind) : null)}
            </form.Subscribe>
            <form.Field name="check">{(field) => <FieldErrors field={field} />}</form.Field>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(submitting) =>
                readOnly ? null : (
                  <Button type="submit" size="touch" disabled={submitting}>
                    {submitting ? t("common:actions.saving") : t("dashboard:runtime.reader.save")}
                  </Button>
                )
              }
            </form.Subscribe>
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}
