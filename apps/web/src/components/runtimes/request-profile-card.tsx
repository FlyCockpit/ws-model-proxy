import { useMutation, useQueryClient } from "@tanstack/react-query";
import { COMPAT_ENDPOINT_PATHS } from "@ws-model-proxy/api/lib/request-compat";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "@/components/access/confirm-action";
import { TimeAgo } from "@/components/time-ago";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;
const K = "dashboard:runtime.compat.profile";

/** Read-only: what the current engine accepts, as described or learned, and a way to forget it. */
export function RequestProfileCard({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const update = useMutation({
    ...orpc.runtimes.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const profile = runtime.requestProfile;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t(`${K}.title`)}</CardTitle>
        <CardDescription>{t(`${K}.hint`)}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {profile === null ? (
          <p className="text-sm text-muted-foreground">{t(`${K}.none`)}</p>
        ) : (
          <>
            <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-3">
              <Fact label={t(`${K}.source`)}>{t(`${K}.sources.${profile.source}`)}</Fact>
              <Fact label={t(`${K}.engine`)}>
                <span className="break-all">{profile.engine ?? t(`${K}.engineUnknown`)}</span>
              </Fact>
              <Fact label={t(`${K}.probedAt`)}>
                <TimeAgo value={profile.probedAt} />
              </Fact>
            </dl>
            <CodeList
              label={t(`${K}.described`)}
              empty={t(`${K}.describedNone`)}
              items={profile.described.map((endpoint) => COMPAT_ENDPOINT_PATHS[endpoint])}
            />
            <CodeList
              label={t(`${K}.learned`)}
              empty={t(`${K}.learnedNone`)}
              items={profile.learned}
            />
            <CodeList
              label={t(`${K}.stripHeaders`)}
              empty={t(`${K}.stripHeadersNone`)}
              items={profile.stripHeaders}
            />
            <Button
              type="button"
              size="touch"
              variant="outline"
              className="self-start"
              onClick={() => setConfirming(true)}
            >
              {t(`${K}.forget`)}
            </Button>
          </>
        )}
      </CardContent>
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title={t(`${K}.forgetTitle`)}
        description={t(`${K}.forgetHint`)}
        confirmLabel={t(`${K}.forget`)}
        isPending={update.isPending}
        onConfirm={async () => {
          try {
            await update.mutateAsync({ runtimeId: runtime.id, relearn: true });
            await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
            toast.success(t(`${K}.forgotten`));
            setConfirming(false);
          } catch (error) {
            toast.error(refusalText(error));
          }
        }}
      />
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function CodeList({ label, empty, items }: { label: string; empty: string; items: string[] }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item} className="min-w-0 max-w-full">
              <code className="block break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {item}
              </code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
