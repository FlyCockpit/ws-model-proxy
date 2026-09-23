import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { Button } from "@ws-model-proxy/ui/components/button";
import { useTranslation } from "react-i18next";

import type { GranteePrivacyConfirm } from "@/lib/grantee-privacy-confirmation";

export function GranteePrivacyConfirmDialog({
  confirmation,
  pending = false,
  onOpenChange,
  onConfirm,
}: {
  confirmation: GranteePrivacyConfirm | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  return (
    <AlertDialog open={confirmation !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md!">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("dashboard:pools.granteePrivacyConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription className="min-w-0 max-w-full break-words">
            {t("dashboard:pools.granteePrivacyConfirmDescription", {
              pool: confirmation?.poolName ?? "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="min-w-0 space-y-1 text-sm">
          {(confirmation?.grantees ?? []).map((grantee) => (
            <li key={grantee.email} className="min-w-0 break-all">
              {grantee.email}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[44px]" disabled={pending}>
            {t("common:actions.cancel")}
          </AlertDialogCancel>
          <Button type="button" size="touch" disabled={pending} onClick={onConfirm}>
            {t("dashboard:pools.granteePrivacyConfirmAction")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
