import { isQrIban, isValidIban, normalizeIban } from "$lib/iban";
import { parseAmount, type Minor } from "$lib/money";
import { isValidQrr, isValidScor, normalizeReference } from "$lib/references";

export interface QrBillParty {
  name: string;
  addressLines: string[];
  postalCode: string | null;
  town: string | null;
  country: string;
}

export interface QrBill {
  creditorIban: string;
  creditor: QrBillParty;
  amount: Minor | null;
  currency: "CHF" | "EUR";
  debtor: QrBillParty | null;
  referenceType: "QRR" | "SCOR" | "NON";
  reference: string | null;
  message: string | null;
  billInformation: string | null;
  invoiceNumber: string | null;
  /** YYYY-MM-DD */
  invoiceDate: string | null;
  /** YYYY-MM-DD, derived from invoice date + net payment days of `/40/`, if present. */
  dueDate: string | null;
  alternativeProcedures: string[];
  /** Non-fatal observations for the user, e.g. a zero amount. */
  warnings: string[];
}

export class QrBillParseError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`QR-bill field "${field}": ${message}`);
    this.name = "QrBillParseError";
    this.field = field;
  }
}

// Line positions in the SPC payload (Swiss Implementation Guidelines QR-bill 2.x).
const L = {
  header: 0,
  version: 1,
  coding: 2,
  iban: 3,
  creditor: 4, // 7 lines: type, name, street/line1, number/line2, postal code, town, country
  ultimateCreditor: 11, // 7 lines, reserved for future use
  amount: 18,
  currency: 19,
  debtor: 20, // 7 lines
  referenceType: 27,
  reference: 28,
  message: 29,
  trailer: 30,
  billInformation: 31,
  alt1: 32,
  alt2: 33,
} as const;

function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
}

function parseParty(
  lines: string[],
  start: number,
  field: string,
  required: boolean,
): QrBillParty | null {
  const [type, name, l1, l2, postalCode, town, country] = lines
    .slice(start, start + 7)
    .concat(Array(7).fill(""))
    .slice(0, 7);

  if (
    !required &&
    [type, name, l1, l2, postalCode, town, country].every((v) => v === "")
  ) {
    return null;
  }
  if (type !== "S" && type !== "K") {
    throw new QrBillParseError(`${field}.addressType`, 'must be "S" or "K"');
  }
  if (name === "") throw new QrBillParseError(`${field}.name`, "is required");
  if (name.length > 70)
    throw new QrBillParseError(`${field}.name`, "is longer than 70 characters");
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new QrBillParseError(
      `${field}.country`,
      "must be a two-letter ISO 3166 code",
    );
  }

  if (type === "S") {
    if (town === "") throw new QrBillParseError(`${field}.town`, "is required");
    if (postalCode.length > 16) {
      throw new QrBillParseError(
        `${field}.postalCode`,
        "is longer than 16 characters",
      );
    }
    const street = [l1, l2].filter((v) => v !== "").join(" ");
    return {
      name,
      addressLines: street === "" ? [] : [street],
      postalCode: emptyToNull(postalCode),
      town,
      country,
    };
  }

  // Combined address: line 1 is street/number, line 2 is postal code + town.
  if (l2 === "")
    throw new QrBillParseError(`${field}.addressLine2`, "is required");
  const match = /^(\d{3,10})\s+(.+)$/.exec(l2);
  return {
    name,
    addressLines: match
      ? l1 === ""
        ? []
        : [l1]
      : [l1, l2].filter((v) => v !== ""),
    postalCode: match ? match[1] : null,
    town: match ? match[2] : null,
    country,
  };
}

function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function parseYyMmDd(value: string): string | null {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isRealDate(year, month, day)) return null;
  return `${year}-${match[2]}-${match[3]}`;
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Splits on `/` but keeps `\/` (escaped slash) inside values. */
function splitBillInfo(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) {
      current += body[i + 1];
      i++;
    } else if (body[i] === "/") {
      parts.push(current);
      current = "";
    } else {
      current += body[i];
    }
  }
  parts.push(current);
  return parts;
}

export interface BillInformation {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
}

/**
 * Parses the Swico S1 syntax (`//S1/10/<invoice no>/11/<YYMMDD>/40/<pct>:<days>;...`).
 * Tag 11 is only used when it is a single date (a 12-digit service period is ignored).
 * Tag 40 lists `percent:days` pairs; the due date is invoice date + the days of the
 * pair with 0 percent (the net term). Discount-only terms yield no due date.
 * Unknown or malformed tags are ignored: billing information is informational only.
 */
