import { fail } from "@sveltejs/kit";
import { CHANNEL_KINDS, type ChannelKind } from "$lib/notification-types";
import { requireUser } from "$lib/server/auth/guards";
import { privateNetworkAllowed } from "$lib/server/net/private-network";
import { assertAllowedUrl } from "$lib/server/notifications/channels/guard";
import { ChannelError } from "$lib/server/notifications/types";
import { parseForm } from "$lib/server/forms";
import { getSmtpConfig } from "$lib/server/notifications";
import { sendTest } from "$lib/server/notifications/dispatch";
import {
  channelFormSchemas,
  channelKindSchema,
  settingsFormSchema,
} from "$lib/server/notifications/schemas";
import {
  deleteChannel,
  getReadableChannelConfig,
  getSettings,
  listChannels,
  saveChannel,
  saveSettings,
  setChannelEnabled,
  type ChannelConfig,
} from "$lib/server/notifications/store";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  const smtpConfigured = getSmtpConfig() !== null;
  const channels = listChannels(user.id);
  return {
    settings: getSettings(user.id),
    channels,
    kinds: CHANNEL_KINDS.filter((k) => k !== "email" || smtpConfigured),
  };
};

function kindOf(form: FormData): ChannelKind | null {
  const parsed = channelKindSchema.safeParse(form.get("kind"));
  return parsed.success ? parsed.data : null;
}

const unknownChannel = () =>
  fail(400, { action: "channel", errors: { form: ["Unknown channel."] } });

const emailUnavailable = () =>
  fail(400, {
    action: "channel",
    errors: { form: ["The administrator has not configured email."] },
  });

export const actions: Actions = {
  saveSettings: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(settingsFormSchema, await request.formData());
    if (!parsed.ok) {
      return fail(400, { action: "saveSettings", errors: parsed.errors });
    }
    saveSettings(user.id, parsed.data);
    return { success: true as const, action: "saveSettings" as const };
  },

  saveChannel: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const kind = kindOf(form);
    if (!kind) return unknownChannel();
    if (kind === "email" && !getSmtpConfig()) return emailUnavailable();
    const parsed = parseForm(channelFormSchemas[kind], form);
    if (!parsed.ok) {
      return fail(400, { action: "channel", kind, errors: parsed.errors });
    }
    // A blank secret keeps the stored one.
    const data = parsed.data as ChannelConfig & {
      token?: string;
      secret?: string;
    };
    const previous = getReadableChannelConfig(user.id, kind) as {
      token?: string;
      secret?: string;
    } | null;
    if (kind === "ntfy" && data.token === undefined && previous?.token) {
      data.token = previous.token;
    }
    if (kind === "webhook" && data.secret === undefined && previous?.secret) {
      data.secret = previous.secret;
    }
    const target =
      "serverUrl" in data ? data.serverUrl : "url" in data ? data.url : null;
    if (target) {
      try {
        await assertAllowedUrl(target, {
          allowPrivate: privateNetworkAllowed(user.role),
        });
      } catch (err) {
        if (!(err instanceof ChannelError)) throw err;
        const field = kind === "ntfy" ? "serverUrl" : "url";
        return fail(400, {
          action: "channel",
          kind,
          errors: { [field]: [err.reason] },
        });
      }
    }
    saveChannel(user.id, kind, data);
    return { success: true as const, action: "channel" as const, kind };
  },

  toggleChannel: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const kind = kindOf(form);
    if (!kind) return unknownChannel();
    setChannelEnabled(user.id, kind, form.get("enabled") === "true");
    return { success: true as const, action: "channel" as const, kind };
  },

  deleteChannel: async ({ locals, request }) => {
    const user = requireUser(locals);
    const kind = kindOf(await request.formData());
    if (!kind) return unknownChannel();
    deleteChannel(user.id, kind);
    return { success: true as const, action: "channel" as const, kind };
  },

  testChannel: async ({ locals, request }) => {
    const user = requireUser(locals);
    const kind = kindOf(await request.formData());
    if (!kind) return unknownChannel();
    const result = await sendTest(user.id, kind, { smtp: getSmtpConfig() });
    return { action: "test" as const, kind, result };
  },
};
