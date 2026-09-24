import { createFileRoute } from "@tanstack/react-router";

import { ChatTestPage } from "@/components/chat-test/chat-test-page";

export const Route = createFileRoute("/$lang/_auth/dashboard/chat-test")({
  staticData: { dashboardLayout: "fill" },
  component: ChatTestRoute,
});

function ChatTestRoute() {
  const { lang } = Route.useParams();
  return <ChatTestPage lang={lang} />;
}
