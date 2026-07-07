import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
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
