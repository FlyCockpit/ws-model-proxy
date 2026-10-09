import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { AccountDetailsCard } from "@/components/providers/account-details-card";
import { ModelsCard } from "@/components/providers/models-card";
import {
  type ProviderAccountDetail,
  useProviderAction,
  useProviderInvalidation,
} from "@/components/providers/provider-action";
import { ProviderActivity } from "@/components/providers/provider-activity";
import { StatusPill } from "@/components/status-pill";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/providers/$accountId")({
  component: ProviderDetailPage,
});

type Account = ProviderAccountDetail;
const MONEY = /^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/;

function ProviderDetailPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { accountId } = Route.useParams();
  const account = useQuery(orpc.providers.accounts.get.queryOptions({ input: { accountId } }));
  if (account.isPending)
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  if (account.isError)
    return (
      <InlineRetry
        message={t("dashboard:providers.loadFailed")}
        onRetry={() => account.refetch()}
      />
    );
  return <ProviderDetail account={account.data} />;
}

function ProviderDetail({ account }: { account: Account }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const setEnabled = useMutation({
    ...orpc.providers.accounts.setEnabled.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const setCollection = useMutation({
    ...orpc.providers.accounts.setDataCollection.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-2xl font-semibold">
          <span className="break-all">{account.label}</span>
          <StatusPill tone="info">{t(`dashboard:providers.health.${account.health}`)}</StatusPill>
        </h1>
        <p className="break-all text-sm text-muted-foreground">{account.baseUrl}</p>
        <p className="text-sm text-muted-foreground">{t("dashboard:providers.humanOnly")}</p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="flex min-h-11 items-center gap-3">
            <Switch
              id="account-enabled"
              checked={account.enabled}
              disabled={setEnabled.isPending}
              onCheckedChange={(checked) =>
                action(() =>
                  setEnabled.mutateAsync({ accountId: account.id, enabled: checked === true }),
                )
              }
            />
            <Label htmlFor="account-enabled">{t("dashboard:providers.enabled")}</Label>
          </div>
          {account.providerType === "openrouter" ? (
            <div className="flex min-h-11 items-center gap-3">
              <Switch
                id="account-collection"
                checked={account.allowDataCollection}
                disabled={setCollection.isPending}
                onCheckedChange={(checked) =>
                  action(() =>
                    setCollection.mutateAsync({ accountId: account.id, allow: checked === true }),
                  )
                }
              />
              <Label htmlFor="account-collection">
                {t("dashboard:providers.form.dataCollection")}
              </Label>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <AccountDetailsCard key={`${account.label}|${account.baseUrl}`} account={account} />
      <KeyCard account={account} />
      <CapCard account={account} />
      <ModelsCard account={account} />
      <ProviderActivity account={account} />
      <DeleteAccount account={account} />
    </div>
  );
}

function KeyCard({ account }: { account: Account }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const [secret, setSecret] = useState("");
  const [probe, setProbe] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const replace = useMutation({
    ...orpc.providers.credentials.replace.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const revoke = useMutation({
    ...orpc.providers.credentials.revoke.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const test = useMutation({
    ...orpc.providers.credentials.test.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const credential = account.credential;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:providers.key")}</CardTitle>
        <CardDescription>
          {credential
            ? t("dashboard:providers.keyEnding", { suffix: credential.displaySuffix })
            : t("dashboard:providers.noKey")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {credential ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="touch"
              disabled={test.isPending}
              onClick={async () => {
                try {
                  const result = await test.mutateAsync({ accountId: account.id });
                  const code = result.ok ? "ok" : (result.detail ?? "unexpected_status");
                  setProbe(
                    t(`dashboard:providers.testResult.${code}`, {
                      defaultValue: t("dashboard:providers.testResult.unexpected_status"),
                    }),
                  );
                } catch (error) {
                  toast.error(refusalText(error));
                }
              }}
            >
              {t("dashboard:providers.test")}
            </Button>
            <Button
              variant="outline"
              size="touch"
              disabled={revoke.isPending}
              onClick={() => setConfirmRevoke(true)}
            >
              {t("dashboard:providers.revoke")}
            </Button>
          </div>
        ) : null}
        {credential ? (
          <ResponsiveDialog
            open={confirmRevoke}
            onOpenChange={setConfirmRevoke}
            title={t("dashboard:providers.revokeTitle")}
            description={t("dashboard:providers.revokeHint")}
            footer={
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" size="touch" onClick={() => setConfirmRevoke(false)}>
                  {t("common:actions.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  size="touch"
                  disabled={revoke.isPending}
                  onClick={async () => {
                    if (await action(() => revoke.mutateAsync({ credentialId: credential.id }))) {
                      setConfirmRevoke(false);
                      setProbe(null);
                    }
                  }}
                >
                  {t("dashboard:providers.revoke")}
                </Button>
              </div>
            }
          >
            <span />
          </ResponsiveDialog>
        ) : null}
        {probe ? (
          <p className="text-sm" role="status">
            {probe}
          </p>
        ) : null}
        <form
          className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!secret) return;
            const ok = await action(() => replace.mutateAsync({ accountId: account.id, secret }));
            if (ok) {
              setSecret("");
              setProbe(null);
            }
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="replace-key">{t("dashboard:providers.replaceKey")}</Label>
            <Input
              id="replace-key"
              type="password"
              autoComplete="off"
              className="h-11 font-mono"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </div>
          <Button type="submit" size="touch" disabled={!secret || replace.isPending}>
            {t("common:actions.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CapCard({ account }: { account: Account }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const action = useProviderAction();
  const [limit, setLimit] = useState(account.spend.monthlyLimit ?? "");
  const set = useMutation({
    ...orpc.providers.spendCaps.set.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const clear = useMutation({
    ...orpc.providers.spendCaps.clear.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const valid = MONEY.test(limit.trim());
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:providers.cap")}</CardTitle>
        <CardDescription>
          {t("dashboard:providers.capSpend", {
            spent: account.spend.spentThisMonth,
            reserved: account.spend.reservedNow,
            currency: account.spend.currency,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid)
              action(() => set.mutateAsync({ accountId: account.id, monthlyLimit: limit.trim() }));
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="cap-limit">
              {t("dashboard:providers.capLimit", { currency: account.spend.currency })}
            </Label>
            <Input
              id="cap-limit"
              inputMode="decimal"
              className="h-11"
              placeholder={t("dashboard:providers.noCap")}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
            {limit.trim() !== "" && !valid ? (
              <p className="text-sm text-destructive">{t("dashboard:providers.capInvalid")}</p>
            ) : null}
          </div>
          <Button type="submit" size="touch" disabled={!valid || set.isPending}>
            {t("dashboard:providers.setCap")}
          </Button>
          {account.spend.monthlyLimit !== null ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              disabled={clear.isPending}
              onClick={async () => {
                if (await action(() => clear.mutateAsync({ accountId: account.id }))) setLimit("");
              }}
            >
              {t("dashboard:providers.clearCap")}
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function DeleteAccount({ account }: { account: Account }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const invalidate = useProviderInvalidation();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    ...orpc.providers.accounts.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <>
      <div>
        <Button variant="destructive" size="touch" onClick={() => setOpen(true)}>
          {t("dashboard:providers.delete")}
        </Button>
      </div>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dashboard:providers.deleteTitle", { name: account.label })}
        description={t("dashboard:providers.deleteHint")}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" size="touch" onClick={() => setOpen(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="touch"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync({ accountId: account.id });
                  setOpen(false);
                  await navigate({ to: "/$lang/providers", params: { lang } });
                  await invalidate();
                } catch (error) {
                  toast.error(refusalText(error));
                }
              }}
            >
              {remove.isPending ? t("common:actions.deleting") : t("common:actions.delete")}
            </Button>
          </div>
        }
      >
        <span />
      </ResponsiveDialog>
    </>
  );
}
