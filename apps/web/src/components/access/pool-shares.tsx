import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import { SecretReveal } from "@/components/access/secret-reveal";
import { FieldErrors } from "@/components/field-errors";
import { SegmentedControl } from "@/components/segmented-control";
import { TimeAgo } from "@/components/time-ago";
import { refusalText } from "@/lib/refusal-text";
import { isConflict, isNotFound } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/**
 * Pool and runtime shares and invites, shared by Access → Shares (everything), a pool's Sharing
 * tab (that pool only) and a runtime's sharing card. Every write here is people-only (a
 * CSRF-checked session).
 */

type SharesList = Awaited<ReturnType<AppRouterClient["access"]["shares"]["list"]>>;
export type ShareView = SharesList["byMe"][number];
export type InviteView = SharesList["invites"][number];
export type InviteLink = { email: string; link: string; expiresAt: string };
type CreateShareInput = Parameters<AppRouterClient["access"]["shares"]["create"]>[0];

export const PRIORITY_CHOICES = ["POOL", "BACKGROUND", "NORMAL", "HIGH"] as const;
export type PriorityChoice = (typeof PRIORITY_CHOICES)[number];
const MONEY = /^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A money string as the server writes it back: no trailing fractional zeros. */
function sameMoney(a: string, b: string) {
  const trim = (value: string) =>
    value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
  return trim(a) === trim(b);
}

export function ShareSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">{children}</CardContent>
    </Card>
  );
}

export function ShareEmpty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

export function useInvalidateShares() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.access.shares.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.shares.list.key() }),
      // A runtime's page lists its shares too.
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.get.key() }),
      // A pool shows its share count and contributed members.
      queryClient.invalidateQueries({ queryKey: orpc.pools.key() }),
    ]);
}

/**
 * Share a pool: a share for a proved mailbox, else an invite whose link is shown once when no
 * e-mail went out. `onShared` runs before the answer is announced (close a dialog first, so the
 * invite link dialog opens on top). Resolves true when something was shared or invited.
 */
