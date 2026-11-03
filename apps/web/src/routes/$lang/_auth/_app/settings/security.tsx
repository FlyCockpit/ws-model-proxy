import { useQuery } from "@tanstack/react-query";
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
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { useGuardedMachine } from "@/hooks/use-guarded-machine";
import { useTotpEnrollment } from "@/hooks/use-totp-enrollment";
import { authClient } from "@/lib/auth-client";
import {
  type DisableTwoFactorEvent,
  type DisableTwoFactorState,
  disableTwoFactorTransition,
  initialDisableTwoFactorState,
} from "@/lib/two-factor-state";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/settings/security")({
  component: SecuritySettings,
});

function SecuritySettings() {
  const { session } = Route.useRouteContext();
  const has2FA = session.user.twoFactorEnabled === true;
  const passwordCapabilities = useQuery(orpc.auth.passwordCapabilities.queryOptions());
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {has2FA ? (
              <ShieldCheck className="size-5 text-green-500" />
            ) : (
              <ShieldOff className="size-5 text-muted-foreground" />
            )}
            {t("security.twoFactorTitle")}
          </CardTitle>
          <CardDescription>
            {has2FA ? t("security.enabledDescription") : t("security.disabledDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>{has2FA ? <Disable2FASection /> : <Enable2FASection />}</CardContent>
      </Card>
      {passwordCapabilities.data?.canChangePassword && <ChangePasswordCard />}
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation(["settings", "auth", "common"]);

  const canSubmit =
    currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  const handleChangePassword = async () => {
    if (!canSubmit) return;
    setIsLoading(true);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        console.error("[settings.security.changePassword]", result.error);
        toast.error(t("settings:security.changePasswordError"));
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success(t("settings:security.changePasswordSuccess"));
    } catch (err) {
      console.error("[settings.security.changePassword]", err);
      toast.error(t("settings:security.changePasswordError"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings:security.changePasswordTitle")}</CardTitle>
        <CardDescription>{t("settings:security.changePasswordDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="max-w-sm space-y-4">
        <div className="space-y-2">
          <Label htmlFor="current-password">{t("auth:fields.password")}</Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password">{t("settings:security.newPassword")}</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-new-password">{t("settings:security.confirmNewPassword")}</Label>
          <Input
            id="confirm-new-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleChangePassword();
            }}
          />
        </div>
        <Button
          className="min-h-[44px]"
          onClick={handleChangePassword}
          disabled={!canSubmit || isLoading}
        >
          {isLoading
            ? t("settings:security.changingPassword")
            : t("settings:security.changePassword")}
        </Button>
      </CardContent>
    </Card>
  );
}

function Enable2FASection() {
  const { t } = useTranslation(["settings", "auth", "common"]);
  const enrollment = useTotpEnrollment({
    messages: {
      couldNotStartSetup: t("settings:security.couldNotStartSetup"),
      invalidCode: t("auth:errors.invalidTotp"),
      enabled: t("settings:security.enabledSuccess"),
    },
    logPrefix: "settings.security.twoFactor",
    confirmBackupCodes: true,
    onVerified: () => window.location.reload(),
  });
  const { state } = enrollment;

  if (state.kind === "idle") {
    return (
      <Button className="min-h-[44px]" onClick={() => enrollment.start()}>
        {t("settings:security.enable2FA")}
      </Button>
    );
  }

  if (state.kind === "password") {
    const isEnabling = state.activity.kind === "enabling";
    return (
      <div className="space-y-4 max-w-sm">
        <p className="text-sm text-muted-foreground">
          {t("settings:security.confirmPasswordPrompt")}
        </p>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">{t("auth:fields.password")}</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="current-password"
            value={state.password}
            onChange={(e) => enrollment.setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") enrollment.enable();
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button
            className="min-h-[44px]"
            onClick={() => enrollment.enable()}
            disabled={!state.password || isEnabling}
          >
            {isEnabling ? t("auth:twoFactor.settingUp") : t("auth:twoFactor.continue")}
          </Button>
          <Button className="min-h-[44px]" variant="ghost" onClick={() => enrollment.cancel()}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === "setup") {
    return (
      <div className="space-y-4 max-w-sm">
        <TwoFactorSetupDetails
          backupCodes={state.backupCodes}
          backupCodesLabel={t("settings:security.saveBackupCodes")}
          manualPrompt={t("settings:security.addKeyToApp")}
          qrPrompt={t("settings:security.scanQrPrompt")}
          totpURI={state.totpURI}
        />

        <Button className="min-h-[44px]" onClick={() => enrollment.saveBackupCodes()}>
          {t("settings:security.savedBackupCodes")}
        </Button>
      </div>
    );
  }

  const isVerifying = state.activity.kind !== "idle";
  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.verifyPrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="setup-verify-code">{t("auth:fields.verificationCode")}</Label>
        <Input
          id="setup-verify-code"
          placeholder="000000"
          value={state.code}
          onChange={(e) => enrollment.setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="text-center text-lg tracking-widest"
          onKeyDown={(e) => {
            if (e.key === "Enter") enrollment.verify();
          }}
        />
      </div>
      <Button
        className="min-h-[44px]"
        onClick={() => enrollment.verify()}
        disabled={state.code.length !== 6 || isVerifying}
      >
        {isVerifying ? t("auth:twoFactor.verifying") : t("settings:security.verifyAndEnable")}
      </Button>
    </div>
  );
}

function Disable2FASection() {
  const { state, send, nextAttempt, current } = useGuardedMachine<
    DisableTwoFactorState,
    DisableTwoFactorEvent
  >(initialDisableTwoFactorState, disableTwoFactorTransition);
  const { t } = useTranslation(["settings", "auth", "common"]);

  const handleDisable = async () => {
    const before = current();
    if (before.kind !== "confirm") return;
    const attempt = nextAttempt();
    // Rejected while a disable is in flight or the password is empty.
    if (!send({ type: "disableStarted", attempt })) return;
    const fail = () => {
      if (send({ type: "disableFailed", attempt })) {
        toast.error(t("settings:security.couldNotDisable"));
      }
    };
    try {
      const result = await authClient.twoFactor.disable({
        password: before.password,
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.disable]", result.error);
        fail();
        return;
      }
      send({ type: "disableSucceeded", attempt });
      toast.success(t("settings:security.disabledSuccess"));
      window.location.reload();
    } catch (err) {
      console.error("[settings.security.twoFactor.disable]", err);
      fail();
    }
  };

  if (state.kind === "closed") {
    return (
      <Button className="min-h-[44px]" variant="outline" onClick={() => send({ type: "open" })}>
        {t("settings:security.disable2FA")}
      </Button>
    );
  }

  const isBusy = state.activity.kind !== "idle";
  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.disablePrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="disable-password">{t("auth:fields.password")}</Label>
        <Input
          id="disable-password"
          type="password"
          autoComplete="current-password"
          value={state.password}
          onChange={(e) => send({ type: "passwordChanged", password: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleDisable();
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button
          className="min-h-[44px]"
          variant="destructive"
          onClick={handleDisable}
          disabled={!state.password || isBusy}
        >
          {isBusy ? t("settings:security.disabling") : t("settings:security.disable")}
        </Button>
        <Button
          className="min-h-[44px]"
          variant="ghost"
          onClick={() => send({ type: "cancel" })}
          disabled={isBusy}
        >
          {t("common:actions.cancel")}
        </Button>
      </div>
    </div>
  );
}
