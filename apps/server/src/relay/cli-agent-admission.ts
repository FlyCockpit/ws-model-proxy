import {
  fileGrantStageRefusal,
  fileLiveStageRefusal,
  fileToolAccess,
} from "@ws-model-proxy/api/lib/cli-file-access";
import { cliTokenAllows } from "@ws-model-proxy/api/lib/cli-token-capability";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  type McpCommandModeDb,
  mcpCommandModeFromDb,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import { activeMcpPersonalTokenWhere } from "@ws-model-proxy/api/lib/mcp-token-active";
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { relaySessionManager } from "./session-manager.js";

/**
 * The shared admission of everything an MCP agent asks a CLI to do: headless
 * exec, supervised commands, and node file tools. One read (`readCliAgentAdmission`),
 * one synchronous verdict (`judgeCliAgentAdmission`), one revoke sweep
 * (`revokeOpenCliAgentAdmissions`). Callers keep the "no await between the
 * verdict and the dispatch" ordering described on `Admission`.
 */
export type CliAgentCapability = "headless_exec" | "supervised" | "file_read" | "file_write";

export type CliAgentAdmissionRejection =
  | "not_found"
  | "grant_disabled"
  | "offline"
  | "feature_disabled"
  | "supervised_only"
  | "unsupported"
  | "token_inactive"
  /** File capabilities only: the offline CLI's last hello was refused for an old protocol. */
  | "upgrade_required";

type CliOwnerState = {
  banned: boolean | null;
  banExpires: Date | null;
  deletionRequestedAt: Date | null;
};

/**
 * The owner's account state, read last inside the admission, after the
 * device and token reads, so the verdict needs no await after
 * `admitted()`. See `Admission` for why a mark committed after this read is
 * still covered.
 */
function readCliOwner(userId: string): Promise<CliOwnerState | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { banned: true, banExpires: true, deletionRequestedAt: true },
  });
}

/** Synchronous owner verdict: missing, banned (with expiry) or deleting refuses. */
function ownerAllowsCliEffects(owner: CliOwnerState | null): boolean {
  return owner !== null && !userCredentialAccessBlocked(owner, new Date());
}

/**
 * One request between its first await and the moment its record is
 * registered (or it is refused). The revoke sweep only sees records that
 * exist, so it also marks the open admissions of the token; the request
 * then refuses. Together with the live token read (issued after the
 * admission opened) this orders every revoke or narrowing against a start:
 * - committed before the read: the read sees it and the start refuses;
 * - swept while the admission is open: the mark refuses the start;
 * - swept later: the record exists by then (closing the admission,
 *   registering the record and sending the frame happen in one synchronous
 *   step) and the sweep ends it like any other.
 * The owner read (ban, ban expiry, deletion marker) is issued last, so its
 * verdict is taken without an await after `admitted()`. A deletion mark is
 * ordered against a start the same way:
 * - committed before the owner read: the read sees it and the start refuses;
 * - committed after it: `notifyUserDeletionMarked` runs the in-process
 *   `closeSessionsForUser`, which tears down and detaches the device socket
 *   synchronously. Before the start's synchronous step the device has no
 *   live session (the start returns `offline`); after it, the registered
 *   record is ended with the session.
 * A ban is ordered the same way, without closing the socket: committed before
 * the owner read, the verdict refuses; committed after it, `notifyUserBanned`
 * runs the per-user sweep (`revokeOpenCliAgentAdmissionsForUser`), which marks
 * the open admission (the start refuses) or, once the record exists, ends it
 * (`cancelCommandsForUser`, `cancelFileOpsForUser`).
 * In memory, single process: the relay sockets and the sweeps live here.
 */
type Admission = { tokenId: string; userId: string; revoked: boolean; grantChangeSeq: number };
const openAdmissions = new Set<Admission>();

function openAdmission(tokenId: string, userId: string, cliDeviceId: string): Admission {
  const admission = {
    tokenId,
    userId,
    revoked: false,
    grantChangeSeq: relaySessionManager.featureGrantChangeSeq(cliDeviceId),
  };
  openAdmissions.add(admission);
  return admission;
}

/** Mark every admission still reading for `tokenId`: its request refuses. */
export function revokeOpenCliAgentAdmissions(tokenId: string): void {
  for (const admission of openAdmissions) {
    if (admission.tokenId === tokenId) admission.revoked = true;
  }
}

/**
 * Mark every admission still reading for `userId` (a ban): its request refuses.
 * The per-user twin of {@link revokeOpenCliAgentAdmissions}, with the same
 * ordering argument (see `Admission`): a ban committed before the owner read is
 * seen by the verdict, one committed later is swept here, or ends the record.
 */
export function revokeOpenCliAgentAdmissionsForUser(userId: string): void {
  for (const admission of openAdmissions) {
    if (admission.userId === userId) admission.revoked = true;
  }
}

