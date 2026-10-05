import { and, eq } from "drizzle-orm";
import type { ChannelKind } from "$lib/notification-types";
import {
  SecretUnreadableError,
  decryptSecret,
  encryptSecret,
} from "$lib/server/crypto";
import {
  first,
  getDB,
  notificationChannels,
  notificationSettings,
  notificationsSent,
  transaction,
} from "$lib/server/db";
import type { EmailConfig } from "./channels/email";
import type { NtfyConfig } from "./channels/ntfy";
import type { WebhookConfig } from "./channels/webhook";
import { DEFAULT_SETTINGS, type TriggerSettings } from "./types";

export type ChannelConfig = NtfyConfig | WebhookConfig | EmailConfig;

type SettingsRow = typeof notificationSettings.$inferSelect;

function toSettings(row: SettingsRow | undefined): TriggerSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    billDueEnabled: row.billDueEnabled,
    billDueDays: row.billDueDays,
    billOverdueEnabled: row.billOverdueEnabled,
    budgetEnabled: row.budgetEnabled,
    budgetPercent: row.budgetPercent,
    staleImportEnabled: row.staleImportEnabled,
    staleImportDays: row.staleImportDays,
  };
}

export async function getSettings(userId: string): Promise<TriggerSettings> {
  return toSettings(
    await first(
      getDB()
        .select()
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, userId))
        .limit(1),
    ),
  );
}

export async function saveSettings(
  userId: string,
  settings: TriggerSettings,
): Promise<void> {
  await getDB()
    .insert(notificationSettings)
    .values({ userId, ...settings })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: settings,
    });
}

export function anyTriggerEnabled(s: TriggerSettings): boolean {
  return (
    s.billDueEnabled ||
    s.billOverdueEnabled ||
    s.budgetEnabled ||
    s.staleImportEnabled
  );
}

/** Users who have at least one trigger switched on. */
export async function usersWithTriggers(): Promise<
  {
    userId: string;
    settings: TriggerSettings;
  }[]
> {
  return (await getDB().select().from(notificationSettings))
    .map((r) => ({ userId: r.userId, settings: toSettings(r) }))
    .filter((u) => anyTriggerEnabled(u.settings));
}

type ChannelRow = typeof notificationChannels.$inferSelect;

async function channelRow(
  userId: string,
  kind: ChannelKind,
): Promise<ChannelRow | null> {
  return (
    (await first(
      getDB()
        .select()
        .from(notificationChannels)
        .where(
          and(
            eq(notificationChannels.userId, userId),
            eq(notificationChannels.kind, kind),
          ),
        )
        .limit(1),
    )) ?? null
  );
}

/** Decrypted settings of a channel; null when it is not configured. */
export async function getChannelConfig<K extends ChannelKind>(
  userId: string,
  kind: K,
): Promise<
  | (K extends "ntfy"
      ? NtfyConfig
      : K extends "webhook"
        ? WebhookConfig
        : EmailConfig)
  | null
> {
  const row = await channelRow(userId, kind);
  if (!row) return null;
  return JSON.parse(decryptSecret(row.configEncrypted));
}

export interface SaveChannelOptions {
  /**
   * The secret field a blank form leaves out. When `config` lacks it, the
   * stored value is kept.
   */
  keepSecret?: "token" | "secret";
  /** Allow the save although the stored secret cannot be read and none was given (it is dropped). */
  dropUnreadableSecret?: boolean;
}

export type SaveChannelResult =
  | { ok: true }
  /** Nothing was written: the stored secret cannot be decrypted, and the caller neither supplied one nor allowed dropping it. */
  | { ok: false; reason: "secret_unreadable" };

/**
 * Stores the channel settings. Keeping the stored secret and the write happen
 * in one transaction, so a concurrent save cannot be overwritten by a stale
 * copy of its secret.
 */
