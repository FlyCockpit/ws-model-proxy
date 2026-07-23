// ---------------------------------------------------------------------------
// Side-effect entrypoint for process boots.
//
// packages/env validation modules (shared, server, web) only read process.env.
// They never import this file. Call this from process entrypoints BEFORE any
// import that validates env (server boot, Vite config, seeds, scripts, vitest
// setup). See scripts/check-load-dotenv-contract.ts for the enforced list.
//
// Pure helpers live in ./root-dotenv.ts — import those when you need
// loadRootDotenv() without an import-time side effect (e.g. prisma.config.ts).
//
// Production containers inject env vars and ship no .env file — loading is a
// no-op when the resolved `.env` file is absent. Existing process.env values
// win (dotenv default).
// ---------------------------------------------------------------------------

import { loadRootDotenv, warnIfStaleServerEnv } from "./root-dotenv.js";

export {
  findRepoRoot,
  loadRootDotenv,
  resolveRootEnvPath,
  warnIfStaleServerEnv,
} from "./root-dotenv.js";

loadRootDotenv();
warnIfStaleServerEnv();
