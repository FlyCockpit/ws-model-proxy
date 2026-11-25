// ---------------------------------------------------------------------------
// Configuration errors the operator fixes in the environment.
//
// The message is the whole report: it names the variables and the fixes, so
// process entrypoints print only the message (no stack trace) and exit 1 (see
// apps/server/src/boot-error.ts). `pnpm doctor:app` shows the same
// message, because it imports ./server.ts and reports what it throws.
// ---------------------------------------------------------------------------

const ENV_CONFIG_ERROR = Symbol.for("ws-model-proxy.env-config-error");

export class EnvConfigError extends Error {
  readonly [ENV_CONFIG_ERROR] = true;

  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

/** True for an EnvConfigError, also one from a second copy of this module. */
export function isEnvConfigError(error: unknown): error is EnvConfigError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [ENV_CONFIG_ERROR]?: unknown })[ENV_CONFIG_ERROR] === true
  );
}
