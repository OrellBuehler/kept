export interface CamtEntry {
  date: string;
  /** Unsigned decimal string, e.g. "12.50". */
  amount: string;
  sign: "CRDT" | "DBIT";
  ref: string;
}

export interface CamtOptions {
  iban: string;
  currency?: string;
  opening?: { amount: string; date: string };
  closing?: { amount: string; date: string };
  entries: CamtEntry[];
}

/** Builds a small synthetic camt.053.001.04 document for tests. */
export function buildCamt(o: CamtOptions): Uint8Array {
  const ccy = o.currency ?? "CHF";
  const bal = (code: string, b: { amount: string; date: string }) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">${b.amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${b.date}</Dt></Dt></Bal>`;
  const entry = (e: CamtEntry, i: number) =>
    `<Ntry><NtryRef>${i + 1}</NtryRef><Amt Ccy="${ccy}">${e.amount}</Amt><CdtDbtInd>${e.sign}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><AcctSvcrRef>${e.ref}</AcctSvcrRef><NtryDtls><TxDtls><RmtInf><Ustrd>Example booking</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"><BkToCstmrStmt><GrpHdr><MsgId>BUILT</MsgId><CreDtTm>2024-01-01T00:00:00</CreDtTm></GrpHdr><Stmt><Id>BUILT-1</Id><Acct><Id><IBAN>${o.iban}</IBAN></Id><Ccy>${ccy}</Ccy></Acct>${o.opening ? bal("OPBD", o.opening) : ""}${o.closing ? bal("CLBD", o.closing) : ""}${o.entries.map(entry).join("")}</Stmt></BkToCstmrStmt></Document>`;
  return new TextEncoder().encode(xml);
}
