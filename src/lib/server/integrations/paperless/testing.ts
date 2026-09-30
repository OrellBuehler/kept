import type {
  PaperlessBillSource,
  PaperlessFieldMapping,
} from "$lib/server/db";
import { buildBillPdf } from "$lib/testing/fixtures/bills/pdf";
import {
  QR_IBAN,
  QRR,
  buildPayload,
  type PayloadOptions,
} from "$lib/testing/fixtures/bills/payloads";
import {
  saveConnection,
  setBillSourceRow,
  setFieldMapping,
} from "./connection";
import type { FakePaperless } from "./fake-server";

/** Test helper: connect `userId` to the fake server and pick a source. */
export function seedConnection(
  userId: string,
  fake: FakePaperless,
  options: {
    source?: PaperlessBillSource | null;
    mapping?: PaperlessFieldMapping;
  } = {},
) {
  const saved = saveConnection(userId, {
    baseUrl: fake.baseUrl,
    token: fake.token,
    allowInsecureTls: false,
  });
  if (options.source !== null) {
    setBillSourceRow(
      userId,
      options.source ?? { kind: "tag", id: 1, label: "Bills" },
    );
  }
  if (options.mapping) setFieldMapping(userId, options.mapping);
  return saved;
}

/** A synthetic Swiss QR-bill PDF; everything in it is invented. */
export function billPdf(
  over: Partial<PayloadOptions> = {},
): Promise<Uint8Array> {
  const payload = buildPayload(over);
  return buildBillPdf({
    qrPayload: payload,
    paymentPart: {
      account: over.iban ?? QR_IBAN,
      reference: over.reference ?? QRR,
      amount: "1 949.75",
    },
  });
}

/** A PDF with some text but no bill data at all. */
export function plainPdf(): Promise<Uint8Array> {
  return buildBillPdf({ bodyLines: ["Nothing to see here"] });
}
