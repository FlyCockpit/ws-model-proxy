/** Post-commit, process-local recovery notification. Never emitted on password change. */
export type MachineCredentialsRevokedListener = (userId: string) => void | Promise<void>;

const listeners = new Set<MachineCredentialsRevokedListener>();

/** Subscribes a listener; returns its unsubscribe function. Idempotent per function. */
export function onMachineCredentialsRevoked(
  listener: MachineCredentialsRevokedListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs every listener for a committed ban. A listener failure is logged (class
 * only) and never thrown, and never stops the listeners after it: the ban
 * already happened and must not be reported as failed.
 */
export async function notifyMachineCredentialsRevoked(userId: string): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener(userId);
    } catch (error) {
      console.error(
        "[auth] machine credential listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}
