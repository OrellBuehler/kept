import { isQrIban, isValidIban, normalizeIban } from "$lib/iban";
import { parseAmount, type Minor } from "$lib/money";
import { isValidQrr, isValidScor, normalizeReference } from "./references";

export interface BillFields {
  creditorName: string | null;
  creditorIban: string | null;
  amount: Minor | null;
  currency: "CHF" | "EUR" | null;
  reference: string | null;
  referenceType: "QRR" | "SCOR" | "NON" | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  invoiceNumber: string | null;
}

export type TextConfidence = "medium" | "low" | "none";

export interface TextExtraction {
  fields: BillFields;
  /**
   * medium: a validated IBAN plus an amount or validated reference were found.
   * low: something was found but it is incomplete. none: nothing usable.
   */
  confidence: TextConfidence;
}

const MAX_AMOUNT = 99_999_999_999;

const NUM =
  "(?:\\d{1,3}(?:\\.\\d{3})+,\\d{2}|\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d{1,3}(?:[ '’  ]\\d{3})+[.,]\\d{2}|\\d+[.,]\\d{2})";
const NOT_DIGIT_BEFORE = "(?<![\\d.,])";
const NOT_DIGIT_AFTER = "(?![\\d])";

const AMOUNT_KEYWORDS = [
  "gesamtbetrag",
  "rechnungsbetrag",
  "endbetrag",
  "betrag",
  "total",
  "zu zahlen",
  "montant",
  "à payer",
  "importo",
  "totale",
  "amount due",
  "amount",
  "balance due",
]
  .map((k) => k.replace(/ /g, "\\s+"))
  .join("|");

const KEYWORD_AMOUNT = new RegExp(
  `(?<!\\p{L})(?:${AMOUNT_KEYWORDS})(?!\\p{L})[^\\d]{0,30}?(?:(CHF|EUR)\\s*)?${NOT_DIGIT_BEFORE}(${NUM})${NOT_DIGIT_AFTER}(?:\\s*(CHF|EUR))?`,
  "giu",
);
const CURRENCY_FIRST = new RegExp(
  `(?<![A-Z])(CHF|EUR)\\s*${NOT_DIGIT_BEFORE}(${NUM})${NOT_DIGIT_AFTER}`,
  "g",
);
const CURRENCY_LAST = new RegExp(
  `${NOT_DIGIT_BEFORE}(${NUM})${NOT_DIGIT_AFTER}\\s*(CHF|EUR)(?![A-Z])`,
  "g",
);

const DATE =
  "(\\d{1,2})[./](\\d{1,2})[./](\\d{4}|\\d{2})|(\\d{4})-(\\d{2})-(\\d{2})";
const DUE_KEYWORDS = [
  "zahlbar\\s+(?:bis|innert|spätestens)(?:\\s+zum|\\s+am)?",
  "zahlungsfrist",
  "fälligkeitsdatum",
  "fälligkeit",
  "fällig(?:\\s+am|\\s+bis)?",
  "payable\\s+(?:by|until|on)",
  "payment\\s+due(?:\\s+date)?",
  "due\\s+(?:date|on|by)",
  "pay\\s+by",
  "date\\s+d['’]échéance",
  "échéance",
  "payable\\s+jusqu['’]au",
  "payer\\s+avant(?:\\s+le)?",
  "scadenza",
  "da\\s+pagare\\s+entro(?:\\s+il)?",
  "pagabile\\s+entro(?:\\s+il)?",
  "termine\\s+di\\s+pagamento",
].join("|");
const DUE_DATE = new RegExp(
  `(?<!\\p{L})(?:${DUE_KEYWORDS})(?!\\p{L})[^\\d]{0,30}?(?:${DATE})`,
  "giu",
);

const INVOICE_NUMBER = new RegExp(
  "(?<!\\p{L})(?:rechnungs?[-\\s]?(?:nummer|nr\\.?)|invoice\\s*(?:number|no\\.?|#)|facture\\s*(?:numéro|n°|no\\.?)|fattura\\s*(?:numero|n°|no\\.?)|numéro\\s+de\\s+facture|numero\\s+fattura)\\s*[:.]?\\s*([A-Z0-9][A-Z0-9\\-/.]{2,30})",
  "iu",
);

const NON_NAME_LABEL =
  /^(referenz|reference|riferimento|zusätzliche|informations?|informazioni|zahlbar\s+durch|payable\s+by|payable\s+par|pagabile\s+da|währung|monnaie|valuta|betrag|montant|importo|annahmestelle|point\s+de\s+dépôt|punto\s+di|empfangsschein|récépissé|ricevuta|zahlteil|section\s+paiement|sezione\s+pagamento|konto|compte|conto|account)/iu;

function emptyFields(): BillFields {
  return {
    creditorName: null,
    creditorIban: null,
    amount: null,
    currency: null,
    reference: null,
    referenceType: null,
    dueDate: null,
    invoiceNumber: null,
  };
}

