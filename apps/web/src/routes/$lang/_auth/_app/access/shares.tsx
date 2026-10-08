import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import { OwnKeyChoice } from "@/components/access/own-key-choice";
import { SecretReveal } from "@/components/access/secret-reveal";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/shares")({
  component: AccessSharesPage,
});

type PriorityClass = "BACKGROUND" | "NORMAL" | "HIGH";
type ShareView = {
  id: string;
  poolId: string;
  callableId: string;
  ownerEmail: string;
  granteeEmail: string;
  canUse: boolean;
  canContribute: boolean;
  priorityClass: PriorityClass | null;
  monthlyCap: { limit: string; currency: string; spentThisMonth: string } | null;
  contributedMembers: number;
  createdAt: string;
};
type InviteView = {
  id: string;
  target:
    | { kind: "pool"; poolId: string; callableId: string }
    | { kind: "runtime"; runtimeId: string; name: string };
  email: string;
  canUse: boolean;
  canContribute: boolean;
  expiresAt: string;
  emailSentAt: string | null;
};
type InviteLink = { email: string; link: string; expiresAt: string };

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
          <Section title={t("access:shares.byMeTitle")}>
            {shares.data.byMe.length === 0 ? (
              <Empty text={t("access:shares.byMeEmpty")} />
            ) : (
              shares.data.byMe.map((share) => <ShareByMeRow key={share.id} share={share} />)
            )}
          </Section>
          <RuntimeSharesByMe />
          <Section title={t("access:shares.invitesTitle")}>
            {shares.data.invites.length === 0 ? (
              <Empty text={t("access:shares.invitesEmpty")} />
            ) : (
              shares.data.invites.map((invite) => (
                <InviteRow key={invite.id} invite={invite} onLink={setInviteLink} />
              ))
            )}
          </Section>
          <Section title={t("access:shares.withMeTitle")}>
            {shares.data.withMe.length === 0 ? (
              <Empty text={t("access:shares.withMeEmpty")} />
            ) : (
              shares.data.withMe.map((share) => <ShareWithMeRow key={share.id} share={share} />)
            )}
          </Section>
        </>
      )}
      <CreateShareDialog open={createOpen} onOpenChange={setCreateOpen} onLink={setInviteLink} />
      <InviteLinkDialog value={inviteLink} onClose={() => setInviteLink(null)} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">{children}</CardContent>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function useInvalidateShares() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.access.shares.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.shares.list.key() }),
      // A runtime's page lists its shares too.
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.get.key() }),
    ]);
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
    <Section title={t("access:shares.runtimesByMeTitle")}>
      {shares.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : shares.isError ? (
        <InlineRetry message={t("access:shares.loadFailed")} onRetry={() => shares.refetch()} />
      ) : shares.data.sharedByMe.length === 0 ? (
        <Empty text={t("access:shares.runtimesByMeEmpty")} />
      ) : (
        shares.data.sharedByMe.map((share) => (
          <RuntimeShareRow
            key={share.id}
            share={share}
            name={names.get(share.runtimeId) ?? share.runtimeId}
          />
        ))
      )}
    </Section>
  );
}

