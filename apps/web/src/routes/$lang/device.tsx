import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { env } from "@ws-model-proxy/env/web";
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
  DeviceLoginRequestDetails,
  DeviceLoginRequestSkeleton,
} from "@/components/device-login-request";
import { authClient } from "@/lib/auth-client";
import { decideDeviceRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

// OAuth 2.0 Device Authorization Grant verification page (RFC 8628 §3.3).
// CLI clients link an admin here with `?user_code=…`. The signed-in admin
// approves or denies the request — never silently. Unauthenticated visitors
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

type Decision = "approved" | "denied" | null;

async function claimDeviceCode(userCode: string, fallbackMessage: string) {
  const params = new URLSearchParams({ user_code: userCode });
  const response = await fetch(`${env.VITE_SERVER_URL}/api/auth/device?${params.toString()}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (response.ok) return;

  let message: string | undefined;
  try {
    const body = (await response.json()) as { error_description?: unknown; message?: unknown };
    message =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.message === "string"
          ? body.message
          : undefined;
  } catch {
    message = undefined;
  }
  throw new Error(message ?? fallbackMessage);
}

function DevicePage() {
  const { lang } = Route.useParams();
  const search = Route.useSearch();
  const userCode = search.user_code ?? "";
  const [decision, setDecision] = useState<Decision>(null);
  const queryClient = useQueryClient();
  const { t } = useTranslation("auth");

  // Claim the code for this account (Better Auth `GET /device`), then read
  // what approving it authorizes. Approve stays disabled until that is shown.
  //
  // The claim happens on page load, not on Approve/Deny: the summary is
  // owner-scoped (`deviceLoginRequest` only answers the account that claimed
  // the code), so it cannot be shown before the claim. Better Auth binds a
  // pending code to the first signed-in account that opens this link; anyone
  // else who opens it later gets "not found". This page is for signed-in users
  // approving their own `wsmp login`, so the opener is expected to be the
  // approver; a link opened by the wrong account needs a fresh `wsmp login`.
  const claimQuery = useQuery({
    queryKey: ["device-login-claim", userCode],
    queryFn: async () => {
      await claimDeviceCode(userCode, t("device.request.loadError"));
      return true;
    },
    enabled: userCode.length > 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    meta: { skipGlobalErrorToast: true },
  });
  const requestQuery = useQuery({
    ...orpc.cliCredentials.deviceLoginRequest.queryOptions({ input: { userCode } }),
    enabled: claimQuery.isSuccess,
    retry: false,
    meta: { skipGlobalErrorToast: true },
  });
  const requestError = claimQuery.error ?? requestQuery.error;

  const approveMutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.device.approve({ userCode });
      if (result.error) {
        throw new Error(result.error.error_description ?? "Failed to approve");
      }
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.devices.key() });
      queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      setDecision("approved");
      toast.success(t("device.approveSuccess"));
    },
    onError: (err) => {
      console.error("[device.approve]", err);
      toast.error(friendly(err, t("device.approveError")));
    },
    meta: { skipGlobalErrorToast: true },
  });

  const denyMutation = useMutation({
    mutationFn: async () => {
      await claimDeviceCode(userCode, t("device.denyError"));
      const result = await authClient.device.deny({ userCode });
      if (result.error) {
        throw new Error(result.error.error_description ?? "Failed to deny");
      }
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.devices.key() });
      setDecision("denied");
      toast.success(t("device.denySuccess"));
    },
    onError: (err) => {
      console.error("[device.deny]", err);
      toast.error(friendly(err, t("device.denyError")));
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

  if (decision === "approved") {
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

  if (decision === "denied") {
    return (
      <DeviceShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldX className="size-5 text-destructive" /> {t("device.denied.title")}
          </CardTitle>
          <CardDescription>{t("device.denied.description")}</CardDescription>
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
        {requestQuery.data ? (
          <DeviceLoginRequestDetails request={requestQuery.data} />
        ) : requestError ? (
          <p role="alert" className="text-sm text-destructive">
            {friendly(requestError, t("device.request.loadError"))}
          </p>
        ) : (
          <DeviceLoginRequestSkeleton />
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            className="min-h-[44px]"
            onClick={() => approveMutation.mutate()}
            disabled={!requestQuery.data || approveMutation.isPending || denyMutation.isPending}
          >
            {approveMutation.isPending ? t("device.approving") : t("device.approve")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            onClick={() => denyMutation.mutate()}
            disabled={approveMutation.isPending || denyMutation.isPending}
          >
            {denyMutation.isPending ? t("device.denying") : t("device.deny")}
          </Button>
        </div>
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
