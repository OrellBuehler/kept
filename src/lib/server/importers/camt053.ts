import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { parseAmount, type Minor } from "$lib/money";
import { isValidQrr, isValidScor } from "$lib/references";
import {
  ImportFormatError,
  type NormalizedBalance,
  type NormalizedStatement,
  type NormalizedTransaction,
  type ReferenceType,
} from "./types";

/**
 * ISO 20022 camt.053 (bank-to-customer statement) importer.
 *
 * Elements are read by local name and meaning, never by a fixed per-version path, so
 * camt.053.001.02 / .04 / .08 (and other .001.NN versions) share one code path. Differences
 * handled: `Sts` (plain text vs `Sts/Cd`), party name (`Cdtr/Nm` vs `Cdtr/Pty/Nm`),
 * `Dt` vs `DtTm` date choices.
 *
 * Rules
 * -----
 * Sign:      from CdtDbtInd only (CRDT +, DBIT -), for balances and entries.
 * Reversal:  ISO 20022 Ntry/RvslInd usage rule: "This element should only be present if the
 *            entry is the result of a reversal. If the CreditDebitIndicator is CRDT and
 *            ReversalIndicator is Yes, the original operation was a debit entry. If the
 *            CreditDebitIndicator is DBIT and ReversalIndicator is Yes, the original operation
 *            was a credit entry." So CdtDbtInd is the direction of the reversal entry itself:
 *            the sign comes from CdtDbtInd unchanged and `reversal: true` is only a flag.
 *            Consequently the original payment's roles are the opposite of the entry's
 *            direction (a CRDT reversal undoes a debit, so the original creditor is in Cdtr).
 * Batches:   an Ntry with >= 2 TxDtls is split into one transaction per TxDtls only when every
 *            TxDtls carries its own amount (AmtDtls/TxAmt/Amt, else Amt) in the booked
 *            currency and those amounts sum exactly to the entry amount. Otherwise (missing or
 *            non-summing amounts, or foreign currency) the entry is ONE transaction, and
 *            because it is ambiguous which TxDtls would describe it, counterparty, reference and
 *            remittance text of the individual TxDtls are not used (entry-level AddtlNtryInf
 *            only). An Ntry with a single TxDtls is one transaction enriched with its details.
 * Counterparty: DBIT -> Cdtr/CdtrAcct, CRDT -> Dbtr/DbtrAcct. For reversals the original
 *            operation's role is tried first (CRDT reversal -> Cdtr, DBIT reversal -> Dbtr), then
 *            the entry-direction role. Normal entries never fall back (the other party would be
 *            the account holder).
 * externalId: see `assignExternalIds`.
 *
 * Only booked entries (Sts BOOK) are imported; PDNG/INFO are skipped.
 * The input is size-limited and DOCTYPE/ENTITY declarations are rejected (no XXE, no
 * entity expansion). The parser's entity processing is off; the five predefined XML
 * entities and numeric character references are decoded in a single pass by `decodeEntities`.
 */

const MAX_INPUT_CHARS = 25_000_000;

type Rec = Record<string, unknown>;

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
  isArray: (name) =>
    ["Stmt", "Ntry", "Bal", "NtryDtls", "TxDtls", "Ustrd", "Strd"].includes(
      name,
    ),
});

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/)
  .transform((s) => s.slice(0, 10))
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  });
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const indicatorSchema = z.enum(["CRDT", "DBIT"]);
const amountSchema = z.string().regex(/^\d+(\.\d+)?$/);

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function walk(v: unknown, path: string[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (Array.isArray(cur)) cur = cur[0];
    if (!isRec(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function at(v: unknown, ...path: string[]): unknown {
  const r = walk(v, path);
  return Array.isArray(r) ? r[0] : r;
}

function list(v: unknown, ...path: string[]): unknown[] {
  return asArray(walk(v, path));
}

const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, body: string) => {
    if (body[0] !== "#") return PREDEFINED[body] ?? m;
    const cp =
      body[1] === "x"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
    const valid =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd && cp !== 0xfffe) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    if (!valid) fail(`Invalid numeric character reference "${m}"`);
    return String.fromCodePoint(cp);
  });
}

