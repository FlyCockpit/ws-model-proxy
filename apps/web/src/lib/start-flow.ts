/**
 * Start or restart a runtime: preview, then confirm with the preview's fingerprint.
 *
 * Every state past `picking` carries the target it is for, so a preview that resolves after
 * the person picked other nodes is dropped, and a confirm always sends the target its
 * fingerprint was planned for (never the picker's newer one).
 */

/** Where to start: an existing instance (restart), chosen nodes per rank, or the planner's pick. */
export type StartTarget =
  | { instanceId: string; nodeIds?: undefined }
  | { nodeIds: string[]; instanceId?: undefined }
  | { instanceId?: undefined; nodeIds?: undefined };

export type StartFlow<Preview> =
  | { kind: "picking" }
  | { kind: "previewing"; target: StartTarget }
  | { kind: "previewed"; target: StartTarget; preview: Preview }
  | { kind: "confirming"; target: StartTarget; preview: Preview }
  | { kind: "done" };

export type StartFlowEvent<Preview> =
  /** The person changed the target: any preview is for another target now. */
  | { type: "picked" }
  | { type: "previewRequested"; target: StartTarget }
  | { type: "previewResolved"; target: StartTarget; preview: Preview }
  | { type: "previewFailed"; target: StartTarget }
  | { type: "confirmRequested" }
  /** The confirm was refused (stale fingerprint, a new refusal...): preview again. */
  | { type: "confirmFailed" }
  | { type: "confirmSucceeded" };

export const START_FLOW_INITIAL = { kind: "picking" } as const;

/** Ranks are picked all or none, each on its own node. */
export function pickProblemOf(chosen: readonly string[], groupSize: number) {
  return chosen.length > 0 && chosen.length < groupSize
    ? "pickEveryRank"
    : new Set(chosen).size < chosen.length
      ? "pickDistinct"
      : null;
}

export function startTarget(
  instanceId: string | undefined,
  chosen: readonly string[],
  groupSize: number,
): StartTarget {
  return instanceId ? { instanceId } : chosen.length === groupSize ? { nodeIds: [...chosen] } : {};
}

export function sameStartTarget(a: StartTarget, b: StartTarget): boolean {
  if (a.instanceId !== b.instanceId) return false;
  if (a.nodeIds === undefined || b.nodeIds === undefined) return a.nodeIds === b.nodeIds;
  return (
    a.nodeIds.length === b.nodeIds.length && a.nodeIds.every((id, at) => id === b.nodeIds?.[at])
  );
}

export function startFlowReducer<Preview>(
  state: StartFlow<Preview>,
  event: StartFlowEvent<Preview>,
): StartFlow<Preview> {
  switch (event.type) {
    case "picked":
      // A confirm in flight was sent for its own target; it settles on its own.
      return state.kind === "confirming" || state.kind === "done" ? state : { kind: "picking" };
    case "previewRequested":
      return state.kind === "picking" || state.kind === "previewed"
        ? { kind: "previewing", target: event.target }
        : state;
    case "previewResolved":
      return state.kind === "previewing" && sameStartTarget(state.target, event.target)
        ? { kind: "previewed", target: state.target, preview: event.preview }
        : state;
    case "previewFailed":
      return state.kind === "previewing" && sameStartTarget(state.target, event.target)
        ? { kind: "picking" }
        : state;
    case "confirmRequested":
      return state.kind === "previewed"
        ? { kind: "confirming", target: state.target, preview: state.preview }
        : state;
    case "confirmFailed":
      return state.kind === "confirming" ? { kind: "picking" } : state;
    case "confirmSucceeded":
      return state.kind === "confirming" ? { kind: "done" } : state;
  }
}

/** The preview on screen, if it is (still) for the current flow. */
export function shownPreview<Preview>(state: StartFlow<Preview>): Preview | null {
  return state.kind === "previewed" || state.kind === "confirming" ? state.preview : null;
}
