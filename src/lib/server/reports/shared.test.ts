import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { buildReport, loadNetWorthReport, netWorthReportTitle } from "./index";
import { money } from "./pdf";

const TODAY = "2026-10-15";
const m = minor;
const norm = (s: string) => s.replace(/\s+/g, " ");

async function textOf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text.replace(/\s+/g, " ");
}

async function setup() {
  const user = await createTestUser();
  seedAccount(user.id, {
    name: "Everyday",
    openingBalance: m(100000),
    openingDate: "2026-01-01",
  });
  const joint = seedAccount(user.id, {
    name: "Joint",
    openingBalance: m(50001),
    openingDate: "2026-01-01",
    shareBps: 5000,
  });
  seedImportedTransaction(user.id, joint.id, {
    bookingDate: "2026-09-02",
    amount: m(-1001),
  });
  return user;
}

describe("net worth report variants", () => {
  useTestDB();

  it("loads the total by default and the share on request", async () => {
    const u = await setup();
    const total = loadNetWorthReport(u.id, TODAY);
    const share = loadNetWorthReport(u.id, TODAY, "share");
    expect(total.basis).toBe("total");
    expect(share.basis).toBe("share");
    expect(total.series[0]!.points.at(-1)!.amount).toBe(100000 + 49000);
    // 49000 / 2 = 24500
    expect(share.series[0]!.points.at(-1)!.amount).toBe(100000 + 24500);
    expect(share.balances.find((b) => b.name === "Joint")).toMatchObject({
      balance: 49000,
      shareBalance: 24500,
      shareBps: 5000,
    });
  });

  it("prints the total variant at full amounts without a share column", async () => {
    const u = await setup();
    const built = await buildReport(u.id, "net-worth", {}, TODAY);
    expect(built.fileName).toBe("kept-net-worth-2026-10-15.pdf");
    expect(built.title).toBe("Net worth 2026-10-15");
    const text = await textOf(built.bytes);
    expect(text).toContain(norm(money(m(149000), "CHF")));
    expect(text).not.toContain("my share");
    expect(text).not.toContain("50%");
  });

  it("prints the share variant, labelled, with the percentage", async () => {
    const u = await setup();
    const built = await buildReport(
      u.id,
      "net-worth",
      { basis: "share" },
      TODAY,
    );
    expect(built.fileName).toBe("kept-net-worth-share-2026-10-15.pdf");
    expect(built.title).toBe(
      netWorthReportTitle(loadNetWorthReport(u.id, TODAY, "share")),
    );
    expect(built.title).toContain("my share");
    const text = await textOf(built.bytes);
    expect(text).toContain("my share");
    expect(text).toContain("50%");
    expect(text).toContain(norm(money(m(124500), "CHF")));
    expect(text).not.toContain(norm(money(m(149000), "CHF")));
  });

  it("rejects an unknown basis", async () => {
    const u = await createTestUser();
    await expect(
      buildReport(u.id, "net-worth", { basis: "half" }, TODAY),
    ).rejects.toMatchObject({ code: "invalid", field: "basis" });
  });
});