/** Test only: admissions still open (a leak check). */
export function openCliAgentAdmissionCountForTests(): number {
  return openAdmissions.size;
}

/** Test isolation. */
export function resetCliAgentAdmissionsForTests(): void {
  openAdmissions.clear();
}

export type LiveCliToken = {
  name: string;
  expiresAt: Date | null;
  allowCliCommands: boolean;
  allowCliFileRead: boolean;
  scopes: string[];
};

/**
 * The PAT as it is now: unrevoked (with its grant), unexpired, still minted
 * with current flags/scopes. Capability-specific consent is checked at the verdict.
 */
async function liveCliToken(tokenId: string, userId: string): Promise<LiveCliToken | null> {
  const token = await prisma.mcpPersonalToken.findFirst({
    where: { id: tokenId, ...activeMcpPersonalTokenWhere(userId, new Date()) },
    select: {
      name: true,
      scopes: true,
      allowCliCommands: true,
      allowCliFileRead: true,
      expiresAt: true,
    },
  });
  return token;
}

/**
 * The admission verdict, taken in the same synchronous step that registers
 * the record: the token must be live, not swept meanwhile, and unexpired now.
 */
function admitted(
  admission: Admission,
  token: LiveCliToken | null,
  admittedExpiry: Date | null,
): token is LiveCliToken {
  if (admission.revoked || token === null) return false;
  const now = Date.now();
  if (token.expiresAt !== null && token.expiresAt.getTime() <= now) return false;
  return admittedExpiry === null || admittedExpiry.getTime() > now;
}

type AdmissionDevice = {
  id: string;
  userId: string;
  mcpCommandMode: McpCommandModeDb;
  mcpFileRead: boolean;
  rejectedRelayProtocolVersion: string | null;
};

export type CliAgentAdmissionInput = {
  userId: string;
  tokenId: string;
  /** The expiry the caller's credential was admitted with. */
  expiresAt: Date | null;
  cliDeviceId: string;
};

export type CliAgentAdmissionReads = {
  input: CliAgentAdmissionInput;
  admission: Admission;
  device: AdmissionDevice | null;
  token: LiveCliToken | null;
  owner: CliOwnerState | null;
};

/**
 * Open the admission, read the device and live token together, then the
 * owner last. The admission stays OPEN when this returns, so a revoke landing
 * before the caller resumes still marks it. `judgeCliAgentAdmission` closes it
 * synchronously; a caller that never judges must call `closeCliAgentAdmission`.
 */
export async function readCliAgentAdmission(
  input: CliAgentAdmissionInput,
): Promise<CliAgentAdmissionReads> {
  const admission = openAdmission(input.tokenId, input.userId, input.cliDeviceId);
  let device: AdmissionDevice | null;
  let token: LiveCliToken | null;
  let owner: CliOwnerState | null;
  try {
    [device, token] = await Promise.all([
      prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: {
          id: true,
          userId: true,
          mcpCommandMode: true,
          mcpFileRead: true,
          rejectedRelayProtocolVersion: true,
        },
      }),
      liveCliToken(input.tokenId, input.userId),
    ]);
    // The owner is read LAST: a ban or deletion committed before this read is
    // seen by the verdict, and the window between this read and the dispatch is
    // one synchronous step (a stale owner snapshot taken before the slower
    // device read would extend it).
    owner = await readCliOwner(input.userId);
  } catch (error) {
    openAdmissions.delete(admission);
    throw error;
  }
  return { input, admission, device, token, owner };
}

/** Close an admission that will not be judged. */
export function closeCliAgentAdmission(reads: CliAgentAdmissionReads): void {
  openAdmissions.delete(reads.admission);
}

type AdmissionOk = {
  ok: true;
  token: LiveCliToken;
  device: AdmissionDevice;
  live: NonNullable<ReturnType<typeof liveFeatures>>;
};

export type CliAgentAdmissionVerdict =
  | AdmissionOk
  | {
      ok: false;
      error: CliAgentAdmissionRejection;
      /** With `upgrade_required`: the relay protocol the refused CLI spoke. */
      rejectedProtocolVersion?: string;
    };

/** The verdict for a command capability: never `upgrade_required` (file ops only). */
export type CliCommandAdmissionVerdict =
  | AdmissionOk
  | { ok: false; error: Exclude<CliAgentAdmissionRejection, "upgrade_required"> };

function liveFeatures(cliDeviceId: string) {
  return relaySessionManager.getLiveCliFeatures([cliDeviceId]).get(cliDeviceId);
}

/**
 * The synchronous verdict for `capability`: token, device ownership, owner
 * state, server grant, then the live CLI (protocol, its own mode, features).
 * The caller checks its limits and input and registers the record in the same
 * synchronous step; nothing may await in between.
 */
