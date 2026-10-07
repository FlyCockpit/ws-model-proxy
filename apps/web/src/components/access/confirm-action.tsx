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
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * A destructive action behind a confirmation (revoke, remove, withdraw). `children` (optional
 * fields, such as a note) sit between the explanation and the buttons.
 */
export function ConfirmAction({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  isPending,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel?: string;
  isPending: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation(["common"]);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Fields make it tall: keep it inside the viewport (and above a phone keyboard). */}
      <AlertDialogContent
        className={
          children
            ? "max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto overscroll-contain"
            : undefined
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">{t("common:actions.cancel")}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            size="touch"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