function text(v: unknown): string | null {
  if (Array.isArray(v)) return text(v[0]);
  let s: string | null = null;
  if (typeof v === "string") s = decodeEntities(v);
  else if (typeof v === "number") s = String(v);
  else if (isRec(v) && "#text" in v) return text(v["#text"]);
  s = s?.trim() ?? null;
  return s ? s : null;
}

function fail(message: string): never {
  throw new ImportFormatError(message);
}

function readDate(v: unknown, what: string): string | null {
  return readDateText(text(at(v, "Dt")) ?? text(at(v, "DtTm")), what);
}

function readDateText(raw: string | null, what: string): string | null {
  if (raw === null) return null;
  const parsed = dateSchema.safeParse(raw);
  if (!parsed.success) fail(`Invalid ${what} date "${raw}"`);
  return parsed.data;
}

function decimalsFor(currency: string): number {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits!;
}

interface Amount {
  value: Minor;
  currency: string;
}

function readAmount(v: unknown, what: string): Amount | null {
  const raw = text(v);
  if (raw === null) return null;
  const ccy = isRec(v) ? text(v["@_Ccy"]) : null;
  const currency = currencySchema.safeParse(ccy);
  if (!currency.success)
    fail(`${what}: missing or invalid currency "${ccy ?? ""}"`);
  if (!amountSchema.safeParse(raw).success)
    fail(`${what}: invalid amount "${raw}" (must be a non-negative decimal)`);
  const decimals = decimalsFor(currency.data);
  const [whole, rawFraction = ""] = raw.split(".");
  let fraction = rawFraction;
  if (fraction.length > decimals) {
    const extra = fraction.slice(decimals);
    if (/[^0]/.test(extra))
      fail(
        `${what}: amount "${raw}" has more decimals than ${currency.data} allows`,
      );
    fraction = fraction.slice(0, decimals);
  }
  let value: Minor;
  try {
    value = parseAmount(fraction ? `${whole}.${fraction}` : whole!, decimals);
  } catch {
    fail(`${what}: amount "${raw}" is out of range`);
  }
  return { value, currency: currency.data };
}

function applySign(value: Minor, credit: boolean): Minor {
  return (credit || value === 0 ? value : 0 - value) as Minor;
}

function readIndicator(v: unknown, what: string): boolean {
  const raw = text(v);
  const parsed = indicatorSchema.safeParse(raw);
  if (!parsed.success)
    fail(`${what}: CdtDbtInd must be CRDT or DBIT, got "${raw ?? ""}"`);
  return parsed.data === "CRDT";
}

function checkNamespace(xml: string): void {
  const root = /<(?:[\w.-]+:)?Document\b([^>]*)>/.exec(xml);
  if (!root) fail("Not a camt.053 file: no <Document> root element");
  const namespaces = [
    ...root[1]!.matchAll(/xmlns(?::[\w.-]+)?\s*=\s*["']([^"']*)["']/g),
  ].map((m) => m[1]!);
  // Match by the last path segment so URNs (urn:iso:std:iso:20022:tech:xsd:camt.053.001.04) and
  // URLs with suffixes (.../camt.053.001.04.ch.02.xsd) are both recognized.
  const messages = namespaces
    .map((ns) =>
      /^([a-z]+\.\d{3}\.\d{3}\.\d{2})(?:\..*)?$/.exec(ns.split(/[/:]/).pop()!),
    )
    .filter((m) => m !== null)
    .map((m) => m[1]!);
  if (messages.length > 0) {
    if (!messages.some((m) => /^camt\.053\.001\.\d+$/.test(m)))
      fail(`Not a camt.053 file: found ${messages[0]}`);
  } else if (namespaces.length > 0) {
    fail(`Not a camt.053 file: unrecognized namespace ${namespaces[0]}`);
  }
}

