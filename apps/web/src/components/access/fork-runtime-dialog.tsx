import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import { refusalText } from "@/lib/refusal-text";
import { SLUG_PATTERN, slugify } from "@/lib/slugify";
import { orpc } from "@/utils/orpc";

export type SharedDefinition = {
  runtimeId: string;
  name: string;
  kind: "ALWAYS_ON" | "STARTABLE";
};

/** Copy a runtime definition shared with you into your own runtime (pick a node, a name). */
export function ForkRuntimeDialog({
  definition,
  lang,
  onClose,
}: {
  definition: SharedDefinition | null;
  lang: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["access"]);
  return (
    <ResponsiveDialog
      open={definition !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={t("access:fork.title", { name: definition?.name ?? "" })}
      description={t("access:fork.description")}
    >
      {definition ? (
        <ForkForm key={definition.runtimeId} definition={definition} lang={lang} onDone={onClose} />
      ) : null}
    </ResponsiveDialog>
  );
}

function ForkForm({
  definition,
  lang,
  onDone,
}: {
  definition: SharedDefinition;
  lang: string;
  onDone: () => void;
}) {
  const { t } = useTranslation(["access", "dashboard"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const alwaysOn = definition.kind === "ALWAYS_ON";
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), enabled: alwaysOn });
  const fork = useMutation({
    ...orpc.runtimes.fork.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const schema = z.object({
    nodeId: alwaysOn ? z.string().min(1, t("access:fork.nodeRequired")) : z.string(),
    name: z.string().trim().min(1, t("dashboard:runtime.form.nameRequired")).max(120),
    slug: z
      .string()
      .regex(SLUG_PATTERN, t("dashboard:pool.form.slugInvalid"))
      .refine((slug) => !/^i-[a-z0-9]{12}$/.test(slug), t("dashboard:runtime.form.slugReserved")),
  });
  const form = useForm({
    defaultValues: { nodeId: "", name: definition.name, slug: slugify(definition.name) },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      try {
        const result = await fork.mutateAsync({
          runtimeId: definition.runtimeId,
          name: value.name.trim(),
          slug: value.slug,
          ...(alwaysOn ? { nodeId: value.nodeId } : {}),
        });
        await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
        toast.success(t("access:fork.done"));
        onDone();
        await navigate({
          to: "/$lang/runtimes/$runtimeId",
          params: { lang, runtimeId: result.runtime.id },
        });
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {alwaysOn ? (
        <form.Field name="nodeId">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="fork-node">{t("dashboard:runtime.form.node")}</Label>
              {nodes.isPending ? (
                <Skeleton className="h-11 w-full" />
              ) : nodes.isError ? (
                <p className="text-sm text-muted-foreground">{t("access:fork.nodesFailed")}</p>
              ) : nodes.data.nodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("access:fork.noNodes")}</p>
              ) : (
                <NativeSelect
                  id="fork-node"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  <option value="">{t("dashboard:runtime.form.pickNode")}</option>
                  {nodes.data.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name ?? node.slug}
                    </option>
                  ))}
                </NativeSelect>
              )}
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
      ) : (
        <p className="text-sm text-muted-foreground">{t("access:fork.startableHint")}</p>
      )}
      <form.Field name="name">
        {(field) => (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="fork-name">{t("dashboard:runtime.form.name")}</Label>
            <Input
              id="fork-name"
              className="h-11"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => {
                const previous = slugify(field.state.value);
                field.handleChange(event.target.value);
                const slug = form.getFieldValue("slug");
                if (slug === "" || slug === previous)
                  form.setFieldValue("slug", slugify(event.target.value));
              }}
            />
            <FieldErrors field={field} />
          </div>
        )}
      </form.Field>
      <form.Field name="slug">
        {(field) => (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="fork-slug">{t("dashboard:runtime.form.slug")}</Label>
            <Input
              id="fork-slug"
              className="h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldErrors field={field} />
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" size="touch" disabled={isSubmitting}>
            {isSubmitting ? t("access:fork.forking") : t("access:fork.submit")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
