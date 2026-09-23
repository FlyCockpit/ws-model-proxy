export const TERMINAL_FRAME_BODY_MAX_BYTES = 1024 * 1024;
const TERMINAL_FRAME_METADATA_MAX_BYTES = 64 * 1024;

export type TerminalWriterLabel = "you" | "other" | "none";

export type ListedTerminal = {
  terminalId: string;
  cliDeviceId: string;
  cols: number;
  rows: number;
  /** Attached viewers across every tab. */
  viewerCount: number;
  /** This socket already views (or waits to view) the terminal. */
  attachedHere: boolean;
  /** This socket's viewer is the writer. */
  writerHere: boolean;
  /** Someone views the terminal. Kept by the server for one release. */
  viewerAttached: boolean;
};

export type ListedCli = {
  cliDeviceId: string;
  publicKey: string | null;
  /** Protocol 2.5 CLI: several tabs can view one terminal (v2 crypto). */
  terminalViewers: boolean;
};

export type TerminalIdentityMessage = {
  publicKey: string;
  signature: string;
};

export type TerminalClientMessage =
  | { type: "list" }
  | {
      type: "open";
      cliDeviceId: string;
      cols: number;
      rows: number;
      publicKey: string;
      nonce: string;
      identity?: { publicKey: string };
    }
  | {
      type: "attach";
      terminalId: string;
      publicKey: string;
      nonce: string;
      identity?: { publicKey: string };
    }
  | { type: "auth"; terminalId: string; signature: string }
  | { type: "close"; terminalId: string }
  | { type: "detach"; terminalId: string };

export type TerminalServerMessage =
  | { type: "terminals"; terminals: ListedTerminal[]; clis: ListedCli[] }
  | { type: "opening"; terminalId: string; viewerId: string | null }
  | { type: "attaching"; terminalId: string; viewerId: string }
  | { type: "viewers"; terminalId: string; count: number; writer: TerminalWriterLabel }
  | {
      type: "pending";
      terminalId: string;
      cliPublicKey: string;
      cliNonce: string;
      approvalCode: string | null;
    }
  | { type: "opened"; terminalId: string; cliPublicKey: string; cliNonce: string }
  | { type: "attached"; terminalId: string; cliPublicKey: string; cliNonce: string }
  | {
      type: "rejected";
      terminalId: string | null;
      reason: string;
      approvalCode: string | null;
    }
  | { type: "exit"; terminalId: string; exitCode: number | null; signal: string | null }
  /** `self`: this tab stopped viewing. `slow`: this tab fell behind. None: 2.4 steal. */
  | { type: "detached"; terminalId: string; reason: "self" | "slow" | null }
  | { type: "error"; message: string; code: string | null; terminalId: string | null };

export type SealedTerminalFrame = {
  terminalId: string;
  seq: number;
  /** Set on broadcast frames (shared output key). Unicast frames have none. */
  epoch?: number;
  body: Uint8Array;
};

const EPOCH_MAX = 0xffffffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readWriter(value: unknown): TerminalWriterLabel | null {
  return value === "you" || value === "other" || value === "none" ? value : null;
}

function readListedTerminal(value: unknown): ListedTerminal | null {
  if (!isRecord(value)) return null;
  const terminalId = readString(value, "terminalId");
  const cliDeviceId = readString(value, "cliDeviceId") ?? readString(value, "id");
  if (!terminalId || !cliDeviceId) return null;
  const viewerAttached = value.viewerAttached === true;
  return {
    terminalId,
    cliDeviceId,
    cols: readDimension(value.cols, 80),
    rows: readDimension(value.rows, 24),
    viewerCount: readCount(value.viewerCount) ?? (viewerAttached ? 1 : 0),
    attachedHere: value.attachedHere === true,
    writerHere: value.writerHere === true,
    viewerAttached,
  };
}

function readListedCli(value: unknown): ListedCli | null {
  if (!isRecord(value)) return null;
  const cliDeviceId = readString(value, "cliDeviceId") ?? readString(value, "id");
  if (!cliDeviceId) return null;
  return {
    cliDeviceId,
    publicKey: typeof value.publicKey === "string" ? value.publicKey : null,
    terminalViewers: value.terminalViewers === true,
  };
}

function readHandshake(
  record: Record<string, unknown>,
  type: "opened" | "attached",
): TerminalServerMessage | null {
  const terminalId = readString(record, "terminalId");
  const cliPublicKey = readString(record, "cliPublicKey");
  const cliNonce = readString(record, "cliNonce");
  if (!terminalId || !cliPublicKey || !cliNonce) return null;
  return { type, terminalId, cliPublicKey, cliNonce };
}

