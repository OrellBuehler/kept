import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // Native/WASM-backed PDF stack must be loaded from node_modules at runtime,
  // not bundled (the zxing WASM binary is resolved relative to the package).
  ssr: {
    external: ["pdfjs-dist", "zxing-wasm", "@napi-rs/canvas", "pdfmake"],
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist", "zxing-wasm", "@napi-rs/canvas", "pdfmake"],
  },
  build: {
    rollupOptions: {
      external: [/^bun:/],
    },
  },
  test: {
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.ts",
      "eslint-rules/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 30000,
    // Fake servers in tests listen on loopback; tests of the default policy unset this.
    env: { KEPT_ALLOW_PRIVATE_NETWORK: "true" },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/routes/**/*.ts"],
      exclude: ["src/lib/components/ui/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
