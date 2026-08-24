import { Client } from "pg";

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
    return new Promise((resolve) => {
      const finish = (payload: string | null) => {
        clearTimeout(timer);
        this.#client.off("notification", notification);
        resolve(payload);
      };
      const notification = (message: { channel: string; payload?: string }) => {
        if (message.channel === this.#channel) finish(message.payload ?? "");
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.#client.on("notification", notification);
    });
  }

  async close() {
    await this.#client.end();
  }
}
