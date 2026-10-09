/**
 * The node definition (Full control only): labels, port range, command lifetime, metric
 * commands, fabric memberships, declared hardware. Each card saves through `nodes.update`.
 */
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  declaredHardwareSchema,
  GPU_VENDORS,
  nodeFabricMembershipsSchema,
  nodeMetricCommandsSchema,
  runtimeLabelsSchema,
} from "@ws-model-proxy/api/lib/runtime-spec";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { Plus, RefreshCw, Trash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Help } from "@/components/help";
import { specIssueText } from "@/lib/spec-issue-text";
import { orpc } from "@/utils/orpc";

import { parseLabels } from "./add-node-dialog";
import { type GpuRow, KINDS, type Kind, toDeclaration } from "./declared-hardware";
import { FieldError } from "./field-error";
import { formatGb, StatusPill } from "./node-badges";
import type { NodeDetail } from "./node-types";
import { refusalToastOptions } from "./refusal";

type UpdateInput = Parameters<AppRouterClient["nodes"]["update"]>[0];

function useUpdateNode(successKey: string) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.nodes.update.mutationOptions({
      onSuccess: () => {
        toast.success(t(successKey));
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
      },
    }),
    ...refusalToastOptions(t),
  });
}

/** Where the first metric-command issue is and what it says, in the active language. */
function metricCommandsIssueDetail(
  issue: { path: PropertyKey[]; message: string; params?: unknown } | undefined,
): string {
  if (!issue) return "";
  const where = issue.path.map(String).join(".");
  const text = specIssueText(issue);
  return where ? `${where}: ${text}` : text;
}

/** Shown instead of a form when the node is Relay only. */
function FrozenNote() {
  const { t } = useTranslation(["dashboard"]);
  return <p className="text-sm text-muted-foreground">{t("dashboard:nodes.definition.frozen")}</p>;
}

function SyncPill({ inSync }: { inSync: boolean }) {
  const { t } = useTranslation(["dashboard"]);
  return inSync ? (
    <StatusPill tone="success">{t("dashboard:nodes.definition.inSync")}</StatusPill>
  ) : (
    <StatusPill tone="warning">{t("dashboard:nodes.definition.pending")}</StatusPill>
  );
}

const HOUR_MS = 3_600_000;

