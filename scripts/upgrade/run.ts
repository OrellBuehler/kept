#!/usr/bin/env bun
/**
 * Upgrade test on real images: builds a database with a published release of Kept, seeds it
 * with the synthetic dataset of `src/lib/testing/fixtures/upgrade/<version>/`, starts the image under test on the same
 * volume, and checks that nothing was lost or changed beyond what the migrations rewrite.
 *
 *   bun scripts/upgrade/run.ts --image kept:test                 every version directory
 *   bun scripts/upgrade/run.ts --image kept:test --from 0.3.0    one version
 *
 * A version is a directory `src/lib/testing/fixtures/upgrade/<version>/` holding `seed.sql` (rows for the schema of that
 * release) and `fixture.ts` (the image tag, the expected result, the HTTP checks). To test an
 * upgrade from a later release, add such a directory; nothing else changes.
 *
 * Steps per version:
 *   1. start the old image on an empty volume: it creates its own schema (its real migrations)
 *   2. stop it, seed the database and the files next to it, snapshot every table
 *   3. start the image under test on the volume (first start: runs the upgrade), stop it,
 *      snapshot again and compare with what the migrations are meant to do
 *   4. start it a second time (nothing to migrate), browse it with the seeded sessions, a
 *      login and an API token, stop it, and check that only activity tables changed
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { compareUpgrade, diffSnapshots, type Snapshot } from "./lib";

const here = import.meta.dir;
const fixtures = join(
  here,
  "..",
  "..",
  "src",
  "lib",
  "testing",
  "fixtures",
  "upgrade",
);
const args = Bun.argv.slice(2);

function option(name: string): string[] {
  const values: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1]) values.push(args[i + 1]);
  });
  return values;
}

const imageUnderTest = option("image")[0] ?? process.env.KEPT_IMAGE;
if (!imageUnderTest) {
  console.error(
    "usage: bun scripts/upgrade/run.ts --image <image> [--from <version>]...",
  );
  process.exit(2);
}
const versions = option("from");
if (versions.length === 0) {
  versions.push(
    ...readdirSync(fixtures, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(),
  );
}
if (versions.length === 0) {
  console.error(`no version directories found in ${fixtures}`);
  process.exit(1);
}

const started = Date.now();
const log = (message: string) =>
  console.log(
    `[${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s] ${message}`,
  );

async function docker(
  argv: string[],
  { allowFailure = false }: { allowFailure?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["docker", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !allowFailure) {
    throw new Error(
      `docker ${argv.slice(0, 3).join(" ")} failed (${code}): ${err.trim()}`,
    );
  }
  return { code, out, err };
}

class Failure extends Error {}

async function freePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

interface Fixture {
  image: string;
  secretKey: string;
  password: string;
  sessionCookies: Record<"alice" | "bob", string>;
  activityTables: string[];
  rowCounts: Record<string, number>;
  baseline: {
    migrations: number;
    lastTag: string;
    lastWhen: number;
    lastHash: string;
  };
  expected: Parameters<typeof compareUpgrade>[2];
  pages: {
    as: "alice" | "bob";
    path: string;
    status: number;
    includes?: string[];
  }[];
  downloads: {
    as: "alice" | "bob";
    path: string;
    mime: string;
    bytes: string;
  }[];
  notFound: { as: "alice" | "bob"; path: string }[];
  apiToken: string;
  checkExternalApi: (
    get: (path: string) => Promise<{ status: number; body: unknown }>,
  ) => Promise<string[]>;
}

async function upgradeFrom(version: string): Promise<void> {
  const fixture = (await import(
    join(fixtures, version, "fixture.ts")
  )) as Fixture;
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const volume = `kept-upgrade-${version}-${suffix}`;
  const containers: string[] = [];
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);

  const mounts = [
    "-v",
    `${volume}:/data`,
    "-v",
    `${here}:/upgrade:ro`,
    "-v",
    `${fixtures}:/fixtures:ro`,
  ];
  const env = ["-e", `KEPT_SECRET_KEY=${fixture.secretKey}`];

  async function start(image: string, name: string): Promise<string> {
    containers.push(name);
    // SvelteKit refuses form posts whose Origin is not the server's own origin (ORIGIN).
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    await docker([
      "run",
      "-d",
      "--name",
      name,
      ...mounts,
      ...env,
      "-e",
      `ORIGIN=${base}`,
      "-p",
      `127.0.0.1:${port}:3000`,
      image,
    ]);
    for (let attempt = 0; attempt < 90; attempt++) {
      const state = (
        await docker(["inspect", "-f", "{{.State.Running}}", name])
      ).out.trim();
      if (state !== "true") break;
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) return base;
      } catch {
        // Not listening yet; the loop gives up after 90 s or when the container exits.
      }
      await Bun.sleep(1000);
    }
    throw new Failure(`${name} did not become healthy`);
  }

  async function stop(name: string): Promise<void> {
    await docker(["stop", "-t", "30", name]);
  }

  const bunIn = (image: string, ...argv: string[]) =>
    docker([
      "run",
      "--rm",
      ...mounts,
      ...env,
      "--entrypoint",
      "bun",
      image,
      ...argv,
    ]);

  async function snapshotOf(image: string): Promise<Snapshot> {
    const { out } = await bunIn(image, "/upgrade/snapshot.ts", "/data/kept.db");
    return JSON.parse(out) as Snapshot;
  }

  try {
    log(`${version}: pulling ${fixture.image}`);
    if (
      (
        await docker(["image", "inspect", fixture.image], {
          allowFailure: true,
        })
      ).code !== 0
    ) {
      await docker(["pull", "--quiet", fixture.image]);
    }
    await docker(["volume", "create", volume]);

    log(`${version}: creating the old database with ${fixture.image}`);
    const old = `kept-upgrade-old-${suffix}`;
    await start(fixture.image, old);
    await stop(old);

    log(`${version}: seeding`);
    await bunIn(
      fixture.image,
      "/upgrade/apply-seed.ts",
      "/data/kept.db",
      version,
    );
    const before = await snapshotOf(fixture.image);
    const rows = Object.values(before.tables).reduce(
      (n, t) => n + t.rows.length,
      0,
    );
    log(
      `${version}: seeded ${Object.keys(before.tables).length} tables, ${rows} rows, ${before.migrations.length} migrations applied`,
    );
    if (
      before.integrityCheck.join() !== "ok" ||
      before.foreignKeyViolations.length > 0
    ) {
      throw new Failure(
        "the seeded database is not consistent before the upgrade",
      );
    }
    const baseline = fixture.baseline;
    const newest = before.migrations.at(-1);
    if (before.migrations.length !== baseline.migrations) {
      fail(
        `the baseline has ${before.migrations.length} migrations applied, expected ${baseline.migrations}`,
      );
    }
    if (
      newest?.hash !== baseline.lastHash ||
      newest?.createdAt !== baseline.lastWhen
    ) {
      fail(`the last baseline migration is not ${baseline.lastTag}`);
    }
    const tables = Object.keys(before.tables).sort();
    if (tables.join() !== Object.keys(fixture.rowCounts).sort().join()) {
      fail(`the baseline has the tables [${tables}]`);
    }
    for (const [table, count] of Object.entries(fixture.rowCounts)) {
      const got = before.tables[table]?.rows.length;
      if (got !== count)
        fail(`${table}: ${got} seeded rows, expected ${count}`);
    }
    if (problems.length > 0) {
      throw new Failure(
        "the seeded baseline is not what the fixture describes",
      );
    }

    log(`${version}: first start of ${imageUnderTest} (runs the migrations)`);
    const upgraded = `kept-upgrade-new-${suffix}`;
    await start(imageUnderTest, upgraded);
    await stop(upgraded);

    const after = await snapshotOf(imageUnderTest);
    for (const p of compareUpgrade(before, after, fixture.expected)) fail(p);
    const journal = JSON.parse(
      (
        await docker([
          "run",
          "--rm",
          "--entrypoint",
          "cat",
          imageUnderTest,
          "/app/drizzle/sqlite/meta/_journal.json",
        ])
      ).out,
    ) as { entries: unknown[] };
    if (after.migrations.length !== journal.entries.length) {
      fail(
        `${after.migrations.length} migrations applied, the image ships ${journal.entries.length}`,
      );
    }
    log(
      `${version}: upgraded, ${after.migrations.length - before.migrations.length} migrations applied, ${problems.length} problems`,
    );

    await bunIn(
      imageUnderTest,
      "/upgrade/add-api-token.ts",
      "/data/kept.db",
      version,
    );

    log(`${version}: second start and browsing`);
    const again = `kept-upgrade-again-${suffix}`;
    const base = await start(imageUnderTest, again);
    for (const p of await browse(base, fixture)) fail(p);
    await stop(again);

    const last = await snapshotOf(imageUnderTest);
    for (const p of diffSnapshots(after, last, fixture.activityTables)) {
      fail(`after browsing: ${p}`);
    }
    if (
      last.integrityCheck.join() !== "ok" ||
      last.foreignKeyViolations.length > 0
    ) {
      fail("the database is not consistent after browsing");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    for (const name of containers) {
      const logs = await docker(["logs", "--tail", "60", name], {
        allowFailure: true,
      });
      console.error(`--- logs of ${name}\n${logs.out}${logs.err}`);
    }
  } finally {
    for (const name of containers)
      await docker(["rm", "-f", name], { allowFailure: true });
    await docker(["volume", "rm", "-f", volume], { allowFailure: true });
  }

  if (problems.length > 0) {
    console.error(`\nUpgrade from ${version} FAILED:`);
    for (const p of problems) console.error(`  - ${p}`);
    throw new Failure(`upgrade from ${version} failed`);
  }
  log(`${version}: ok`);
}

async function browse(base: string, fixture: Fixture): Promise<string[]> {
  const problems: string[] = [];
  const cookie = (as: "alice" | "bob") =>
    `kept_session=${fixture.sessionCookies[as]}`;
  const fetchAs = (as: "alice" | "bob", path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: cookie(as) },
      redirect: "manual",
    });

  for (const page of fixture.pages) {
    const res = await fetchAs(page.as, page.path);
    const html = await res.text();
    if (res.status !== page.status) {
      problems.push(
        `${page.as} GET ${page.path}: status ${res.status}, expected ${page.status}`,
      );
      continue;
    }
    for (const needle of page.includes ?? []) {
      if (!html.includes(needle))
        problems.push(`${page.as} GET ${page.path}: missing "${needle}"`);
    }
  }

  for (const file of fixture.downloads) {
    const res = await fetchAs(file.as, file.path);
    const bytes = await res.text();
    if (res.status !== 200) {
      problems.push(`${file.as} GET ${file.path}: status ${res.status}`);
    } else if (bytes !== file.bytes) {
      problems.push(
        `${file.as} GET ${file.path}: the file differs from what was stored`,
      );
    } else if (!(res.headers.get("content-type") ?? "").startsWith(file.mime)) {
      problems.push(
        `${file.as} GET ${file.path}: content type ${res.headers.get("content-type")}`,
      );
    }
  }

  for (const miss of fixture.notFound) {
    const res = await fetchAs(miss.as, miss.path);
    await res.arrayBuffer();
    if (res.status !== 404) {
      problems.push(
        `${miss.as} GET ${miss.path}: status ${res.status}, expected 404`,
      );
    }
  }

  // The password hashes of the old release must still verify: log in with the form.
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: base,
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
    },
    body: new URLSearchParams({
      username: "alice",
      password: fixture.password,
    }),
  });
  await login.arrayBuffer();
  if (
    login.status !== 303 ||
    !(login.headers.get("set-cookie") ?? "").includes("kept_session=")
  ) {
    problems.push(
      `POST /login: status ${login.status} without a session cookie`,
    );
  }
  const wrong = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: base,
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
    },
    body: new URLSearchParams({
      username: "alice",
      password: "not the password",
    }),
  });
  await wrong.arrayBuffer();
  if (wrong.status === 303)
    problems.push("POST /login with a wrong password was accepted");

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${fixture.apiToken}` },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { status: res.status, body };
  };
  problems.push(...(await fixture.checkExternalApi(get)));
  return problems;
}

let failed = false;
for (const version of versions) {
  try {
    await upgradeFrom(version);
  } catch (error) {
    failed = true;
    if (!(error instanceof Failure)) console.error(error);
  }
}
process.exit(failed ? 1 : 0);
