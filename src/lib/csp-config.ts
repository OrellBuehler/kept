import type { Config } from "@sveltejs/kit/vite";

// "auto" lets SvelteKit add nonces (rendered pages) or hashes (prerendered
// pages) for its own inline bootstrap script. Styles stay 'unsafe-inline'
// because Svelte and the UI components set style attributes at runtime.
export const csp: NonNullable<Config["csp"]> = {
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
};
