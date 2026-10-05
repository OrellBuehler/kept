import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dialect } from "./dialect";
import {
  closeDatabase,
  migrateDatabase,
  openDatabase,
  withExclusiveClient,
  type DB,
} from "./index";

/**
 * Every migration an existing install may already have applied, from before
 * the migrations moved from `drizzle/` to `drizzle/sqlite/`: tag, journal
 * `when`, and the SHA-256 of the file (what `__drizzle_migrations` stores).
 * Migrations are never edited; new ones are only appended to the journal.
 */
const SHIPPED: [tag: string, when: number, sha256: string][] = [
  [
    "0000_fixed_rattler",
    1790804256722,
    "be506ca72bd937bde8eb0e125a9da973cd59185ec3f7e66fbef20ab38213cd2a",
  ],
  [
    "0001_green_violations",
    1790805330817,
    "42b8cc36046bc7a3af26fee5391cb03297b0eae44171d934eedf19e474d71a43",
  ],
  [
    "0002_brave_sheva_callister",
    1790806986579,
    "4153df3e8b8c24302041dc228a5c57d2b0f4e00c59c511a8d52527fa68c34e55",
  ],
  [
    "0003_little_trauma",
    1790808748055,
    "5afec670fd32d7d79f355734f3b6994f19e87ec2670a46091e821a9e565443ca",
  ],
  [
    "0004_heavy_wildside",
    1790810697123,
    "9197fc68b1d4c17b01a9eb7a0f636ab5bc3122ff47ec21f39c7567bc3a484b6a",
  ],
  [
    "0005_stormy_silvermane",
    1790883192087,
    "620f052aa1cde2d5a67502defc76f8d77dcc4a005b1554839856b788ba8965e9",
  ],
  [
    "0006_wet_robbie_robertson",
    1790892599497,
    "3653e680e6b68eda25ff73e3e28813e9583533f6b08949ba93bb5b955ece46d4",
  ],
  [
    "0007_clumsy_diamondback",
    1790979349908,
    "3794af0dd0015c4a48aa1be21461b4dfd31f84fb8a46cd6b96be0241063564bd",
  ],
  [
    "0008_bumpy_scream",
    1791017459715,
    "3338c46e1eb02824808885054a5710c1310f25cad0cad6e07cc4c2c6e209585c",
  ],
  [
    "0009_complete_madame_web",
    1791019665130,
    "a1a57cda6bd4ef2320043501648525e4c9505b81763c73da36306ff69641af03",
  ],
  [
    "0010_green_thunderball",
    1791020103596,
    "b8846b802e3f4452d9827264e9d0ce5d94da8415583a4c7bd60e87af49530488",
  ],
  [
    "0011_moaning_virginia_dare",
    1791020333059,
    "f94a169685dfbd27ffd4d2b9ff82be143aa8d43f564179fa6bb57a82e2ca6872",
  ],
  [
    "0012_romantic_mongoose",
    1791020641936,
    "2d91b1166e57107684bf6babae09c1d86a592f1260ea653dd70d9c1c4f8ffd5e",
  ],
  [
    "0013_oval_mattie_franklin",
    1791106206981,
    "101d3dc98e5252a5bf3546f30bd7c51e5f83cc72aef85b3216952c547f309c8a",
  ],
  [
    "0014_quiet_sersi",
    1791106671595,
    "390283dd551eae2db5a9e36bced915740538d407835de1df586c2686c007cdcf",
  ],
  [
    "0015_giant_wasp",
    1791107024895,
    "255991acf611ab06c9c6e6367abab6a74bc00b1b348b3b0b0888b374d09a211a",
  ],
  [
    "0016_warm_the_santerians",
    1791107209889,
    "d80801d9fb6c37f6214c915bc6ef4f66e42bd4c71c857a07df3cea2f3129faff",
  ],
  [
    "0017_purple_roland_deschain",
    1791113964895,
    "a98172ffc1cefb5282e20999b27034e5d94c395a36d26b4f9c6f1659fa4c47aa",
  ],
  [
    "0018_typical_warhawk",
    1791115509862,
    "43c3be5888f7e494a71b858fdb9e67f044dfe2e70ab4f5b02bf36641f1418434",
  ],
  [
    "0019_material_shooting_star",
    1791125664847,
    "ae50c50d7159977b6698ff79535af0e3bfdc17c49c3d6da7dc8548b3b455d500",
  ],
  [
    "0020_shocking_red_shift",
    1791127613180,
    "d2006d17c2f3bcfe770f7f82efbf190b2a2ace22150309ebb35062883cf13f6c",
  ],
  [
    "0021_reclassify_deduction_years",
    1791127619976,
    "b17ff1a9a280580ad5a8fed2d0edd7ef1b76d787eb16b974edfd87f9977ed52c",
  ],
  [
    "0022_tiny_synch",
    1791130010334,
    "0263d0811fa46d1d2a30a534858490a4ad1dfd2997c66764b6bf34ac848467a9",
  ],
  [
    "0023_backfill_archived_at",
    1791130019997,
    "32117956f48eb322e42d21aa51667fb9d42a871d14b3bfb48b36159bf5c57058",
  ],
  [
    "0024_redundant_rafael_vega",
    1791130311474,
    "53fb44115c477f91cc3de56a0ede589b03ee08222b0eee6c3f3b81084fb6e7b7",
  ],
  [
    "0025_fantastic_skin",
    1791139444397,
    "4b7dbf71f7ec3f4d0561ab05bf62de217b28a520d72730e2e368ae09a83b5587",
  ],
  [
    "0026_tiresome_flatman",
    1791140561301,
    "92c96dfadea94dde9edd98b80b8a44160f25b3e87d731b07cfe4e4bd191bc393",
  ],
  [
    "0027_typical_lord_hawal",
    1791142343747,
    "a3afc33accef6d85d73a808b46dafbabbc85aa7d7be2305b1dfd98b1e6bde715",
  ],
  [
    "0028_stormy_albert_cleary",
    1791146152296,
    "55a759724994a92338d509c57bb09d72d1661e1b435ada2d2816fbfcfc28c0d7",
  ],
  [
    "0029_strong_scourge",
    1791150347030,
    "c325a4e5dd711cdbf9ece0b12b95e89ab6bb235bb5c5f55f6fa0337e68e57754",
  ],
];

