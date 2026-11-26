import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import { OwnKeyChoice } from "@/components/access/own-key-choice";
import {
  CapLine,
  type InviteLink,
  InviteLinkDialog,
  InviteRow,
  PermissionCheckbox,
  Permissions,
  RuntimeShareRow,
  ShareByMeRow,
  ShareEmpty,
  ShareSection,
  type ShareView,
  useCreatePoolShare,
  useInvalidateShares,
} from "@/components/access/pool-shares";
import {
  announceShared,
  PRIORITY_CHOICES,
  type PriorityChoice,
  priorityItems,
  priorityLabel,
} from "@/components/access/pool-shares-utils";
import { FormAdvanced, focusFirstInvalid } from "@/components/form-surface";
import { InlineRetry } from "@/components/inline-retry";
import { LabelledSelect } from "@/components/labelled-select";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/shares")({
  component: AccessSharesPage,
});

function AccessSharesPage() {
  const { t } = useTranslation(["access"]);
  const shares = useQuery(orpc.access.shares.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<InviteLink | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <PageHeading page="accessShares" />
        <Button type="button" size="touch" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
          {t("access:shares.create")}
        </Button>
      </div>
      {shares.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : shares.isError ? (
        <InlineRetry message={t("access:shares.loadFailed")} onRetry={() => shares.refetch()} />
      ) : (
        <>
          <ShareSection title={t("access:shares.byMeTitle")}>
            {shares.data.byMe.length === 0 ? (
              <ShareEmpty text={t("access:shares.byMeEmpty")} />
            ) : (
              shares.data.byMe.map((share) => <ShareByMeRow key={share.id} share={share} />)
            )}
          </ShareSection>
          <RuntimeSharesByMe />
          <ShareSection title={t("access:shares.invitesTitle")}>
            {shares.data.invites.length === 0 ? (
              <ShareEmpty text={t("access:shares.invitesEmpty")} />
            ) : (
              shares.data.invites.map((invite) => (
                <InviteRow key={invite.id} invite={invite} onLink={setInviteLink} />
              ))
            )}
          </ShareSection>
          <ShareSection title={t("access:shares.withMeTitle")}>
            {shares.data.withMe.length === 0 ? (
              <ShareEmpty text={t("access:shares.withMeEmpty")} />
            ) : (
              shares.data.withMe.map((share) => <ShareWithMeRow key={share.id} share={share} />)
            )}
          </ShareSection>
        </>
      )}
      <CreateShareDialog open={createOpen} onOpenChange={setCreateOpen} onLink={setInviteLink} />
      <InviteLinkDialog value={inviteLink} onClose={() => setInviteLink(null)} />
    </div>
  );
}

/** Runtime definitions you share (read-only, every version), with stop sharing. */
function RuntimeSharesByMe() {
  const { t } = useTranslation(["access"]);
  const shares = useQuery(orpc.runtimes.shares.list.queryOptions({ input: {} }));
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const names = new Map(
    (runtimes.data?.runtimes ?? []).map((runtime) => [runtime.id, runtime.name]),
  );
  return (
    <ShareSection title={t("access:shares.runtimesByMeTitle")}>
      {shares.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : shares.isError ? (
        <InlineRetry message={t("access:shares.loadFailed")} onRetry={() => shares.refetch()} />
      ) : shares.data.sharedByMe.length === 0 ? (
        <ShareEmpty text={t("access:shares.runtimesByMeEmpty")} />
      ) : (
        shares.data.sharedByMe.map((share) => (
          <RuntimeShareRow
            key={share.id}
            share={share}
            name={names.get(share.runtimeId) ?? share.runtimeId}
          />
        ))
      )}
    </ShareSection>
  );
}

function ShareWithMeRow({ share }: { share: ShareView }) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const leave = useMutation(
    orpc.access.shares.delete.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:shares.removed"));
        await invalidate();
      },
    }),
  );
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-mono font-medium">{share.callableId}</p>
        <p className="truncate text-xs text-muted-foreground">
          {t("access:shares.from", { email: share.ownerEmail })}
        </p>
        <Permissions grant={share} />
        <CapLine share={share} />
      </div>
      <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
        {t("access:shares.leave")}
      </Button>
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:shares.leaveTitle", { pool: share.callableId })}
        description={t("access:shares.leaveDescription")}
        confirmLabel={t("access:shares.leave")}
        isPending={leave.isPending}
        onConfirm={() => leave.mutate({ shareId: share.id })}
      />
      <OwnKeyChoice shareId={share.id} />
    </div>
  );
}

