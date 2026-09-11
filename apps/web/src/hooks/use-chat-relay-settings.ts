import type { ChatTestReasoningSelection } from "@ws-model-proxy/api/lib/reasoning-contract";
import { useCallback, useState } from "react";

import type {
  ChatTestRoutingMode,
  ChatTestSurfaceSelection,
} from "@/components/chat-test/chat-test-types";

/** Owns request-scoped relay settings. Thread and attachment state deliberately
 * stay separate so changing a model cannot mutate sent history. */
export function useChatRelaySettings() {
  const [selectedModelId, setSelectedModelId] = useState("");
  const [routingMode, setRoutingMode] = useState<ChatTestRoutingMode>("PREFER_NATIVE");
  const [surfaceSelection, setSurfaceSelection] = useState<ChatTestSurfaceSelection>("PREFERRED");
  const [reasoningSelection, setReasoningSelection] = useState<ChatTestReasoningSelection>("unset");
  const [requestSettingsOpen, setRequestSettingsOpen] = useState(false);
  const [anthropicMaxTokens, setAnthropicMaxTokens] = useState(1024);

  const handleSurfaceChange = useCallback((value: ChatTestSurfaceSelection) => {
    setSurfaceSelection(value);
    setReasoningSelection("unset");
  }, []);
  const handleRoutingModeChange = useCallback((value: ChatTestRoutingMode) => {
    setRoutingMode(value);
    if (value === "REQUIRE_ADAPTED") setReasoningSelection("unset");
  }, []);

  return {
    selectedModelId,
    setSelectedModelId,
    routingMode,
    setRoutingMode,
    surfaceSelection,
    setSurfaceSelection,
    reasoningSelection,
    setReasoningSelection,
    requestSettingsOpen,
    setRequestSettingsOpen,
    anthropicMaxTokens,
    setAnthropicMaxTokens,
    handleSurfaceChange,
    handleRoutingModeChange,
  };
}
