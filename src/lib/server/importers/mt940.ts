import { z } from "zod";
import { currencyExponent, parseAmount, type Minor } from "$lib/money";
import { detectReference } from "$lib/references";
import {
  assignExternalIds,
  counterpartyKey,
  sha256,
  type Draft,
} from "./external-id";
import {
  ImportFormatError,
  type NormalizedBalance,
  type NormalizedStatement,
  type ReferenceType,
} from "./types";

/**
 * SWIFT MT940 (customer statement message) importer. Takes decoded text; choosing the
 * character set (UTF-8, Latin-1 / windows-1252, UTF-16) is the caller's job, see `decodeText`.
 *
 * Structure
 * ---------
 * A file holds one or more statements. A statement starts at `:20:` and runs to the next
 * `:20:`, a `-` line or the end of the file. Optional SWIFT block headers (`{1:..}{2:..}{4:`
 * ... `-}`) are stripped. Fields: `:25:` account (IBAN, `IBAN/CCY` or a local number),
 * `:28C:` statement number, `:60F:`/`:60M:` opening balance, `:61:` entry (+ optional `:86:`),
 * `:62F:`/`:62M:` closing balance; `:64:`, `:65:` and unknown tags are ignored, as is an
 * `:86:` after the closing balance. A multi-page statement (`:60M:`/`:62M:`) is several
 * statements of the same account. LF, CRLF and CR line endings are accepted.
 *
 * Rules
 * -----
 * Sign:      from the debit/credit mark only: C and RD (reversal of a debit) are credits, D and
 *            RC (reversal of a credit) are debits; RC/RD set `reversal: true`. As in camt, the
 *            mark gives the direction of the entry itself. Amounts are unsigned with a comma.
 * Dates:     `:61:` carries the value date (YYMMDD) and optionally the entry date (MMDD, its
 *            year inferred as the one closest to the value date). bookingDate is the entry date,
 *            else the value date; two-digit years 70-99 mean 19xx, the rest 20xx.
 * Balances:  `:60:` is dated with the day the balance was struck at the end of (SWIFT: the
 *            previous statement's closing date), but a Kept opening balance is "at the start of
 *            that day". So its date moves to the following day, unless an entry is booked on or
 *            before it: then the bank dated the balance at the start of the first day and the
 *            date is kept. Closing balances keep their date.
 * `:86:`     Structured (`<gvc>?00..?34`): ?20-?29 and ?60-?63 are the purpose text, ?32/?33 the
 *            counterparty name, ?31 the counterparty account, ?00 the posting text. SEPA keywords
 *            (EREF+ KREF+ MREF+ CRED+ SVWZ+ IBAN+ ...) are read from the purpose text of a
 *            structured field and from the text of an unstructured one. Anything else is the
 *            description.
 * Reference: only a valid QR or creditor (RF) reference found in the description is stored.
 * Foreign:   `/OCMT/<CCY><amount>` in `:86:` or the `:61:` supplementary line is the original
 *            amount; entries themselves are always in the statement currency.
 * externalId, in order: `mt940:<bank reference>:<date>:<amount>` (the part after `//` in
 *            `:61:`), `e2e:<EREF+>:<date>:<amount>[:<party>]` (same shape as camt), `cref:<customer
 *            reference>:<date>:<amount>[:<party>]`, else `hash:<sha256>` of the booking content
 *            (no statement id, no position), so overlapping files agree. `NONREF` and
 *            `NOTPROVIDED` count as no reference. Identical ids within one statement get a
 *            `#2`, `#3` suffix in file order (see `assignExternalIds`); the pages of one
 *            multi-page statement (`:62M:` / `:60M:`) count as one statement for this.
 *
 * Errors name the field and the line, never its content.
 */

const MAX_INPUT_CHARS = 25_000_000;

function fail(message: string): never {
  throw new ImportFormatError(message);
}

