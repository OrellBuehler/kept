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
  getSettings,
  listChannels,
  saveChannel,
  saveSettings,
  setChannelEnabled,
  type ChannelConfig,
} from "$lib/server/notifications/store";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = requireUser(locals);
  const smtpConfigured = getSmtpConfig() !== null;
  const channels = await listChannels(user.id);
  return {
    settings: await getSettings(user.id),
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
    await saveSettings(user.id, parsed.data);
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
    const data = parsed.data as ChannelConfig;
    const secretField =
      kind === "ntfy" ? "token" : kind === "webhook" ? "secret" : null;
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
    // A blank secret keeps the stored one. If the stored one cannot be read
    // there is nothing to keep: it must be entered again or removed explicitly.
    const saved = await saveChannel(user.id, kind, data, {
      keepSecret: secretField ?? undefined,
      dropUnreadableSecret: form.get("removeSecret") === "on",
    });
    if (!saved.ok) {
      return fail(400, {
        action: "channel",
        kind,
        errors: {
          [secretField ?? "form"]: [
            'The saved secret can no longer be read. Enter it again, or tick "Remove the saved secret".',
          ],
        },
      });
    }
    return { success: true as const, action: "channel" as const, kind };
  },

  toggleChannel: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const kind = kindOf(form);
    if (!kind) return unknownChannel();
    await setChannelEnabled(user.id, kind, form.get("enabled") === "true");
    return { success: true as const, action: "channel" as const, kind };
  },

  deleteChannel: async ({ locals, request }) => {
    const user = requireUser(locals);
    const kind = kindOf(await request.formData());
    if (!kind) return unknownChannel();
    await deleteChannel(user.id, kind);
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
