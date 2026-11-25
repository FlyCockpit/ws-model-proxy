import { defineConfig } from "tsdown";

export default defineConfig({
  // The process entry is start.ts, emitted as dist/index.mjs (the image's CMD). It imports the
  // boot module, src/index.ts, dynamically, so the boot graph is its own chunk that evaluates after
  // start.ts loaded the root .env, and start.ts reports configuration errors at boot.
  entry: { index: "./src/start.ts" },
  format: "esm",
  outDir: "./dist",
  clean: true,
  deps: {
    alwaysBundle: [/@ws-model-proxy\/.*/],
    // The TanStack Start SSR handler at apps/web/dist/server is imported via a
    // runtime-computed specifier in src/index.ts, so rolldown leaves it external
    // automatically and no entry is needed here.
  },
});
