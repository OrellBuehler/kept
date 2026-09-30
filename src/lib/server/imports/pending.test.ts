import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "$lib/testing/fixtures";
import { usePendingDir } from "$lib/testing/imports";
import { LedgerError } from "$lib/server/ledger/errors";
import {
  deletePending,
  detectFormat,
  getPendingMeta,
  MAX_UPLOAD_BYTES,
  pendingRoot,
  PENDING_TTL_MS,
  purgeExpired,
  readPending,
  storePending,
} from "./pending";

const ctx = usePendingDir();
const enc = (s: string) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("detects camt.053 by content, whatever the file name", () => {
    expect(detectFormat(fixture("camt053/v04-basic.xml"))).toBe("camt053");
    expect(detectFormat(fixture("camt053/v08-basic.xml"))).toBe("camt053");
  });

  it("detects camt.053 behind a UTF-8 BOM", () => {
    const xml = fixture("camt053/v04-basic.xml");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...xml]);
    expect(detectFormat(withBom)).toBe("camt053");
  });

  it("detects xlsx by the zip magic", () => {
    expect(detectFormat(fixture("xlsx/statement.xlsx"))).toBe("xlsx");
  });

  it("treats other text as csv", () => {
    expect(detectFormat(fixture("csv/comma-dot.csv"))).toBe("csv");
    expect(detectFormat(fixture("csv/utf16le-bom.csv"))).toBe("csv");
  });

  it("rejects camt.054 and other XML with a clear message", () => {
    const xml054 = enc(
      '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08"><BkToCstmrDbtCdtNtfctn/></Document>',
    );
    const pain = enc(
      '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"/>',
    );
    for (const bytes of [xml054, pain]) {
      expect(() => detectFormat(bytes)).toThrow(/not a camt\.053/);
    }
  });

  it("rejects empty files", () => {
    expect(() => detectFormat(new Uint8Array())).toThrow(LedgerError);
  });
});

describe("pending uploads", () => {
  it("stores bytes plus metadata under the user's directory", () => {
    const meta = storePending("user-a", {
      accountId: "acc",
      fileName: "../../etc/statement.csv",
      bytes: fixture("csv/comma-dot.csv"),
    });
    expect(meta.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(meta.fileName).toBe("statement.csv");
    expect(meta.format).toBe("csv");
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(pendingRoot(), "user-a")).sort()).toEqual(
      [meta.id, `${meta.id}.json`].sort(),
    );
    expect(pendingRoot().startsWith(ctx.dir)).toBe(true);
    const read = readPending("user-a", meta.id);
    expect(read.bytes).toEqual(fixture("csv/comma-dot.csv"));
    expect(read.meta).toEqual(meta);
  });

  it("generates distinct unguessable ids", () => {
    const ids = new Set(
      Array.from(
        { length: 20 },
        () =>
          storePending("user-a", {
            accountId: "acc",
            fileName: "a.csv",
            bytes: enc("a,b\n1,2\n"),
          }).id,
      ),
    );
    expect(ids.size).toBe(20);
  });

  it("rejects files over 20 MB and empty files", () => {
    expect(() =>
      storePending("user-a", {
        accountId: "acc",
        fileName: "big.csv",
        bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(97),
      }),
    ).toThrow(/larger than 20 MB/);
    expect(() =>
      storePending("user-a", {
        accountId: "acc",
        fileName: "e.csv",
        bytes: new Uint8Array(),
      }),
    ).toThrow(/empty/);
  });

  it("does not touch the filesystem for malformed ids", () => {
    for (const id of ["../x", "..%2Fx", "a/b", "short", "", "a".repeat(33)]) {
      expect(() => readPending("user-a", id)).toThrow(LedgerError);
      expect(() => deletePending("user-a", id)).toThrow(LedgerError);
    }
    expect(() => getPendingMeta("../other", "a".repeat(32))).toThrow(
      LedgerError,
    );
  });

  it("is invisible to other users", () => {
    const meta = storePending("user-a", {
      accountId: "acc",
      fileName: "a.csv",
      bytes: enc("a,b\n1,2\n"),
    });
    expect(() => readPending("user-b", meta.id)).toThrow(/not found/);
    expect(() => deletePending("user-b", meta.id)).toThrow(/not found/);
    expect(readPending("user-a", meta.id).meta.id).toBe(meta.id);
  });

  it("refuses a sidecar that names another owner", () => {
    const meta = storePending("user-a", {
      accountId: "acc",
      fileName: "a.csv",
      bytes: enc("a,b\n1,2\n"),
    });
    writeFileSync(
      join(pendingRoot(), "user-a", `${meta.id}.json`),
      JSON.stringify({ ...meta, userId: "user-b" }),
    );
    expect(() => readPending("user-a", meta.id)).toThrow(/not found/);
  });

  it("delete removes both files", () => {
    const meta = storePending("user-a", {
      accountId: "acc",
      fileName: "a.csv",
      bytes: enc("a,b\n1,2\n"),
    });
    deletePending("user-a", meta.id);
    expect(readdirSync(join(pendingRoot(), "user-a"))).toEqual([]);
    expect(() => readPending("user-a", meta.id)).toThrow(/not found/);
  });

  it("expires after two hours and purges on access", () => {
    const meta = storePending("user-a", {
      accountId: "acc",
      fileName: "a.csv",
      bytes: enc("a,b\n1,2\n"),
    });
    expect(() =>
      getPendingMeta("user-a", meta.id, meta.createdAt + PENDING_TTL_MS + 1),
    ).toThrow(/not found/);
    expect(readdirSync(join(pendingRoot(), "user-a"))).toEqual([]);
  });

  it("purgeExpired removes expired uploads of every user and orphans, keeps fresh ones", () => {
    const old = storePending("user-a", {
      accountId: "acc",
      fileName: "a.csv",
      bytes: enc("a,b\n1,2\n"),
    });
    const fresh = storePending("user-b", {
      accountId: "acc",
      fileName: "b.csv",
      bytes: enc("a,b\n1,2\n"),
    });
    const orphan = join(pendingRoot(), "user-b", "o".repeat(32));
    writeFileSync(orphan, "x");
    const longAgo = new Date(Date.now() - PENDING_TTL_MS - 60_000);
    utimesSync(orphan, longAgo, longAgo);
    writeFileSync(
      join(pendingRoot(), "user-a", `${old.id}.json`),
      JSON.stringify({ ...old, createdAt: Date.now() - PENDING_TTL_MS - 1000 }),
    );
    purgeExpired();
    expect(existsSync(join(pendingRoot(), "user-a", old.id))).toBe(false);
    expect(existsSync(join(pendingRoot(), "user-a", `${old.id}.json`))).toBe(
      false,
    );
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(pendingRoot(), "user-b", fresh.id))).toBe(true);
  });
});