export function PlacementCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const full = node.trust.effective === "FULL";
  const update = useUpdateNode("dashboard:nodes.definition.saved");
  const form = useForm({
    defaultValues: {
      labels: node.labels.join(" "),
      portStart: String(node.portRange[0]),
      portEnd: String(node.portRange[1]),
      commandMaxHours: String(node.commandMaxMs / HOUR_MS),
    },
    validators: {
      onChange: z
        .object({
          labels: z.string(),
          portStart: z.string(),
          portEnd: z.string(),
          commandMaxHours: z.string(),
        })
        .superRefine((value, ctx) => {
          if (!runtimeLabelsSchema.safeParse(parseLabels(value.labels)).success)
            ctx.addIssue({
              code: "custom",
              path: ["labels"],
              message: t("dashboard:nodes.add.labelsInvalid"),
            });
          const start = Number(value.portStart);
          const end = Number(value.portEnd);
          const port = (n: number) => Number.isInteger(n) && n >= 1024 && n <= 65_535;
          if (!port(start) || !port(end) || start > end)
            ctx.addIssue({
              code: "custom",
              path: ["portEnd"],
              message: t("dashboard:nodes.definition.portsInvalid"),
            });
          const hours = Number(value.commandMaxHours);
          if (!(hours >= 1 / 60 && hours <= 24))
            ctx.addIssue({
              code: "custom",
              path: ["commandMaxHours"],
              message: t("dashboard:nodes.definition.commandMaxInvalid"),
            });
        }),
    },
    onSubmit: async ({ value }) => {
      await update.mutateAsync({
        nodeId: node.id,
        labels: parseLabels(value.labels),
        portRange: [Number(value.portStart), Number(value.portEnd)],
        commandMaxMs: Math.round(Number(value.commandMaxHours) * HOUR_MS),
      });
    },
  });

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">
          {t("dashboard:nodes.definition.placementTitle")}
        </CardTitle>
        <CardDescription>{t("dashboard:nodes.definition.placementDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!full ? (
          <div className="space-y-2 text-sm">
            <FrozenNote />
            <p>
              {t("dashboard:nodes.definition.labels")}: {node.labels.join(", ") || "—"}
            </p>
            <p>
              {t("dashboard:nodes.definition.ports")}: {node.portRange[0]}–{node.portRange[1]}
            </p>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              form.handleSubmit().catch(() => undefined);
            }}
          >
            <form.Field name="labels">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="node-labels">{t("dashboard:nodes.definition.labels")}</Label>
                  <Input
                    id="node-labels"
                    className="min-h-[44px] font-mono"
                    autoCapitalize="none"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              )}
            </form.Field>
            <div className="grid grid-cols-2 gap-2">
              <form.Field name="portStart">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="node-port-start">
                      {t("dashboard:nodes.definition.portStart")}
                    </Label>
                    <Input
                      id="node-port-start"
                      inputMode="numeric"
                      className="min-h-[44px]"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </div>
                )}
              </form.Field>
              <form.Field name="portEnd">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="node-port-end">{t("dashboard:nodes.definition.portEnd")}</Label>
                    <Input
                      id="node-port-end"
                      inputMode="numeric"
                      className="min-h-[44px]"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldError errors={field.state.meta.errors} />
                  </div>
                )}
              </form.Field>
            </div>
            <form.Field name="commandMaxHours">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="node-command-max" className="flex items-center gap-1.5">
                    {t("dashboard:nodes.definition.commandMax")}
                    <Help>{t("dashboard:nodes.definition.commandMaxHelp")}</Help>
                  </Label>
                  <Input
                    id="node-command-max"
                    inputMode="decimal"
                    className="min-h-[44px]"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              )}
            </form.Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-[44px]" disabled={update.isPending}>
                {t("common:actions.save")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px]"
                disabled={update.isPending || node.connection !== "ONLINE"}
                onClick={() => update.mutate({ nodeId: node.id, rescan: true })}
              >
                <RefreshCw aria-hidden="true" />
                {t("dashboard:nodes.definition.rescan")}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function MetricCommandsCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const full = node.trust.effective === "FULL";
  const update = useUpdateNode("dashboard:nodes.definition.saved");
  const form = useForm({
    defaultValues: { json: JSON.stringify(node.metricCommands, null, 2) },
    validators: {
      onChange: z.object({ json: z.string() }).superRefine((value, ctx) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value.json);
        } catch {
          ctx.addIssue({
            code: "custom",
            path: ["json"],
            message: t("dashboard:nodes.definition.jsonInvalid"),
          });
          return;
        }
        const result = nodeMetricCommandsSchema.safeParse(parsed);
        if (!result.success)
          ctx.addIssue({
            code: "custom",
            path: ["json"],
            message: t("dashboard:nodes.definition.metricCommandsInvalid", {
              detail: metricCommandsIssueDetail(result.error.issues[0]),
            }),
          });
      }),
    },
    onSubmit: async ({ value }) => {
      const parsed = nodeMetricCommandsSchema.parse(JSON.parse(value.json));
      await update.mutateAsync({ nodeId: node.id, metricCommands: parsed });
    },
  });
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t("dashboard:nodes.definition.metricCommandsTitle")}
          <SyncPill inSync={node.metricCommandsInSync} />
        </CardTitle>
        <CardDescription>
          {t("dashboard:nodes.definition.metricCommandsDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!full ? (
          <div className="space-y-2">
            <FrozenNote />
            {node.metricCommands.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("dashboard:nodes.definition.metricCommandsNone")}
              </p>
            ) : (
              <ul className="min-w-0 space-y-3">
                {node.metricCommands.map((command) => (
                  <li key={command.name} className="min-w-0 space-y-1">
                    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="break-all font-mono font-medium">{command.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("dashboard:nodes.definition.metricCommandSchedule", {
                          interval: command.intervalSecs,
                          timeout: command.timeoutSecs,
                          format: command.format,
                        })}
                      </span>
                    </p>
                    <pre
                      aria-label={t("dashboard:nodes.definition.metricCommandBody", {
                        name: command.name,
                      })}
                      className="max-h-48 min-w-0 overflow-x-auto overflow-y-auto overscroll-contain whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 font-mono text-xs"
                    >
                      {command.command}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              form.handleSubmit().catch(() => undefined);
            }}
          >
            <form.Field name="json">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="node-metric-commands">
                    {t("dashboard:nodes.definition.metricCommandsJson")}
                  </Label>
                  <Textarea
                    id="node-metric-commands"
                    className="max-h-96 min-h-32 font-mono"
                    spellCheck={false}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              )}
            </form.Field>
            <Button type="submit" className="min-h-[44px]" disabled={update.isPending}>
              {t("common:actions.save")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

type FabricRow = { name: string; ip: string };

export function NodeFabricsCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const full = node.trust.effective === "FULL";
  const update = useUpdateNode("dashboard:nodes.definition.saved");
  const form = useForm({
    defaultValues: {
      fabrics: node.fabrics.map((fabric) => ({ name: fabric.name, ip: fabric.ip })) as FabricRow[],
    },
    validators: {
      onChange: z
        .object({ fabrics: z.array(z.object({ name: z.string(), ip: z.string() })) })
        .superRefine((value, ctx) => {
          if (!nodeFabricMembershipsSchema.safeParse(value.fabrics).success)
            ctx.addIssue({
              code: "custom",
              path: ["fabrics"],
              message: t("dashboard:nodes.fabrics.membershipInvalid"),
            });
        }),
    },
    onSubmit: async ({ value }) => {
      await update.mutateAsync({ nodeId: node.id, fabrics: value.fabrics });
    },
  });

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t("dashboard:nodes.fabrics.nodeTitle")}
          <SyncPill inSync={node.fabricsInSync} />
          <Help>{t("dashboard:nodes.fabrics.help")}</Help>
        </CardTitle>
        <CardDescription>{t("dashboard:nodes.fabrics.nodeDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {node.fabrics.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {node.fabrics.map((fabric) => (
              <li key={fabric.fabricId}>
                <span className="font-mono">{fabric.name}</span> · {fabric.ip}
                {fabric.peers.length > 0
                  ? ` · ${t("dashboard:nodes.fabrics.peers", {
                      peers: fabric.peers.map((peer) => `${peer.slug} (${peer.ip})`).join(", "),
                    })}`
                  : null}
              </li>
            ))}
          </ul>
        ) : null}
        {!full ? (
          <FrozenNote />
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              form.handleSubmit().catch(() => undefined);
            }}
          >
            <form.Field name="fabrics" mode="array">
              {(field) => (
                <div className="space-y-2">
                  {field.state.value.map((_, index) => (
                    <div key={index} className="flex min-w-0 flex-wrap items-end gap-2">
                      <form.Field name={`fabrics[${index}].name`}>
                        {(sub) => (
                          <div className="min-w-0 flex-1 space-y-1">
                            <Label htmlFor={`fabric-name-${index}`}>
                              {t("dashboard:nodes.fabrics.name")}
                            </Label>
                            <Input
                              id={`fabric-name-${index}`}
                              className="min-h-[44px] font-mono"
                              autoCapitalize="none"
                              value={sub.state.value}
                              onChange={(event) => sub.handleChange(event.target.value)}
                            />
                          </div>
                        )}
                      </form.Field>
                      <form.Field name={`fabrics[${index}].ip`}>
                        {(sub) => (
                          <div className="min-w-0 flex-1 space-y-1">
                            <Label htmlFor={`fabric-ip-${index}`}>
                              {t("dashboard:nodes.fabrics.ip")}
                            </Label>
                            <Input
                              id={`fabric-ip-${index}`}
                              className="min-h-[44px] font-mono"
                              inputMode="decimal"
                              value={sub.state.value}
                              onChange={(event) => sub.handleChange(event.target.value)}
                            />
                          </div>
                        )}
                      </form.Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-touch"
                        aria-label={t("dashboard:nodes.fabrics.removeRow")}
                        onClick={() => field.removeValue(index)}
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <FieldError errors={field.state.meta.errors} />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-[44px]"
                      onClick={() => field.pushValue({ name: "", ip: "" })}
                    >
                      <Plus aria-hidden="true" />
                      {t("dashboard:nodes.fabrics.addRow")}
                    </Button>
                    {node.fabricSuggestions
                      .filter(
                        (suggestion) => !field.state.value.some((row) => row.ip === suggestion.ip),
                      )
                      .map((suggestion) => (
                        <Button
                          key={suggestion.ip}
                          type="button"
                          variant="ghost"
                          className="min-h-[44px]"
                          onClick={() => field.pushValue({ name: "", ip: suggestion.ip })}
                        >
                          {t("dashboard:nodes.fabrics.suggestion", {
                            ip: suggestion.ip,
                            speed: suggestion.linkSpeedMbps
                              ? t("dashboard:nodes.fabrics.speed", {
                                  gbps: Math.round(suggestion.linkSpeedMbps / 1000),
                                })
                              : suggestion.rdma
                                ? t("dashboard:nodes.fabrics.rdma")
                                : "",
                          })}
                        </Button>
                      ))}
                  </div>
                </div>
              )}
            </form.Field>
            <Button type="submit" className="min-h-[44px]" disabled={update.isPending}>
              {t("common:actions.save")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function SourceTag({ source }: { source: "browser" | "agent" | "node" | "detected" | null }) {
  const { t } = useTranslation(["dashboard"]);
  if (!source) return null;
  return (
    <span className="rounded bg-muted px-1 text-[0.7rem] text-muted-foreground">
      {t(`dashboard:nodes.hardware.source.${source}`)}
    </span>
  );
}

export function HardwareCard({ node, lang }: { node: NodeDetail; lang: string }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const hw = node.hardware;
  const full = node.trust.effective === "FULL";
  const update = useUpdateNode("dashboard:nodes.hardware.saved");
  const declared = node.declaredHardware;
  const form = useForm({
    defaultValues: {
      kind: (declared?.kind ?? "") as Kind | "",
      memoryGb: declared?.memoryGb === undefined ? "" : String(declared.memoryGb),
      reservedMemoryGb:
        declared?.reservedMemoryGb === undefined ? "" : String(declared.reservedMemoryGb),
      gpus: (declared?.gpus ?? []).map(
        (gpu): GpuRow => ({
          vendor: gpu.vendor,
          index: String(gpu.index),
          name: gpu.name ?? "",
          unified: gpu.unified === true,
          vramGb: gpu.vramGb === undefined ? "" : String(gpu.vramGb),
        }),
      ),
    },
    validators: {
      onChange: z
        .object({
          kind: z.enum(["", ...KINDS]),
          memoryGb: z.string(),
          reservedMemoryGb: z.string(),
          gpus: z.array(
            z.object({
              vendor: z.enum(GPU_VENDORS),
              index: z.string(),
              name: z.string(),
              unified: z.boolean(),
              vramGb: z.string(),
            }),
          ),
        })
        .superRefine((value, ctx) => {
          const parsed = declaredHardwareSchema.safeParse(toDeclaration(value, declared));
          if (parsed.success) return;
          const onGpus = parsed.error.issues.some((issue) => issue.path[0] === "gpus");
          ctx.addIssue({
            code: "custom",
            path: [onGpus ? "gpus" : "memoryGb"],
            message: t(
              onGpus ? "dashboard:nodes.hardware.gpuInvalid" : "dashboard:nodes.hardware.invalid",
            ),
          });
        }),
    },
    onSubmit: async ({ value }) => {
      const declaration = toDeclaration(value, declared);
      const input: UpdateInput = {
        nodeId: node.id,
        hardware: Object.keys(declaration).length === 0 ? null : declaration,
      };
      await update.mutateAsync(input);
    },
  });

  const rows: Array<[string, string | null, "browser" | "agent" | "node" | "detected" | null]> = [
    [
      t("dashboard:nodes.hardware.kind"),
      hw.kind.value ? t(`dashboard:nodes.hardwareKind.${hw.kind.value}`) : null,
      hw.kind.source,
    ],
    [t("dashboard:nodes.hardware.memory"), formatGb(hw.memoryGb.value, lang), hw.memoryGb.source],
    [
      t("dashboard:nodes.hardware.accelerator"),
      formatGb(hw.acceleratorMemoryGb.value, lang),
      hw.acceleratorMemoryGb.source,
    ],
    [
      t("dashboard:nodes.hardware.reserved"),
      formatGb(hw.reservedMemoryGb.value, lang),
      hw.reservedMemoryGb.source,
    ],
  ];

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.hardware.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.hardware.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {rows.map(([label, value, source]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {value ?? t("dashboard:nodes.card.unknown")}
                <SourceTag source={source} />
              </dd>
            </div>
          ))}
          <dt className="text-muted-foreground">{t("dashboard:nodes.hardware.usable")}</dt>
          <dd>{formatGb(hw.usableMemoryGb, lang)}</dd>
          <dt className="text-muted-foreground">{t("dashboard:nodes.hardware.reservedNow")}</dt>
          <dd>{formatGb(hw.reservedNowMemoryGb, lang)}</dd>
          <dt className="text-muted-foreground">{t("dashboard:nodes.card.freeMemory")}</dt>
          <dd>{formatGb(hw.liveFreeMemoryGb, lang) ?? t("dashboard:nodes.card.unknown")}</dd>
        </dl>
        {hw.gpus.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {hw.gpus.map((gpu) => (
              <li key={gpu.key} className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs">{gpu.key}</span>
                <span>{gpu.name ?? gpu.vendor}</span>
                <span className="text-muted-foreground">
                  {gpu.unified
                    ? t("dashboard:nodes.hardware.sharedVram")
                    : formatGb(gpu.vramGb, lang)}
                </span>
                <SourceTag source={gpu.source} />
              </li>
            ))}
          </ul>
        ) : null}
        {full ? (
          <form
            className="space-y-3 border-t pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              form.handleSubmit().catch(() => undefined);
            }}
          >
            <p className="text-sm font-medium">{t("dashboard:nodes.hardware.declare")}</p>
            <form.Field name="kind">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="hw-kind">{t("dashboard:nodes.hardware.kind")}</Label>
                  <Select
                    value={field.state.value === "" ? "auto" : field.state.value}
                    onValueChange={(next) => {
                      const kind = KINDS.find((candidate) => candidate === next);
                      field.handleChange(kind ?? "");
                    }}
                  >
                    <SelectTrigger id="hw-kind" className="min-h-[44px] w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("dashboard:nodes.hardware.auto")}</SelectItem>
                      {KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`dashboard:nodes.hardwareKind.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </form.Field>
            <div className="grid grid-cols-2 gap-2">
              <form.Field name="memoryGb">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="hw-memory">{t("dashboard:nodes.hardware.memory")}</Label>
                    <Input
                      id="hw-memory"
                      inputMode="decimal"
                      className="min-h-[44px]"
                      placeholder={t("dashboard:nodes.hardware.auto")}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldError errors={field.state.meta.errors} />
                  </div>
                )}
              </form.Field>
              <form.Field name="reservedMemoryGb">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="hw-reserved">{t("dashboard:nodes.hardware.reserved")}</Label>
                    <Input
                      id="hw-reserved"
                      inputMode="decimal"
                      className="min-h-[44px]"
                      placeholder="0"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </div>
                )}
              </form.Field>
            </div>
            <form.Field name="gpus" mode="array">
              {(field) => (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t("dashboard:nodes.hardware.gpus")}</p>
                  {field.state.value.map((row, index) => (
                    <div key={index} className="flex min-w-0 flex-wrap items-end gap-2">
                      <form.Field name={`gpus[${index}].vendor`}>
                        {(sub) => (
                          <div className="w-28 space-y-1">
                            <Label htmlFor={`gpu-vendor-${index}`}>
                              {t("dashboard:nodes.hardware.gpuVendor")}
                            </Label>
                            <Select
                              value={sub.state.value}
                              onValueChange={(next) => {
                                const vendor = GPU_VENDORS.find((candidate) => candidate === next);
                                if (vendor) sub.handleChange(vendor);
                              }}
                            >
                              <SelectTrigger
                                id={`gpu-vendor-${index}`}
                                className="min-h-[44px] w-full"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {GPU_VENDORS.map((vendor) => (
                                  <SelectItem key={vendor} value={vendor}>
                                    {vendor}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </form.Field>
                      <form.Field name={`gpus[${index}].index`}>
                        {(sub) => (
                          <div className="w-16 space-y-1">
                            <Label htmlFor={`gpu-index-${index}`}>
                              {t("dashboard:nodes.hardware.gpuIndex")}
                            </Label>
                            <Input
                              id={`gpu-index-${index}`}
                              inputMode="numeric"
                              className="min-h-[44px]"
                              value={sub.state.value}
                              onChange={(event) => sub.handleChange(event.target.value)}
                            />
                          </div>
                        )}
                      </form.Field>
                      <form.Field name={`gpus[${index}].name`}>
                        {(sub) => (
                          <div className="min-w-0 flex-1 space-y-1">
                            <Label htmlFor={`gpu-name-${index}`}>
                              {t("dashboard:nodes.hardware.gpuName")}
                            </Label>
                            <Input
                              id={`gpu-name-${index}`}
                              className="min-h-[44px]"
                              value={sub.state.value}
                              onChange={(event) => sub.handleChange(event.target.value)}
                            />
                          </div>
                        )}
                      </form.Field>
                      <form.Field name={`gpus[${index}].unified`}>
                        {(sub) => (
                          <div className="flex min-h-[44px] items-center gap-2">
                            <Checkbox
                              id={`gpu-unified-${index}`}
                              checked={sub.state.value}
                              onCheckedChange={(checked) => sub.handleChange(checked === true)}
                            />
                            <Label htmlFor={`gpu-unified-${index}`}>
                              {t("dashboard:nodes.hardware.sharedVram")}
                            </Label>
                          </div>
                        )}
                      </form.Field>
                      {row.unified ? null : (
                        <form.Field name={`gpus[${index}].vramGb`}>
                          {(sub) => (
                            <div className="w-24 space-y-1">
                              <Label htmlFor={`gpu-vram-${index}`}>
                                {t("dashboard:nodes.hardware.gpuVram")}
                              </Label>
                              <Input
                                id={`gpu-vram-${index}`}
                                inputMode="decimal"
                                className="min-h-[44px]"
                                value={sub.state.value}
                                onChange={(event) => sub.handleChange(event.target.value)}
                              />
                            </div>
                          )}
                        </form.Field>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-touch"
                        aria-label={t("dashboard:nodes.hardware.removeGpu")}
                        onClick={() => field.removeValue(index)}
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <FieldError errors={field.state.meta.errors} />
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[44px]"
                    onClick={() =>
                      field.pushValue({
                        vendor: "nvidia",
                        index: String(field.state.value.length),
                        name: "",
                        unified: false,
                        vramGb: "",
                      })
                    }
                  >
                    <Plus aria-hidden="true" />
                    {t("dashboard:nodes.hardware.addGpu")}
                  </Button>
                </div>
              )}
            </form.Field>
            <Button type="submit" className="min-h-[44px]" disabled={update.isPending}>
              {t("common:actions.save")}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
