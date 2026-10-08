import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CopyableCode, CopyButton } from "@/components/copy-button";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { WideContent } from "@/components/wide-content";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/models")({
  component: ModelsPage,
});

const STATUS_TONE: Record<"serving" | "starting" | "unavailable", PillTone> = {
  serving: "good",
  starting: "busy",
  unavailable: "muted",
};

const TYPE_ENDPOINT: Record<ModelType, string> = {
  LLM: "chat/completions",
  EMBEDDINGS: "embeddings",
  TRANSCRIPTION: "audio/transcriptions",
};

type ModelType = "LLM" | "EMBEDDINGS" | "TRANSCRIPTION";
type SnippetStyle = "curl" | "openai" | "anthropic";
const SNIPPET_STYLES: readonly SnippetStyle[] = ["curl", "openai", "anthropic"];

function curlSnippet(baseUrl: string, callableId: string, type: ModelType) {
  const endpoint = `${baseUrl}/${TYPE_ENDPOINT[type]}`;
  if (type === "TRANSCRIPTION")
    return `curl ${endpoint} \\\n  -H "Authorization: Bearer $WSMP_API_KEY" \\\n  -F model=${callableId} \\\n  -F file=@audio.wav`;
  const body =
    type === "EMBEDDINGS"
      ? `{"model":"${callableId}","input":"hello"}`
      : `{"model":"${callableId}","messages":[{"role":"user","content":"hello"}]}`;
  return `curl ${endpoint} \\\n  -H "Authorization: Bearer $WSMP_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}

function openAiSnippet(baseUrl: string, callableId: string, type: ModelType) {
  const call =
    type === "EMBEDDINGS"
      ? `result = client.embeddings.create(model="${callableId}", input="hello")\nprint(len(result.data[0].embedding))`
      : type === "TRANSCRIPTION"
        ? `with open("audio.wav", "rb") as audio:\n    result = client.audio.transcriptions.create(model="${callableId}", file=audio)\nprint(result.text)`
        : `result = client.chat.completions.create(\n    model="${callableId}",\n    messages=[{"role": "user", "content": "hello"}],\n)\nprint(result.choices[0].message.content)`;
  return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="${baseUrl}", api_key=os.environ["WSMP_API_KEY"])\n${call}`;
}

/** The Anthropic SDK adds `/v1/messages` itself; chat models only. */
function anthropicSnippet(baseUrl: string, callableId: string, type: ModelType) {
  if (type !== "LLM") return null;
  const root = baseUrl.replace(/\/v1\/?$/, "");
  return `import os\nfrom anthropic import Anthropic\n\nclient = Anthropic(base_url="${root}", api_key=os.environ["WSMP_API_KEY"])\nmessage = client.messages.create(\n    model="${callableId}",\n    max_tokens=256,\n    messages=[{"role": "user", "content": "hello"}],\n)\nprint(message.content[0].text)`;
}

function snippetFor(style: SnippetStyle, baseUrl: string, callableId: string, type: ModelType) {
  if (style === "openai") return openAiSnippet(baseUrl, callableId, type);
  if (style === "anthropic") return anthropicSnippet(baseUrl, callableId, type);
  return curlSnippet(baseUrl, callableId, type);
}

/** One snippet in a sideways-scrolling block with its copy button. */
function Snippet({ value }: { value: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="flex min-w-0 items-start gap-1">
      <WideContent className="flex-1 rounded-md bg-muted">
        <pre className="p-3 font-mono text-xs">{value}</pre>
      </WideContent>
      <CopyButton value={value} label={t("dashboard:models.copySnippet")} />
    </div>
  );
}

function SnippetOrNote({ value }: { value: string | null }) {
  const { t } = useTranslation(["dashboard"]);
  return value === null ? (
    <p className="text-sm text-muted-foreground">
      {t("dashboard:models.snippets.anthropicChatOnly")}
    </p>
  ) : (
    <Snippet value={value} />
  );
}

function ModelsPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const models = useQuery(orpc.models.list.queryOptions());
  const [style, setStyle] = useState<SnippetStyle>("curl");
  const first = models.data?.models[0];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="models" />
      {models.isPending ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : models.isError ? (
        <InlineRetry message={t("dashboard:models.loadFailed")} onRetry={() => models.refetch()} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("dashboard:models.baseUrl")}</CardTitle>
              <CardDescription>{t("dashboard:models.baseUrlHint")}</CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">
              <CopyableCode value={models.data.baseUrl} label={t("dashboard:models.copyBaseUrl")} />
              <SegmentedControl
                ariaLabel={t("dashboard:models.snippets.label")}
                value={style}
                onChange={setStyle}
                items={SNIPPET_STYLES.map((value) => ({
                  value,
                  label: t(`dashboard:models.snippets.${value}`),
                }))}
              />
              <SnippetOrNote
                value={snippetFor(
                  style,
                  models.data.baseUrl,
                  first?.callableId ?? "owner/pool",
                  first?.type ?? "LLM",
                )}
              />
            </CardContent>
          </Card>

          {models.data.models.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("dashboard:models.emptyTitle")}</CardTitle>
                <CardDescription>{t("dashboard:models.emptyHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link
                  to="/$lang/pools"
                  params={{ lang }}
                  className={buttonVariants({ size: "touch" })}
                >
                  {t("dashboard:models.goToPools")}
                </Link>
              </CardContent>
            </Card>
          ) : (
            <ul className="flex min-w-0 flex-col gap-3">
              {models.data.models.map((model) => (
                <li key={model.callableId}>
                  <Card>
                    <CardContent className="flex min-w-0 flex-col gap-3 pt-4">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <CopyableCode
                          value={model.callableId}
                          label={t("dashboard:models.copyId", { id: model.callableId })}
                        />
                        <StatusPill tone={STATUS_TONE[model.status]}>
                          {t(`dashboard:models.status.${model.status}`)}
                        </StatusPill>
                        <StatusPill tone="info">
                          {t(`dashboard:models.type.${model.type}`)}
                        </StatusPill>
                        {model.external ? (
                          <StatusPill tone="busy">{t("dashboard:models.external")}</StatusPill>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {model.owner.you
                          ? t("dashboard:models.yourPool")
                          : t("dashboard:models.sharedBy", {
                              owner: model.owner.email ?? model.owner.slug,
                            })}
                        {model.external ? ` · ${t("dashboard:models.externalHint")}` : ""}
                      </p>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Link
                          to="/$lang/test"
                          params={{ lang }}
                          search={{ target: model.callableId }}
                          className={buttonVariants({ variant: "outline", size: "touch" })}
                          aria-label={t("dashboard:models.testOne", { id: model.callableId })}
                        >
                          <FlaskConical aria-hidden="true" className="size-4" />
                          {t("dashboard:models.test")}
                        </Link>
                      </div>
                      <details className="group min-w-0">
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
                          {t("dashboard:models.snippet")}
                        </summary>
                        <SnippetOrNote
                          value={snippetFor(
                            style,
                            models.data.baseUrl,
                            model.callableId,
                            model.type,
                          )}
                        />
                      </details>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">
            {t("dashboard:models.directNote")}{" "}
            <Link to="/$lang/test" params={{ lang }} className="underline underline-offset-4">
              {t("dashboard:models.testLink")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
