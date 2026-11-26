import { minor, parseAmount, type Minor } from "../../src/lib/money";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_IBAN_THIRD,
  FOREIGN_IBANS,
} from "../../src/lib/testing/fixtures/bill-identifiers";

export const HISTORY_START = "2026-01-01";

const foreign = (country: string) =>
  FOREIGN_IBANS.find((iban) => iban.startsWith(country))!;

export const IBANS = {
  checking: EXAMPLE_IBAN,
  savings: EXAMPLE_IBAN_THIRD,
  wallet: foreign("LU"),
  walletTopUp: foreign("GB"),
  broker: foreign("DE"),
  pillar3a: EXAMPLE_IBAN_OTHER,
};

export type AccountKey = "checking" | "savings" | "wallet";

export interface Entry {
  id: string;
  date: string;
  amount: Minor;
  counterparty: string;
  counterpartyIban: string | null;
  description: string;
  reference: string | null;
}

export interface BillSpec {
  invoiceNumber: string;
  creditor: string;
  amount: Minor;
  issueDate: string;
  dueDate: string;
  reference: string;
  message: string;
  taxYear: number | null;
  document: boolean;
  payment: { date: string; amount: Minor } | null;
}

export interface Ledger {
  checking: Entry[];
  savings: Entry[];
  wallet: Entry[];
  bills: BillSpec[];
}

const m = (text: string) => parseAmount(text);
const neg = (value: Minor) => minor(-value);

