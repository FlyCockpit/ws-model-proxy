import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// public/logo.png is a full-bleed square whose edges are this colour.
const logoEdgeColor = "#0e1230";

export default defineConfig({
  headLinkOptions: {
    preset: "2023",
  },
  preset: {
    ...minimal2023Preset,
    // iOS masks the corners itself. Any padding here is baked into the PNG
    // (white by default) and shows up as a frame on the home screen.
    apple: {
      ...minimal2023Preset.apple,
      padding: 0,
      resizeOptions: { background: logoEdgeColor },
    },
    // Keep the default padding so the artwork stays inside Android's circular
    // safe zone, but pad with the logo's edge colour instead of white.
    maskable: {
      ...minimal2023Preset.maskable,
      resizeOptions: { background: logoEdgeColor },
    },
  },
  images: ["public/logo.png"],
});
