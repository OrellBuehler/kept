import { signBody } from "../sign";
import type { Channel } from "../types";
import { postJson, type FetchFn } from "./http";

export interface WebhookConfig {
  url: string;
  secret?: string;
}

export const SIGNATURE_HEADER = "x-kept-signature";

/** JSON payload; with a secret it carries `x-kept-signature: sha256=<hmac of the exact body>`. */
export function webhookChannel(
  config: WebhookConfig,
  fetchFn: FetchFn = fetch,
  now: () => Date = () => new Date(),
  allowPrivate = false,
): Channel {
  return {
    async send({ title, body }) {
      const payload = JSON.stringify({
        source: "kept",
        title,
        message: body,
        sentAt: now().toISOString(),
      });
      await postJson(
        fetchFn,
        config.url,
        payload,
        config.secret
          ? { [SIGNATURE_HEADER]: signBody(config.secret, payload) }
          : {},
        allowPrivate,
      );
    },
  };
}
