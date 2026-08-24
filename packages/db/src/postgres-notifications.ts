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

  async close() {
    await this.#client.end();
  }
}
