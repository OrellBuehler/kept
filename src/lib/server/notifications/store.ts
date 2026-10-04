import { and, eq } from "drizzle-orm";
import type { ChannelKind } from "$lib/notification-types";
import { decryptSecret, encryptSecret } from "$lib/server/crypto";
import {
  getDB,
  notificationChannels,
  notificationSettings,
  notificationsSent,
} from "$lib/server/db";
import type { EmailConfig } from "./channels/email";
import type { NtfyConfig } from "./channels/ntfy";
import type { WebhookConfig } from "./channels/webhook";
import { DEFAULT_SETTINGS, type TriggerSettings } from "./types";

export type ChannelConfig = NtfyConfig | WebhookConfig | EmailConfig;

export function getSettings(userId: string): TriggerSettings {
  const row = getDB()
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId))
    .get();
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

export function saveSettings(userId: string, settings: TriggerSettings): void {
  getDB()
    .insert(notificationSettings)
    .values({ userId, ...settings })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: settings,
    })
    .run();
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
export function usersWithTriggers(): {
  userId: string;
  settings: TriggerSettings;
}[] {
  return getDB()
    .select()
    .from(notificationSettings)
    .all()
    .map((r) => ({ userId: r.userId, settings: getSettings(r.userId) }))
    .filter((u) => anyTriggerEnabled(u.settings));
}

type ChannelRow = typeof notificationChannels.$inferSelect;

function channelRow(userId: string, kind: ChannelKind): ChannelRow | null {
  return (
    getDB()
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.userId, userId),
          eq(notificationChannels.kind, kind),
        ),
      )
      .get() ?? null
  );
}

/** Decrypted settings of a channel; null when it is not configured. */
export function getChannelConfig<K extends ChannelKind>(
  userId: string,
  kind: K,
):
  | (K extends "ntfy"
      ? NtfyConfig
      : K extends "webhook"
        ? WebhookConfig
        : EmailConfig)
  | null {
  const row = channelRow(userId, kind);
  if (!row) return null;
  return JSON.parse(decryptSecret(row.configEncrypted));
}

export function saveChannel(
  userId: string,
  kind: ChannelKind,
  config: ChannelConfig,
): void {
  const configEncrypted = encryptSecret(JSON.stringify(config));
  getDB()
    .insert(notificationChannels)
    .values({ userId, kind, configEncrypted })
    .onConflictDoUpdate({
      target: [notificationChannels.userId, notificationChannels.kind],
      set: { configEncrypted, lastError: null, lastErrorAt: null },
    })
    .run();
}

export function setChannelEnabled(
  userId: string,
  kind: ChannelKind,
  enabled: boolean,
): void {
  getDB()
    .update(notificationChannels)
    .set({ enabled })
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.kind, kind),
      ),
    )
    .run();
}

export function deleteChannel(userId: string, kind: ChannelKind): void {
  getDB()
    .delete(notificationChannels)
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.kind, kind),
      ),
    )
    .run();
}

export function recordChannelResult(
  userId: string,
  kind: ChannelKind,
  reason: string | null,
  now: Date = new Date(),
): void {
  getDB()
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
    )
    .run();
}

/** Everything the UI may see: no token, no secret. */
export interface ChannelView {
  kind: ChannelKind;
  enabled: boolean;
  /** Non-secret settings, by field name. */
  fields: Record<string, string>;
  hasSecret: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

function toView(row: ChannelRow): ChannelView {
  const config = JSON.parse(decryptSecret(row.configEncrypted)) as Record<
    string,
    string | undefined
  >;
  const { token, secret, ...fields } = config;
  return {
    kind: row.kind,
    enabled: row.enabled,
    fields: fields as Record<string, string>,
    hasSecret: Boolean(token ?? secret),
    lastSuccessAt: row.lastSuccessAt?.getTime() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.getTime() ?? null,
  };
}

export function listChannels(userId: string): ChannelView[] {
  return getDB()
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.userId, userId))
    .all()
    .map(toView);
}

export function listEnabledChannelKinds(userId: string): ChannelKind[] {
  return listChannels(userId)
    .filter((c) => c.enabled)
    .map((c) => c.kind);
}

export function sentKeys(userId: string): Set<string> {
  return new Set(
    getDB()
      .select({ key: notificationsSent.eventKey })
      .from(notificationsSent)
      .where(eq(notificationsSent.userId, userId))
      .all()
      .map((r) => r.key),
  );
}

export function markSent(userId: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  getDB()
    .insert(notificationsSent)
    .values(keys.map((eventKey) => ({ userId, eventKey })))
    .onConflictDoNothing()
    .run();
}
