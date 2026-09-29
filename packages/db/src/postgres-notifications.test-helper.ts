import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POSTGRES_NOTIFICATION_LISTENER_CLOSE_TIMEOUT_MS,
  PostgresNotificationListener,
} from "./postgres-notifications";

const { clients } = vi.hoisted(() => ({
  clients: [] as Array<{
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

// No socket opens: the listener's Client is a double whose end() the test
// controls and whose connection stream records destroy().
vi.mock("pg", () => ({
  Client: class {
    readonly end = vi.fn<() => Promise<void>>();
    readonly connection = { stream: { destroy: vi.fn() } };
    constructor() {
      clients.push({ end: this.end, destroy: this.connection.stream.destroy });
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  clients.length = 0;
});

describe("PostgresNotificationListener.close", () => {
  it("ends gracefully without destroying the socket or leaving a timer", async () => {
    vi.useFakeTimers();
    const listener = new PostgresNotificationListener("postgresql://localhost/test");
    const client = clients[0]!;
    client.end.mockResolvedValue(undefined);
    await listener.close();
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys the socket when end() stalls past the close bound", async () => {
    vi.useFakeTimers();
    const listener = new PostgresNotificationListener("postgresql://localhost/test");
    const client = clients[0]!;
    client.end.mockReturnValue(new Promise<void>(() => undefined));
    let settled = false;
    const closing = listener.close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(POSTGRES_NOTIFICATION_LISTENER_CLOSE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(client.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a rejected end() as closed without destroying", async () => {
    vi.useFakeTimers();
    const listener = new PostgresNotificationListener("postgresql://localhost/test");
    const client = clients[0]!;
    client.end.mockRejectedValue(new Error("already ended"));
    await expect(listener.close()).resolves.toBeUndefined();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
