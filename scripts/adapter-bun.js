import { readFileSync, writeFileSync } from "node:fs";
import adapter from "svelte-adapter-bun";

export const SERVICE_WORKER_PATH = /^\/(sw|workbox-[\w-]+)\.js$/;

const IMMUTABLE_CHECK =
  "if (pathname.startsWith(`/${manifest.appDir}/immutable/`)) {";

/**
 * svelte-adapter-bun serves build/client before SvelteKit's hooks run, so
 * hooks.server.ts never sees the service worker request. Its static handler
 * sets Cache-Control for immutable assets only; this adds no-cache for the
 * service worker script and its workbox runtime.
 *
 * @param {string} handler
 * @returns {string}
 */
export function withServiceWorkerHeaders(handler) {
  if (!handler.includes(IMMUTABLE_CHECK)) {
    throw new Error(
      "svelte-adapter-bun changed: cannot add Cache-Control for the service worker",
    );
  }
  return handler.replace(
    IMMUTABLE_CHECK,
    () => `if (${SERVICE_WORKER_PATH}.test(pathname)) {
          headers.set("cache-control", "no-cache");
        } else ${IMMUTABLE_CHECK}`,
  );
}

/**
 * @param {NonNullable<Parameters<typeof adapter>[0]>} [options]
 * @returns {import("@sveltejs/kit").Adapter}
 */
export default function adapterBun(options = {}) {
  const inner = adapter(options);
  return {
    ...inner,
    async adapt(builder) {
      await inner.adapt(builder);
      const file = `${options.out ?? "build"}/handler.js`;
      writeFileSync(file, withServiceWorkerHeaders(readFileSync(file, "utf8")));
    },
  };
}