const dateSchema = z.string().regex(/^\d{6}$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const amountSchema = z.string().regex(/^\d+,\d*$/);
const monthDaySchema = z.string().regex(/^\d{4}$/);
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

interface Field {
  tag: string;
  value: string;
  line: number;
}

interface RawStatement {
  fields: Field[];
}

const SEPA_KEYWORD =
  /(EREF|KREF|MREF|CRED|DEBT|COAM|OAMT|SVWZ|ABWA|ABWE|IBAN|BIC|PURP|ORDP|BENM|RREF)\+/g;

function stripBlocks(text: string): string {
  const head = text.trimStart();
  if (!/^\{[1-5]:/.test(head)) return text;
  const nested = String.raw`(?:[^{}]|\{[^{}]*\})*`;
  return head
    .replace(new RegExp(String.raw`\{[1-35]:${nested}\}`, "g"), "\n")
    .replace(/\{4:/g, "\n")
    .replace(/-\}/g, "\n-\n");
}

function tokenize(text: string): RawStatement[] {
  const statements: RawStatement[] = [];
  let current: RawStatement | null = null;
  let field: Field | null = null;
  stripBlocks(text)
    .split(/\r\n|\n|\r/)
    .forEach((raw, i) => {
      const line = i + 1;
      const tag = /^:(\d{2}[A-Z]?):(.*)$/.exec(raw);
      if (tag) {
        field = { tag: tag[1]!, value: tag[2]!, line };
        if (tag[1] === "20") {
          current = { fields: [] };
          statements.push(current);
        }
        if (!current)
          fail(
            `Line ${line}: field :${tag[1]}: appears before the first :20: field`,
          );
        current.fields.push(field);
        return;
      }
      if (raw.trim() === "-") {
        current = null;
        field = null;
        return;
      }
      if (raw.trim() === "") return;
      if (!field)
        fail(`Line ${line}: text outside of any field (expected a :tag: line)`);
      field.value += `\n${raw}`;
    });
  return statements;
}

function twoDigitYear(yy: number): number {
  return (yy >= 70 ? 1900 : 2000) + yy;
}

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  )
    return null;
  return d.toISOString().slice(0, 10);
}

function readDate(raw: string, where: string): string {
  if (!dateSchema.safeParse(raw).success) fail(`${where}: invalid date`);
  const date = isoDate(
    twoDigitYear(Number(raw.slice(0, 2))),
    Number(raw.slice(2, 4)),
    Number(raw.slice(4, 6)),
  );
  if (!date) fail(`${where}: "${raw}" is not a calendar date`);
  return date;
}

