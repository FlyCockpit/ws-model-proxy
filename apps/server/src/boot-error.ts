// ---------------------------------------------------------------------------
// Boot errors: what start.ts does when the server's modules fail to evaluate.
//
// Configuration and password pepper key errors carry operator-facing fixes,
// so only their message is printed: no stack trace. Any other error is printed
// whole, stack included, as Node would. Both exit 1.
// ---------------------------------------------------------------------------

import { isEnvConfigError } from "@ws-model-proxy/env/config-error";

type Output = { error: (message: unknown) => void; exit: (code: number) => never | void };

const processOutput: Output = {
  error: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

function isPasswordPepperKeyError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    Reflect.get(error, Symbol.for("ws-model-proxy.password-pepper-key-error")) === true
  );
}

export function reportBootError(error: unknown, output: Output = processOutput): void {
  output.error(
    isEnvConfigError(error) || isPasswordPepperKeyError(error)
      ? `[server] FATAL: ${error.message}`
      : error,
  );
  output.exit(1);
}
