import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import {
  CapLine,
  type InviteLink,
  InviteLinkDialog,
  InviteRow,
  PermissionCheckbox,
  Permissions,
  PRIORITY_CHOICES,
  type PriorityChoice,
  priorityItems,
  SettingsLine,
  ShareByMeRow,
  ShareEmpty,
  ShareSection,
  useCreatePoolShare,
} from "@/components/access/pool-shares";
import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import type { PoolMemberView, PoolView } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { isNotFound } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/sharing")({
  component: PoolSharingPage,
});

function PoolSharingPage() {
  const { t } = useTranslation(["dashboard"]);
  const { poolId } = Route.useParams();
  // Only the owner gets the pool: anyone else gets not found, and sees their own grant.
  // The page shows its own error states (not found is expected for anyone but the owner).
  const pool = useQuery({
    ...orpc.pools.get.queryOptions({ input: { poolId } }),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeading page="poolSharing" />
      {pool.isPending ? (
        <SharingSkeleton />
      ) : pool.isError ? (
        isNotFound(pool.error) ? (
          <YourGrant poolId={poolId} />
        ) : (
          <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pool.refetch()} />
        )
      ) : pool.data.owner.you ? (
        <OwnerSharing pool={pool.data} />
      ) : (
        <YourGrant poolId={poolId} />
      )}
    </div>
  );
}

function SharingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

function OwnerSharing({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["access", "dashboard"]);
  const shares = useQuery(orpc.access.shares.list.queryOptions());
  const [inviteLink, setInviteLink] = useState<InviteLink | null>(null);
  const byMe = shares.data?.byMe.filter((share) => share.poolId === pool.id) ?? [];
  const invites =
    shares.data?.invites.filter(
      (invite) => invite.target.kind === "pool" && invite.target.poolId === pool.id,
    ) ?? [];
  return (
    <>
      <ShareThisPool poolId={pool.id} onLink={setInviteLink} />
      {shares.isPending ? (
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : shares.isError ? (
        <InlineRetry message={t("access:shares.loadFailed")} onRetry={() => shares.refetch()} />
      ) : (
        <>
          <ShareSection title={t("dashboard:pool.sharing.sharesTitle")}>
            {byMe.length === 0 ? (
              <ShareEmpty text={t("dashboard:pool.sharing.sharesEmpty")} />
            ) : (
              byMe.map((share) => <ShareByMeRow key={share.id} share={share} showPool={false} />)
            )}
          </ShareSection>
          <ShareSection title={t("access:shares.invitesTitle")}>
            {invites.length === 0 ? (
              <ShareEmpty text={t("access:shares.invitesEmpty")} />
            ) : (
              invites.map((invite) => (
                <InviteRow
                  key={invite.id}
                  invite={invite}
                  onLink={setInviteLink}
                  showTarget={false}
                />
              ))
            )}
          </ShareSection>
        </>
      )}
      <ContributedMembers pool={pool} />
      <InviteLinkDialog value={inviteLink} onClose={() => setInviteLink(null)} />
    </>
  );
}

const shareSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    canUse: z.boolean(),
    canContribute: z.boolean(),
    priority: z.enum(PRIORITY_CHOICES),
  })
  .superRefine((value, ctx) => {
    if (!value.canUse && !value.canContribute)
      ctx.addIssue({ code: "custom", path: ["canUse"], message: "" });
  });