/** The entry date (MMDD) in the year that puts it closest to the value date. */
function readEntryDate(raw: string, valueDate: string, where: string): string {
  if (!monthDaySchema.safeParse(raw).success) fail(`${where}: invalid date`);
  const month = Number(raw.slice(0, 2));
  const day = Number(raw.slice(2, 4));
  const valueYear = Number(valueDate.slice(0, 4));
  const valueTime = Date.parse(`${valueDate}T00:00:00Z`);
  let best: { date: string; distance: number } | null = null;
  for (const year of [valueYear - 1, valueYear, valueYear + 1]) {
    const date = isoDate(year, month, day);
    if (!date) continue;
    const distance = Math.abs(Date.parse(`${date}T00:00:00Z`) - valueTime);
    if (!best || distance < best.distance) best = { date, distance };
  }
  if (!best) fail(`${where}: "${raw}" is not a calendar date`);
  return best.date;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function readAmount(raw: string, currency: string, where: string): Minor {
  if (!amountSchema.safeParse(raw).success)
    fail(`${where}: invalid amount (expected digits with a decimal comma)`);
  const decimals = currencyExponent(currency);
  const [whole, fraction = ""] = raw.split(",");
  if (fraction.length > decimals && /[^0]/.test(fraction.slice(decimals)))
    fail(`${where}: amount has more decimals than ${currency} allows`);
  const kept = fraction.slice(0, decimals);
  try {
    return parseAmount(kept ? `${whole}.${kept}` : whole!, decimals);
  } catch {
    fail(`${where}: amount is out of range`);
  }
}

function sign(value: Minor, credit: boolean): Minor {
  return (credit || value === 0 ? value : 0 - value) as Minor;
}

interface Balance {
  balance: NormalizedBalance;
  rawDate: string;
}

function readBalance(field: Field, where: string): Balance {
  const m = /^([CD])(\d{6})([A-Z]{3})(\d+,\d*)$/.exec(field.value.trim());
  if (!m) fail(`${where} (line ${field.line}): malformed balance field`);
  const currency = currencySchema.safeParse(m[3]);
  if (!currency.success) fail(`${where}: invalid currency`);
  const date = readDate(m[2]!, `${where} (line ${field.line})`);
  const amount = readAmount(
    m[4]!,
    currency.data,
    `${where} (line ${field.line})`,
  );
  return {
    balance: {
      amount: sign(amount, m[1] === "C"),
      currency: currency.data,
      date,
    },
    rawDate: date,
  };
}

function parseAccount(value: string): {
  iban: string | null;
  otherId: string | null;
  currency: string | null;
} {
  const raw = value.split("\n")[0]!.replace(/\s+/g, "").toUpperCase();
  const m = /^(.+?)(?:\/([A-Z]{3}))?$/.exec(raw);
  const id = m?.[1] ?? "";
  const currency = m?.[2] ?? null;
  if (IBAN_SHAPE.test(id)) return { iban: id, otherId: null, currency };
  return { iban: null, otherId: id || null, currency };
}

interface ParsedInfo {
  description: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  endToEndId: string | null;
  referenceSource: string | null;
  flat: string;
}

function clean(s: string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

function usable(id: string | null | undefined): string | null {
  const t = id?.trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  return upper === "NOTPROVIDED" || upper === "NONREF" ? null : t;
}

function keywordsOf(text: string): {
  prefix: string;
  values: Map<string, string>;
} {
  const matches = [...text.matchAll(SEPA_KEYWORD)];
  const values = new Map<string, string>();
  if (matches.length === 0) return { prefix: text, values };
  matches.forEach((m, i) => {
    const end = matches[i + 1]?.index ?? text.length;
    const key = m[1]!;
    if (!values.has(key))
      values.set(key, text.slice(m.index + m[0].length, end).trim());
  });
  return { prefix: text.slice(0, matches[0]!.index), values };
}

function parseInfo(
  raw: string | null,
  fallbackText: string | null,
): ParsedInfo {
  if (raw === null) {
    return {
      description: clean(fallbackText),
      counterpartyName: null,
      counterpartyIban: null,
      endToEndId: null,
      referenceSource: clean(fallbackText),
      flat: "",
    };
  }
  const lines = raw.split("\n");
  const joined = lines.join("");
  const structured = /^(?:\d{3})?\?\d{2}/.test(joined.trimStart());
  let purpose: string;
  let name: string | null = null;
  let account: string | null = null;
  let posting: string | null = null;
  if (structured) {
    const parts = new Map<string, string>();
    const body = joined.trimStart().replace(/^\d{3}(?=\?)/, "");
    const pieces = body.split(/\?(\d{2})/);
    for (let i = 1; i < pieces.length; i += 2) {
      const key = pieces[i]!;
      parts.set(key, (parts.get(key) ?? "") + (pieces[i + 1] ?? ""));
    }
    const range = (from: number, to: number): string =>
      [...parts.entries()]
        .filter(([k]) => Number(k) >= from && Number(k) <= to)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, v]) => v)
        .join("");
    purpose = range(20, 29) + range(60, 63);
    name = clean(range(32, 33));
    account = clean(parts.get("31"))?.replace(/\s+/g, "").toUpperCase() ?? null;
    posting = clean(parts.get("00"));
  } else {
    purpose = lines.join(" ");
  }
  const { prefix, values } = keywordsOf(purpose);
  const description =
    clean(values.get("SVWZ")) ??
    clean(prefix) ??
    posting ??
    (values.size === 0 ? null : clean(fallbackText));
  const ibanCandidates = [values.get("IBAN"), account]
    .map((v) => v?.replace(/\s+/g, "").toUpperCase())
    .filter((v): v is string => !!v && IBAN_SHAPE.test(v));
  return {
    description: description ?? clean(fallbackText),
    counterpartyName: name,
    counterpartyIban: ibanCandidates[0] ?? null,
    endToEndId: usable(values.get("EREF")),
    referenceSource: clean(values.get("SVWZ") ?? prefix) ?? description,
    flat: lines.map((l) => l.trim()).join("\n"),
  };
}

