import { z } from "zod";

// Zod's JIT probes `new Function`, which the Content Security Policy blocks
// (and reports). Parsing still works without it, so skip the probe.
z.config({ jitless: true });
