import type { SvelteKitPWAOptions } from "@vite-pwa/sveltekit";

// Everything here is public, content-hashed or identical for every user. Pages,
// __data.json, /api, form actions, bill documents and institution logos sit
// behind the session, so they are never precached and never get a caching
// route: the only runtime route is network-only and exists to show the offline
// page when a navigation fails. Cache Storage therefore never holds user data,
// which is why logging out has no cache to clear.
export const PRECACHE_GLOBS = [
  "client/_app/immutable/**/*.{js,css,woff,woff2,svg,png,webp,ico}",
  "client/brand/*.svg",
  "client/*.{ico,png,svg}",
  "client/theme-init.js",
  "client/offline.{html,css}",
];

export const pwaOptions: Partial<SvelteKitPWAOptions> = {
  // SvelteKit 3 builds with Vite's base set to "./", which would register
  // "./sw.js" relative to the page and give it the page's directory as scope.
  base: "/",
  registerType: "prompt",
  injectRegister: false,
  manifest: false,
  workbox: {
    // The SvelteKit plugin sets this to "/" when the key is missing; pages are
    // rendered per request behind a session, so there is no app shell to serve.
    navigateFallback: undefined,
    globPatterns: PRECACHE_GLOBS,
    // Setting these keeps the SvelteKit plugin from adding prerendered HTML and
    // the web manifest to the precache and from rewriting .html URLs.
    modifyURLPrefix: { "client/": "" },
    manifestTransforms: [],
    runtimeCaching: [
      {
        urlPattern: ({ request }) => request.mode === "navigate",
        handler: "NetworkOnly",
        options: {
          plugins: [
            {
              handlerDidError: () =>
                caches.match("/offline.html", { ignoreSearch: true }),
            },
          ],
        },
      },
    ],
  },
};