const folder = join(process.cwd(), "drizzle", "sqlite");

interface Journal {
  entries: { tag: string; when: number }[];
}

interface Applied {
  id: number;
  hash: string;
  created_at: number;
}

const readJournal = (dir: string) =>
  JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as Journal;

/** What a build before the move had: the same files, in a folder of their own. */
function oldLayout(root: string, count: number): string {
  const dir = join(root, "drizzle");
  cpSync(folder, dir, { recursive: true });
  const journal = readJournal(dir);
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

// Replays the SQLite migration folder move with the sync SQLite migrator on a
// raw connection (and a SQLite-only `__drizzle_migrations` table). PostgreSQL
// has a single folder from its first release; its migrations run in
// postgres.pg.test.ts.
describe.skipIf(dialect === "pg")("drizzle/sqlite", () => {
  let scratch: string;
  let db: DB;

  const applied = () =>
    withExclusiveClient(
      (client) =>
        client
          .query(
            "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id",
          )
          .all() as Applied[],
      db,
    );
  const tableCount = () =>
    withExclusiveClient(
      (client) =>
        (
          client
            .query(
              "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
            )
            .get() as { n: number }
        ).n,
      db,
    );
  /** Migrates the way the previous build did: the sync migrator over a folder. */
  const migrateWith = (migrationsFolder: string) =>
    withExclusiveClient(
      (client) => migrate(drizzle({ client }), { migrationsFolder }),
      db,
    );

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "kept-migration-move-"));
    mkdirSync(scratch, { recursive: true });
    db = openDatabase(":memory:");
  });

  afterEach(async () => {
    await closeDatabase(db);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps every shipped migration byte for byte, in order", () => {
    const entries = readJournal(folder).entries;
    expect(entries.length).toBeGreaterThanOrEqual(SHIPPED.length);
    SHIPPED.forEach(([tag, when, sha256], index) => {
      expect(entries[index]).toMatchObject({ tag, when });
      const text = readFileSync(join(folder, `${tag}.sql`), "utf8");
      expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
    });
  });

  it("re-runs nothing on a database the old folder fully migrated", async () => {
    await migrateWith(oldLayout(scratch, SHIPPED.length));
    const before = await applied();
    const tables = await tableCount();
    expect(before).toHaveLength(SHIPPED.length);

    await migrateDatabase(db);

    expect(await applied()).toEqual(before);
    expect(await tableCount()).toBe(tables);
  });

  it("is a no-op the second time the new folder runs", async () => {
    await migrateDatabase(db);
    const before = await applied();
    await migrateDatabase(db);
    expect(await applied()).toEqual(before);
  });

  it("applies only what the old folder had not on a partly migrated database", async () => {
    const partial = SHIPPED.length - 1;
    await migrateWith(oldLayout(scratch, partial));
    const before = await applied();
    expect(before).toHaveLength(partial);

    await migrateDatabase(db);

    const after = await applied();
    expect(after.slice(0, partial)).toEqual(before);
    expect(after).toHaveLength(readJournal(folder).entries.length);
  });

  it("records the same rows as a database migrated from the old folder", async () => {
    await migrateWith(oldLayout(scratch, SHIPPED.length));
    const fromOld = await applied();
    const fresh = openDatabase(":memory:");
    try {
      await migrateDatabase(fresh);
      const rows = await withExclusiveClient(
        (client) =>
          client
            .query(
              "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id",
            )
            .all() as Applied[],
        fresh,
      );
      expect(rows.slice(0, SHIPPED.length)).toEqual(fromOld);
      expect(rows.slice(0, SHIPPED.length).map((r) => r.hash)).toEqual(
        SHIPPED.map(([, , sha256]) => sha256),
      );
      expect(rows.slice(0, SHIPPED.length).map((r) => r.created_at)).toEqual(
        SHIPPED.map(([, when]) => when),
      );
    } finally {
      await closeDatabase(fresh);
    }
  });
});
