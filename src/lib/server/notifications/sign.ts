import { createHmac } from "node:crypto";

/** `sha256=<hex>` HMAC of the exact request body. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