function pickBalance(bals: Rec[], codes: string[]): NormalizedBalance | null {
  for (const code of codes) {
    const bal = bals.find((b) => text(at(b, "Tp", "CdOrPrtry", "Cd")) === code);
    if (!bal) continue;
    const amount = readAmount(bal["Amt"], `Balance ${code}`);
    if (!amount) fail(`Balance ${code} has no amount`);
    const credit = readIndicator(bal["CdtDbtInd"], `Balance ${code}`);
    const date = readDate(bal["Dt"], `balance ${code}`);
    if (!date) fail(`Balance ${code} has no date`);
    return {
      amount: applySign(amount.value, credit),
      currency: amount.currency,
      date,
    };
  }
  return null;
}

function normalizeIban(v: unknown): string | null {
  const s = text(v);
  return s ? s.replace(/\s+/g, "").toUpperCase() : null;
}

function readReference(tx: unknown): {
  reference: string | null;
  referenceType: ReferenceType | null;
} {
  for (const strd of list(tx, "RmtInf", "Strd")) {
    const raw = text(at(strd, "CdtrRefInf", "Ref"));
    if (!raw) continue;
    const reference = raw.replace(/\s+/g, "");
    const declared =
      text(at(strd, "CdtrRefInf", "Tp", "CdOrPrtry", "Prtry")) ??
      text(at(strd, "CdtrRefInf", "Tp", "CdOrPrtry", "Cd"));
    let referenceType: ReferenceType | null = null;
    if (declared === "QRR" || declared === "SCOR") referenceType = declared;
    else if (isValidQrr(reference)) referenceType = "QRR";
    else if (isValidScor(reference)) referenceType = "SCOR";
    return { reference, referenceType };
  }
  return { reference: null, referenceType: null };
}

function readDescription(tx: unknown, entry: Rec): string | null {
  const ustrd = list(tx, "RmtInf", "Ustrd")
    .map(text)
    .filter((s): s is string => s !== null)
    .join(" ");
  return (
    (ustrd ? ustrd : null) ??
    text(at(tx, "AddtlTxInf")) ??
    text(entry["AddtlNtryInf"])
  );
}

function readParty(
  tx: unknown,
  role: "Cdtr" | "Dbtr",
): { name: string | null; iban: string | null } {
  const party = at(tx, "RltdPties", role);
  return {
    name: text(at(party, "Nm")) ?? text(at(party, "Pty", "Nm")),
    iban: normalizeIban(at(tx, "RltdPties", `${role}Acct`, "Id", "IBAN")),
  };
}

function readCounterparty(
  tx: unknown,
  credit: boolean,
  reversal: boolean,
  ownIban: string | null,
) {
  const entryRole = credit ? ("Dbtr" as const) : ("Cdtr" as const);
  const otherRole = credit ? ("Cdtr" as const) : ("Dbtr" as const);
  // A reversal undoes an original operation of the opposite direction, so the original
  // counterparty is usually reported in the other role; banks are inconsistent, so try both.
  // The statement's own account is never a counterparty.
  const roles = reversal ? [otherRole, entryRole] : [entryRole];
  for (const role of roles) {
    const party = readParty(tx, role);
    if ((party.name || party.iban) && (!ownIban || party.iban !== ownIban))
      return party;
  }
  return { name: null, iban: null };
}

function readOriginal(
  sources: unknown[],
  booked: Amount,
  credit: boolean,
): { amount: Minor; currency: string } | null {
  for (const source of sources) {
    for (const path of [
      ["AmtDtls", "InstdAmt", "Amt"],
      ["AmtDtls", "TxAmt", "Amt"],
    ]) {
      const amt = readAmount(at(source, ...path), "Original amount");
      if (amt && amt.currency !== booked.currency)
        return {
          amount: applySign(amt.value, credit),
          currency: amt.currency,
        };
    }
  }
  return null;
}

