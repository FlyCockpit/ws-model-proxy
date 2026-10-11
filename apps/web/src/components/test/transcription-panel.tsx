import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { FileAudio, Loader2 } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { FieldErrors } from "@/components/field-errors";
import { LiveTranscriptionPanel } from "@/components/test/live-transcription-panel";
import { TestErrorNotice } from "@/components/test/test-error";
import { sendTestTranscription, type TestTarget, testErrorOf } from "@/lib/test-relay";

/** The session Test routes take at most 10 MB per request (the server's global body limit). */
const MAX_FILE_BYTES = 9.5 * 1024 * 1024;

/**
 * Transcription on the Test page: upload an audio file (with an optional language hint) and
 * read the transcript; a live microphone panel where the target declares live transcription.
 */
export function TranscriptionPanel({ target }: { target: TestTarget }) {
  const { t } = useTranslation(["dashboard"]);
  const ids = useId();
  const transcribe = useMutation({
    mutationFn: (input: { file: File; language: string }) =>
      sendTestTranscription({
        model: target.model,
        file: input.file,
        ...(input.language ? { language: input.language } : {}),
      }),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { file: null as File | null, language: "" },
    validators: {
      onSubmit: z.object({
        file: z
          .custom<File | null>()
          .refine((file) => file !== null, t("dashboard:test.transcription.fileRequired"))
          .refine(
            (file) => file === null || file.size <= MAX_FILE_BYTES,
            t("dashboard:test.transcription.fileTooLarge"),
          ),
        language: z
          .string()
          .trim()
          .regex(
            /^$|^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/,
            t("dashboard:test.transcription.badLanguage"),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      if (!value.file) return;
      await transcribe
        .mutateAsync({ file: value.file, language: value.language.trim() })
        .catch(() => undefined);
    },
  });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <form
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="file">
          {(field) => (
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={`${ids}-file`}>{t("dashboard:test.transcription.file")}</Label>
              <Input
                id={`${ids}-file`}
                type="file"
                accept="audio/*,video/webm,video/mp4"
                className="h-11 min-w-0 py-2"
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.files?.[0] ?? null)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="language">
          {(field) => (
            <div className="flex min-w-0 flex-col gap-2 md:w-48">
              <Label htmlFor={`${ids}-language`}>
                {t("dashboard:test.transcription.language")}
              </Label>
              <Input
                id={`${ids}-language`}
                className="h-11"
                placeholder="en"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <Button type="submit" size="touch" className="self-start" disabled={transcribe.isPending}>
          {transcribe.isPending ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <FileAudio aria-hidden="true" className="size-4" />
          )}
          {t("dashboard:test.transcription.send")}
        </Button>
      </form>
      {transcribe.isError ? <TestErrorNotice error={testErrorOf(transcribe.error)} /> : null}
      {transcribe.data ? (
        <section
          className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
          aria-label={t("dashboard:test.transcription.result")}
        >
          <p className="whitespace-pre-wrap break-words text-sm">
            {transcribe.data.text || t("dashboard:test.transcription.emptyText")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("dashboard:test.metrics.total", { ms: Math.round(transcribe.data.latencyMs) })}
          </p>
        </section>
      ) : null}
      {target.liveTranscription ? (
        <LiveTranscriptionPanel model={target.model} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("dashboard:test.live.unsupported")}</p>
      )}
    </div>
  );
}
