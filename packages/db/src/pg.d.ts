declare module "pg" {
  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query(text: string, values?: readonly unknown[]): Promise<unknown>;
    on(
      event: "notification",
      listener: (message: { channel: string; payload?: string }) => void,
    ): this;
    on(event: "error", listener: (error: Error) => void): this;
    off(
      event: "notification",
      listener: (message: { channel: string; payload?: string }) => void,
    ): this;
    off(event: "error", listener: (error: Error) => void): this;
    end(): Promise<void>;
  }
}