export function useCreatePoolShare(onLink: (link: InviteLink) => void) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const create = useMutation({
    ...orpc.access.shares.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const submit = async (input: CreateShareInput, onShared?: () => void): Promise<boolean> => {
    const result = await create.mutateAsync(input).catch((error: unknown) => {
      // already_shared, invite_pending, too_many_invites have their own copy.
      toast.error(refusalText(error));
      return null;
    });
    if (!result) return false;
    await invalidate();
    onShared?.();
    announceShared(result, input.email, t, onLink);
    return true;
  };
  return { submit, isPending: create.isPending };
}

/** What a share or invite answer tells the owner: shared, e-mailed, or a link to copy. */
export function announceShared(
  result:
    | { kind: "share" }
    | { kind: "invite"; invite: { expiresAt: string }; link: string | null },
  email: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  onLink: (link: InviteLink) => void,
) {
  if (result.kind === "share") toast.success(t("access:shares.shared", { email }));
  else if (result.link) onLink({ email, link: result.link, expiresAt: result.invite.expiresAt });
  else toast.success(t("access:shares.invited", { email }));
}

function priorityLabel(
  t: (key: string) => string,
  priority: ShareView["priorityClass"] | PriorityChoice,
) {
  switch (priority) {
    case null:
    case "POOL":
      return t("access:shares.priorityPool");
    case "BACKGROUND":
      return t("access:shares.priorityBackground");
    case "NORMAL":
      return t("access:shares.priorityNormal");
    case "HIGH":
      return t("access:shares.priorityHigh");
  }
}

export function priorityItems(t: (key: string) => string) {
  return PRIORITY_CHOICES.map((value) => ({ value, label: priorityLabel(t, value) }));
}

/** What an invite or share names: a pool's callable id, or a runtime definition. */
function TargetLine({ target }: { target: InviteView["target"] }) {
  const { t } = useTranslation(["access"]);
  return target.kind === "pool" ? (
    <p className="truncate font-mono text-xs text-muted-foreground">{target.callableId}</p>
  ) : (
    <p className="truncate text-xs text-muted-foreground">
      {t("access:shares.runtimeTarget", { name: target.name })}
    </p>
  );
}

/** Can use · can contribute (and how many models they contributed). */
export function Permissions({
  grant,
}: {
  grant: { canUse: boolean; canContribute: boolean; contributedMembers?: number };
}) {
  const { t } = useTranslation(["access"]);
  return (
    <p className="text-xs text-muted-foreground">
      {[
        grant.canUse ? t("access:shares.canUse") : null,
        grant.canContribute ? t("access:shares.canContribute") : null,
        grant.contributedMembers
          ? t("access:shares.contributed", { count: grant.contributedMembers })
          : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/** Priority class and warm protection, each "the pool's" when not set on the share. */
export function SettingsLine({ share }: { share: ShareView }) {
  const { t } = useTranslation(["access"]);
  return (
    <p className="text-xs text-muted-foreground">
      {t("access:shares.priorityValue", { priority: priorityLabel(t, share.priorityClass) })}
      {" · "}
      {share.protectionPercent === null
        ? t("access:shares.protectionPoolValue")
        : t("access:shares.protectionValue", { percent: share.protectionPercent })}
    </p>
  );
}

export function CapLine({ share }: { share: ShareView }) {
  const { t } = useTranslation(["access"]);
  if (!share.monthlyCap) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t("access:shares.monthlyCap", {
        spent: share.monthlyCap.spentThisMonth,
        limit: share.monthlyCap.limit,
        currency: share.monthlyCap.currency,
      })}
    </p>
  );
}

/** One share of your pool: permissions to toggle, settings to edit, remove. */
export function ShareByMeRow({ share, showPool = true }: { share: ShareView; showPool?: boolean }) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [contributeOffOpen, setContributeOffOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const update = useMutation(
    orpc.access.shares.update.mutationOptions({
      onSuccess: async () => {
        toast.success(t("access:shares.updated"));
        await invalidate();
      },
    }),
  );
  const remove = useMutation(
    orpc.access.shares.delete.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:shares.removed"));
        await invalidate();
      },
    }),
  );
  const toggle = (field: "canUse" | "canContribute", next: boolean) => {
    const other = field === "canUse" ? share.canContribute : share.canUse;
    if (!next && !other) {
      toast.error(t("access:shares.needOne"));
      return;
    }
    // Clearing can contribute removes the person's contributed members: confirm first.
    if (field === "canContribute" && !next && share.contributedMembers > 0) {
      setContributeOffOpen(true);
      return;
    }
    update.mutate({ shareId: share.id, [field]: next });
  };
  return (
    <div className="flex min-w-0 flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate font-medium">{share.granteeEmail}</p>
          {showPool ? (
            <p className="truncate font-mono text-xs text-muted-foreground">{share.callableId}</p>
          ) : null}
          {share.contributedMembers > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("access:shares.contributed", { count: share.contributedMembers })}
            </p>
          ) : null}
          <SettingsLine share={share} />
          <CapLine share={share} />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" size="touch" onClick={() => setEditOpen(true)}>
            {t("access:shares.edit")}
          </Button>
          <Button type="button" variant="ghost" size="touch" onClick={() => setConfirmOpen(true)}>
            {t("access:shares.remove")}
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-1">
        <SwitchRow
          id={`share-${share.id}-use`}
          label={t("access:shares.canUse")}
          checked={share.canUse}
          disabled={update.isPending}
          onChange={(next) => toggle("canUse", next)}
        />
        <SwitchRow
          id={`share-${share.id}-contribute`}
          label={t("access:shares.canContribute")}
          checked={share.canContribute}
          disabled={update.isPending}
          onChange={(next) => toggle("canContribute", next)}
        />
      </div>
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:shares.removeTitle", {
          pool: share.callableId,
          email: share.granteeEmail,
        })}
        description={t("access:shares.removeDescription")}
        confirmLabel={t("access:shares.remove")}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ shareId: share.id })}
      />
      <ConfirmAction
        open={contributeOffOpen}
        onOpenChange={setContributeOffOpen}
        title={t("access:shares.contributeOffTitle", {
          email: share.granteeEmail,
          pool: share.callableId,
        })}
        description={t("access:shares.contributeOffDescription", {
          count: share.contributedMembers,
        })}
        confirmLabel={t("access:shares.contributeOff")}
        isPending={update.isPending}
        onConfirm={() =>
          update.mutate(
            { shareId: share.id, canContribute: false },
            { onSettled: () => setContributeOffOpen(false) },
          )
        }
      />
      <ResponsiveDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t("access:shares.editTitle", { email: share.granteeEmail })}
        description={t("access:shares.editDescription")}
      >
        {editOpen ? <ShareSettingsForm share={share} onDone={() => setEditOpen(false)} /> : null}
      </ResponsiveDialog>
    </div>
  );
}

