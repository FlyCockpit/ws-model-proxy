import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

type Out<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export type NodeSummary = Out<AppRouterClient["nodes"]["list"]>["nodes"][number];
export type NodeDetail = Out<AppRouterClient["nodes"]["get"]>;
export type EnrollmentCode = Out<
  AppRouterClient["nodes"]["enrollmentCodes"]["list"]
>["codes"][number];
export type EnrollmentResult = Out<AppRouterClient["nodes"]["enrollmentCodes"]["create"]>;
export type FabricView = Out<AppRouterClient["nodes"]["fabrics"]["list"]>["fabrics"][number];
export type LowerTrustPreview = Out<AppRouterClient["nodes"]["lowerTrustPreview"]>;
export type ProfileView = Out<AppRouterClient["profiles"]["get"]>;
export type ApplyResult = Out<AppRouterClient["profiles"]["apply"]>;
export type StartPreview = Extract<ApplyResult, { mode: "preview" }>["preview"];
/** `nodes.agentUpdate.overview` (wsmp self-update, contract §5). */
export type AgentUpdateOverview = Out<AppRouterClient["nodes"]["agentUpdate"]["overview"]>;
export type NodeAgentUpdateView = AgentUpdateOverview["nodes"][number];
export type AgentUpdateView = NonNullable<NodeAgentUpdateView["latest"]>;
export type AgentUpdateBatchView = Out<AppRouterClient["nodes"]["agentUpdate"]["startAll"]>;
export type AgentUpdatePolicy = NodeAgentUpdateView["policy"];