export function judgeCliAgentAdmission(
  reads: CliAgentAdmissionReads,
  capability: "headless_exec" | "supervised",
): CliCommandAdmissionVerdict;
export function judgeCliAgentAdmission(
  reads: CliAgentAdmissionReads,
  capability: CliAgentCapability,
  options?: { fileWrite: true },
): CliAgentAdmissionVerdict;
export function judgeCliAgentAdmission(
  reads: CliAgentAdmissionReads,
  capability: CliAgentCapability,
  options?: { fileWrite: true },
): CliAgentAdmissionVerdict {
  const { input, admission, device, token, owner } = reads;
  // Closing and judging are one synchronous step: no revoke can slip between them.
  openAdmissions.delete(admission);
  if (!admitted(admission, token, input.expiresAt)) return { ok: false, error: "token_inactive" };
  if (
    !cliTokenAllows(
      token,
      capability === "file_read" || capability === "file_write" ? capability : "command",
    )
  )
    return { ok: false, error: "token_inactive" };
  if (!device || device.userId !== input.userId) return { ok: false, error: "not_found" };
  if (!ownerAllowsCliEffects(owner)) return { ok: false, error: "token_inactive" };
  // A committed policy change invalidates reads opened before its notification,
  // even if a reconnect or a later enable has already restored live authority.
  if (admission.grantChangeSeq !== relaySessionManager.featureGrantChangeSeq(input.cliDeviceId)) {
    // Preserve the dispatch gate's specific refusal (e.g. a headless command
    // narrowed to supervised). A newer enable still cannot revive this admission.
    const refusal =
      capability === "file_read" || capability === "file_write"
        ? relaySessionManager.fileOpModeRefusal(
            input.cliDeviceId,
            capability === "file_read" ? "read" : "write",
          )
        : relaySessionManager.commandModeRefusal(
            input.cliDeviceId,
            capability === "headless_exec" ? "headless" : "supervised",
          );
    return { ok: false, error: refusal ?? "grant_disabled" };
  }
  const grant = mcpCommandModeFromDb(device.mcpCommandMode);

  if (capability === "headless_exec") {
    if (grant === "off") return { ok: false, error: "grant_disabled" };
    // Mode `supervised`: a person must confirm each command. Headless exec is refused.
    if (!allowsHeadlessCommands(grant)) return { ok: false, error: "supervised_only" };
    const live = liveFeatures(input.cliDeviceId);
    if (!live) {
      return { ok: false, error: "offline" };
    }
    if (live.mcpCommandMode === "off") return { ok: false, error: "feature_disabled" };
    if (!allowsHeadlessCommands(live.mcpCommandMode)) {
      return { ok: false, error: "supervised_only" };
    }
    return { ok: true, token, device, live };
  }

  if (capability === "file_read" || capability === "file_write") {
    const opClass = capability === "file_read" ? "read" : "write";
    const live = liveFeatures(input.cliDeviceId);
    const readGrant = {
      server: device.mcpFileRead === true,
      live: live?.mcpFileRead === true && live.fileOps === true,
      roots: live?.fileRootsConfigured === true,
    };
    const grantRefusal = fileGrantStageRefusal(grant, opClass, readGrant);
    if (grantRefusal) return { ok: false, error: grantRefusal };
    if (!live) {
      // Not connected. A device whose last hello was refused for an old
      // protocol says so (#90) instead of a bare `offline`.
      return device.rejectedRelayProtocolVersion
        ? {
            ok: false,
            error: "upgrade_required",
            rejectedProtocolVersion: device.rejectedRelayProtocolVersion,
          }
        : { ok: false, error: "offline" };
    }
    if (!live.fileOps) {
      return { ok: false, error: "offline" };
    }
    const liveRefusal = fileLiveStageRefusal(grant, live.mcpCommandMode, opClass, readGrant);
    if (liveRefusal) return { ok: false, error: liveRefusal };
    return { ok: true, token, device, live };
  }

  // The supervised capability is shared by commands and file writes. File
  // writes take their mode verdict from the single file-access matrix.
  const permitsSupervised = options?.fileWrite
    ? (mode: typeof grant) => fileToolAccess(mode, "write") !== "off"
    : allowsSupervisedCommands;
  if (!permitsSupervised(grant)) return { ok: false, error: "grant_disabled" };
  const live = liveFeatures(input.cliDeviceId);
  if (!live && options?.fileWrite && device.rejectedRelayProtocolVersion) {
    return {
      ok: false,
      error: "upgrade_required",
      rejectedProtocolVersion: device.rejectedRelayProtocolVersion,
    };
  }
  if (!live || !live.supervisedCommands || (options?.fileWrite && !live.fileOps)) {
    return { ok: false, error: "offline" };
  }
  if (!permitsSupervised(live.mcpCommandMode)) {
    return { ok: false, error: "feature_disabled" };
  }
  if (!live.terminalSupported) return { ok: false, error: "unsupported" };
  return { ok: true, token, device, live };
}
