import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { first, getDB, institutions } from "$lib/server/db";
import { LedgerError, notFound } from "./errors";
import { UnsafeSvgError, sanitizeSvg } from "./svg-sanitize";

export const MAX_LOGO_BYTES = 512 * 1024;
export type LogoMime =
  "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to));

/** Detects the image type from the content; the declared type and file name are ignored. */
export function sniffLogo(bytes: Uint8Array): LogoMime | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length > 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 2048));
  if (
    /^\ufeff?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
      head,
    )
  ) {
    return "image/svg+xml";
  }
  return null;
}

export interface StoredLogo {
  bytes: Uint8Array;
  mime: LogoMime;
}

/** Validates an upload by content and returns what should be stored (SVGs are sanitized). */
export function prepareLogo(bytes: Uint8Array): StoredLogo {
  if (bytes.byteLength === 0) {
    throw new LedgerError("invalid", "The file is empty.", "logo");
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw new LedgerError(
      "invalid",
      `The logo is larger than ${MAX_LOGO_BYTES / 1024} KB.`,
      "logo",
    );
  }
  const mime = sniffLogo(bytes);
  if (!mime) {
    throw new LedgerError(
      "invalid",
      "Choose a PNG, JPEG, WebP or SVG image.",
      "logo",
    );
  }
  if (mime !== "image/svg+xml") return { bytes, mime };
  try {
    const clean = sanitizeSvg(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return { bytes: new TextEncoder().encode(clean), mime };
  } catch (err) {
    if (err instanceof UnsafeSvgError || err instanceof TypeError) {
      throw new LedgerError(
        "invalid",
        "The SVG could not be used safely.",
        "logo",
      );
    }
    throw err;
  }
}

export async function setInstitutionLogo(
  userId: string,
  id: string,
  upload: Uint8Array,
): Promise<string> {
  const { bytes, mime } = prepareLogo(upload);
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const updated = await getDB()
    .update(institutions)
    .set({ logo: Buffer.from(bytes), logoMime: mime, logoVersion: version })
    .where(and(eq(institutions.userId, userId), eq(institutions.id, id)))
    .returning({ id: institutions.id });
  if (updated.length === 0) throw notFound("Institution");
  return version;
}

export async function removeInstitutionLogo(
  userId: string,
  id: string,
): Promise<void> {
  const updated = await getDB()
    .update(institutions)
    .set({ logo: null, logoMime: null, logoVersion: null })
    .where(and(eq(institutions.userId, userId), eq(institutions.id, id)))
    .returning({ id: institutions.id });
  if (updated.length === 0) throw notFound("Institution");
}

export async function readInstitutionLogo(
  userId: string,
  id: string,
): Promise<StoredLogo & { version: string }> {
  const row = await first(
    getDB()
      .select({
        logo: institutions.logo,
        mime: institutions.logoMime,
        version: institutions.logoVersion,
      })
      .from(institutions)
      .where(and(eq(institutions.userId, userId), eq(institutions.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Institution");
  if (!row.logo || !row.mime || !row.version) throw notFound("Logo");
  return {
    bytes: new Uint8Array(row.logo),
    mime: row.mime as LogoMime,
    version: row.version,
  };
}
