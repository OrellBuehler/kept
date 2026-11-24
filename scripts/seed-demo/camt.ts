import { minor, type Minor } from "../../src/lib/money";
import { HISTORY_START, addMonths, lastDay, plain, type Entry } from "./ledger";

export interface StatementBalance {
  amount: Minor;
  date: string;
}

export interface Statement {
  id: string;
  iban: string;
  currency: string;
  from: string;
  to: string;
  opening: StatementBalance;
  closing: StatementBalance;
  entries: Entry[];
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function balance(code: "OPBD" | "CLBD", b: StatementBalance, currency: string) {
  const sign = b.amount < 0 ? "DBIT" : "CRDT";
  return `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${currency}">${plain(Math.abs(b.amount))}</Amt><CdtDbtInd>${sign}</CdtDbtInd><Dt><Dt>${b.date}</Dt></Dt></Bal>`;
}

function ntry(e: Entry, currency: string, n: number): string {
  const debit = e.amount < 0;
  const role = debit ? "Cdtr" : "Dbtr";
  const party = `<${role}><Nm>${escapeXml(e.counterparty)}</Nm></${role}>${
    e.counterpartyIban
      ? `<${role}Acct><Id><IBAN>${e.counterpartyIban}</IBAN></Id></${role}Acct>`
      : ""
  }`;
  const reference = e.reference
    ? `<Strd><CdtrRefInf><Tp><CdOrPrtry>${/^\d{27}$/.test(e.reference) ? "<Prtry>QRR</Prtry>" : "<Cd>SCOR</Cd>"}</CdOrPrtry></Tp><Ref>${e.reference}</Ref></CdtrRefInf></Strd>`
    : "";
  return `<Ntry><NtryRef>${n}</NtryRef><Amt Ccy="${currency}">${plain(Math.abs(e.amount))}</Amt><CdtDbtInd>${debit ? "DBIT" : "CRDT"}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><ValDt><Dt>${e.date}</Dt></ValDt><AcctSvcrRef>${escapeXml(e.id)}</AcctSvcrRef><NtryDtls><TxDtls><RltdPties>${party}</RltdPties><RmtInf><Ustrd>${escapeXml(e.description)}</Ustrd>${reference}</RmtInf></TxDtls></NtryDtls></Ntry>`;
}

/** One account's statement as a camt.053.001.04 document. Entry ids become the account servicer references, so the server recognises them again. */
export function buildCamt053(s: Statement): string {
  const entries = s.entries.map((e, i) => ntry(e, s.currency, i + 1)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"><BkToCstmrStmt><GrpHdr><MsgId>${escapeXml(s.id)}</MsgId><CreDtTm>${s.to}T00:00:00</CreDtTm></GrpHdr><Stmt><Id>${escapeXml(s.id)}</Id><FrToDt><FrDtTm>${s.from}T00:00:00</FrDtTm><ToDtTm>${s.to}T23:59:59</ToDtTm></FrToDt><Acct><Id><IBAN>${s.iban}</IBAN></Id><Ccy>${s.currency}</Ccy></Acct>${balance("OPBD", s.opening, s.currency)}${balance("CLBD", s.closing, s.currency)}${entries}</Stmt></BkToCstmrStmt></Document>`;
}

const quarterStart = (ym: string) =>
  `${ym.slice(0, 5)}${String(Math.floor((Number(ym.slice(5)) - 1) / 3) * 3 + 1).padStart(2, "0")}`;

/**
 * The account's entries as one statement per calendar quarter, each opening where the last one closed;
 * the running quarter ends today. `openingBalance` is the balance at the start of the history.
 */
export function quarterlyStatements(
  name: string,
  iban: string,
  currency: string,
  openingBalance: Minor,
  entries: readonly Entry[],
  today: string,
): Statement[] {
  const statements: Statement[] = [];
  let running = openingBalance;
  for (
    let q = quarterStart(HISTORY_START.slice(0, 7));
    q <= today.slice(0, 7);
    q = addMonths(q, 3)
  ) {
    const from =
      q === quarterStart(HISTORY_START.slice(0, 7)) ? HISTORY_START : `${q}-01`;
    const quarterEnd = addMonths(q, 3);
    const to = `${quarterEnd}-01` <= today ? lastDay(addMonths(q, 2)) : today;
    const inQuarter = entries.filter((e) => e.date >= from && e.date <= to);
    const closing = minor(
      running + inQuarter.reduce((total, e) => total + e.amount, 0),
    );
    if (inQuarter.length > 0) {
      statements.push({
        id: `${name}-${q.slice(0, 4)}-q${Math.floor((Number(q.slice(5)) - 1) / 3) + 1}`,
        iban,
        currency,
        from,
        to,
        opening: { amount: running, date: from },
        closing: { amount: closing, date: to },
        entries: inQuarter,
      });
    }
    running = closing;
  }
  return statements;
}
