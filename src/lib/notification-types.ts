export const CHANNEL_KINDS = ["ntfy", "webhook", "email"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  ntfy: "ntfy",
  webhook: "Webhook",
  email: "Email",
};
