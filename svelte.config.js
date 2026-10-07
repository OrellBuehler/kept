import adapter from "./scripts/adapter-bun.js";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      precompress: true,
    }),
    // "auto" lets SvelteKit add nonces (rendered pages) or hashes (prerendered
    // pages) for its own inline bootstrap script. Styles stay 'unsafe-inline'
    // because Svelte and the UI components set style attributes at runtime.
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:", "blob:"],
        "font-src": ["self", "data:"],
        "connect-src": ["self"],
        "frame-src": ["self"],
        "frame-ancestors": ["none"],
        "object-src": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
      },
    },
  },
};

export default config;
