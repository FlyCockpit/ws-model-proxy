import { describe, expect, it, vi } from "vitest";

import {
  type AuthSessionData,
  classifyAuthSession,
  nextConfirmedAuthSession,
} from "./auth-session-state";

const actions = { refetch: vi.fn(), retry: vi.fn() };
const session: AuthSessionData = {
  user: {
    id: "u1",
    name: "User One",
    email: "u1@example.com",
    emailVerified: true,
    role: "user",
    twoFactorEnabled: false,
  },
};

describe("classifyAuthSession", () => {
  it("returns pending before the first session result", () => {
    expect(classifyAuthSession({ data: null, isPending: true, actions }).state.status).toBe(
      "pending",
    );
  });

  it("returns authenticated when Better Auth has session data", () => {
    const result = classifyAuthSession({ data: session, actions });

    expect(result.state).toEqual({ status: "authenticated", session });
    expect(result.meta.isDegraded).toBe(false);
  });

  it("treats explicit 401 as anonymous", () => {
    const result = classifyAuthSession({
      data: null,
      error: { status: 401 },
      actions,
    });

    expect(result.state.status).toBe("anonymous");
  });

  it("treats resolved null session as anonymous", () => {
    const result = classifyAuthSession({ data: null, actions });

    expect(result.state.status).toBe("anonymous");
  });

  it("keeps confirmed session data during transient errors", () => {
    const result = classifyAuthSession({
      data: null,
      confirmedSession: session,
      error: new Error("network failed"),
      actions,
    });

    expect(result.state).toEqual({ status: "authenticated", session });
    expect(result.meta.isDegraded).toBe(true);
  });

  it("marks retained offline sessions as degraded while pending", () => {
    const result = classifyAuthSession({
      data: null,
      confirmedSession: session,
      isPending: true,
      isOffline: true,
      actions,
    });

    expect(result.state).toEqual({ status: "authenticated", session });
    expect(result.meta).toMatchObject({ isOffline: true, isRefetching: true, isDegraded: true });
  });

  it("returns error when there is no confirmed session to retain", () => {
    const error = new Error("failed");
    const result = classifyAuthSession({ data: null, error, actions });

    expect(result.state).toEqual({ status: "error", session: null, error });
    expect(result.meta.isDegraded).toBe(true);
  });

  it("clears retained sessions after explicit no-session before later transient failures", () => {
    const retained = nextConfirmedAuthSession(null, { data: session });
    expect(retained).toBe(session);

    const cleared = nextConfirmedAuthSession(retained, { data: null, error: { status: 401 } });
    expect(cleared).toBeNull();

    const result = classifyAuthSession({
      data: null,
      confirmedSession: cleared,
      error: new Error("network failed"),
      actions,
    });

    expect(result.state.status).toBe("error");
  });
});