/** E-mail and permissions; a monthly cap and warm protection are edited on the share. */
function ShareThisPool({ poolId, onLink }: { poolId: string; onLink: (link: InviteLink) => void }) {
  const { t } = useTranslation(["access", "dashboard"]);
  const create = useCreatePoolShare(onLink);
  const form = useForm({
    defaultValues: {
      email: "",
      canUse: true,
      canContribute: false,
      priority: "POOL" as PriorityChoice,
    },
    validators: { onSubmit: shareSchema },
    onSubmit: async ({ value, formApi }) => {
      const shared = await create.submit({
        poolId,
        email: value.email.trim().toLowerCase(),
        canUse: value.canUse,
        canContribute: value.canContribute,
        priorityClass: value.priority === "POOL" ? null : value.priority,
        protectionPercent: null,
        monthlyCap: null,
      });
      if (shared) formApi.reset();
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.sharing.shareTitle")}</CardTitle>
        <CardDescription>{t("access:shares.createDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="email">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="pool-share-email">{t("access:shares.email")}</Label>
                <Input
                  id="pool-share-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  className="h-11"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={field.state.meta.errors.length > 0}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Field name="canUse">
            {(field) => (
              <PermissionCheckbox
                id="pool-share-can-use"
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
                id="pool-share-can-contribute"
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
                  items={priorityItems(t)}
                />
              </div>
            )}
          </form.Field>
          <p className="text-xs text-muted-foreground">{t("dashboard:pool.sharing.laterHint")}</p>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" size="touch" className="self-start" disabled={isSubmitting}>
                {isSubmitting ? t("access:shares.sharing") : t("dashboard:pool.sharing.share")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}

type Contributor = { shareId: string; email: string | null; members: PoolMemberView[] };

/** Contributed members grouped by the person who contributed them. */
function contributorsOf(members: readonly PoolMemberView[]): Contributor[] {
  const byShare = new Map<string, Contributor>();
  for (const member of members) {
    if (!member.shareId) continue;
    const contributor = byShare.get(member.shareId) ?? {
      shareId: member.shareId,
      email: member.contributorEmail,
      members: [],
    };
    contributor.members.push(member);
    byShare.set(member.shareId, contributor);
  }
  return [...byShare.values()].sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
}

function ContributedMembers({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard"]);
  const contributors = contributorsOf(pool.members);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.sharing.contributedTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <div
          role="note"
          className="flex min-w-0 gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0">{t("dashboard:pool.sharing.othersHardware")}</p>
        </div>
        {pool.routing.ownHardwareOnly ? (
          <p className="text-sm text-muted-foreground">
            {t("dashboard:pool.sharing.ownHardwareOnly")}
          </p>
        ) : null}
        {contributors.length === 0 ? (
          <ShareEmpty text={t("dashboard:pool.sharing.contributedEmpty")} />
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {contributors.map((contributor) => (
              <li key={contributor.shareId} className="min-w-0 py-3 first:pt-0 last:pb-0">
                <p className="truncate font-medium">
                  {contributor.email ?? t("dashboard:pool.sharing.unknownPerson")}
                </p>
                <ul className="mt-1 flex min-w-0 flex-col">
                  {contributor.members.map((member) => (
                    <ContributedMemberRow
                      key={member.id}
                      member={member}
                      email={contributor.email ?? t("dashboard:pool.sharing.unknownPerson")}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ContributedMemberRow({ member, email }: { member: PoolMemberView; email: string }) {
  const { t } = useTranslation(["dashboard", "access"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.pools.key() }),
      // The share's contributed count.
      queryClient.invalidateQueries({ queryKey: orpc.access.shares.list.key() }),
    ]);
  const remove = useMutation({
    ...orpc.pools.members.removeContributed.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("dashboard:pool.memberRemoved"));
        await refresh();
      },
      onError: async (error) => {
        toast.error(refusalText(error));
        // Withdrawn by its contributor meanwhile: drop the stale row.
        if (isNotFound(error)) {
          setConfirmOpen(false);
          await refresh();
        }
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <li className="flex min-w-0 items-center justify-between gap-2">
      <span className="min-w-0 break-all font-mono text-sm">{member.upstreamModelId}</span>
      <Button type="button" variant="ghost" size="touch" onClick={() => setConfirmOpen(true)}>
        {t("access:shares.remove")}
      </Button>
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("dashboard:pool.sharing.removeContributedTitle", {
          model: member.upstreamModelId,
          email,
        })}
        description={t("dashboard:pool.sharing.removeContributedDescription")}
        confirmLabel={t("access:shares.remove")}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ memberId: member.id })}
      />
    </li>
  );
}

/** A share holder's own grant on someone else's pool (read-only), or nothing. */
function YourGrant({ poolId }: { poolId: string }) {
  const { t } = useTranslation(["access", "dashboard"]);
  const shares = useQuery(orpc.access.shares.list.queryOptions());
  if (shares.isPending) return <Skeleton className="h-32 w-full rounded-xl" aria-hidden="true" />;
  if (shares.isError)
    return <InlineRetry message={t("access:shares.loadFailed")} onRetry={() => shares.refetch()} />;
  const grant = shares.data.withMe.find((share) => share.poolId === poolId);
  if (!grant)
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground">
          {t("dashboard:pool.sharing.notYours")}
        </CardContent>
      </Card>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.sharing.yourGrantTitle")}</CardTitle>
        <CardDescription>{t("access:shares.from", { email: grant.ownerEmail })}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-1">
        <p className="truncate font-mono text-sm">{grant.callableId}</p>
        <Permissions grant={grant} />
        <SettingsLine share={grant} />
        <CapLine share={grant} />
        <p className="pt-2 text-xs text-muted-foreground">
          {t("dashboard:pool.sharing.yourGrantHint")}
        </p>
      </CardContent>
    </Card>
  );
}
