/** A current Linux hello report for tests that do not exercise feature negotiation. */
import type { NodeFeatures } from "./runtime-spec";

export const TEST_NODE_FEATURES: NodeFeatures = {
  terminals: { supported: true, max: 4, approvalRequired: false },
  operatorTerminals: false,
  files: { roots: null, asRoot: false, source: "default" },
  runtimeHosts: [],
  mediaExpand: false,
  liveStt: false,
  secrets: [],
  jobReservations: true,
  rankIdle: true,
  launch: { platform: "linux", management: ["process", "service"], shells: ["sh"] },
  selfUpdate: { strategies: ["self-replace"], instancesSurvive: true, remote: "allowed" },
};