type ShareWhat = "pool" | "runtime";

const createSchema = z
  .object({
    what: z.enum(["pool", "runtime"]),
    poolId: z.string(),
    runtimeId: z.string(),
    email: z.string().trim().toLowerCase().email().max(320),
    canUse: z.boolean(),
    canContribute: z.boolean(),
    priority: z.enum(PRIORITY_CHOICES),
  })
  .superRefine((value, ctx) => {
    if (value.what === "runtime") {
      if (!value.runtimeId) ctx.addIssue({ code: "custom", path: ["runtimeId"], message: "" });
      return;
    }
    if (!value.poolId) ctx.addIssue({ code: "custom", path: ["poolId"], message: "" });
    if (!value.canUse && !value.canContribute)
      ctx.addIssue({ code: "custom", path: ["canUse"], message: "" });
  });

/**
 * "Share a pool or runtime": what, with whom, and what they may do; the queue priority sits
 * folded away (the pool's own priority unless changed). Cancel and Share stay pinned. Mounted
 * only while open, so every opening starts from the defaults.
 */
function CreateShareDialog({
  open,
  onOpenChange,
  onLink,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLink: (link: InviteLink) => void;
}) {
  return open ? <CreateShareForm onOpenChange={onOpenChange} onLink={onLink} /> : null;
}

