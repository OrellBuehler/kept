import type { Channel } from "../types";
import { postJson, type FetchFn } from "./http";
import type { Lookup } from "./guard";

export interface NtfyConfig {
  serverUrl: string;
  topic: string;
  token?: string;
}

/** Publishes as JSON to the server root, so titles and bodies may be any UTF-8 text. */
export function ntfyChannel(
  config: NtfyConfig,
  fetchFn?: FetchFn,
  allowPrivate = false,
  lookup?: Lookup,
): Channel {
  return {
    async send({ title, body }) {
      await postJson(
        fetchFn,
        config.serverUrl,
        JSON.stringify({ topic: config.topic, title, message: body }),
        config.token ? { authorization: `Bearer ${config.token}` } : {},
        allowPrivate,
        lookup,
      );
    },
  };
}
