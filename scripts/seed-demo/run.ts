#!/usr/bin/env bun
/**
 * Fills a running Kept server with a synthetic example household, for the people who review the
 * phone apps for the app stores. It only uses what the apps use (`/api/app/v1`): it signs in as the
 * account whose data it fills, creates records through the pages' form actions and imports
 * generated camt.053 statements through the upload, preview and confirm flow. Nothing is made up
 * on the server's side, and a second run adds nothing that is already there.
 *
 *   KEPT_SEED_USERNAME=reviewer KEPT_SEED_PASSWORD=… bun scripts/seed-demo/run.ts --url https://kept.example.org
 *   … --today 2026-12-24      pretend it is another day (the server's own date is used otherwise)
 *
 * The session it opens is ended at the end, also when a step fails, and the script checks that the
 * token stopped working. It creates no API tokens and leaves the account's password, username,
 * two-step sign-in and preferences alone.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { ApiError, Client, parseServerUrl, type Fetch } from "./client";
import { Interrupted, seed } from "./seed";

const credentials = z.object({
  KEPT_SEED_USERNAME: z.string().min(1),
  KEPT_SEED_PASSWORD: z.string().min(1),
});

const day = z.iso.date();

const USAGE =
  "usage: KEPT_SEED_USERNAME=… KEPT_SEED_PASSWORD=… bun scripts/seed-demo/run.ts --url <server address> [--today YYYY-MM-DD]";

export interface RunOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fetch?: Fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof z.ZodError) {
    const where = err.issues
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    return `unexpected answer from the server (${where})`;
  }
  return err instanceof Error ? err.message : "unknown error";
}

export async function run(options: RunOptions): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  let args;
  try {
    args = parseArgs({
      args: options.argv,
      options: { url: { type: "string" }, today: { type: "string" } },
      strict: true,
    }).values;
  } catch (err) {
    error(`${describe(err)}\n${USAGE}`);
    return 2;
  }
  const env = credentials.safeParse(options.env);
  const today = args.today === undefined ? null : day.safeParse(args.today);
  if (!args.url || !env.success || (today && !today.success)) {
    error(
      !env.success
        ? `set ${env.error.issues.map((i) => i.path.join("")).join(" and ")}\n${USAGE}`
        : USAGE,
    );
    return 2;
  }
  let origin;
  try {
    origin = parseServerUrl(args.url);
  } catch (err) {
    error(describe(err));
    return 2;
  }

  const api = new Client(origin, options.fetch);
  let code = 0;
  const signOut = async () => {
    if (!api.signedIn) return;
    try {
      const revoked = await api.signOut();
      if (revoked) log("signed out: the session no longer works");
      else {
        error(
          "warning: the session could not be ended or still works; it ends by itself after 30 days",
        );
        code = 1;
      }
    } catch (err) {
      error(`warning: signing out failed: ${describe(err)}`);
      code = 1;
    }
  };
  let stopping = false;
  const interrupted = () => {
    if (stopping) {
      void signOut().then(() => process.exit(130));
      return;
    }
    stopping = true;
    error(
      "interrupted: finishing the current step, then signing out (press again to stop now)",
    );
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    await api.signIn(env.data.KEPT_SEED_USERNAME, env.data.KEPT_SEED_PASSWORD);
    log("signed in");
    await seed({
      api,
      today: today?.data ?? (await api.session()).today,
      log,
      stopped: () => stopping,
    });
  } catch (err) {
    error(err instanceof Interrupted ? "stopped" : `failed: ${describe(err)}`);
    code = err instanceof Interrupted ? 130 : 1;
  } finally {
    await signOut();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
  return code;
}

if (import.meta.main) {
  process.exit(await run({ argv: Bun.argv.slice(2), env: process.env }));
}