function RuntimeShareRow({
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

function Permissions({ share }: { share: ShareView }) {
  const { t } = useTranslation(["access"]);
  return (
    <p className="text-xs text-muted-foreground">
      {[
        share.canUse ? t("access:shares.canUse") : null,
        share.canContribute ? t("access:shares.canContribute") : null,
        share.contributedMembers > 0
          ? t("access:shares.contributed", { count: share.contributedMembers })
          : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

function CapLine({ share }: { share: ShareView }) {
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

function ShareByMeRow({ share }: { share: ShareView }) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [contributeOffOpen, setContributeOffOpen] = useState(false);
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
          <p className="truncate font-mono text-xs text-muted-foreground">{share.callableId}</p>
          {share.contributedMembers > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("access:shares.contributed", { count: share.contributedMembers })}
            </p>
          ) : null}
          <CapLine share={share} />
        </div>
        <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
          {t("access:shares.remove")}
        </Button>
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
    </div>
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
        <Permissions share={share} />
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

function InviteRow({ invite, onLink }: { invite: InviteView; onLink: (link: InviteLink) => void }) {
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
  const withdraw = useMutation(
    orpc.access.invites.revoke.mutationOptions({
      onSuccess: async () => {
        setWithdrawOpen(false);
        toast.success(t("access:shares.withdrawn"));
        await invalidate();
      },
    }),
  );
  return (
    <div className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-medium">{invite.email}</p>
        <TargetLine target={invite.target} />
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

function InviteLinkDialog({ value, onClose }: { value: InviteLink | null; onClose: () => void }) {
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

const PRIORITY_CHOICES = ["POOL", "BACKGROUND", "NORMAL", "HIGH"] as const;
type PriorityChoice = (typeof PRIORITY_CHOICES)[number];
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

function CreateShareDialog({
  open,
  onOpenChange,
  onLink,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLink: (link: InviteLink) => void;
}) {
  const { t } = useTranslation(["access"]);
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("access:shares.createTitle")}
      description={t("access:shares.createDescription")}
    >
      {open ? (
        <CreateShareForm
          onDone={(link) => {
            onOpenChange(false);
            if (link) onLink(link);
          }}
        />
      ) : null}
    </ResponsiveDialog>
  );
}

function CreateShareForm({ onDone }: { onDone: (link: InviteLink | null) => void }) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const pools = useQuery(orpc.pools.list.queryOptions());
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const createPoolShare = useMutation(orpc.access.shares.create.mutationOptions());
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
    onSubmit: async ({ value }) => {
      const email = value.email.trim().toLowerCase();
      // A failure is toasted by the global mutation error handler. Both answer alike: a share
      // (a proved mailbox) or an invite, whose link is shown once when no e-mail went out.
      const result = await (value.what === "runtime"
        ? createRuntimeShare.mutateAsync({ runtimeId: value.runtimeId, email })
        : createPoolShare.mutateAsync({
            poolId: value.poolId,
            email,
            canUse: value.canUse,
            canContribute: value.canContribute,
            priorityClass: value.priority === "POOL" ? null : value.priority,
            protectionPercent: null,
            monthlyCap: null,
          })
      ).catch(() => null);
      if (!result) return;
      await invalidate();
      if (result.kind === "share") {
        toast.success(t("access:shares.shared", { email }));
        onDone(null);
      } else if (result.link) {
        onDone({ email, link: result.link, expiresAt: result.invite.expiresAt });
      } else {
        toast.success(t("access:shares.invited", { email }));
        onDone(null);
      }
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
                <fieldset className="min-w-0 space-y-1">
                  <legend className="mb-1 text-sm font-medium">{t("access:shares.runtime")}</legend>
                  {runtimes.isPending ? (
                    <Skeleton className="h-11 w-full" />
                  ) : runtimes.isError ? (
                    <p className="text-sm text-muted-foreground">
                      {t("access:shares.runtimesLoadFailed")}
                    </p>
                  ) : ownRuntimes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("access:shares.noOwnRuntimes")}
                    </p>
                  ) : (
                    <div className="flex min-w-0 flex-col">
                      {ownRuntimes.map((runtime) => (
                        <label
                          key={runtime.id}
                          className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted"
                        >
                          <input
                            type="radio"
                            name="share-runtime"
                            className="size-4 shrink-0 accent-primary"
                            checked={field.state.value === runtime.id}
                            onChange={() => field.handleChange(runtime.id)}
                          />
                          <span className="min-w-0 truncate text-sm">{runtime.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {field.state.meta.errors.length > 0 ? (
                    <p className="text-sm text-destructive">{t("access:shares.chooseRuntime")}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">{t("access:shares.runtimeHint")}</p>
                </fieldset>
              )}
            </form.Field>
          ) : (
            <form.Field name="poolId">
              {(field) => (
                <fieldset className="min-w-0 space-y-1">
                  <legend className="mb-1 text-sm font-medium">{t("access:shares.pool")}</legend>
                  {pools.isPending ? (
                    <Skeleton className="h-11 w-full" />
                  ) : pools.isError ? (
                    <p className="text-sm text-muted-foreground">
                      {t("access:shares.poolsLoadFailed")}
                    </p>
                  ) : ownPools.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("access:shares.noOwnPools")}</p>
                  ) : (
                    <div className="flex min-w-0 flex-col">
                      {ownPools.map((pool) => (
                        <label
                          key={pool.id}
                          className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted"
                        >
                          <input
                            type="radio"
                            name="share-pool"
                            className="size-4 shrink-0 accent-primary"
                            checked={field.state.value === pool.id}
                            onChange={() => field.handleChange(pool.id)}
                          />
                          <span className="truncate font-mono text-sm">
                            {pool.callableIds[0] ?? pool.slug}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {field.state.meta.errors.length > 0 ? (
                    <p className="text-sm text-destructive">{t("access:shares.choosePool")}</p>
                  ) : null}
                </fieldset>
              )}
            </form.Field>
          )
        }
      </form.Subscribe>
      <form.Field name="email">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("access:shares.email")}</Label>
            <Input
              id={field.name}
              type="email"
              inputMode="email"
              autoComplete="off"
              className="min-h-11"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.what}>
        {(what) =>
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
              <form.Field name="priority">
                {(field) => (
                  <div className="min-w-0 space-y-2">
                    <Label>{t("access:shares.priority")}</Label>
                    <SegmentedControl
                      value={field.state.value}
                      onChange={field.handleChange}
                      ariaLabel={t("access:shares.priority")}
                      items={[
                        { value: "POOL", label: t("access:shares.priorityPool") },
                        { value: "BACKGROUND", label: t("access:shares.priorityBackground") },
                        { value: "NORMAL", label: t("access:shares.priorityNormal") },
                        { value: "HIGH", label: t("access:shares.priorityHigh") },
                      ]}
                    />
                  </div>
                )}
              </form.Field>
            </>
          ) : null
        }
      </form.Subscribe>
      <form.Subscribe selector={(state) => [state.isSubmitting, state.values.what] as const}>
        {([isSubmitting, what]) => (
          <Button
            type="submit"
            size="touch"
            disabled={
              isSubmitting ||
              (what === "runtime" ? ownRuntimes.length === 0 : ownPools.length === 0)
            }
          >
            {isSubmitting ? t("access:shares.sharing") : t("access:shares.create")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

function PermissionCheckbox({
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