export function parseBillInformation(text: string | null): BillInformation {
  const result: BillInformation = {
    invoiceNumber: null,
    invoiceDate: null,
    dueDate: null,
  };
  if (!text || !text.startsWith("//S1/")) return result;
  const parts = splitBillInfo(text.slice("//S1/".length));
  const tags = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!tags.has(parts[i])) tags.set(parts[i], parts[i + 1]);
  }
  result.invoiceNumber = emptyToNull(tags.get("10") ?? "");
  result.invoiceDate = parseYyMmDd(tags.get("11") ?? "");
  const conditions = tags.get("40");
  if (conditions && result.invoiceDate) {
    for (const pair of conditions.split(";")) {
      const m = /^(\d+(?:\.\d+)?):(\d{1,4})$/.exec(pair.trim());
      if (m && Number(m[1]) === 0) {
        result.dueDate = addDays(result.invoiceDate, Number(m[2]));
        break;
      }
    }
  }
  return result;
}

/**
 * The implementation guidelines require exactly two decimals; we also accept
 * "50" and "1.5" since they are unambiguous and some generators omit them.
 * Zero is allowed (notification bills carry 0.00); the caller adds a warning.
 */
function parseAmountField(value: string): Minor | null {
  if (value === "") return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(value)) {
    throw new QrBillParseError(
      "amount",
      "must be a decimal with at most two decimals",
    );
  }
  const amount = parseAmount(value);
  if (amount > 99_999_999_999) {
    throw new QrBillParseError("amount", "must be at most 999999999.99");
  }
  return amount;
}

/**
 * Parses the text of a Swiss QR code (type SPC, version 0200, coding 1).
 * Lines may be separated by CRLF or LF; trailing empty lines and missing optional
 * trailing fields are tolerated. Throws QrBillParseError naming the offending field.
 *
 * Leniency: both structured (S) and combined (K) creditor/debtor addresses are
 * accepted (K was withdrawn from the guidelines in late 2025 but is still common);
 * a filled ultimate-creditor block is ignored; amounts may omit decimals.
 */
export function parseQrBillPayload(text: string): QrBill {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim());
  const at = (index: number) => lines[index] ?? "";

  if (at(L.header) !== "SPC") {
    throw new QrBillParseError("header", 'must be "SPC"');
  }
  if (at(L.version) !== "0200") {
    throw new QrBillParseError(
      "version",
      'unsupported version, expected "0200"',
    );
  }
  if (at(L.coding) !== "1") {
    throw new QrBillParseError(
      "coding",
      'unsupported coding type, expected "1" (UTF-8)',
    );
  }

  const creditorIban = normalizeIban(at(L.iban));
  if (!/^(CH|LI)/.test(creditorIban) || !isValidIban(creditorIban)) {
    throw new QrBillParseError("creditorIban", "is not a valid CH/LI IBAN");
  }

  const creditor = parseParty(
    lines,
    L.creditor,
    "creditor",
    true,
  ) as QrBillParty;

  const amount = parseAmountField(at(L.amount));

  const currency = at(L.currency);
  if (currency !== "CHF" && currency !== "EUR") {
    throw new QrBillParseError("currency", 'must be "CHF" or "EUR"');
  }

  const debtor = parseParty(lines, L.debtor, "debtor", false);

  const referenceType = at(L.referenceType);
  if (
    referenceType !== "QRR" &&
    referenceType !== "SCOR" &&
    referenceType !== "NON"
  ) {
    throw new QrBillParseError(
      "referenceType",
      'must be "QRR", "SCOR" or "NON"',
    );
  }
  const qrIban = isQrIban(creditorIban);
  if (qrIban && referenceType !== "QRR") {
    throw new QrBillParseError(
      "referenceType",
      "a QR-IBAN requires a QR reference (QRR)",
    );
  }
  if (!qrIban && referenceType === "QRR") {
    throw new QrBillParseError(
      "referenceType",
      "a QR reference (QRR) requires a QR-IBAN",
    );
  }

  let reference: string | null = null;
  if (referenceType === "NON") {
    if (at(L.reference) !== "") {
      throw new QrBillParseError(
        "reference",
        'must be empty for reference type "NON"',
      );
    }
  } else {
    reference = normalizeReference(at(L.reference));
    const valid =
      referenceType === "QRR" ? isValidQrr(reference) : isValidScor(reference);
    if (!valid) {
      throw new QrBillParseError(
        "reference",
        referenceType === "QRR"
          ? "is not a valid QR reference (27 digits, mod-10 check)"
          : "is not a valid creditor reference (ISO 11649)",
      );
    }
  }

  if (at(L.trailer) !== "EPD") {
    throw new QrBillParseError("trailer", 'must be "EPD"');
  }

  const billInformation = emptyToNull(at(L.billInformation));
  const info = parseBillInformation(billInformation);

  return {
    creditorIban,
    creditor,
    amount,
    currency,
    debtor,
    referenceType,
    reference,
    message: emptyToNull(at(L.message)),
    billInformation,
    invoiceNumber: info.invoiceNumber,
    invoiceDate: info.invoiceDate,
    dueDate: info.dueDate,
    alternativeProcedures: [at(L.alt1), at(L.alt2)].filter((v) => v !== ""),
    warnings:
      amount === 0 ? ["Zero amount - notification only, nothing to pay"] : [],
  };
}
