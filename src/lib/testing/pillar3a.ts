import { EXAMPLE_IBAN_OTHER } from "$lib/testing/fixtures/bill-identifiers";
import { minor } from "$lib/money";
import { LedgerError } from "$lib/server/ledger/errors";
import { createPortfolio, type PortfolioInput } from "$lib/server/pillar3a";
import { seedAccount } from "./ledger";

/** Documented example QR-IBAN (shared across customers in real life). */
export const QR_IBAN = EXAMPLE_IBAN_OTHER;

const MOD10 = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

/** A 27-digit QR reference: 26 digits of `body` (left-padded with zeros) plus the mod-10 check digit. */
export function makeQrr(body: string | number): string {
  const digits = String(body).padStart(26, "0");
  if (!/^\d{26}$/.test(digits))
    throw new Error("QRR body must be <= 26 digits");
  let carry = 0;
  for (const ch of digits) carry = MOD10[(carry + Number(ch)) % 10]!;
  return digits + String((10 - carry) % 10);
}

export async function seedPillar3aAccount(
  userId: string,
  over: Parameters<typeof seedAccount>[1] = {},
) {
  return await seedAccount(userId, {
    name: "Retirement 3a",
    type: "pillar_3a",
    currency: "CHF",
    contractNumber: "TEST-0001",
    depositIban: QR_IBAN,
    ...over,
  });
}

export async function seedPortfolio(
  userId: string,
  accountId: string,
  over: Partial<PortfolioInput> = {},
) {
  return await createPortfolio(userId, accountId, {
    name: "Portfolio A",
    number: null,
    strategy: null,
    depositReference: null,
    openedOn: null,
    sortOrder: null,
    ...over,
  });
}

export const chf = (n: number) => minor(n);

/** `code:field` of the LedgerError `fn` throws, undefined when it does not throw. */
export async function errorCode(
  fn: () => unknown,
): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof LedgerError) return `${err.code}:${err.field ?? ""}`;
    throw err;
  }
  return undefined;
}
