export type ChatTestRoutingMode = "PREFER_NATIVE" | "REQUIRE_NATIVE" | "REQUIRE_ADAPTED";

export function resolveChatTestRoutingMode(
  headerValue: string | null,
  enabled: boolean,
): ChatTestRoutingMode {
  if (!enabled) return "PREFER_NATIVE";
  return headerValue === "REQUIRE_NATIVE" || headerValue === "REQUIRE_ADAPTED"
    ? headerValue
    : "PREFER_NATIVE";
}

export function allowsChatTestExecutionMode(
  routingMode: ChatTestRoutingMode,
  executionMode: "native" | "adapted" | "legacy",
): boolean {
  if (routingMode === "REQUIRE_NATIVE") return executionMode === "native";
  if (routingMode === "REQUIRE_ADAPTED") return executionMode === "adapted";
  return true;
}