function findIban(text: string): string | null {
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]*$/.test(tokens[i])) continue;
    let candidate = "";
    for (let j = i; j < Math.min(tokens.length, i + 9); j++) {
      if (!/^[A-Z0-9]+$/.test(tokens[j])) break;
      candidate += tokens[j];
      if (candidate.length > 34) break;
      if (isValidIban(candidate)) return normalizeIban(candidate);
    }
  }
  return null;
}

function findReferences(text: string): {
  qrr: string | null;
  scor: string | null;
} {
  let qrr: string | null = null;
  const qrrPattern = /(?<!\d)(?:\d{2}(?: ?\d{5}){5}|\d{27})(?!\d)/g;
  for (const match of text.matchAll(qrrPattern)) {
    const ref = normalizeReference(match[0]);
    if (isValidQrr(ref)) {
      qrr = ref;
      break;
    }
  }

  let scor: string | null = null;
  const tokens = text.split(/\s+/);
  outer: for (let i = 0; i < tokens.length; i++) {
    if (!/^RF\d{2}[A-Z0-9]*$/.test(tokens[i])) continue;
    let candidate = "";
    for (let j = i; j < Math.min(tokens.length, i + 7); j++) {
      if (!/^[A-Z0-9]+$/.test(tokens[j])) break;
      candidate += tokens[j];
      if (candidate.length > 25) break;
      if (isValidScor(candidate)) {
        scor = candidate;
        break outer;
      }
    }
  }
  return { qrr, scor };
}

/** Every NUM match ends in exactly two decimals, so separators can simply be dropped. */
function toDecimal(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return `${digits.slice(0, -2) || "0"}.${digits.slice(-2)}`;
}

function tryAmount(raw: string): Minor | null {
  try {
    const amount = parseAmount(toDecimal(raw));
    return amount >= 1 && amount <= MAX_AMOUNT ? amount : null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError)
      return null;
    throw error;
  }
}

function findAmount(
  text: string,
): { amount: Minor; currency: "CHF" | "EUR" | null } | null {
  let best: { amount: Minor; currency: "CHF" | "EUR" | null } | null = null;
  for (const m of text.matchAll(KEYWORD_AMOUNT)) {
    const amount = tryAmount(m[2]);
    if (amount !== null) {
      best = {
        amount,
        currency: ((m[1] ?? m[3])?.toUpperCase() as "CHF" | "EUR") ?? null,
      };
    }
  }
  if (best) return best;
  for (const m of text.matchAll(CURRENCY_FIRST)) {
    const amount = tryAmount(m[2]);
    if (amount !== null) best = { amount, currency: m[1] as "CHF" | "EUR" };
  }
  if (best) return best;
  for (const m of text.matchAll(CURRENCY_LAST)) {
    const amount = tryAmount(m[1]);
    if (amount !== null) best = { amount, currency: m[2] as "CHF" | "EUR" };
  }
  return best;
}

function toIsoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function findDueDate(text: string): string | null {
  for (const m of text.matchAll(DUE_DATE)) {
    const iso = m[4]
      ? toIsoDate(Number(m[4]), Number(m[5]), Number(m[6]))
      : toIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    if (iso) return iso;
  }
  return null;
}

function findCreditorName(text: string, iban: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex(
    (l) => l !== "" && normalizeIban(l).includes(iban),
  );
  if (at < 0) return null;
  for (let i = at + 1; i < Math.min(lines.length, at + 4); i++) {
    const line = lines[i];
    if (line === "") continue;
    if (NON_NAME_LABEL.test(line)) return null;
    if (/\p{L}/u.test(line) && line.length <= 70 && !/^\d/.test(line))
      return line;
    return null;
  }
  return null;
}

/**
 * Best-effort extraction from plain PDF text (German, French, Italian, English).
 * Every returned value is either validated (IBAN, reference, real calendar date,
 * amount range) or explicitly heuristic (creditor name, invoice number).
 */
export function extractFromText(text: string): TextExtraction {
  const fields = emptyFields();

  const iban = findIban(text);
  fields.creditorIban = iban;

  const { qrr, scor } = findReferences(text);
  if (qrr && (!iban || isQrIban(iban))) {
    fields.reference = qrr;
    fields.referenceType = "QRR";
  } else if (scor) {
    fields.reference = scor;
    fields.referenceType = "SCOR";
  } else if (qrr) {
    fields.reference = qrr;
    fields.referenceType = "QRR";
  }

  const amount = findAmount(text);
  if (amount) {
    fields.amount = amount.amount;
    fields.currency = amount.currency;
  }

  fields.dueDate = findDueDate(text);
  fields.invoiceNumber =
    INVOICE_NUMBER.exec(text)?.[1]?.replace(/[.\-/]+$/, "") ?? null;
  if (iban) fields.creditorName = findCreditorName(text, iban);

  const found =
    iban !== null ||
    fields.reference !== null ||
    fields.amount !== null ||
    fields.dueDate !== null ||
    fields.invoiceNumber !== null;
  let confidence: TextConfidence = "none";
  if (found) {
    confidence =
      iban && (fields.amount !== null || fields.reference !== null)
        ? "medium"
        : "low";
  }
  return { fields, confidence };
}
