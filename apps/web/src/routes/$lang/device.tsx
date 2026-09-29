import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { deviceLoginRefusalReasonOf } from "@ws-model-proxy/config/cli-device-login";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  DeviceLoginRefusal,
  DeviceLoginRequestDetails,
  DeviceLoginRequestSkeleton,
} from "@/components/device-login-request";
import { decideDeviceRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

// OAuth 2.0 Device Authorization Grant verification page (RFC 8628 §3.3).
// `wsmp login` links the user here with `?user_code=…`. The signed-in user
// approves the request (never silently) or cancels, which writes nothing and
// leaves the request for another account. Unauthenticated visitors
// bounce through /login; non-admin users go to /dashboard rather than seeing
// any indication that an admin device-flow exists.
export const Route = createFileRoute("/$lang/device")({
  validateSearch: (search: Record<string, unknown>) => {
    const userCode = typeof search.user_code === "string" ? search.user_code : undefined;
    return { user_code: userCode };
  },
  beforeLoad: async ({ params }) => {
    const decision = decideDeviceRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      throw redirect({
        to: "/$lang/login",
        params: { lang: params.lang },
        search: { redirectTo: `/${params.lang}/device` },
      });
    }
    if (decision.kind === "redirect-to-dashboard") {
      throw redirect({ to: "/$lang/dashboard", params: { lang: params.lang } });
    }
    return { session: decision.session };
  },
  component: DevicePage,
});

type Decision = "approved" | "cancelled" | null;

function DevicePage() {
  const { lang } = Route.useParams();
  const search = Route.useSearch();
  const userCode = search.user_code ?? "";
  const [decision, setDecision] = useState<Decision>(null);
  const queryClient = useQueryClient();
  const { t } = useTranslation("auth");

  // Read what approving authorizes. The read claims nothing: a pending code
  // stays claimable until someone approves it, so opening the link while
  // signed in to the wrong account does not use it up. Approve stays disabled
  // until the request is shown.
  const requestQuery = useQuery({
    ...orpc.cliCredentials.deviceLoginRequest.queryOptions({ input: { userCode } }),
    enabled: userCode.length > 0,
    retry: false,
    refetchOnWindowFocus: false,
    meta: { skipGlobalErrorToast: true },
  });

  // Claims and approves in one server-side conditional write, for the CLI
  // slug shown on the page.
  const approveMutation = useMutation({
    ...orpc.cliCredentials.approveDeviceLogin.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.devices.key() });
      queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      setDecision("approved");
      toast.success(t("device.approveSuccess"));
    },
    onError: (err) => {
      console.error("[device.approve]", err);
      // A structured refusal is explained on the page (with the next step)
      // instead of a generic toast over a button that would only be refused
      // again. Anything else (network, server) stays retryable.
      if (deviceLoginRefusalReasonOf(err) === null) {
        toast.error(friendly(err, t("device.approveError")));
      }
    },
    meta: { skipGlobalErrorToast: true },
  });

  if (!userCode) {
    return (
      <DeviceShell>
        <CardHeader>
          <CardTitle>{t("device.enterCodeTitle")}</CardTitle>
          <CardDescription>
            <Trans i18nKey="device.enterCodeDescription" t={t} components={[<code key="0" />]} />
          </CardDescription>
        </CardHeader>
      </DeviceShell>
    );
  }

  // A refusal from the read or from the approve; the latest approve wins.
  const refusal =
    deviceLoginRefusalReasonOf(approveMutation.error) ??
    deviceLoginRefusalReasonOf(requestQuery.error);
  const reload = () => {
    approveMutation.reset();
    void requestQuery.refetch();
  };

  // Already approved by this account (a second tab, or a retry after the
  // first approval landed): the same outcome as approving now.
  if (decision === "approved" || requestQuery.data?.status === "approved") {
    return (
      <DeviceShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-emerald-600" /> {t("device.approved.title")}
          </CardTitle>
          <CardDescription>{t("device.approved.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/$lang/admin/devices"
            params={{ lang }}
            className="inline-flex min-h-[44px] items-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {t("device.approved.viewActive")}
          </Link>
        </CardContent>
      </DeviceShell>
    );
  }

  if (decision === "cancelled") {
    return (
      <DeviceShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldX className="size-5 text-muted-foreground" /> {t("device.cancelled.title")}
          </CardTitle>
          <CardDescription>{t("device.cancelled.description")}</CardDescription>
        </CardHeader>
      </DeviceShell>
    );
  }

  return (
    <DeviceShell>
      <CardHeader>
        <CardTitle>{t("device.approveTitle")}</CardTitle>
        <CardDescription>{t("device.approveDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
          {t("device.userCodeLabel")} <strong>{userCode}</strong>
        </div>
        {refusal ? (
          <DeviceLoginRefusal reason={refusal} onReload={reload} />
        ) : (
          <>
            {requestQuery.data ? (
              <DeviceLoginRequestDetails request={requestQuery.data} />
            ) : requestQuery.error ? null : (
              <DeviceLoginRequestSkeleton />
            )}
            {requestQuery.error ? (
              <p role="alert" className="text-sm text-destructive">
                {friendly(requestQuery.error, t("device.request.loadError"))}
              </p>
            ) : null}
          </>
        )}
        {refusal ? null : (
          <div className="flex gap-2">
            <Button
              type="button"
              className="min-h-[44px]"
              onClick={() => {
                if (requestQuery.data) {
                  approveMutation.mutate({ userCode, slug: requestQuery.data.slug });
                }
              }}
              disabled={!requestQuery.data || requestQuery.isFetching || approveMutation.isPending}
            >
              {approveMutation.isPending ? t("device.approving") : t("device.approve")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              onClick={() => setDecision("cancelled")}
              disabled={approveMutation.isPending}
            >
              {t("device.cancel")}
            </Button>
          </div>
        )}
      </CardContent>
    </DeviceShell>
  );
}

function DeviceShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="container mx-auto flex min-h-[80vh] max-w-md items-center px-4 py-8">
      <Card className="w-full">{children}</Card>
    </div>
  );
}
