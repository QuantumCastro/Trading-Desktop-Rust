import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import { ViteImageOptimizer } from "vite-plugin-image-optimizer";

const enableImageOptimizer = process.env.ENABLE_IMAGE_OPTIMIZER === "true";

export default defineConfig({
  output: "static",
  srcDir: "src",
  prefetch: true,
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: true,
    }),
  ],
  build: {
    format: "file",
  },
  vite: {
    plugins: [
      enableImageOptimizer
        ? ViteImageOptimizer({
            includePublic: true,
            logStats: true,
          })
        : null,
    ].filter(Boolean),
  },
});
