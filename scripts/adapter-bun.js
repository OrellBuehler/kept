import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import adapter from "@sveltejs/adapter-bun";

export const SERVICE_WORKER_FILE = /[\\/]client[\\/](sw|workbox-[\w-]+)\.js$/;

const FILE_ENTRY = "function file_entry(file,";
const IMMUTABLE_HEADER =
  /if \(immutable\) (base_headers\[["']cache-control["']\]) = ["']public,max-age=31536000,immutable["'];/;

/**
 * The adapter serves build/client with Bun routes before SvelteKit's hooks
 * run, so hooks.server.ts never sees the service worker request. Its static
 * routes set Cache-Control for immutable assets only; this adds no-cache for
 * the service worker script and its workbox runtime.
 *
 * @param {string} source
 * @returns {string}
 */
export function withServiceWorkerHeaders(source) {
  if (!source.includes(FILE_ENTRY) || !IMMUTABLE_HEADER.test(source)) {
    throw new Error(
      "@sveltejs/adapter-bun changed: cannot add Cache-Control for the service worker",
    );
  }
  return source.replace(
    IMMUTABLE_HEADER,
    (line, header) =>
      `${line} else if (${SERVICE_WORKER_FILE}.test(file)) ${header} = "no-cache";`,
  );
}

/**
 * @vite-pwa/sveltekit 1.x generates the service worker in the SSR build's
 * closeBundle, which SvelteKit 3 runs before the client build, so no worker is
 * written. Generate it here, after SvelteKit's build and before the adapter
 * copies the client output. Skipped once the plugin writes sw.js itself.
 * (2.x does, but needs node:module's findPackageJSON, which Bun lacks.)
 *
 * @param {import("@sveltejs/kit").Builder} builder
 * @param {Record<string, unknown>} workbox
 */
async function generateServiceWorker(builder, workbox) {
  const client = builder.getClientDirectory();
  if (existsSync(join(client, "sw.js"))) return;
  const mod = await import("workbox-build");
  const generateSW = mod.generateSW ?? mod.default.generateSW;
  const result = await generateSW({
    swDest: join(client, "sw.js"),
    globDirectory: dirname(client),
    globIgnores: ["server/**"],
    offlineGoogleAnalytics: false,
    cleanupOutdatedCaches: true,
    dontCacheBustURLsMatching: new RegExp(
      `${builder.config.appDir}/immutable/`,
    ),
    mode: "production",
    sourcemap: false,
    ...workbox,
  });
  for (const warning of result.warnings) builder.log.warn(warning);
  builder.log.minor(
    `Service worker precaches ${result.count} files (${result.size} bytes)`,
  );
}

/**
 * @param {NonNullable<Parameters<typeof adapter>[0]> & { workbox?: Record<string, unknown> }} [options]
 * @returns {import("@sveltejs/kit").Adapter}
 */
export default function adapterBun({ workbox, ...options } = {}) {
  const inner = adapter(options);
  const out = options.out ?? "build";
  return {
    ...inner,
    async adapt(builder) {
      if (workbox) await generateServiceWorker(builder, workbox);
      await inner.adapt(builder);
      const routes = `${out}/server/adapter-index.js`;
      writeFileSync(
        routes,
        withServiceWorkerHeaders(readFileSync(routes, "utf8")),
      );
    },
  };
}
