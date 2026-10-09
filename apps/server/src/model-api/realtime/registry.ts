import { capacityLeaseLostSignal } from "../capacity/lease-loss.js";
import { credentialEndedError, type RealtimeCredentialRef } from "./requester.js";
import {
  type RealtimeAccessVerdict,
  type RealtimeResolvedTarget,
  recheckRealtimeAccess,
} from "./routing.js";
import type {
  RealtimeCandidate,
  RealtimeCandidateLease,
  RealtimeCloseCode,
  RealtimeTranscriptionSession,
} from "./transcription-session.js";
import { REALTIME_CLOSE_CODES } from "./transcription-session.js";

/**
 * Every live transcription client session of this process, from the upgrade
 * on, including sessions still waiting for a model (which hold no relay
 * session, so neither the relay hub's shutdown nor its rechecks reach them).
 *
 * - `closeAll()` (shutdown) ends each with 1001 and refuses later additions.
 * - `recheckSessions()` (every 60 s, relay maintenance) rechecks the
 *   credential (an API key, or a Chat Test dashboard session),
 *   model access and the opened member for each session and ends a session
 *   that lost any of them: 1008 for the credential or the model, 1011 for a
 *   member that is no longer a live-capable route of its target. A lookup that
 *   throws skips that session for one sweep (the terminal rechecks' rule).
 * - A lost capacity lease ends its session with 1011.
 */

export type RealtimeRecheck = (input: {
  credential: RealtimeCredentialRef;
  userId: string;
  model: string | null;
  resolved: RealtimeResolvedTarget | null;
  candidate: RealtimeCandidate | null;
}) => Promise<RealtimeAccessVerdict>;

type Terminable = Pick<RealtimeTranscriptionSession, "terminate">;

type Entry = {
  session: Terminable;
  credential: RealtimeCredentialRef;
  userId: string;
  model: string | null;
  resolved: RealtimeResolvedTarget | null;
  candidate: RealtimeCandidate | null;
  checking: boolean;
  /** Asked to recheck while a check was running (it may have read the old state). */
  again?: boolean;
};

export type RealtimeRegistration = {
  /** The router resolved the model (routing started). */
  resolved(target: RealtimeResolvedTarget, model: string): void;
  /** The session opened on `candidate`; a lost `lease` ends it with 1011. */
  opened(candidate: RealtimeCandidate, lease: RealtimeCandidateLease | null): void;
  /** The session ended; idempotent. */
  remove(): void;
};

const RECHECK_CONCURRENCY = 16;

type Denial = {
  close: RealtimeCloseCode;
  type: "invalid_request_error" | "server_error";
  code: string;
  message: string;
};

function denial(
  reason: "credential" | "model" | "member",
  kind: RealtimeCredentialRef["kind"],
): Denial {
  switch (reason) {
    case "credential":
      return {
        close: REALTIME_CLOSE_CODES.policy,
        type: "invalid_request_error",
        ...credentialEndedError(kind),
      };
    case "model":
      return {
        close: REALTIME_CLOSE_CODES.policy,
        type: "invalid_request_error",
        code: "model_not_found",
        message:
          kind === "token"
            ? "The model is no longer available to this API key."
            : "The model is no longer available to you.",
      };
    case "member":
      return {
        close: REALTIME_CLOSE_CODES.internal,
        type: "server_error",
        code: "model_unavailable",
        message: "The model's live transcription member is no longer available.",
      };
  }
}

export class RealtimeSessionRegistry {
  private readonly entries = new Set<Entry>();
  private closed = false;