function findReference(source: string | null): {
  reference: string | null;
  referenceType: ReferenceType | null;
} {
  if (!source) return { reference: null, referenceType: null };
  const candidates = [source, ...source.split(/\s+/)].map((s) =>
    s.replace(/\s+/g, ""),
  );
  for (const candidate of candidates) {
    const found = detectReference(candidate);
    if (found.referenceType) return found;
  }
  return { reference: null, referenceType: null };
}

function originalAmount(
  texts: (string | null)[],
  currency: string,
  credit: boolean,
  where: string,
): { amount: Minor; currency: string } | null {
  for (const t of texts) {
    const m = t ? /\/OCMT\/([A-Z]{3})(\d+(?:,\d*)?)(?:\/|\s|$)/.exec(t) : null;
    if (!m || m[1] === currency) continue;
    const amount = readAmount(
      m[2]!.includes(",") ? m[2]! : `${m[2]},`,
      m[1]!,
      where,
    );
    return { amount: sign(amount, credit), currency: m[1]! };
  }
  return null;
}

interface RawEntry {
  field: Field;
  info: string[];
}

const ENTRY =
  /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([NSF][A-Z0-9]{3})(.*)$/;

function parseEntry(
  entry: RawEntry,
  statementNo: number,
  currency: string,
  accountKey: string,
  ownIban: string | null,
): Draft {
  const where = `Statement #${statementNo} :61: (line ${entry.field.line})`;
  const [first = "", ...supplementary] = entry.field.value.split("\n");
  const m = ENTRY.exec(first.trimEnd());
  if (!m) fail(`${where}: malformed entry field`);
  const valueDate = readDate(m[1]!, where);
  const bookingDate = m[2] ? readEntryDate(m[2], valueDate, where) : valueDate;
  const mark = m[3]!;
  const credit = mark === "C" || mark === "RD";
  const reversal = mark === "RC" || mark === "RD";
  const value = sign(readAmount(m[5]!, currency, where), credit);

  const refs = m[7]!;
  const slashes = refs.indexOf("//");
  const customerRef = usable(slashes < 0 ? refs : refs.slice(0, slashes));
  const bankRef = usable(slashes < 0 ? null : refs.slice(slashes + 2));
  const supplement = clean(supplementary.join(" "));

  const info = parseInfo(
    entry.info.length > 0 ? entry.info.join("\n") : null,
    supplement,
  );
  const iban = info.counterpartyIban === ownIban ? null : info.counterpartyIban;
  const cp = { name: info.counterpartyName, iban };
  const ref = findReference(info.referenceSource);
  const original = originalAmount(
    [entry.info.join(" "), supplementary.join(" ")],
    currency,
    credit,
    where,
  );

  const tx = {
    bookingDate,
    valueDate,
    amount: value,
    currency,
    originalAmount: original?.amount ?? null,
    originalCurrency: original?.currency ?? null,
    counterpartyName: cp.name,
    counterpartyIban: cp.iban,
    description: info.description,
    reference: ref.reference,
    referenceType: ref.referenceType,
    reversal,
  };

  const party = counterpartyKey(cp);
  const when = `${bookingDate}:${value}${party ? `:${party}` : ""}`;
  let baseId: string;
  if (bankRef) baseId = `mt940:${bankRef}:${bookingDate}:${value}`;
  else if (info.endToEndId) baseId = `e2e:${info.endToEndId}:${when}`;
  else if (customerRef) baseId = `cref:${customerRef}:${when}`;
  else
    baseId = `hash:${sha256([
      "mt940",
      accountKey,
      bookingDate,
      valueDate,
      value,
      currency,
      cp.iban,
      cp.name,
      info.description,
      info.flat,
      supplement,
      reversal,
    ])}`;
  return { tx, baseId, legacyBaseId: null };
}

/** Per account: the id counters of the latest statement and whether it ended on `:62M:`. */
type Pages = Map<string, { seen: Map<string, number>; intermediate: boolean }>;

