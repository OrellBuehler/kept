import { SecretUnreadableError } from "$lib/server/crypto";
import { privateNetworkAllowedForUser } from "$lib/server/net/private-network";
import type { ChannelKind } from "$lib/notification-types";
import { emailChannel, type SendMail } from "./channels/email";
import type { FetchFn } from "./channels/http";
import { ntfyChannel } from "./channels/ntfy";
import { webhookChannel } from "./channels/webhook";
import type { SmtpConfig } from "./smtp";
import { getChannelConfig, listChannels, recordChannelResult } from "./store";
import { ChannelError, type Channel, type NotificationMessage } from "./types";

export interface DispatchDeps {
  fetch?: FetchFn;
  smtp: SmtpConfig | null;
  sendMail?: SendMail;
}

async function buildChannel(
  userId: string,
  kind: ChannelKind,
  deps: DispatchDeps,
): Promise<Channel> {
  let config;
  try {
    config = getChannelConfig(userId, kind);
  } catch (err) {
    if (!(err instanceof SecretUnreadableError)) throw err;
    throw new ChannelError(
      "decrypt_failed",
      "The saved settings cannot be read; KEPT_SECRET_KEY may have changed. Save them again.",
    );
  }
  if (!config) throw new ChannelError("not_configured", "Not configured.");
  switch (kind) {
    case "ntfy":
      return ntfyChannel(
        config as never,
        deps.fetch,
        await privateNetworkAllowedForUser(userId),
      );
    case "webhook":
      return webhookChannel(
        config as never,
        deps.fetch,
        undefined,
        await privateNetworkAllowedForUser(userId),
      );
    case "email":
      if (!deps.smtp) {
        throw new ChannelError(
          "smtp_not_configured",
          "The administrator has not configured SMTP.",
        );
      }
      return emailChannel(config as never, deps.smtp, deps.sendMail);
  }
}

export type SendResult = { ok: true } | { ok: false; reason: string };

/** Sends through one channel and records the outcome; failures are logged by code only. */
export async function sendVia(
  userId: string,
  kind: ChannelKind,
  message: NotificationMessage,
  deps: DispatchDeps,
): Promise<SendResult> {
  try {
    await (await buildChannel(userId, kind, deps)).send(message);
    recordChannelResult(userId, kind, null);
    return { ok: true };
  } catch (err) {
    const error =
      err instanceof ChannelError
        ? err
        : new ChannelError("unknown", "Sending failed unexpectedly.");
    console.error("notification delivery failed", kind, error.code);
    recordChannelResult(userId, kind, error.reason);
    return { ok: false, reason: error.reason };
  }
}

/** Sends through every enabled channel; returns how many accepted the message. */
export async function deliver(
  userId: string,
  message: NotificationMessage,
  deps: DispatchDeps,
): Promise<number> {
  let delivered = 0;
  for (const channel of listChannels(userId)) {
    if (!channel.enabled) continue;
    if (channel.needsReentry) {
      console.warn(
        "notification channel skipped",
        channel.kind,
        "secret_unreadable",
      );
      continue;
    }
    const result = await sendVia(userId, channel.kind, message, deps);
    if (result.ok) delivered += 1;
  }
  return delivered;
}

export const TEST_MESSAGE: NotificationMessage = {
  title: "Kept test notification",
  body: "If you can read this, this channel works.",
};

export function sendTest(
  userId: string,
  kind: ChannelKind,
  deps: DispatchDeps,
): Promise<SendResult> {
  return sendVia(userId, kind, TEST_MESSAGE, deps);
}
