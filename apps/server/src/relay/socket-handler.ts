/** Catch a fire-and-forget websocket handler. Log only the error's constructor name. */
export function settleSocketHandler(operation: string, task: Promise<unknown>): void {
  void task.catch((error: unknown) => {
    const label = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
    console.error(`[relay] ${operation} failed (${label})`);
  });
}
