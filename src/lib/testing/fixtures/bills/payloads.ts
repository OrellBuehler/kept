export const QR_IBAN = "CH4431999123000889012";
export const PLAIN_IBAN = "CH9300762011623852957";
export const QRR = "210000000003139471430009017";
export const SCOR = "RF18539007547034";

export interface PayloadOptions {
  iban: string;
  addressType: string;
  name: string;
  line1: string;
  line2: string;
  postalCode: string;
  town: string;
  country: string;
  amount: string;
  currency: string;
  debtor: string[];
  referenceType: string;
  reference: string;
  message: string;
  trailer: string;
  billInformation: string;
  alternative: string[];
}

export const defaultPayloadOptions: PayloadOptions = {
  iban: QR_IBAN,
  addressType: "S",
  name: "Example Energy Ltd",
  line1: "Samplestrasse",
  line2: "1",
  postalCode: "8000",
  town: "Zürich",
  country: "CH",
  amount: "1949.75",
  currency: "CHF",
  debtor: ["S", "Erika Muster", "Beispielweg", "7", "3000", "Bern", "CH"],
  referenceType: "QRR",
  reference: QRR,
  message: "Invoice 2024-0815",
  trailer: "EPD",
  billInformation: "//S1/10/INV-0815/11/240315/40/2:10;0:30",
  alternative: [],
};

/** Builds a synthetic SPC payload (LF separated). */
export function buildPayload(overrides: Partial<PayloadOptions> = {}): string {
  const o = { ...defaultPayloadOptions, ...overrides };
  const debtor = [...o.debtor, "", "", "", "", "", "", ""].slice(0, 7);
  return [
    "SPC",
    "0200",
    "1",
    o.iban,
    o.addressType,
    o.name,
    o.line1,
    o.line2,
    o.postalCode,
    o.town,
    o.country,
    ...Array<string>(7).fill(""),
    o.amount,
    o.currency,
    ...debtor,
    o.referenceType,
    o.reference,
    o.message,
    o.trailer,
    o.billInformation,
    ...o.alternative,
  ].join("\n");
}
