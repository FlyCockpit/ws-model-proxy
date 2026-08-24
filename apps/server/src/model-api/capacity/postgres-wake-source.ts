import { PostgresNotificationListener } from "@ws-model-proxy/db/postgres-notifications";
import type { CapacityWakeSource } from "./postgres-store.js";

export interface NotificationConnection {
  connect(): Promise<void>;
  wait(timeoutMs: number): Promise<string | null>;
  close(): Promise<void>;
}

type PendingWaiter = {
  capacityIds: ReadonlySet<string>;
  finish: () => void;
};

export class PostgresCapacityWakeSource implements CapacityWakeSource {
  private connection?: NotificationConnection;
  private connecting?: Promise<NotificationConnection>;
  private readonly pending = new Set<PendingWaiter>();
  private pumping = false;
  private closed = false;

  constructor(
    private readonly createConnection: () => NotificationConnection,
    private readonly reconnectBackoffMs = 50,
  ) {}

  static production(connectionString: string) {
    return new PostgresCapacityWakeSource(
      () => new PostgresNotificationListener(connectionString, "wsmp_capacity"),
    );
  }

  wait(capacityIds: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted || timeoutMs <= 0) return Promise.resolve();
    const allowed = new Set(capacityIds.filter((id) => id.length > 0));
    if (allowed.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.pending.delete(waiter);
        resolve();
      };
      const waiter: PendingWaiter = { capacityIds: allowed, finish };
      timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      this.pending.add(waiter);
      void this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.pending]) waiter.finish();
    const connection = this.connection;
    this.connection = undefined;
    await connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<NotificationConnection> {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = (async () => {
        const connection = this.createConnection();
        await connection.connect();
        if (this.closed) {
          await connection.close().catch(() => undefined);
          throw new Error("Capacity wake source is closed.");
        }
        this.connection = connection;
        return connection;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.pending.size > 0) {
        try {
          const payload = await (await this.connect()).wait(1_000);
          if (!payload) continue;
          for (const waiter of [...this.pending]) {
            if (waiter.capacityIds.has(payload)) waiter.finish();
          }
        } catch {
          const failed = this.connection;
          this.connection = undefined;
          await failed?.close().catch(() => undefined);
          if (!this.closed)
            await new Promise((resolve) => setTimeout(resolve, this.reconnectBackoffMs));
        }
      }
    } finally {
      this.pumping = false;
      if (!this.closed && this.pending.size > 0) void this.pump();
    }
  }
}
