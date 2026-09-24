import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CLI_DEVICE_NAME_MAX_LENGTH,
  cliDeviceDisplayName,
  cliDeviceNameIssue,
} from "@ws-model-proxy/config/cli-device-name";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { orpc } from "@/utils/orpc";

export type RenamableCliDevice = {
  id: string;
  slug: string;
  name: string | null;
  reportedHostname: string | null;
  displayName: string;
};

/** A blank answer clears the user's name so the hostname or slug shows. */
export function cliDeviceNameInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Rename button plus dialog for one CLI device. */
export function CliDeviceRename({ device }: { device: RenamableCliDevice }) {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        aria-label={t("dashboard:clis.rename.actionLabel", { name: device.displayName })}
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-4" />
        {t("dashboard:clis.rename.action")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dashboard:clis.rename.title")}</DialogTitle>
            <DialogDescription>
              {t("dashboard:clis.rename.description", { slug: device.slug })}
            </DialogDescription>
          </DialogHeader>
          {/* Mounted per open, so the form starts from the current name. */}
          {open ? <RenameForm device={device} onDone={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RenameForm({ device, onDone }: { device: RenamableCliDevice; onDone: () => void }) {
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  // What the device shows once the user's name is cleared.
  const fallback = cliDeviceDisplayName({ ...device, name: null });
  const rename = useMutation(
    orpc.forwarderManagement.renameCliDevice.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.adminObservability.key() });
        toast.success(
          result.name === null
            ? t("dashboard:clis.rename.cleared")
            : t("dashboard:clis.rename.saved"),
        );
        onDone();
      },
      onError: () => {
        toast.error(t("dashboard:clis.rename.saveFailed"));
      },
    }),
  );

  const form = useForm({
    defaultValues: { name: device.name ?? "" },
    validators: {
      onSubmit: z.object({
        // A blank answer clears the name; otherwise the server's policy applies.
        name: z
          .string()
          .trim()
          .superRefine((name, ctx) => {
            const issue = name.length > 0 ? cliDeviceNameIssue(name) : null;
            if (issue === "tooLong") {
              ctx.addIssue({
                code: "custom",
                message: t("dashboard:clis.rename.tooLong", { max: CLI_DEVICE_NAME_MAX_LENGTH }),
              });
            } else if (issue) {
              ctx.addIssue({
                code: "custom",
                message: t("dashboard:clis.rename.invalidCharacters"),
              });
            }
          }),
      }),
    },
    onSubmit: async ({ value }) => {
      await rename
        .mutateAsync({ cliDeviceId: device.id, name: cliDeviceNameInput(value.name) })
        .catch(() => undefined);
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={`cli-device-name-${device.id}`}>
              {t("dashboard:clis.rename.field")}
            </Label>
            <Input
              id={`cli-device-name-${device.id}`}
              name={field.name}
              className="min-h-11"
              autoComplete="off"
              placeholder={fallback}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("dashboard:clis.rename.hint", { fallback })}
            </p>
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" size="touch" onClick={onDone}>
          {t("dashboard:clis.rename.cancel")}
        </Button>
        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button type="submit" size="touch" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? t("dashboard:clis.rename.saving") : t("dashboard:clis.rename.save")}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}
