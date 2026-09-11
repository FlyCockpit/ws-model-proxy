import { Button } from "@ws-model-proxy/ui/components/button";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChatEmptyState } from "./chat-empty-state";
import { ChatMessageView } from "./chat-message";
import type { ChatMessage } from "./chat-test-types";

export function ChatTranscript({
  lang,
  hasModels,
  messages,
  scroll,
  onSamplePrompt,
  onRegenerate,
  canRegenerate,
}: {
  lang: string;
  hasModels: boolean;
  messages: ChatMessage[];
  scroll: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    contentRef: React.RefObject<HTMLDivElement | null>;
    liveEdgeRef: React.RefObject<HTMLDivElement | null>;
    markUserIntent: () => void;
    hasOutOfViewUpdates: boolean;
    jumpToLatest: () => void;
  };
  onSamplePrompt: (prompt: string) => void;
  onRegenerate: (message: ChatMessage) => void;
  canRegenerate: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="relative min-h-0">
      <div
        ref={scroll.scrollRef}
        onScroll={scroll.markUserIntent}
        className="h-full min-h-0 overflow-y-auto overflow-x-clip overscroll-y-contain p-2 scrollbar-gutter-stable focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 sm:p-3"
        aria-label={t("dashboard:chatTest.transcript")}
        role="log"
        tabIndex={0}
      >
        <div ref={scroll.contentRef} className="mx-auto max-w-3xl space-y-3 sm:space-y-4">
          {messages.length === 0 ? (
            <ChatEmptyState hasModels={hasModels} lang={lang} onSamplePrompt={onSamplePrompt} />
          ) : (
            messages.map((message) => (
              <ChatMessageView
                key={message.id}
                message={message}
                onRegenerate={onRegenerate}
                canRegenerate={canRegenerate}
              />
            ))
          )}
          <div ref={scroll.liveEdgeRef} aria-hidden="true" />
        </div>
      </div>
      {scroll.hasOutOfViewUpdates ? (
        <Button
          type="button"
          size="touch"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          onClick={scroll.jumpToLatest}
        >
          <ArrowDown className="size-4" />
          {t("dashboard:chatTest.jumpToLatest")}
        </Button>
      ) : null}
    </div>
  );
}
