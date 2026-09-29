import { fileAccessRefusal, fileToolAccess } from "@ws-model-proxy/api/lib/cli-file-access";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  type McpCommandModeDb,
  mcpCommandModeFromDb,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import { activeMcpPersonalTokenWhere } from "@ws-model-proxy/api/lib/mcp-token-active";
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { relayProtocolAtLeast } from "./protocol.js";
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
 * The owner's account state, read inside the admission (same `Promise.all`
 * as the device and token reads) so the verdict needs no await after
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
 * The owner read (ban, ban expiry, deletion marker) is issued in the same
 * `Promise.all`, so its verdict is also taken without an await after
 * `admitted()`. A deletion mark is ordered against a start the same way:
 * - committed before the owner read: the read sees it and the start refuses;
 * - committed after it: `notifyUserDeletionMarked` runs the in-process
 *   `closeSessionsForUser`, which tears down and detaches the device socket
 *   synchronously. Before the start's synchronous step the device has no
 *   live session (the start returns `offline`); after it, the registered
 *   record is ended with the session.
 * In memory, single process: the relay sockets and the sweeps live here.
 */
type Admission = { tokenId: string; revoked: boolean };
const openAdmissions = new Set<Admission>();

function openAdmission(tokenId: string): Admission {
  const admission = { tokenId, revoked: false };
  openAdmissions.add(admission);
  return admission;
}

/** Mark every admission still reading for `tokenId`: its request refuses. */
export function revokeOpenCliAgentAdmissions(tokenId: string): void {
  for (const admission of openAdmissions) {
    if (admission.tokenId === tokenId) admission.revoked = true;
  }
}

/** Test isolation. */
export function resetCliAgentAdmissionsForTests(): void {
  openAdmissions.clear();
}

export type LiveCliToken = { name: string; expiresAt: Date | null };

/**
 * The PAT as it is now: unrevoked (with its grant), unexpired, still minted
 * with CLI commands and mcp:write. Null when any of that no longer holds.
 */
async function liveCliToken(tokenId: string, userId: string): Promise<LiveCliToken | null> {
  const token = await prisma.mcpPersonalToken.findFirst({
    where: { id: tokenId, ...activeMcpPersonalTokenWhere(userId, new Date()) },
    select: { name: true, scopes: true, allowCliCommands: true, expiresAt: true },
  });
  if (token?.allowCliCommands !== true || !token.scopes.includes("mcp:write")) {
    return null;
  }
  return { name: token.name, expiresAt: token.expiresAt };
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
 * Open the admission and read the device, the live token and the owner in one
 * `Promise.all`. The admission is closed before this returns; the verdict
 * (`judgeCliAgentAdmission`) must be taken in the caller's next synchronous step.
 */
export async function readCliAgentAdmission(
  input: CliAgentAdmissionInput,
): Promise<CliAgentAdmissionReads> {
  const admission = openAdmission(input.tokenId);
  let device: AdmissionDevice | null;
  let token: LiveCliToken | null;
  let owner: CliOwnerState | null;
  try {
    [device, token, owner] = await Promise.all([
      prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: {
          id: true,
          userId: true,
          mcpCommandMode: true,
          rejectedRelayProtocolVersion: true,
        },
      }),
      liveCliToken(input.tokenId, input.userId),
      readCliOwner(input.userId),
    ]);
  } finally {
    openAdmissions.delete(admission);
  }
  return { input, admission, device, token, owner };
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
): CliAgentAdmissionVerdict;
export function judgeCliAgentAdmission(
  reads: CliAgentAdmissionReads,
  capability: CliAgentCapability,
): CliAgentAdmissionVerdict {
  const { input, admission, device, token, owner } = reads;
  if (!admitted(admission, token, input.expiresAt)) return { ok: false, error: "token_inactive" };
  if (!device || device.userId !== input.userId) return { ok: false, error: "not_found" };
  if (!ownerAllowsCliEffects(owner)) return { ok: false, error: "token_inactive" };
  const grant = mcpCommandModeFromDb(device.mcpCommandMode);

  if (capability === "headless_exec") {
    if (grant === "off") return { ok: false, error: "grant_disabled" };
    // Mode `supervised`: a person must confirm each command. Headless exec is refused.
    if (!allowsHeadlessCommands(grant)) return { ok: false, error: "supervised_only" };
    const live = liveFeatures(input.cliDeviceId);
    if (!live || !relayProtocolAtLeast(live.protocolVersion, "2.6")) {
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
    const grantAccess = fileToolAccess(grant, opClass);
    if (grantAccess !== "headless") {
      return { ok: false, error: fileAccessRefusal(grantAccess, "grant") };
    }
    const live = liveFeatures(input.cliDeviceId);
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
    if (!relayProtocolAtLeast(live.protocolVersion, "2.8") || !live.fileOps) {
      return { ok: false, error: "offline" };
    }
    const liveAccess = fileToolAccess(live.mcpCommandMode, opClass);
    if (liveAccess !== "headless") {
      return { ok: false, error: fileAccessRefusal(liveAccess, "live") };
    }
    return { ok: true, token, device, live };
  }

  if (!allowsSupervisedCommands(grant)) return { ok: false, error: "grant_disabled" };
  const live = liveFeatures(input.cliDeviceId);
  if (!live || !relayProtocolAtLeast(live.protocolVersion, "2.6") || !live.supervisedCommands) {
    return { ok: false, error: "offline" };
  }
  if (!allowsSupervisedCommands(live.mcpCommandMode)) {
    return { ok: false, error: "feature_disabled" };
  }
  if (!live.terminalSupported) return { ok: false, error: "unsupported" };
  return { ok: true, token, device, live };
}
