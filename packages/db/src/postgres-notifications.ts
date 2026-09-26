import { Client } from "pg";

/** When `Client.end()` waits on a stalled peer, destroy the socket after this bound. */
export const POSTGRES_NOTIFICATION_LISTENER_CLOSE_TIMEOUT_MS = 2_000;

function destroyPgClientSocket(client: Client): void {
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } })
    .connection?.stream;
  stream?.destroy?.();
}

export class PostgresNotificationListener {
  readonly #client: Client;
  readonly #channel: string;

  constructor(connectionString: string, channel = "wsmp_capacity") {
    if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) throw new Error("Invalid PostgreSQL channel.");
    this.#client = new Client({ connectionString });
    this.#channel = channel;
  }

  async connect() {
    await this.#client.connect();
    await this.#client.query(`LISTEN ${this.#channel}`);
  }

  async wait(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const finish = (payload: string | null) => {
        clearTimeout(timer);
        this.#client.off("notification", notification);
        this.#client.off("error", failed);
        resolve(payload);
      };
      const failed = (error: Error) => {
        clearTimeout(timer);
        this.#client.off("notification", notification);
        this.#client.off("error", failed);
        reject(error);
      };
      const notification = (message: { channel: string; payload?: string }) => {
        if (message.channel === this.#channel) finish(message.payload ?? "");
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.#client.on("notification", notification);
      this.#client.on("error", failed);
    });
  }

  async close(
    closeTimeoutMs: number = POSTGRES_NOTIFICATION_LISTENER_CLOSE_TIMEOUT_MS,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const endSettled = this.#client.end().catch(() => undefined);
    try {
      const result = await Promise.race([
        endSettled.then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), closeTimeoutMs);
          timer.unref();
        }),
      ]);
      if (result === "timeout") destroyPgClientSocket(this.#client);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    void endSettled;
  }
}
