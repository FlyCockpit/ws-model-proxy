// ---------------------------------------------------------------------------
// Boot errors: what start.ts does when the server's modules fail to evaluate.
//
// An EnvConfigError (packages/env/src/config-error.ts) carries the whole
// operator-facing message, naming the variables and the fixes, so only that
// message is printed: no stack trace. Any other error is printed whole, stack
// included, as Node would. Both exit 1.
// ---------------------------------------------------------------------------

import { isEnvConfigError } from "@ws-model-proxy/env/config-error";

type Output = { error: (message: unknown) => void; exit: (code: number) => never | void };

const processOutput: Output = {
  error: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

export function reportBootError(error: unknown, output: Output = processOutput): void {
  output.error(isEnvConfigError(error) ? `[server] FATAL: ${error.message}` : error);
  output.exit(1);
}
