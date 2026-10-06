import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
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
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { FieldError } from "@/components/nodes/field-error";
import type { NodeSummary } from "@/components/nodes/node-types";
import { refusalToastOptions } from "@/components/nodes/refusal";
import { orpc } from "@/utils/orpc";

import { PROFILE_SLUG_PATTERN, slugFromName } from "./profile-editor";

/** Name and nodes first; the editor adds what runs there. */
export function NewProfileDialog({
  open,
  onOpenChange,
  nodes,
  lang,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: readonly NodeSummary[];
  lang: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-x-hidden overflow-y-auto overscroll-contain">
        <DialogHeader>
          <DialogTitle>{t("dashboard:profiles.new.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:profiles.new.description")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <NewProfileForm nodes={nodes} lang={lang} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewProfileForm({
  nodes,
  lang,
  onClose,
}: {
  nodes: readonly NodeSummary[];
  lang: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    ...orpc.profiles.save.mutationOptions({
      onSuccess: (profile) => {
        queryClient.invalidateQueries({ queryKey: orpc.profiles.key() });
        onClose();
        navigate({ to: "/$lang/profiles/$profileId", params: { lang, profileId: profile.id } });
      },
    }),
    ...refusalToastOptions(t),
  });
  const form = useForm({
    defaultValues: { name: "", nodeIds: [] as string[] },
    validators: {
      onChange: z.object({
        name: z
          .string()
          .trim()
          .min(1, t("dashboard:profiles.editor.nameRequired"))
          .max(120)
          .refine(
            (name) => PROFILE_SLUG_PATTERN.test(slugFromName(name)),
            t("dashboard:profiles.new.nameNeedsLetter"),
          ),
        nodeIds: z.array(z.string()).min(1, t("dashboard:profiles.editor.nodesRequired")),
      }),
    },
    onSubmit: async ({ value }) => {
      await create.mutateAsync({
        slug: slugFromName(value.name),
        name: value.name.trim(),
        nodeIds: value.nodeIds,
        items: [],
      });
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="new-profile-name">{t("dashboard:profiles.editor.name")}</Label>
            <Input
              id="new-profile-name"
              className="min-h-[44px]"
              placeholder={t("dashboard:profiles.new.namePlaceholder")}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      </form.Field>
      <form.Field name="nodeIds">
        {(field) => (
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">
              {t("dashboard:profiles.editor.nodesTitle")}
            </legend>
            {nodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("dashboard:profiles.new.noNodes")}</p>
            ) : (
              nodes.map((node) => (
                <label key={node.id} className="flex min-h-[44px] items-center gap-3">
                  <Checkbox
                    checked={field.state.value.includes(node.id)}
                    onCheckedChange={(checked) =>
                      field.handleChange(
                        checked
                          ? [...field.state.value, node.id]
                          : field.state.value.filter((id) => id !== node.id),
                      )
                    }
                  />
                  {node.name ?? node.slug}
                </label>
              ))
            )}
            <FieldError errors={field.state.meta.errors} />
          </fieldset>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="ghost" className="min-h-[44px]" onClick={onClose}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" className="min-h-[44px]" disabled={create.isPending}>
          {t("dashboard:profiles.new.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