  constructor(
    private readonly recheck: RealtimeRecheck = ({
      credential,
      userId,
      model,
      resolved,
      candidate,
    }) => recheckRealtimeAccess({ credential, userId, model, resolved, candidate, config: {} }),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get closing(): boolean {
    return this.closed;
  }

  /** Null after `closeAll()`: the caller must refuse the session (1001). */
  add(
    session: Terminable,
    credential: RealtimeCredentialRef,
    userId: string,
  ): RealtimeRegistration | null {
    if (this.closed) return null;
    const entry: Entry = {
      session,
      credential,
      userId,
      model: null,
      resolved: null,
      candidate: null,
      checking: false,
    };
    this.entries.add(entry);
    return {
      resolved: (target, model) => {
        entry.resolved = target;
        entry.model = model;
      },
      opened: (candidate, lease) => {
        entry.candidate = candidate;
        const signal = lease?.signal;
        if (!signal) return;
        const onLoss = () => {
          if (!capacityLeaseLostSignal(signal)) return;
          entry.session.terminate(REALTIME_CLOSE_CODES.internal, {
            type: "server_error",
            code: "capacity_lease_lost",
            message: "The session lost its execution capacity.",
          });
        };
        if (signal.aborted) onLoss();
        else signal.addEventListener("abort", onLoss, { once: true });
      },
      remove: () => {
        this.entries.delete(entry);
      },
    };
  }

  /**
   * A user was banned, marked for deletion or deleted (review 6b L3): their
   * own sessions end at once (1008), and sessions served by their engines or
   * pools end too (1011), without waiting for the 60 s recheck.
   */
  terminateForUser(userId: string) {
    for (const entry of [...this.entries]) {
      const route = entry.candidate?.route;
      if (entry.userId === userId) {
        this.end(entry, "credential");
      } else if (route && (route.ownerUserId === userId || route.engineOwnerUserId === userId)) {
        this.end(entry, "member");
      }
    }
  }

  /** An API key was revoked: its sessions end at once (1008). */
  terminateForToken(tokenId: string) {
    for (const entry of [...this.entries]) {
      if (entry.credential.kind === "token" && entry.credential.tokenId === tokenId) {
        this.end(entry, "credential");
      }
    }
  }

  private end(entry: Entry, reason: "credential" | "model" | "member") {
    this.entries.delete(entry);
    const ended = denial(reason, entry.credential.kind);
    entry.session.terminate(ended.close, {
      type: ended.type,
      code: ended.code,
      message: ended.message,
    });
  }

  /** Shutdown: every session ends with 1001; later additions are refused. */
  closeAll() {
    this.closed = true;
    for (const entry of [...this.entries]) {
      this.entries.delete(entry);
      entry.session.terminate(REALTIME_CLOSE_CODES.goingAway, {
        type: "server_error",
        code: "server_shutting_down",
        message: "The server is shutting down.",
      });
    }
  }

  /**
   * A person's access changed (a share was revoked): recheck their sessions now. A session
   * mid-check is rechecked once more after it (that check may have read the old state).
   */
  async recheckForUser(userId: string): Promise<void> {
    const mine = [...this.entries].filter((entry) => entry.userId === userId);
    for (const entry of mine) if (entry.checking) entry.again = true;
    const pending = mine.filter((entry) => !entry.checking);
    for (let index = 0; index < pending.length; index += RECHECK_CONCURRENCY) {
      await Promise.all(
        pending.slice(index, index + RECHECK_CONCURRENCY).map((entry) => this.recheckOne(entry)),
      );
    }
  }

  async recheckSessions(): Promise<void> {
    const pending = [...this.entries].filter((entry) => !entry.checking);
    for (let index = 0; index < pending.length; index += RECHECK_CONCURRENCY) {
      await Promise.all(
        pending.slice(index, index + RECHECK_CONCURRENCY).map((entry) => this.recheckOne(entry)),
      );
    }
  }

  private async recheckOne(entry: Entry) {
    entry.checking = true;
    let verdict: RealtimeAccessVerdict;
    try {
      verdict = await this.recheck({
        credential: entry.credential,
        userId: entry.userId,
        model: entry.model,
        resolved: entry.resolved,
        candidate: entry.candidate,
      });
    } catch (error) {
      // Like the terminal rechecks: a failed lookup skips this sweep for the
      // session (the next one, 60 s later, decides). Never a pass recorded.
      console.error(
        "[realtime] session recheck failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
      return;
    } finally {
      entry.checking = false;
    }
    if (!verdict.ok && this.entries.has(entry)) {
      this.end(entry, verdict.reason);
      return;
    }
    if (entry.again && this.entries.has(entry)) {
      entry.again = false;
      await this.recheckOne(entry);
    }
  }
}

export const realtimeSessionRegistry = new RealtimeSessionRegistry();