function txAmount(tx: unknown): Amount | null {
  return (
    readAmount(at(tx, "Amt"), "TxDtls amount") ??
    readAmount(at(tx, "AmtDtls", "TxAmt", "Amt"), "TxDtls amount")
  );
}

function reference(v: unknown): string | null {
  const r = text(v);
  return r === null || r.toUpperCase() === "NOTPROVIDED" ? null : r;
}

function sumSafe(values: number[], what: string): number {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!Number.isSafeInteger(total)) fail(`${what}: amounts are out of range`);
  return total;
}

function detailKey(tx: unknown, index: number): string {
  const acsr = reference(at(tx, "Refs", "AcctSvcrRef"));
  if (acsr) return `a:${acsr}`;
  const e2e = reference(at(tx, "Refs", "EndToEndId"));
  if (e2e) return `e:${e2e}`;
  const txId = reference(at(tx, "Refs", "TxId"));
  if (txId) return `t:${txId}`;
  return `i:${index}`;
}

interface Draft {
  tx: Omit<NormalizedTransaction, "externalId">;
  baseId: string;
  legacyBaseId: string | null;
}

function sha256(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** The IBAN, else a short hash of the case- and spacing-normalised name, else null. */
function counterpartyKey(cp: {
  name: string | null;
  iban: string | null;
}): string | null {
  if (cp.iban) return cp.iban;
  const name = cp.name?.toLowerCase().replace(/\s+/g, " ").trim();
  return name ? `n-${sha256([name]).slice(0, 16)}` : null;
}

function parseEntry(
  entry: Rec,
  accountKey: string,
  ownIban: string | null,
  n: number,
): Draft[] {
  const what = `Ntry #${n}`;
  const booked = readAmount(entry["Amt"], `${what} Amt`);
  if (!booked) fail(`${what} has no amount`);
  const credit = readIndicator(entry["CdtDbtInd"], what);
  const reversal = ["true", "1"].includes(
    text(entry["RvslInd"])?.toLowerCase() ?? "",
  );
  const bookingDate = readDate(entry["BookgDt"], `${what} booking`);
  if (!bookingDate) fail(`${what} has no booking date (BookgDt)`);
  const valueDate = readDate(entry["ValDt"], `${what} value`);
  const signed = applySign(booked.value, credit);

  const txs = list(entry, "NtryDtls").flatMap((d) => list(d, "TxDtls"));
  const entryRef = reference(entry["AcctSvcrRef"]);
  const ntryRef = reference(entry["NtryRef"]);

  let parts: (unknown | null)[] = [null];
  let split = false;
  if (txs.length >= 2) {
    const amounts = txs.map(txAmount);
    if (
      amounts.every(
        (a): a is Amount => a !== null && a.currency === booked.currency,
      ) &&
      sumSafe(
        amounts.map((a) => a.value),
        what,
      ) === booked.value
    ) {
      split = true;
      parts = txs;
    }
  } else if (txs.length === 1) {
    parts = txs;
  }

  return parts.map((tx, index): Draft => {
    const amount: Amount = split ? txAmount(tx)! : booked;
    const value = applySign(amount.value, credit);
    const cp =
      tx === null
        ? { name: null, iban: null }
        : readCounterparty(tx, credit, reversal, ownIban);
    const ref =
      tx === null
        ? { reference: null, referenceType: null }
        : readReference(tx);
    const description = readDescription(tx, entry);
    const original = readOriginal(
      tx === null ? [entry] : split ? [tx] : [tx, entry],
      amount,
      credit,
    );
    const transaction = {
      bookingDate,
      valueDate,
      amount: value,
      currency: amount.currency,
      originalAmount: original?.amount ?? null,
      originalCurrency: original?.currency ?? null,
      counterpartyName: cp.name,
      counterpartyIban: cp.iban,
      description,
      reference: ref.reference,
      referenceType: ref.referenceType,
      reversal,
    };

    const legacy = (): string => {
      if (ntryRef) {
        const id = `ntry:${ntryRef}:${bookingDate}:${signed}`;
        return split ? `${id}/${detailKey(tx, index)}` : id;
      }
      return `hash:${sha256([
        accountKey,
        bookingDate,
        valueDate,
        value,
        transaction.currency,
        cp.iban,
        ref.reference,
        description,
        reversal,
      ])}`;
    };

    let baseId: string;
    if (entryRef) {
      baseId = split
        ? `acsr:${entryRef}/${detailKey(tx, index)}`
        : `acsr:${entryRef}`;
    } else {
      const txAcsr = reference(at(tx, "Refs", "AcctSvcrRef"));
      const uetr = reference(at(tx, "Refs", "UETR"));
      const e2e = reference(at(tx, "Refs", "EndToEndId"));
      const txId = reference(at(tx, "Refs", "TxId"));
      // EndToEndId and TxId are chosen by the payer and may be reused for different payees on
      // the same day, so the counterparty is part of the id.
      const party = counterpartyKey(cp);
      const when = `${bookingDate}:${value}${party ? `:${party}` : ""}`;
      if (txAcsr) baseId = `acsr:${txAcsr}`;
      else if (uetr) baseId = `uetr:${uetr}`;
      else if (e2e) baseId = `e2e:${e2e}:${when}`;
      else if (txId) baseId = `txid:${txId}:${when}`;
      else {
        baseId = `hash:${sha256([
          accountKey,
          bookingDate,
          valueDate,
          value,
          transaction.currency,
          cp.iban,
          cp.name,
          ref.reference,
          description,
          text(entry["AddtlNtryInf"]),
          reversal,
        ])}`;
      }
    }
    const legacyBaseId = entryRef ? null : legacy();
    return { tx: transaction, baseId, legacyBaseId };
  });
}

/**
 * externalId rules, in order of preference (NtryRef is never used: many banks number entries
 * per file, so the same booking carries a different NtryRef in each overlapping download):
 *   1. `acsr:<AcctSvcrRef>` - the account servicer's reference, at entry level or, failing
 *      that, at TxDtls level. For split batches with an entry-level reference `/<key>` is
 *      appended, where key is the TxDtls AcctSvcrRef, EndToEndId or TxId, else the position.
 *   2. `uetr:<UETR>`, then `e2e:<EndToEndId>:<date>:<amount>[:<party>]` and
 *      `txid:<TxId>:<date>:<amount>[:<party>]` (date, amount and the counterparty - its IBAN,
 *      else `n-` and a hash of its name, omitted when there is none - are added because those
 *      ids are chosen by the payer and may be reused for different payees).
 *   3. `hash:<sha256>` of the booking content: account, booking/value date, signed amount,
 *      currency, counterparty IBAN and name, reference, description, AddtlNtryInf, reversal.
 *      No statement id and no position in the file, so the same booking hashes identically
 *      in every overlapping file.
 * Identical ids within one statement (e.g. two identical bookings on the same day) get an
 * occurrence suffix `#2`, `#3`, ... in file order, so real duplicates are kept apart yet
 * remain stable as long as overlapping files contain the same identical bookings.
 *
 * `legacyExternalIds` holds the ids earlier versions derived (NtryRef-based or the older,
 * smaller hash) so already imported rows are still recognised as duplicates.
 */
function assignExternalIds(drafts: Draft[]): NormalizedTransaction[] {
  const seen = new Map<string, number>();
  const occurrence = (id: string, scope: string): string => {
    const key = `${scope}|${id}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? id : `${id}#${count}`;
  };
  return drafts.map(({ tx, baseId, legacyBaseId }) => {
    const externalId = occurrence(baseId, "id");
    if (legacyBaseId === null) return { ...tx, externalId };
    return {
      ...tx,
      externalId,
      legacyExternalIds: [occurrence(legacyBaseId, "legacy")],
    };
  });
}

function parseStatement(stmt: Rec, index: number): NormalizedStatement {
  const what = `Stmt #${index + 1}`;
  const accountIban = normalizeIban(at(stmt, "Acct", "Id", "IBAN"));
  const accountOtherId = text(at(stmt, "Acct", "Id", "Othr", "Id"));
  if (!accountIban && !accountOtherId)
    fail(`${what} has no account identification (Acct/Id/IBAN or Othr/Id)`);

  const bals = asArray(stmt["Bal"]).filter(isRec);
  const openingBalance = pickBalance(bals, ["OPBD", "PRCD"]);
  const closingBalance = pickBalance(bals, ["CLBD"]);

  const entries = asArray(stmt["Ntry"]).map((e, i) => {
    if (!isRec(e)) fail(`${what}: Ntry #${i + 1} is empty`);
    return e;
  });

  let currency = text(at(stmt, "Acct", "Ccy"));
  if (!currency) {
    currency =
      openingBalance?.currency ??
      closingBalance?.currency ??
      readAmount(entries[0]?.["Amt"], `${what} Ntry #1 Amt`)?.currency ??
      null;
  }
  if (!currency || !currencySchema.safeParse(currency).success)
    fail(`${what}: cannot determine the account currency`);

  const accountKey = accountIban ?? `other:${accountOtherId}`;
  const drafts: Draft[] = [];
  entries.forEach((entry, i) => {
    const sts =
      text(entry["Sts"]) ??
      text(at(entry, "Sts", "Cd")) ??
      text(at(entry, "Sts", "Prtry"));
    if (!sts) fail(`${what}: Ntry #${i + 1} has no status (Sts)`);
    if (sts !== "BOOK") return;
    drafts.push(...parseEntry(entry, accountKey, accountIban, i + 1));
  });

  return {
    accountIban,
    accountOtherId: accountIban ? null : accountOtherId,
    currency,
    statementId: text(stmt["Id"]),
    fromDate: readDateText(text(at(stmt, "FrToDt", "FrDtTm")), `${what} from`),
    toDate: readDateText(text(at(stmt, "FrToDt", "ToDtTm")), `${what} to`),
    openingBalance,
    closingBalance,
    transactions: assignExternalIds(drafts),
  };
}

export function parseCamt053(xml: string): NormalizedStatement[] {
  if (typeof xml !== "string" || xml.trim() === "")
    fail("Empty file: expected a camt.053 XML document");
  if (xml.length > MAX_INPUT_CHARS)
    fail(`File too large: more than ${MAX_INPUT_CHARS} characters`);
  const content = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  if (/<!DOCTYPE|<!ENTITY/i.test(content))
    fail("DOCTYPE and ENTITY declarations are not allowed in camt.053 files");
  const valid = XMLValidator.validate(content);
  if (valid !== true)
    fail(`Invalid XML: ${valid.err.msg} (line ${valid.err.line})`);
  checkNamespace(content);

  let tree: unknown;
  try {
    tree = parser.parse(content);
  } catch (e) {
    fail(`Invalid XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const doc = at(tree, "Document");
  if (doc === undefined)
    fail("Not a camt.053 file: no <Document> root element");
  const container = at(doc, "BkToCstmrStmt");
  if (!isRec(container))
    fail(
      "Not a camt.053 file: <Document> has no BkToCstmrStmt element (is this a different message type?)",
    );
  const stmts = asArray(container["Stmt"]);
  if (stmts.length === 0) fail("camt.053 file contains no statements (Stmt)");
  return stmts.map((s, i) => {
    if (!isRec(s)) fail(`Stmt #${i + 1} is empty`);
    return parseStatement(s, i);
  });
}
