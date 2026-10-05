import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDB } from "$lib/testing/db";
import { getDB, readSnapshot, transaction, users } from "./index";

useTestDB();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const countUsers = async () =>
  (await getDB().select({ n: count() }).from(users))[0]!.n;
const insertUser = (username: string) =>
  getDB().insert(users).values({ username, passwordHash: "x" });

describe("readSnapshot", () => {
  it("returns the callback's value", async () => {
    await insertUser("a");
    expect(await readSnapshot(async () => countUsers())).toBe(1);
  });

  it("shows one state to every query even when another write lands meanwhile", async () => {
    await insertUser("a");
    let release!: () => void;
    const midway = new Promise<void>((r) => (release = r));
    const writer = (async () => {
      await midway;
      await insertUser("b");
    })();
    const seen = await readSnapshot(async () => {
      const before = await countUsers();
      release();
      await sleep(80);
      return { before, after: await countUsers() };
    });
    await writer;
    expect(seen.before).toBe(seen.after);
    expect(await countUsers()).toBe(2);
  });

  it("joins an enclosing transaction and sees its uncommitted writes", async () => {
    const seen = await transaction(async () => {
      await insertUser("inside");
      return readSnapshot(async () => countUsers());
    });
    expect(seen).toBe(1);
  });

  it("nests inside another snapshot", async () => {
    await insertUser("a");
    const seen = await readSnapshot(async () =>
      readSnapshot(async () => countUsers()),
    );
    expect(seen).toBe(1);
  });

  it("releases the connection when the callback throws", async () => {
    await expect(
      readSnapshot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await insertUser("after");
    expect(await countUsers()).toBe(1);
  });

  it("leaves nothing open for a later transaction", async () => {
    await readSnapshot(async () => countUsers());
    await transaction(async () => {
      await insertUser("x");
    });
    expect(await countUsers()).toBe(1);
  });

  it("rejects a transaction started inside it, on every database", async () => {
    await expect(
      readSnapshot(async () => {
        await transaction(async () => {
          await insertUser("nope");
        });
      }),
    ).rejects.toThrow(/inside readSnapshot/);
    expect(await countUsers()).toBe(0);
  });
});
