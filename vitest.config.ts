import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    passWithNoTests: true,
    // Local `.env` for any test that imports real env validation (most mock it).
    // Production CI injects env or relies on mocks; missing file is a no-op.
    setupFiles: ["@ws-model-proxy/env/load-dotenv"],
    exclude: [...configDefaults.exclude, "**/dist/**", "**/dev-dist/**"],
  },
});
