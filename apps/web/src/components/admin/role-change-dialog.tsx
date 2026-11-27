import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

export type RoleChangeTarget = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
};

export function RoleChangeDialog({
  target,
  isPending,
  error,
  onClose,
  onConfirm,
}: {
  target: RoleChangeTarget | null;
  isPending: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const promoting = target?.role === "admin";
  const name = target?.name || target?.email || "";
  const handleClose = () => {
    if (!isPending) onClose();
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent initialFocus={cancelRef} showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle className="break-words">
            {promoting ? t("admin:users.promoteTitle") : t("admin:users.demoteTitle")}
          </DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">
            {promoting
              ? t("admin:users.promoteDescription", { name, email: target?.email ?? "" })
              : t("admin:users.demoteDescription", { name, email: target?.email ?? "" })}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
        <DialogFooter className="sm:flex-wrap">
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            className="min-h-[44px]"
            disabled={isPending}
            onClick={handleClose}
          >
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="button"
            className="h-auto min-h-[44px] max-w-full whitespace-normal [overflow-wrap:anywhere]"
            disabled={isPending}
            onClick={() => {
              if (!isPending) onConfirm();
            }}
          >
            {isPending
              ? t("admin:users.roleUpdating")
              : promoting
                ? t("admin:users.confirmPromote", { name })
                : t("admin:users.confirmDemote")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
