import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // Native/WASM-backed PDF stack must be loaded from node_modules at runtime,
  // not bundled (the zxing WASM binary is resolved relative to the package).
  ssr: {
    external: ["unpdf", "zxing-wasm", "@napi-rs/canvas", "pdfmake"],
  },
  optimizeDeps: {
    exclude: ["unpdf", "zxing-wasm", "@napi-rs/canvas", "pdfmake"],
  },
  build: {
    rollupOptions: {
      external: [/^bun:/],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/components/ui/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
