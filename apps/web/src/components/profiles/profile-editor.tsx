import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { Plus, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { Help } from "@/components/help";
import { FieldError } from "@/components/nodes/field-error";
import type { NodeSummary, ProfileView } from "@/components/nodes/node-types";
import { refusalToastOptions } from "@/components/nodes/refusal";
import { orpc } from "@/utils/orpc";

import { ApplyProfileDialog } from "./apply-profile-dialog";

export const PROFILE_SLUG_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$/;

type ItemRow = { runtimeId: string; versionId: string | null; count: string; nodeIds: string[] };
type HoldRow = { nodeId: string; note: string };

/** A slug from a name: "Evening gaming" → "evening-gaming". */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 41);
}

export function ProfileEditor({
  profile,
  nodes,
  lang,
}: {
  profile: ProfileView;
  nodes: readonly NodeSummary[];
  lang: string;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [applying, setApplying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const startable = (runtimes.data?.runtimes ?? []).filter(
    (runtime) => runtime.kind === "STARTABLE",
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.profiles.key() });
  const save = useMutation({
    ...orpc.profiles.save.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:profiles.editor.saved"));
        invalidate();
      },
    }),
    ...refusalToastOptions(t),
  });
  const remove = useMutation({
    ...orpc.profiles.delete.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:profiles.editor.deleted"));
        invalidate();
        navigate({ to: "/$lang/profiles", params: { lang } });
      },
    }),
    ...refusalToastOptions(t),
  });

  const form = useForm({
    defaultValues: {
      name: profile.name,
      slug: profile.slug,
      description: profile.description ?? "",
      nodeIds: profile.nodeIds,
      holds: profile.holds.map((hold) => ({
        nodeId: hold.nodeId,
        note: hold.note ?? "",
      })) as HoldRow[],
      items: profile.items.map((item) => ({
        runtimeId: item.runtimeId,
        versionId: item.versionId,
        count: String(item.count),
        nodeIds: item.nodeIds,
      })) as ItemRow[],
    },
    validators: {
      onChange: z.object({
        name: z.string().trim().min(1, t("dashboard:profiles.editor.nameRequired")).max(120),
        slug: z.string().regex(PROFILE_SLUG_PATTERN, t("dashboard:profiles.editor.slugInvalid")),
        description: z.string().max(2_000),
        nodeIds: z.array(z.string()).min(1, t("dashboard:profiles.editor.nodesRequired")),
        holds: z.array(z.object({ nodeId: z.string(), note: z.string().max(500) })),
        items: z.array(
          z.object({
            runtimeId: z.string().min(1, t("dashboard:profiles.editor.runtimeRequired")),
            versionId: z.string().nullable(),
            count: z
              .string()
              .regex(/^[1-9][0-9]?$/, t("dashboard:profiles.editor.countInvalid"))
              .refine((count) => Number(count) <= 64, t("dashboard:profiles.editor.countInvalid")),
            nodeIds: z.array(z.string()),
          }),
        ),
      }),
    },
    onSubmit: async ({ value }) => {
      await saveWith(value, false);
    },
  });

  type Values = typeof form.state.values;
  const saveWith = async (value: Values, updatePins: boolean) => {
    const owned = new Set(value.nodeIds);
    await save.mutateAsync({
      profileId: profile.id,
      slug: value.slug,
      name: value.name.trim(),
      ...(value.description.trim() ? { description: value.description.trim() } : {}),
      nodeIds: value.nodeIds,
      holds: value.holds
        .filter((hold) => owned.has(hold.nodeId))
        .map((hold) => ({
          nodeId: hold.nodeId,
          ...(hold.note.trim() ? { note: hold.note.trim() } : {}),
        })),
      items: value.items.map((item) => ({
        runtimeId: item.runtimeId,
        ...(item.versionId && !updatePins ? { versionId: item.versionId } : {}),
        count: Number(item.count),
        nodeIds: item.nodeIds.filter((nodeId) => owned.has(nodeId)),
      })),
      ...(updatePins ? { updatePins: true } : {}),
    });
  };

  const runtimeLabel = (runtimeId: string) =>
    startable.find((runtime) => runtime.id === runtimeId)?.name ??
    profile.items.find((item) => item.runtimeId === runtimeId)?.runtimeSlug ??
    runtimeId;

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit().catch(() => undefined);
      }}
    >
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:profiles.editor.about")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <form.Field name="name">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">{t("dashboard:profiles.editor.name")}</Label>
                <Input
                  id="profile-name"
                  className="min-h-[44px]"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>
          <form.Field name="slug">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="profile-slug">{t("dashboard:profiles.editor.slug")}</Label>
                <Input
                  id="profile-slug"
                  className="min-h-[44px] font-mono"
                  autoCapitalize="none"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="profile-description">
                  {t("dashboard:profiles.editor.description")}
                </Label>
                <Input
                  id="profile-description"
                  className="min-h-[44px]"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </div>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {t("dashboard:profiles.editor.nodesTitle")}
            <Help>{t("dashboard:profiles.editor.nodesHelp")}</Help>
          </CardTitle>
          <CardDescription>{t("dashboard:profiles.editor.nodesDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form.Field name="nodeIds">
            {(nodesField) => (
              <form.Field name="holds">
                {(holdsField) => (
                  <div className="space-y-2">
                    {nodes.map((node) => {
                      const owned = nodesField.state.value.includes(node.id);
                      const hold = holdsField.state.value.find((row) => row.nodeId === node.id);
                      return (
                        <div
                          key={node.id}
                          className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1"
                        >
                          <label className="flex min-h-[44px] min-w-0 items-center gap-3">
                            <Checkbox
                              checked={owned}
                              onCheckedChange={(checked) =>
                                nodesField.handleChange(
                                  checked
                                    ? [...nodesField.state.value, node.id]
                                    : nodesField.state.value.filter((id) => id !== node.id),
                                )
                              }
                            />
                            <span className="truncate">{node.name ?? node.slug}</span>
                          </label>
                          {owned ? (
                            <label className="flex min-h-[44px] items-center gap-2 text-sm">
                              <Checkbox
                                checked={!!hold}
                                onCheckedChange={(checked) =>
                                  holdsField.handleChange(
                                    checked
                                      ? [...holdsField.state.value, { nodeId: node.id, note: "" }]
                                      : holdsField.state.value.filter(
                                          (row) => row.nodeId !== node.id,
                                        ),
                                  )
                                }
                              />
                              {t("dashboard:profiles.editor.holdLine")}
                            </label>
                          ) : null}
                          {owned && hold ? (
                            <Input
                              aria-label={t("dashboard:profiles.editor.holdNote", {
                                slug: node.slug,
                              })}
                              className="min-h-[44px] min-w-0 flex-1"
                              placeholder={t("dashboard:nodes.hold.notePlaceholder")}
                              maxLength={500}
                              value={hold.note}
                              onChange={(event) =>
                                holdsField.handleChange(
                                  holdsField.state.value.map((row) =>
                                    row.nodeId === node.id
                                      ? { ...row, note: event.target.value }
                                      : row,
                                  ),
                                )
                              }
                            />
                          ) : null}
                        </div>
                      );
                    })}
                    <FieldError errors={nodesField.state.meta.errors} />
                  </div>
                )}
              </form.Field>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:profiles.editor.itemsTitle")}</CardTitle>
          <CardDescription>{t("dashboard:profiles.editor.itemsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {runtimes.isError ? (
            <p className="text-sm text-muted-foreground">
              {t("dashboard:profiles.editor.runtimesUnavailable")}
            </p>
          ) : null}
          <form.Field name="items" mode="array">
            {(field) => (
              <div className="space-y-2">
                {field.state.value.map((row, index) => {
                  const item = profile.items.find(
                    (candidate) =>
                      candidate.runtimeId === row.runtimeId &&
                      candidate.versionId === row.versionId,
                  );
                  return (
                    <div
                      key={`${row.runtimeId}-${index}`}
                      className="flex min-w-0 flex-wrap items-end gap-2 border-b pb-2"
                    >
                      <form.Field name={`items[${index}].runtimeId`}>
                        {(sub) => (
                          <div className="min-w-0 flex-1 space-y-1">
                            <Label htmlFor={`item-runtime-${index}`}>
                              {t("dashboard:profiles.editor.runtime")}
                            </Label>
                            <Select
                              value={sub.state.value}
                              onValueChange={(next) => {
                                if (typeof next !== "string") return;
                                sub.handleChange(next);
                                form.setFieldValue(`items[${index}].versionId`, null);
                              }}
                            >
                              <SelectTrigger
                                id={`item-runtime-${index}`}
                                className="min-h-[44px] w-full"
                              >
                                <SelectValue>{runtimeLabel(sub.state.value)}</SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {startable.map((runtime) => (
                                  <SelectItem key={runtime.id} value={runtime.id}>
                                    {runtime.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </form.Field>
                      <form.Field name={`items[${index}].count`}>
                        {(sub) => (
                          <div className="w-24 space-y-1">
                            <Label htmlFor={`item-count-${index}`}>
                              {t("dashboard:profiles.editor.count")}
                            </Label>
                            <Input
                              id={`item-count-${index}`}
                              inputMode="numeric"
                              className="min-h-[44px]"
                              value={sub.state.value}
                              onChange={(event) => sub.handleChange(event.target.value)}
                            />
                            <FieldError errors={sub.state.meta.errors} />
                          </div>
                        )}
                      </form.Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-touch"
                        aria-label={t("dashboard:profiles.editor.removeItem")}
                        onClick={() => field.removeValue(index)}
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                      {item ? (
                        <p className="w-full text-xs text-muted-foreground">
                          {t("dashboard:profiles.editor.pinned", { version: item.versionNumber })}
                          {item.pinOutdated ? ` · ${t("dashboard:profiles.pinsOutdated")}` : ""}
                          {item.nodeIds.length > 0
                            ? ` · ${t("dashboard:profiles.editor.onlyOn", {
                                nodes: item.nodeIds
                                  .map((id) => nodes.find((node) => node.id === id)?.slug ?? id)
                                  .join(", "),
                              })}`
                            : ""}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                <FieldError errors={field.state.meta.errors} />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={startable.length === 0}
                  onClick={() =>
                    field.pushValue({
                      runtimeId: startable[0]?.id ?? "",
                      versionId: null,
                      count: "1",
                      nodeIds: [],
                    })
                  }
                >
                  <Plus aria-hidden="true" />
                  {t("dashboard:profiles.editor.addItem")}
                </Button>
              </div>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" className="min-h-[44px]" disabled={!canSubmit || isSubmitting}>
              {t("common:actions.save")}
            </Button>
          )}
        </form.Subscribe>
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          disabled={save.isPending || !profile.items.some((item) => item.pinOutdated)}
          onClick={() => saveWith(form.state.values, true)}
        >
          {t("dashboard:profiles.editor.updatePins")}
        </Button>
        <form.Subscribe selector={(state) => state.isDirty}>
          {(dirty) => (
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={dirty}
              title={dirty ? t("dashboard:profiles.editor.saveFirst") : undefined}
              onClick={() => setApplying(true)}
            >
              {t("dashboard:profiles.apply.button")}
            </Button>
          )}
        </form.Subscribe>
        <Button
          type="button"
          variant="ghost"
          className="min-h-[44px] text-destructive"
          onClick={() => setDeleting(true)}
        >
          {t("common:actions.delete")}
        </Button>
      </div>
      <form.Subscribe selector={(state) => state.isDirty}>
        {(dirty) => (
          <p className="text-xs text-muted-foreground">
            {dirty
              ? t("dashboard:profiles.editor.saveFirst")
              : t("dashboard:profiles.editor.applyHint")}
          </p>
        )}
      </form.Subscribe>

      <ApplyProfileDialog profile={profile} open={applying} onOpenChange={setApplying} />
      <ConfirmDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("dashboard:profiles.editor.deleteTitle")}
        description={t("dashboard:profiles.editor.deleteDescription")}
        confirmToken={profile.slug}
        typePrompt={t("dashboard:profiles.editor.typeSlug")}
        copyAriaLabel={t("dashboard:nodes.copy")}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ profileId: profile.id })}
      />
    </form>
  );
}