function CreateShareForm({
  onOpenChange,
  onLink,
}: {
  onOpenChange: (open: boolean) => void;
  onLink: (link: InviteLink) => void;
}) {
  const { t } = useTranslation(["access", "common"]);
  const formId = useId();
  const onDone = () => onOpenChange(false);
  const invalidate = useInvalidateShares();
  const pools = useQuery(orpc.pools.list.queryOptions());
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const createPoolShare = useCreatePoolShare(onLink);
  const createRuntimeShare = useMutation(orpc.runtimes.shares.create.mutationOptions());
  const ownPools = pools.data?.pools ?? [];
  const ownRuntimes = runtimes.data?.runtimes ?? [];
  const form = useForm({
    defaultValues: {
      what: "pool" as ShareWhat,
      poolId: "",
      runtimeId: "",
      email: "",
      canUse: true,
      canContribute: false,
      priority: "POOL" as PriorityChoice,
    },
    validators: { onSubmit: createSchema },
    // Errors sit next to their field; focus moves to the first one.
    onSubmitInvalid: () =>
      window.setTimeout(() => focusFirstInvalid(document.getElementById(formId)), 0),
    onSubmit: async ({ value }) => {
      const email = value.email.trim().toLowerCase();
      // Both answer alike: a share (a proved mailbox) or an invite, whose link is shown once
      // when no e-mail went out.
      if (value.what === "pool") {
        await createPoolShare.submit(
          {
            poolId: value.poolId,
            email,
            canUse: value.canUse,
            canContribute: value.canContribute,
            priorityClass: value.priority === "POOL" ? null : value.priority,
            protectionPercent: null,
            monthlyCap: null,
          },
          onDone,
        );
        return;
      }
      // A failure is toasted by the global mutation error handler.
      const result = await createRuntimeShare
        .mutateAsync({ runtimeId: value.runtimeId, email })
        .catch(() => null);
      if (!result) return;
      await invalidate();
      onDone();
      announceShared(result, email, t, onLink);
    },
  });

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next && !form.state.isSubmitting) onOpenChange(false);
      }}
      title={t("access:shares.createTitle")}
      description={t("access:shares.createDescription")}
      footer={
        <form.Subscribe selector={(state) => [state.isSubmitting, state.values.what] as const}>
          {([isSubmitting, what]) => (
            <div className="flex min-w-0 flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={isSubmitting}
                onClick={onDone}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                form={formId}
                size="touch"
                disabled={
                  isSubmitting ||
                  (what === "runtime" ? ownRuntimes.length === 0 : ownPools.length === 0)
                }
              >
                {isSubmitting ? t("access:shares.sharing") : t("access:shares.create")}
              </Button>
            </div>
          )}
        </form.Subscribe>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex min-w-0 flex-col gap-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <form.Field name="what">
          {(field) => (
            <div className="min-w-0 space-y-2">
              <Label>{t("access:shares.what")}</Label>
              <SegmentedControl
                value={field.state.value}
                onChange={field.handleChange}
                ariaLabel={t("access:shares.what")}
                items={[
                  { value: "pool", label: t("access:shares.whatPool") },
                  { value: "runtime", label: t("access:shares.whatRuntime") },
                ]}
              />
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.what}>
          {(what) =>
            what === "runtime" ? (
              <form.Field name="runtimeId">
                {(field) => (
                  <TargetPicker
                    id="share-runtime"
                    label={t("access:shares.runtime")}
                    hint={t("access:shares.runtimeHint")}
                    placeholder={t("access:shares.chooseRuntime")}
                    error={
                      field.state.meta.errors.length > 0 ? t("access:shares.chooseRuntime") : null
                    }
                    query={runtimes}
                    failed={t("access:shares.runtimesLoadFailed")}
                    empty={t("access:shares.noOwnRuntimes")}
                    options={ownRuntimes.map((runtime) => ({
                      value: runtime.id,
                      label: runtime.name,
                    }))}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            ) : (
              <form.Field name="poolId">
                {(field) => (
                  <TargetPicker
                    id="share-pool"
                    label={t("access:shares.pool")}
                    placeholder={t("access:shares.choosePool")}
                    error={
                      field.state.meta.errors.length > 0 ? t("access:shares.choosePool") : null
                    }
                    query={pools}
                    failed={t("access:shares.poolsLoadFailed")}
                    empty={t("access:shares.noOwnPools")}
                    options={ownPools.map((pool) => ({
                      value: pool.id,
                      label: pool.callableIds[0] ?? pool.slug,
                    }))}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            )
          }
        </form.Subscribe>
        <form.Field name="email">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="share-email">{t("access:shares.email")}</Label>
              <Input
                id="share-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                className="min-h-11"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                aria-describedby={
                  field.state.meta.errors.length > 0 ? "share-email-error" : undefined
                }
              />
              {field.state.meta.errors.length > 0 ? (
                <p id="share-email-error" className="text-sm text-destructive">
                  {field.state.meta.errors[0]?.message}
                </p>
              ) : null}
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => [state.values.what, state.values.priority] as const}>
          {([what, priority]) =>
            what === "pool" ? (
              <>
                <form.Field name="canUse">
                  {(field) => (
                    <PermissionCheckbox
                      id="share-can-use"
                      label={t("access:shares.canUse")}
                      hint={t("access:shares.canUseHint")}
                      checked={field.state.value}
                      onChange={field.handleChange}
                      error={field.state.meta.errors.length > 0 ? t("access:shares.needOne") : null}
                    />
                  )}
                </form.Field>
                <form.Field name="canContribute">
                  {(field) => (
                    <PermissionCheckbox
                      id="share-can-contribute"
                      label={t("access:shares.canContribute")}
                      hint={t("access:shares.canContributeHint")}
                      checked={field.state.value}
                      onChange={field.handleChange}
                      error={null}
                    />
                  )}
                </form.Field>
                <FormAdvanced
                  title={t("access:shares.priority")}
                  summary={t("access:shares.priorityValue", {
                    priority: priorityLabel(t, priority),
                  })}
                >
                  <form.Field name="priority">
                    {(field) => (
                      <SegmentedControl
                        value={field.state.value}
                        onChange={field.handleChange}
                        ariaLabel={t("access:shares.priority")}
                        items={priorityItems(t)}
                      />
                    )}
                  </form.Field>
                </FormAdvanced>
              </>
            ) : null
          }
        </form.Subscribe>
      </form>
    </ResponsiveDialog>
  );
}

/**
 * The pool or runtime to share: a select (a long list never grows the dialog), with its load,
 * failure and empty states in place.
 */
function TargetPicker({
  id,
  label,
  hint,
  placeholder,
  error,
  query,
  failed,
  empty,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  error: string | null;
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  failed: string;
  empty: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {query.isPending ? (
        <Skeleton className="h-11 w-full" />
      ) : query.isError ? (
        <InlineRetry message={failed} onRetry={() => query.refetch()} />
      ) : options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <LabelledSelect
          id={id}
          value={value}
          placeholder={placeholder}
          options={options}
          onValueChange={onChange}
          invalid={error !== null}
          describedBy={error ? `${id}-error` : undefined}
        />
      )}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