export async function saveChannel(
  userId: string,
  kind: ChannelKind,
  config: ChannelConfig,
  options: SaveChannelOptions = {},
): Promise<SaveChannelResult> {
  return await transaction(async (tx) => {
    const field = options.keepSecret;
    const next: ChannelConfig & { token?: string; secret?: string } = {
      ...config,
    };
    if (field && next[field] === undefined) {
      const row = await first(
        tx
          .select()
          .from(notificationChannels)
          .where(
            and(
              eq(notificationChannels.userId, userId),
              eq(notificationChannels.kind, kind),
            ),
          )
          .limit(1),
      );
      let previous: Record<string, string | undefined> | null = null;
      let unreadable = false;
      if (row) {
        try {
          previous = JSON.parse(decryptSecret(row.configEncrypted));
        } catch (err) {
          if (!(err instanceof SecretUnreadableError)) throw err;
          unreadable = true;
        }
      }
      if (previous?.[field]) {
        next[field] = previous[field];
      } else if (unreadable && !options.dropUnreadableSecret) {
        return { ok: false, reason: "secret_unreadable" } as const;
      }
    }
    const configEncrypted = encryptSecret(JSON.stringify(next));
    await tx
      .insert(notificationChannels)
      .values({ userId, kind, configEncrypted })
      .onConflictDoUpdate({
        target: [notificationChannels.userId, notificationChannels.kind],
        set: { configEncrypted, lastError: null, lastErrorAt: null },
      });
    return { ok: true } as const;
  });
}

export async function setChannelEnabled(
  userId: string,
  kind: ChannelKind,
  enabled: boolean,
): Promise<void> {
  await getDB()
    .update(notificationChannels)
    .set({ enabled })
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.kind, kind),
      ),
    );
}

export async function deleteChannel(
  userId: string,
  kind: ChannelKind,
): Promise<void> {
  await getDB()
    .delete(notificationChannels)
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.kind, kind),
      ),
    );
}

export async function recordChannelResult(
  userId: string,
  kind: ChannelKind,
  reason: string | null,
  now: Date = new Date(),
): Promise<void> {
  await getDB()
    .update(notificationChannels)
    .set(
      reason === null
        ? { lastSuccessAt: now, lastError: null, lastErrorAt: null }
        : { lastError: reason, lastErrorAt: now },
    )
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.kind, kind),
      ),
    );
}

/** Everything the UI may see: no token, no secret. */
export interface ChannelView {
  kind: ChannelKind;
  enabled: boolean;
  /** Non-secret settings, by field name. */
  fields: Record<string, string>;
  hasSecret: boolean;
  /** The stored settings cannot be decrypted (KEPT_SECRET_KEY changed): save them again or remove the channel. */
  needsReentry: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

function toView(row: ChannelRow): ChannelView {
  let config: Record<string, string | undefined>;
  let needsReentry = false;
  try {
    config = JSON.parse(decryptSecret(row.configEncrypted));
  } catch (err) {
    if (!(err instanceof SecretUnreadableError)) throw err;
    config = {};
    needsReentry = true;
  }
  const { token, secret, ...fields } = config;
  return {
    kind: row.kind,
    enabled: row.enabled,
    fields: fields as Record<string, string>,
    hasSecret: Boolean(token ?? secret),
    needsReentry,
    lastSuccessAt: row.lastSuccessAt?.getTime() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.getTime() ?? null,
  };
}

export async function listChannels(userId: string): Promise<ChannelView[]> {
  return (
    await getDB()
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.userId, userId))
  ).map(toView);
}

export async function listEnabledChannelKinds(
  userId: string,
): Promise<ChannelKind[]> {
  return (await listChannels(userId))
    .filter((c) => c.enabled && !c.needsReentry)
    .map((c) => c.kind);
}

export async function sentKeys(userId: string): Promise<Set<string>> {
  return new Set(
    (
      await getDB()
        .select({ key: notificationsSent.eventKey })
        .from(notificationsSent)
        .where(eq(notificationsSent.userId, userId))
    ).map((r) => r.key),
  );
}

export async function markSent(
  userId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await getDB()
    .insert(notificationsSent)
    .values(keys.map((eventKey) => ({ userId, eventKey })))
    .onConflictDoNothing();
}
