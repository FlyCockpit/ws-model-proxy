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
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/settings/security")({
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
  const [step, setStep] = useState<"idle" | "password" | "setup" | "verify">("idle");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verifyCode, setVerifyCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation(["settings", "auth", "common"]);

  const handleEnable = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.enable({
        password,
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.enable]", result.error);
        toast.error(t("settings:security.couldNotStartSetup"));
        return;
      }
      setTotpURI(result.data?.totpURI || "");
      setBackupCodes(result.data?.backupCodes || []);
      setStep("setup");
    } catch (err) {
      console.error("[settings.security.twoFactor.enable]", err);
      toast.error(t("settings:security.couldNotStartSetup"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: verifyCode,
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.verifyTotp]", result.error);
        toast.error(t("auth:errors.invalidTotp"));
        return;
      }
      toast.success(t("settings:security.enabledSuccess"));
      window.location.reload();
    } catch (err) {
      console.error("[settings.security.twoFactor.verifyTotp]", err);
      toast.error(t("auth:errors.invalidTotp"));
    } finally {
      setIsLoading(false);
    }
  };

  if (step === "idle") {
    return (
      <Button className="min-h-[44px]" onClick={() => setStep("password")}>
        {t("settings:security.enable2FA")}
      </Button>
    );
  }

  if (step === "password") {
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleEnable();
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button className="min-h-[44px]" onClick={handleEnable} disabled={!password || isLoading}>
            {isLoading ? t("auth:twoFactor.settingUp") : t("auth:twoFactor.continue")}
          </Button>
          <Button className="min-h-[44px]" variant="ghost" onClick={() => setStep("idle")}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "setup") {
    return (
      <div className="space-y-4 max-w-sm">
        <TwoFactorSetupDetails
          backupCodes={backupCodes}
          backupCodesLabel={t("settings:security.saveBackupCodes")}
          manualPrompt={t("settings:security.addKeyToApp")}
          qrPrompt={t("settings:security.scanQrPrompt")}
          totpURI={totpURI}
        />

        <Button className="min-h-[44px]" onClick={() => setStep("verify")}>
          {t("settings:security.savedBackupCodes")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.verifyPrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="setup-verify-code">{t("auth:fields.verificationCode")}</Label>
        <Input
          id="setup-verify-code"
          placeholder="000000"
          value={verifyCode}
          onChange={(e) => setVerifyCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="text-center text-lg tracking-widest"
          onKeyDown={(e) => {
            if (e.key === "Enter" && verifyCode.length === 6) handleVerify();
          }}
        />
      </div>
      <Button
        className="min-h-[44px]"
        onClick={handleVerify}
        disabled={verifyCode.length !== 6 || isLoading}
      >
        {isLoading ? t("auth:twoFactor.verifying") : t("settings:security.verifyAndEnable")}
      </Button>
    </div>
  );
}

function Disable2FASection() {
  const [showConfirm, setShowConfirm] = useState(false);
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation(["settings", "auth", "common"]);

  const handleDisable = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.disable({
        password,
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.disable]", result.error);
        toast.error(t("settings:security.couldNotDisable"));
        return;
      }
      toast.success(t("settings:security.disabledSuccess"));
      window.location.reload();
    } catch (err) {
      console.error("[settings.security.twoFactor.disable]", err);
      toast.error(t("settings:security.couldNotDisable"));
    } finally {
      setIsLoading(false);
    }
  };

  if (!showConfirm) {
    return (
      <Button className="min-h-[44px]" variant="outline" onClick={() => setShowConfirm(true)}>
        {t("settings:security.disable2FA")}
      </Button>
    );
  }

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.disablePrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="disable-password">{t("auth:fields.password")}</Label>
        <Input
          id="disable-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
          disabled={!password || isLoading}
        >
          {isLoading ? t("settings:security.disabling") : t("settings:security.disable")}
        </Button>
        <Button className="min-h-[44px]" variant="ghost" onClick={() => setShowConfirm(false)}>
          {t("common:actions.cancel")}
        </Button>
      </div>
    </div>
  );
}