export function parseTerminalServerMessage(value: unknown): TerminalServerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "terminals": {
      const terminals = Array.isArray(value.terminals)
        ? value.terminals.flatMap((entry) => {
            const terminal = readListedTerminal(entry);
            return terminal ? [terminal] : [];
          })
        : [];
      const clis = Array.isArray(value.clis)
        ? value.clis.flatMap((entry) => {
            const cli = readListedCli(entry);
            return cli ? [cli] : [];
          })
        : [];
      return { type: "terminals", terminals, clis };
    }
    case "opening": {
      const terminalId = readString(value, "terminalId");
      if (!terminalId) return null;
      return { type: "opening", terminalId, viewerId: readString(value, "viewerId") };
    }
    case "attaching": {
      const terminalId = readString(value, "terminalId");
      const viewerId = readString(value, "viewerId");
      if (!terminalId || !viewerId) return null;
      return { type: "attaching", terminalId, viewerId };
    }
    case "viewers": {
      const terminalId = readString(value, "terminalId");
      const count = readCount(value.count);
      const writer = readWriter(value.writer);
      if (!terminalId || count === null || !writer) return null;
      return { type: "viewers", terminalId, count, writer };
    }
    case "pending": {
      const terminalId = readString(value, "terminalId");
      const cliPublicKey = readString(value, "cliPublicKey");
      const cliNonce = readString(value, "cliNonce");
      if (!terminalId || !cliPublicKey || !cliNonce) return null;
      return {
        type: "pending",
        terminalId,
        cliPublicKey,
        cliNonce,
        approvalCode: readString(value, "approvalCode"),
      };
    }
    case "opened":
    case "attached":
      return readHandshake(value, value.type);
    case "rejected": {
      const reason = readString(value, "reason") ?? "rejected";
      return {
        type: "rejected",
        terminalId: readString(value, "terminalId"),
        reason,
        approvalCode: readString(value, "approvalCode"),
      };
    }
    case "exit": {
      const terminalId = readString(value, "terminalId");
      if (!terminalId) return null;
      return {
        type: "exit",
        terminalId,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
        signal: typeof value.signal === "string" ? value.signal : null,
      };
    }
    case "detached": {
      const terminalId = readString(value, "terminalId");
      if (!terminalId) return null;
      const reason = value.reason === "self" || value.reason === "slow" ? value.reason : null;
      return { type: "detached", terminalId, reason };
    }
    case "error": {
      const message =
        readString(value, "message") ?? readString(value, "reason") ?? readString(value, "code");
      return {
        type: "error",
        message: message ?? "error",
        code: readString(value, "code"),
        terminalId: readString(value, "terminalId"),
      };
    }
    default:
      return null;
  }
}

/** Clamp a terminal axis to the protocol range, or reject a non-positive value. */
export function clampTerminalAxis(value: number): number | null {
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(1000, value);
}

export function encodeSealedFrame(frame: {
  terminalId: string;
  seq: number;
  body: Uint8Array;
}): ArrayBuffer {
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) {
    throw new Error("terminal frame seq is out of range");
  }
  if (frame.body.byteLength > TERMINAL_FRAME_BODY_MAX_BYTES) {
    throw new Error("terminal frame body exceeds 1 MiB");
  }
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify({ type: "term.sealed", terminalId: frame.terminalId, seq: frame.seq }),
  );
  if (metadataBytes.byteLength > TERMINAL_FRAME_METADATA_MAX_BYTES) {
    throw new Error("terminal frame metadata exceeds 64 KiB");
  }
  const out = new Uint8Array(4 + metadataBytes.byteLength + frame.body.byteLength);
  new DataView(out.buffer).setUint32(0, metadataBytes.byteLength, false);
  out.set(metadataBytes, 4);
  out.set(frame.body, 4 + metadataBytes.byteLength);
  return out.buffer;
}

export function decodeSealedFrame(frame: ArrayBuffer): SealedTerminalFrame {
  if (frame.byteLength < 4) throw new Error("terminal frame is missing metadata length");
  const metadataLength = new DataView(frame).getUint32(0, false);
  if (metadataLength > TERMINAL_FRAME_METADATA_MAX_BYTES) {
    throw new Error("terminal frame metadata exceeds 64 KiB");
  }
  const bodyLength = frame.byteLength - 4 - metadataLength;
  if (bodyLength < 0) throw new Error("terminal frame metadata length is invalid");
  if (bodyLength > TERMINAL_FRAME_BODY_MAX_BYTES) {
    throw new Error("terminal frame body exceeds 1 MiB");
  }
  const metadataText = new TextDecoder().decode(new Uint8Array(frame, 4, metadataLength));
  const metadata: unknown = JSON.parse(metadataText);
  if (!isRecord(metadata) || metadata.type !== "term.sealed") {
    throw new Error("terminal frame metadata is invalid");
  }
  const terminalId = readString(metadata, "terminalId");
  const seq = metadata.seq;
  if (!terminalId || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("terminal frame metadata is invalid");
  }
  let epoch: number | undefined;
  if (metadata.epoch !== undefined) {
    const raw = metadata.epoch;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > EPOCH_MAX) {
      throw new Error("terminal frame metadata is invalid");
    }
    epoch = raw;
  }
  return {
    terminalId,
    seq,
    ...(epoch !== undefined ? { epoch } : {}),
    body: new Uint8Array(new Uint8Array(frame, 4 + metadataLength, bodyLength)),
  };
}
