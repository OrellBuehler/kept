import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import adapter from "@sveltejs/adapter-bun";

export const SERVICE_WORKER_PATH = /^(sw|workbox-[\w-]+)\.js$/;

const IMMUTABLE_HEADERS =
  /immutable \? (\{[^{}]*max-age=31536000[^{}]*\}) : \{\}/;
const ORIGIN_EXPORT = /^export const origin = (.*);$/m;

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
  if (!IMMUTABLE_HEADERS.test(source)) {
    throw new Error(
      "@sveltejs/adapter-bun changed: cannot add Cache-Control for the service worker",
    );
  }
  return source.replace(
    IMMUTABLE_HEADERS,
    (_, immutable) =>
      `immutable ? ${immutable} : ${SERVICE_WORKER_PATH}.test(url) ? { "cache-control": "no-cache" } : {}`,
  );
}

/**
 * SvelteKit 3 removed the ORIGIN variable and the adapter only knows the
 * build-time `paths.origin`. Without a public origin the adapter assumes
 * https, which rejects form posts when Kept is reached over plain http. This
 * keeps ORIGIN as the runtime setting it has always been.
 *
 * @param {string} source
 * @returns {string}
 */
export function withRuntimeOrigin(source) {
  if (!ORIGIN_EXPORT.test(source)) {
    throw new Error(
      "@sveltejs/adapter-bun changed: cannot read ORIGIN at runtime",
    );
  }
  return source.replace(
    ORIGIN_EXPORT,
    (_, built) =>
      `export const origin = Bun.env.ORIGIN ? new URL(Bun.env.ORIGIN).origin : ${built};`,
  );
}

/**
 * @vite-pwa/sveltekit 1.x generates the service worker in the SSR build's
 * closeBundle, which SvelteKit 3 runs before the client build, so no worker is
 * written. Generate it here, after SvelteKit's build and before the adapter
 * copies the client output. Skipped once the plugin writes sw.js itself.
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
      const handoff = `${out}/adapter-bun.js`;
      writeFileSync(handoff, withRuntimeOrigin(readFileSync(handoff, "utf8")));
    },
  };
}
