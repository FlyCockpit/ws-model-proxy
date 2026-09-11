import { createFileRoute } from "@tanstack/react-router";

import { ChatTestPage } from "@/components/chat-test/chat-test-page";

export const Route = createFileRoute("/$lang/_auth/dashboard/chat-test")({
  component: ChatTestRoute,
});

function ChatTestRoute() {
  const { lang } = Route.useParams();
  return <ChatTestPage lang={lang} />;
}
