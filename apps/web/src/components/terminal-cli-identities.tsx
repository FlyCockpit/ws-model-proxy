import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { CliTrust } from "@/lib/terminal-cli-identity";
import type { ListedCli } from "@/lib/terminal-protocol";

type Props = {
  clis: ListedCli[];
  trust: Record<string, CliTrust>;
  labelFor: (cliDeviceId: string) => string;
  onTrustNewKey: (cliDeviceId: string) => Promise<void>;
};

function Fingerprint({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <code className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">{value}</code>
    </p>
  );
}

function IdentityStatus({ trust, onTrust }: { trust: CliTrust | undefined; onTrust: () => void }) {
  const { t } = useTranslation(["dashboard"]);
  if (!trust) {
    return (
      <p className="text-xs text-muted-foreground">{t("dashboard:terminals.identity.checking")}</p>
    );
  }
  switch (trust.status) {
    case "trusted":
      return (
        <Fingerprint
          label={t("dashboard:terminals.identity.fingerprint")}
          value={trust.fingerprint}
        />
      );
    case "unpinned":
      return (
        <>
          <Fingerprint
            label={t("dashboard:terminals.identity.fingerprint")}
            value={trust.fingerprint}
          />
          <p className="text-xs text-muted-foreground">
            {t("dashboard:terminals.identity.unpinned")}
          </p>
        </>
      );
    case "unverified":
      return (
        <p className="text-xs text-muted-foreground">
          {t("dashboard:terminals.identity.unverified")}
        </p>
      );
    case "invalid":
      return (
        <p className="text-xs text-destructive">{t("dashboard:terminals.identity.invalid")}</p>
      );
    case "offline":
      return (
        <p className="text-xs text-muted-foreground">{t("dashboard:terminals.identity.offline")}</p>
      );
    case "changed":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs text-destructive">
            {trust.fingerprint
              ? t("dashboard:terminals.identity.changed")
              : t("dashboard:terminals.identity.downgraded")}
          </p>
          <Fingerprint
            label={t("dashboard:terminals.identity.pinned")}
            value={trust.pinnedFingerprint}
          />
          {trust.fingerprint ? (
            <Fingerprint label={t("dashboard:terminals.identity.new")} value={trust.fingerprint} />
          ) : null}
          <Button
            type="button"
            size="touch"
            variant="outline"
            className="mt-1 self-start"
            onClick={onTrust}
          >
            {trust.fingerprint
              ? t("dashboard:terminals.identity.trustNew")
              : t("dashboard:terminals.identity.allowUnverified")}
          </Button>
        </div>
      );
  }
}

function StatusIcon({ trust }: { trust: CliTrust | undefined }) {
  if (trust?.status === "trusted") {
    return <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  if (trust?.status === "changed" || trust?.status === "invalid") {
    return <ShieldAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
  }
  return <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** Each live CLI's identity fingerprint, and the "Trust new key" flow. */
export function TerminalCliIdentities({ clis, trust, labelFor, onTrustNewKey }: Props) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Offline CLIs have no key to show, unless a pinned key needs attention.
  const shown = clis.filter(
    (cli) => cli.publicKey !== null || trust[cli.cliDeviceId]?.status === "changed",
  );
  if (shown.length === 0) return null;
  const confirmTrust = confirmId ? trust[confirmId] : undefined;
  const downgrade = confirmTrust?.status === "changed" && confirmTrust.fingerprint === null;

  return (
    <section
      className="mb-3 min-w-0 rounded-md border p-3"
      aria-labelledby="terminal-cli-identities"
    >
      <h3 id="terminal-cli-identities" className="text-sm font-medium">
        {t("dashboard:terminals.identity.title")}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("dashboard:terminals.identity.description")}
      </p>
      <ul className="mt-2 flex min-w-0 flex-col gap-2">
        {shown.map((cli) => (
          <li key={cli.cliDeviceId} className="flex min-w-0 items-start gap-2">
            <StatusIcon trust={trust[cli.cliDeviceId]} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="truncate text-sm">{labelFor(cli.cliDeviceId)}</p>
              <IdentityStatus
                trust={trust[cli.cliDeviceId]}
                onTrust={() => setConfirmId(cli.cliDeviceId)}
              />
            </div>
          </li>
        ))}
      </ul>

      <AlertDialog
        open={confirmId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dashboard:terminals.identity.trustTitle", {
                label: confirmId ? labelFor(confirmId) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard:terminals.identity.trustDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 w-full sm:w-auto">
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-11 w-full sm:w-auto"
              onClick={() => {
                const target = confirmId;
                setConfirmId(null);
                if (!target) return;
                void onTrustNewKey(target).catch(() =>
                  toast.error(t("dashboard:terminals.identity.trustFailed")),
                );
              }}
            >
              {downgrade
                ? t("dashboard:terminals.identity.allowUnverified")
                : t("dashboard:terminals.identity.trustNew")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
