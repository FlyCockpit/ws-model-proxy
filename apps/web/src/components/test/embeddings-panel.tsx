import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { Loader2, Send } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { FieldErrors } from "@/components/field-errors";
import { TestErrorNotice } from "@/components/test/test-error";
import { WideContent } from "@/components/wide-content";
import {
  type EmbeddingSummary,
  sendTestEmbeddings,
  type TestTarget,
  testErrorOf,
} from "@/lib/test-relay";

/** Inputs one embeddings test may send (one per line). */
const MAX_INPUTS = 16;

function inputLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Embeddings on the Test page: one input per line; the answer is summarized (dimensions, norm,
 * range, the first values and, for two inputs or more, the first pair's cosine similarity).
 */
export function EmbeddingsPanel({ target }: { target: TestTarget }) {
  const { t } = useTranslation(["dashboard"]);
  const id = useId();
  const embed = useMutation({
    mutationFn: (inputs: string[]) => sendTestEmbeddings({ model: target.model, inputs }),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { text: t("dashboard:test.embeddings.sample") },
    validators: {
      onSubmit: z.object({
        text: z
          .string()
          .refine((value) => inputLines(value).length > 0, t("dashboard:test.embeddings.required"))
          .refine(
            (value) => inputLines(value).length <= MAX_INPUTS,
            t("dashboard:test.embeddings.tooMany", { count: MAX_INPUTS }),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      await embed.mutateAsync(inputLines(value.text)).catch(() => undefined);
    },
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        className="flex min-w-0 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="text">
          {(field) => (
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={id}>{t("dashboard:test.embeddings.label")}</Label>
              <Textarea
                id={id}
                rows={4}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("dashboard:test.embeddings.hint", { count: MAX_INPUTS })}
              </p>
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <Button type="submit" size="touch" className="self-start" disabled={embed.isPending}>
          {embed.isPending ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Send aria-hidden="true" className="size-4" />
          )}
          {t("dashboard:test.embeddings.send")}
        </Button>
      </form>
      {embed.isError ? <TestErrorNotice error={testErrorOf(embed.error)} /> : null}
      {embed.data ? <EmbeddingResult summary={embed.data} /> : null}
    </div>
  );
}

function round(value: number): string {
  return value.toFixed(4);
}

function EmbeddingResult({ summary }: { summary: EmbeddingSummary }) {
  const { t } = useTranslation(["dashboard"]);
  const facts = [
    t("dashboard:test.embeddings.vectors", { count: summary.vectors.length }),
    summary.vectors[0]
      ? t("dashboard:test.embeddings.dimensions", { count: summary.vectors[0].dimensions })
      : null,
    summary.promptTokens !== null
      ? t("dashboard:test.metrics.promptTokens", { count: summary.promptTokens })
      : null,
    t("dashboard:test.metrics.total", { ms: Math.round(summary.latencyMs) }),
  ].filter((part): part is string => part !== null);
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
      aria-label={t("dashboard:test.embeddings.result")}
    >
      <p className="break-words text-sm">{facts.join(" · ")}</p>
      {summary.similarity !== null ? (
        <p className="text-sm">
          {t("dashboard:test.embeddings.similarity", { value: round(summary.similarity) })}
        </p>
      ) : null}
      <WideContent className="overscroll-x-contain">
        <table className="w-full min-w-[36rem] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pe-3 font-medium">#</th>
              <th className="py-1 pe-3 font-medium">{t("dashboard:test.embeddings.dims")}</th>
              <th className="py-1 pe-3 font-medium">{t("dashboard:test.embeddings.norm")}</th>
              <th className="py-1 pe-3 font-medium">{t("dashboard:test.embeddings.range")}</th>
              <th className="py-1 font-medium">{t("dashboard:test.embeddings.head")}</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {summary.vectors.map((vector) => (
              <tr key={vector.index} className="border-t">
                <td className="py-1 pe-3">{vector.index}</td>
                <td className="py-1 pe-3">{vector.dimensions}</td>
                <td className="py-1 pe-3">{round(vector.norm)}</td>
                <td className="py-1 pe-3">
                  {round(vector.min)} … {round(vector.max)}
                </td>
                <td className="py-1">[{vector.head.map(round).join(", ")}, …]</td>
              </tr>
            ))}
          </tbody>
        </table>
      </WideContent>
    </section>
  );
}