export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** An integer from `lo` to `hi`, the same for the same seed on every day and machine. */
export function between(seed: string, lo: number, hi: number): number {
  let t = (hash(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return lo + Math.floor(unit * (hi - lo + 1));
}

const pad = (n: number) => String(n).padStart(2, "0");

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const monthLabel = (ym: string) =>
  `${MONTH_NAMES[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;

const at = (ym: string, day: number) => `${ym}-${pad(day)}`;

export function lastDay(ym: string): string {
  const [y, mo] = ym.split("-").map(Number);
  return at(ym, new Date(Date.UTC(y!, mo!, 0)).getUTCDate());
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d! + days)).toISOString().slice(0, 10);
}

export function addMonths(ym: string, months: number): string {
  const [y, mo] = ym.split("-").map(Number);
  const index = y! * 12 + (mo! - 1) + months;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** Every month from the start of the history up to the one `today` is in. */
export function monthsUpTo(today: string): string[] {
  const months: string[] = [];
  for (
    let ym = HISTORY_START.slice(0, 7);
    ym <= today.slice(0, 7);
    ym = addMonths(ym, 1)
  ) {
    months.push(ym);
  }
  return months;
}

/** ISO 11649 creditor reference for a body of capital letters and digits. */
export function scor(body: string): string {
  const digits = `${body}RF00`.replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );
  let remainder = 0;
  for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  return `RF${pad(98 - remainder)}${body}`;
}

function entry(
  kind: string,
  date: string,
  amount: Minor,
  counterparty: string,
  description: string,
  extra: { id?: string; iban?: string; reference?: string } = {},
): Entry {
  return {
    id: extra.id ?? `DEMO-${kind}-${date.slice(0, 7)}`,
    date,
    amount,
    counterparty,
    counterpartyIban: extra.iban ?? null,
    description,
    reference: extra.reference ?? null,
  };
}

/** `count` purchases a month at deterministic days and amounts, in minor units between `lo` and `hi`. */
function purchases(
  kind: string,
  ym: string,
  count: number,
  [lo, hi]: [number, number],
  counterparty: string,
  description: string,
  days: [number, number] = [2, 28],
): Entry[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `DEMO-${kind}-${ym}-${i + 1}`;
    return entry(
      kind,
      at(ym, between(`${id}:day`, days[0], days[1])),
      neg(minor(between(`${id}:amount`, lo, hi))),
      counterparty,
      description,
      { id },
    );
  });
}

const MOD10 = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

/** Swiss QR reference: the digits padded to 26 and a recursive mod-10 check digit. */
export function qrr(digits: string): string {
  const body = digits.padStart(26, "0");
  let carry = 0;
  for (const d of body) carry = MOD10[(carry + Number(d)) % 10]!;
  return `${body}${(10 - carry) % 10}`;
}

export const PILLAR_3A_REFERENCE = qrr("260001042");

const QUARTER_MONTHS = ["01", "04", "07", "10"];

function walletMonth(ym: string): Entry[] {
  const oneOffs: Record<string, Entry[]> = {
    "2026-03": [
      entry(
        "SKI",
        at("2026-03", 14),
        m("-186.00"),
        "Example Mountain Lift",
        "Day passes",
      ),
    ],
    "2026-07": [
      entry(
        "FLIGHT",
        at("2026-07", 3),
        m("-418.00"),
        "Example Airline",
        "Return flight",
      ),
      entry(
        "HOTEL",
        at("2026-07", 19),
        m("-642.50"),
        "Example Hotel",
        "Hotel, 5 nights",
      ),
    ],
  };
  return [
    entry(
      "GYM",
      at(ym, 1),
      m("-59.00"),
      "Example Fitness",
      `Membership ${monthLabel(ym)}`,
    ),
    entry(
      "PASS",
      at(ym, 2),
      m("-124.00"),
      "Example Rail",
      `Travel pass ${monthLabel(ym)}`,
    ),
    entry(
      "STREAM",
      at(ym, 8),
      m("-13.90"),
      "Example Streaming",
      `Subscription ${monthLabel(ym)}`,
    ),
    entry(
      "CLOUD",
      at(ym, 12),
      m("-2.90"),
      "Example Cloud Storage",
      `Subscription ${monthLabel(ym)}`,
    ),
    ...purchases(
      "CGRO",
      ym,
      4,
      [2480, 9860],
      "Example Market",
      "Prepaid card purchase",
    ),
    ...purchases(
      "CDINE",
      ym,
      3,
      [3600, 11800],
      "Example Restaurant",
      "Prepaid card purchase",
    ),
    ...purchases("TAXI", ym, 1, [1700, 3400], "Example Taxi", "Ride"),
    ...purchases(
      "SHOP",
      ym,
      1,
      [1900, 14900],
      "Example Online Shop",
      "Online order",
    ),
    ...(Number(ym.slice(5)) % 3 === 0
      ? purchases(
          "HARD",
          ym,
          1,
          [2200, 8500],
          "Example Hardware Store",
          "Prepaid card purchase",
        )
      : []),
    ...(oneOffs[ym] ?? []),
  ];
}

/** The wallet's balance at the start of the history. */
export const WALLET_OPENING = m("300.00");

/** The month's spending on the wallet, rounded up to the next 50, loaded on the 1st so the balance never goes below zero. */
function walletTopUp(ym: string): number {
  const spent = walletMonth(ym).reduce((sum, e) => sum - e.amount, 0);
  return Math.ceil(spent / 5000) * 5000;
}

function billSpecs(): BillSpec[] {
  const quarterly = (
    creditor: string,
    prefix: string,
    issueDay: number,
    amountOf: (id: string) => Minor,
    message: string,
    paidDaysBeforeDue: number,
    ym: string,
  ): BillSpec => {
    const issueDate = at(ym, issueDay);
    const dueDate = addDays(issueDate, 30);
    const amount = amountOf(`${prefix}-${ym}`);
    return {
      invoiceNumber: `${prefix}-${ym}`,
      creditor,
      amount,
      issueDate,
      dueDate,
      reference: scor(`${issueDate.replaceAll("-", "")}${pad(issueDay)}`),
      message,
      taxYear: null,
      document: prefix === "EEU" && ym.endsWith("-10"),
      payment: {
        date: addDays(dueDate, -paidDaysBeforeDue),
        amount,
      },
    };
  };
  const years = [2026, 2027, 2028, 2029, 2030].flatMap((y) =>
    QUARTER_MONTHS.map((q) => `${y}-${q}`),
  );
  const periodic = years.flatMap((ym) => [
    quarterly(
      "Example Energy Utility",
      "EEU",
      12,
      (id) => minor(between(id, 9800, 14800)),
      "Electricity, quarterly invoice",
      4,
      ym,
    ),
    quarterly(
      "Example Broadband AG",
      "EBB",
      18,
      () => m("177.00"),
      "Internet and TV, quarterly invoice",
      3,
      ym,
    ),
  ]);
  const tax = (
    invoiceNumber: string,
    issueDate: string,
    dueDate: string,
    amount: string,
    taxYear: number,
    message: string,
    paidOn: string | null,
  ): BillSpec => ({
    invoiceNumber,
    creditor: "Example Cantonal Tax Office",
    amount: m(amount),
    issueDate,
    dueDate,
    reference: scor(`${issueDate.replaceAll("-", "")}${taxYear % 100}`),
    message,
    taxYear,
    document: invoiceNumber === "TAX-2026-4",
    payment: paidOn ? { date: paidOn, amount: m(amount) } : null,
  });
  const scenarios: BillSpec[] = [
    tax(
      "TAX-2025-F",
      "2026-01-20",
      "2026-02-28",
      "2010.00",
      2025,
      "Final invoice 2025, balance",
      "2026-02-20",
    ),
    tax(
      "TAX-2026-1",
      "2026-02-24",
      "2026-03-31",
      "2150.00",
      2026,
      "Provisional invoice 2026, instalment 1 of 4",
      "2026-03-20",
    ),
    tax(
      "TAX-2026-2",
      "2026-05-26",
      "2026-06-30",
      "2150.00",
      2026,
      "Provisional invoice 2026, instalment 2 of 4",
      "2026-06-19",
    ),
    tax(
      "TAX-2026-3",
      "2026-08-25",
      "2026-09-30",
      "2150.00",
      2026,
      "Provisional invoice 2026, instalment 3 of 4",
      "2026-09-18",
    ),
    tax(
      "TAX-2026-4",
      "2026-11-02",
      "2026-12-15",
      "2150.00",
      2026,
      "Provisional invoice 2026, instalment 4 of 4",
      null,
    ),
    {
      invoiceNumber: "DEN-2026-10",
      creditor: "Example Dental Clinic",
      amount: m("285.00"),
      issueDate: "2026-10-02",
      dueDate: "2026-11-01",
      reference: scor("2026100201"),
      message: "Check-up and cleaning",
      taxYear: null,
      document: true,
      payment: null,
    },
    {
      invoiceNumber: "GAR-2026-11",
      creditor: "Example Garage",
      amount: m("1260.00"),
      issueDate: "2026-11-10",
      dueDate: "2026-12-10",
      reference: scor("2026111001"),
      message: "Service and winter tyres, pay in instalments if you wish",
      taxYear: null,
      document: true,
      payment: { date: "2026-11-14", amount: m("600.00") },
    },
  ];
  return [...periodic, ...scenarios];
}

const BILLS = billSpecs();

function monthEntries(ym: string) {
  const label = monthLabel(ym);
  const quarter = QUARTER_MONTHS.includes(ym.slice(5));
  const thirdMonth = Number(ym.slice(5)) % 3 === 0;
  const checking: Entry[] = [
    entry(
      "SAL",
      at(ym, 1),
      m("6850.00"),
      "Example Employer AG",
      `Salary ${label}`,
    ),
    entry(
      "RENT",
      at(ym, 1),
      m("-1850.00"),
      "Example Property Management",
      `Rent ${label}`,
    ),
    entry(
      "HEALTH",
      at(ym, 3),
      m("-412.60"),
      "Example Health Insurance AG",
      `Premium ${label}`,
    ),
    entry(
      "MOBILE",
      at(ym, 10),
      m("-39.90"),
      "Example Telecom",
      `Mobile subscription ${label}`,
    ),
    ...purchases(
      "GRO",
      ym,
      4,
      [2250, 14200],
      "Example Market",
      "Debit card purchase",
    ),
    ...purchases(
      "BAKE",
      ym,
      2,
      [450, 1480],
      "Example Bakery",
      "Debit card purchase",
    ),
    ...purchases(
      "CAFE",
      ym,
      2,
      [1100, 4200],
      "Example Cafe",
      "Debit card purchase",
    ),
    ...(hash(`PHARM-${ym}`) % 2 === 0
      ? purchases(
          "PHARM",
          ym,
          1,
          [2400, 6800],
          "Example Pharmacy",
          "Debit card purchase",
        )
      : []),
    ...purchases(
      "ATM",
      ym,
      1,
      [20000, 20000],
      "Cash withdrawal",
      "Cash withdrawal",
      [12, 20],
    ),
    entry(
      "SAVE",
      at(ym, 26),
      m("-500.00"),
      "Rainy-day savings",
      "Standing order to savings",
      { iban: IBANS.savings },
    ),
    entry(
      "INVEST",
      at(ym, 27),
      m("-400.00"),
      "Example Broker",
      "Monthly investment plan",
      { iban: IBANS.broker },
    ),
    entry(
      "TOPUP",
      at(ym, 1),
      neg(minor(walletTopUp(ym))),
      "Example Pay",
      "Prepaid card top-up",
      { iban: IBANS.wallet },
    ),
    ...(quarter
      ? [
          entry(
            "HOME",
            at(ym, 15),
            m("-96.50"),
            "Example Insurance AG",
            "Household insurance, quarterly premium",
          ),
        ]
      : []),
    ...(ym.endsWith("-02")
      ? [
          entry(
            "P3A",
            at(ym, 3),
            m("-7258.00"),
            "Example Broker Pillar 3a",
            "Pillar 3a contribution",
            {
              reference: PILLAR_3A_REFERENCE,
              iban: IBANS.pillar3a,
              id: `DEMO-P3A-${ym.slice(0, 4)}`,
            },
          ),
        ]
      : []),
  ];
  const savings: Entry[] = [
    entry(
      "SAVEIN",
      at(ym, 26),
      m("500.00"),
      "Everyday account",
      "Standing order",
      {
        iban: IBANS.checking,
      },
    ),
    ...(thirdMonth
      ? [
          entry(
            "INT",
            lastDay(ym),
            minor(between(`INT-${ym}`, 2200, 2700)),
            "Example Bank",
            `Interest ${label}`,
          ),
        ]
      : []),
  ];
  const wallet: Entry[] = [
    ...walletMonth(ym),
    entry(
      "TOPUP",
      at(ym, 1),
      minor(walletTopUp(ym)),
      "Everyday account",
      "Top-up",
      {
        iban: IBANS.checking,
      },
    ),
  ];
  const billPayments = BILLS.flatMap((b) =>
    b.payment && b.payment.date.startsWith(ym)
      ? [
          entry(
            "BILL",
            b.payment.date,
            neg(b.payment.amount),
            b.creditor,
            `Invoice ${b.invoiceNumber}`,
            {
              id: `DEMO-BILL-${b.invoiceNumber}`,
              reference: b.reference,
            },
          ),
        ]
      : [],
  );
  return { checking: [...checking, ...billPayments], savings, wallet };
}

const byDate = (a: Entry, b: Entry) =>
  a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

/** Everything the history holds up to `today`, in minor units; the same call on the same day gives the same answer. */
export function buildLedger(today: string): Ledger {
  const bills = BILLS.filter((b) => b.issueDate <= today).map((b) => ({
    ...b,
    payment: b.payment && b.payment.date <= today ? b.payment : null,
  }));
  const all = {
    checking: [] as Entry[],
    savings: [] as Entry[],
    wallet: [] as Entry[],
  };
  for (const ym of monthsUpTo(today)) {
    const month = monthEntries(ym);
    for (const key of ["checking", "savings", "wallet"] as const) {
      all[key].push(...month[key]);
    }
  }
  const upTo = (entries: Entry[]) =>
    entries
      .filter((e) => e.date >= HISTORY_START && e.date <= today)
      .sort(byDate);
  return {
    checking: upTo(all.checking),
    savings: upTo(all.savings),
    wallet: upTo(all.wallet),
    bills,
  };
}

export function sum(entries: readonly Entry[]): Minor {
  return minor(entries.reduce((total, e) => total + e.amount, 0));
}

/** Plain decimal text for a form field or a statement: `-1850.00`. */
export function plain(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${pad(abs % 100)}`;
}
