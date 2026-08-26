import { describe, expect, it, vi } from "vitest";
import { type NotificationConnection, PostgresCapacityWakeSource } from "./postgres-wake-source.js";

class FakeConnection implements NotificationConnection {
  readonly connect = vi.fn().mockResolvedValue(undefined);
  readonly close = vi.fn().mockResolvedValue(undefined);
  private waits: Array<{
    resolve: (payload: string | null) => void;
    reject: (error: Error) => void;
  }> = [];
  get waiting() {
    return this.waits.length;
  }

  wait() {
    return new Promise<string | null>((resolve, reject) => this.waits.push({ resolve, reject }));
  }

  emit(payload: string) {
    this.waits.shift()?.resolve(payload);
  }

  fail() {
    this.waits.shift()?.reject(new Error("connection lost"));
  }
}

describe("PostgresCapacityWakeSource", () => {
  it("fans out capacity-ID-only notifications to matching waiters", async () => {
    const connection = new FakeConnection();
    const wake = new PostgresCapacityWakeSource(() => connection, 0);
    const capacityA = vi.fn();
    const capacityB = vi.fn();
    const waitA = wake.wait(["capacity-a"], 5_000).then(capacityA);
    const waitB = wake.wait(["capacity-b"], 5_000).then(capacityB);
    await vi.waitFor(() => expect(connection.connect).toHaveBeenCalledTimes(1));

    connection.emit("prompt text that is not a capacity id");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capacityA).not.toHaveBeenCalled();
    expect(capacityB).not.toHaveBeenCalled();
    connection.emit("capacity-a");
    await waitA;
    expect(capacityA).toHaveBeenCalledTimes(1);
    expect(capacityB).not.toHaveBeenCalled();
    connection.emit("capacity-b");
    await waitB;
    await wake.close();
  });

  it("reconnects after listener failure and closes without stranded waiters", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const wake = new PostgresCapacityWakeSource(create, 0);
    const waiting = wake.wait(["capacity-a"], 5_000);
    await vi.waitFor(() => expect(first.connect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(first.waiting).toBe(1));
    first.fail();
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));
    second.emit("capacity-a");
    await waiting;

    const stranded = wake.wait(["capacity-b"], 5_000);
    await wake.close();
    await stranded;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    await expect(wake.wait(["capacity-c"], 5_000)).resolves.toBeUndefined();
  });
});
