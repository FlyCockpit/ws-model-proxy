export type RelayBodySource = {
  readonly kind: "empty" | "memory" | "spool";
  readonly size: number;
  open(): AsyncIterable<Uint8Array>;
  dispose(): Promise<void>;
};