/** Priority class, warm protection and the monthly cloud cap of one share. */
function ShareSettingsForm({ share, onDone }: { share: ShareView; onDone: () => void }) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const update = useMutation({
    ...orpc.access.shares.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const schema = z
    .object({
      priority: z.enum(PRIORITY_CHOICES),
      protection: z
        .string()
        .refine(
          (value) =>
            value.trim() === "" ||
            (/^[0-9]{1,3}$/.test(value.trim()) && Number(value.trim()) <= 100),
          t("access:shares.protectionInvalid"),
        ),
      capLimit: z
        .string()
        .refine(
          (value) => value.trim() === "" || MONEY.test(value.trim()),
          t("access:shares.capInvalid"),
        ),
      capCurrency: z.string(),
    })
    .superRefine((value, ctx) => {
      // The currency matters only with a cap.
      if (value.capLimit.trim() !== "" && !CURRENCY.test(value.capCurrency.trim()))
        ctx.addIssue({
          code: "custom",
          path: ["capCurrency"],
          message: t("access:shares.currencyInvalid"),
        });
    });
  const form = useForm({
    defaultValues: {
      priority: (share.priorityClass ?? "POOL") as PriorityChoice,
      protection: share.protectionPercent === null ? "" : String(share.protectionPercent),
      capLimit: share.monthlyCap?.limit ?? "",
      capCurrency: share.monthlyCap?.currency ?? "USD",
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const priorityClass = value.priority === "POOL" ? null : value.priority;
      const protectionPercent =
        value.protection.trim() === "" ? null : Number(value.protection.trim());
      const limit = value.capLimit.trim();
      const currency = value.capCurrency.trim();
      const capChanged = limit
        ? !share.monthlyCap ||
          !sameMoney(limit, share.monthlyCap.limit) ||
          currency !== share.monthlyCap.currency
        : share.monthlyCap !== null;
      // Only what changed: the server writes just the named fields.
      const patch = {
        ...(priorityClass !== share.priorityClass ? { priorityClass } : {}),
        ...(protectionPercent !== share.protectionPercent ? { protectionPercent } : {}),
        ...(capChanged ? { monthlyCap: limit ? { limit, currency } : null } : {}),
      };
      if (Object.keys(patch).length === 0) {
        onDone();
        return;
      }
      try {
        await update.mutateAsync({ shareId: share.id, ...patch });
      } catch (error) {
        toast.error(refusalText(error));
        return;
      }
      toast.success(t("access:shares.updated"));
      await invalidate();
      onDone();
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="priority">
        {(field) => (
          <div className="min-w-0 space-y-2">
            <Label>{t("access:shares.priority")}</Label>
            <SegmentedControl
              value={field.state.value}
              onChange={field.handleChange}
              ariaLabel={t("access:shares.priority")}
              items={priorityItems(t)}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="protection">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor={`share-${share.id}-protection`}>{t("access:shares.protection")}</Label>
            <Input
              id={`share-${share.id}-protection`}
              inputMode="numeric"
              className="h-11"
              placeholder={t("access:shares.protectionPool")}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={`share-${share.id}-protection-hint`}
            />
            <p id={`share-${share.id}-protection-hint`} className="text-xs text-muted-foreground">
              {t("access:shares.protectionHint")}
            </p>
            <FieldErrors field={field} />
          </div>
        )}
      </form.Field>
      <div className="flex min-w-0 gap-2">
        <form.Field name="capLimit">
          {(field) => (
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`share-${share.id}-cap`}>{t("access:shares.capLimit")}</Label>
              <Input
                id={`share-${share.id}-cap`}
                inputMode="decimal"
                className="h-11"
                placeholder={t("access:shares.noCap")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                aria-invalid={field.state.meta.errors.length > 0}
                aria-describedby={`share-${share.id}-cap-hint`}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="capCurrency">
          {(field) => (
            <div className="w-24 shrink-0 space-y-1.5">
              <Label htmlFor={`share-${share.id}-currency`}>{t("access:shares.capCurrency")}</Label>
              <Input
                id={`share-${share.id}-currency`}
                className="h-11 uppercase"
                maxLength={3}
                autoComplete="off"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value.toUpperCase())}
                aria-invalid={field.state.meta.errors.length > 0}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
      </div>
      <p id={`share-${share.id}-cap-hint`} className="-mt-2 text-xs text-muted-foreground">
        {t("access:shares.capHint")}
      </p>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" size="touch" disabled={isSubmitting}>
            {isSubmitting ? t("access:shares.saving") : t("access:shares.save")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

function SwitchRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <span className="text-sm">{label}</span>
    </label>
  );
}

/** One person a runtime definition is shared with, with stop sharing. */
export function RuntimeShareRow({
  share,
  name,
}: {
  share: { id: string; runtimeId: string; email: string };
  name: string;
}) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation(
    orpc.runtimes.shares.delete.mutationOptions({
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
        <p className="truncate font-medium">{share.email}</p>
        <p className="truncate text-xs text-muted-foreground">
          {t("access:shares.runtimeTarget", { name })}
        </p>
      </div>
      <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
        {t("access:shares.remove")}
      </Button>
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:shares.removeRuntimeTitle", { runtime: name, email: share.email })}
        description={t("access:shares.removeRuntimeDescription")}
        confirmLabel={t("access:shares.remove")}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ shareId: share.id })}
      />
    </div>
  );
}

/** A pending invite: resend (a new link) or withdraw. */
export function InviteRow({
  invite,
  onLink,
  showTarget = true,
}: {
  invite: InviteView;
  onLink: (link: InviteLink) => void;
  showTarget?: boolean;
}) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const resend = useMutation(
    orpc.access.invites.resend.mutationOptions({
      onSuccess: async (result) => {
        if (result.link) {
          onLink({ email: invite.email, link: result.link, expiresAt: result.invite.expiresAt });
        } else {
          toast.success(t("access:shares.resent"));
        }
        await invalidate();
      },
    }),
  );
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const withdraw = useMutation({
    ...orpc.access.invites.revoke.mutationOptions({
      onSuccess: async () => {
        setWithdrawOpen(false);
        toast.success(t("access:shares.withdrawn"));
        await invalidate();
      },
      onError: async (error) => {
        setWithdrawOpen(false);
        // Accepted meanwhile: it is a share now, which the refreshed list shows.
        // invite_accepted has its own copy; a gone invite is refreshed away too.
        toast.error(refusalText(error));
        if (isConflict(error) || isNotFound(error)) await invalidate();
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <div className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-medium">{invite.email}</p>
        {showTarget ? <TargetLine target={invite.target} /> : null}
        {invite.target.kind === "pool" ? (
          <p className="text-xs text-muted-foreground">
            {[
              invite.canUse ? t("access:shares.canUse") : null,
              invite.canContribute ? t("access:shares.canContribute") : null,
              t("access:shares.priorityValue", {
                priority: priorityLabel(t, invite.priorityClass),
              }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {invite.emailSentAt ? t("access:shares.emailSent") : t("access:shares.notEmailed")}
          {" · "}
          {t("access:shares.expires")} <TimeAgo value={invite.expiresAt} />
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={resend.isPending}
          onClick={() => resend.mutate({ inviteId: invite.id })}
        >
          {t("access:shares.resend")}
        </Button>
        <Button type="button" variant="ghost" size="touch" onClick={() => setWithdrawOpen(true)}>
          {t("access:shares.withdraw")}
        </Button>
      </div>
      <ConfirmAction
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        title={t("access:shares.withdrawTitle", { email: invite.email })}
        description={t("access:shares.withdrawDescription")}
        confirmLabel={t("access:shares.withdraw")}
        isPending={withdraw.isPending}
        onConfirm={() => withdraw.mutate({ inviteId: invite.id })}
      />
    </div>
  );
}

/** The invite link of an invite no e-mail went out for, shown once. */
export function InviteLinkDialog({
  value,
  onClose,
}: {
  value: InviteLink | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(["access"]);
  return (
    <ResponsiveDialog
      open={value !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={t("access:shares.inviteLinkTitle")}
    >
      {value ? (
        <SecretReveal
          value={value.link}
          title={t("access:shares.inviteLinkTitle")}
          description={t("access:shares.inviteLinkDescription", {
            email: value.email,
            date: new Date(value.expiresAt).toLocaleDateString(i18n.language, {
              dateStyle: "medium",
            }),
          })}
          copyLabel={t("access:shares.copyInviteLink")}
          onDone={onClose}
        />
      ) : null}
    </ResponsiveDialog>
  );
}

export function PermissionCheckbox({
  id,
  label,
  hint,
  checked,
  onChange,
  error,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  error: string | null;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={checked}
          onCheckedChange={(next) => onChange(next === true)}
        />
        <span className="min-w-0 space-y-0.5">
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      </label>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
