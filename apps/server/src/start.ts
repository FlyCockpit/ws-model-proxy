// ---------------------------------------------------------------------------
// Server process entry (built as dist/index.mjs; see tsdown.config.ts).
//
// Loads the root `.env` (a no-op in production, which injects env vars), then
// imports the boot module, index.ts. The import is dynamic on purpose: the
// whole server graph, env validation included, evaluates only after this
// module ran. A static import would not guarantee that in the tsdown bundle,
// which moves shared modules into chunks that evaluate before the entry's own
// code. A configuration error while the server modules evaluate prints one
// line and exits 1 (boot-error.ts).
// ---------------------------------------------------------------------------

import "@ws-model-proxy/env/load-dotenv";
import { reportBootError } from "./boot-error.js";

try {
  await import("./index.js");
} catch (error) {
  reportBootError(error);
}