function parseStatement(
  raw: RawStatement,
  no: number,
  pages: Pages,
): NormalizedStatement {
  const what = `Statement #${no}`;
  let accountField: Field | null = null;
  let numberField: Field | null = null;
  let reference: Field | null = null;
  let opening: Field | null = null;
  let closing: Field | null = null;
  const entries: RawEntry[] = [];
  let lastWasEntry = false;
  let closed = false;

  for (const f of raw.fields) {
    const base = f.tag.replace(/[A-Z]$/, "");
    const dup = (name: string): never =>
      fail(`${what} (line ${f.line}): more than one ${name} field`);
    if (f.tag === "20") reference = f;
    else if (base === "25") {
      if (accountField) dup(":25:");
      accountField = f;
    } else if (f.tag === "28C") numberField = f;
    else if (f.tag === "60F" || f.tag === "60M") {
      if (opening) dup(":60F:/:60M:");
      opening = f;
    } else if (f.tag === "61") {
      if (closed)
        fail(`${what} (line ${f.line}): :61: after the closing balance`);
      entries.push({ field: f, info: [] });
      lastWasEntry = true;
      continue;
    } else if (f.tag === "86") {
      if (lastWasEntry) entries[entries.length - 1]!.info.push(f.value);
      else if (!closed)
        fail(`${what} (line ${f.line}): :86: without a preceding :61:`);
      continue;
    } else if (f.tag === "62F" || f.tag === "62M") {
      if (closing) dup(":62F:/:62M:");
      closing = f;
      closed = true;
    }
    lastWasEntry = false;
  }

  if (!accountField) fail(`${what} has no account identification (:25: field)`);
  const account = parseAccount(accountField.value);
  if (!account.iban && !account.otherId)
    fail(`${what} (line ${accountField.line}): empty account identification`);

  const openRead = opening ? readBalance(opening, `${what} :60:`) : null;
  const closeRead = closing ? readBalance(closing, `${what} :62:`) : null;
  const currency =
    openRead?.balance.currency ??
    closeRead?.balance.currency ??
    account.currency;
  if (!currency || !currencySchema.safeParse(currency).success)
    fail(
      `${what}: cannot determine the account currency (no :60:/:62: balance)`,
    );
  if (
    openRead &&
    closeRead &&
    openRead.balance.currency !== closeRead.balance.currency
  )
    fail(`${what}: opening and closing balance are in different currencies`);

  const accountKey = account.iban ?? `other:${account.otherId}`;
  const drafts = entries.map((e) =>
    parseEntry(e, no, currency, accountKey, account.iban),
  );
  // The pages of one statement (`:62M:` then `:60M:`) share their occurrence counters, so
  // identical bookings on both sides of a page break stay distinct.
  const previous = pages.get(accountKey);
  const continues =
    previous !== undefined && (previous.intermediate || opening?.tag === "60M");
  const seen = continues ? previous.seen : new Map<string, number>();
  pages.set(accountKey, { seen, intermediate: closing?.tag === "62M" });
  const transactions = assignExternalIds(drafts, seen);

  let openingBalance: NormalizedBalance | null = null;
  if (openRead) {
    const startsOnOrBefore = transactions.some(
      (t) => t.bookingDate <= openRead.rawDate,
    );
    openingBalance = {
      ...openRead.balance,
      date: startsOnOrBefore ? openRead.rawDate : nextDay(openRead.rawDate),
    };
  }

  return {
    accountIban: account.iban,
    accountOtherId: account.iban ? null : account.otherId,
    currency,
    statementId: clean(numberField?.value) ?? clean(reference?.value) ?? null,
    fromDate: null,
    toDate: null,
    openingBalance,
    closingBalance: closeRead?.balance ?? null,
    transactions,
  };
}

export function parseMt940(text: string): NormalizedStatement[] {
  if (typeof text !== "string" || text.trim() === "")
    fail("Empty file: expected an MT940 statement");
  if (text.length > MAX_INPUT_CHARS)
    fail(`File too large: more than ${MAX_INPUT_CHARS} characters`);
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/^\s*</.test(content))
    fail("Not an MT940 file: the content looks like XML");
  const statements = tokenize(content);
  if (statements.length === 0)
    fail("Not an MT940 file: no :20: statement field found");
  const pages: Pages = new Map();
  return statements.map((s, i) => parseStatement(s, i + 1, pages));
}
