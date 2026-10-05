/**
 * Saving a channel keeps the stored secret the form left blank, which is a read
 * followed by a write: two saves of one channel take turns on a lock.
 */
import { describe, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { expectHeldBy } from "$lib/testing/locks";
import { CHANNEL_KINDS, type ChannelKind } from "$lib/notification-types";
import { saveChannel, type ChannelConfig } from "./store";

useTestDB();

const configs = {
  ntfy: { serverUrl: "https://ntfy.example.org", topic: "kept" },
  webhook: { url: "http://127.0.0.1:9000/hook" },
  email: { to: "someone@example.org" },
} as const satisfies Record<ChannelKind, ChannelConfig>;

describe("notifications", () => {
  it.each(CHANNEL_KINDS)(
    "saving a %s channel takes that channel's lock",
    async (kind) => {
      const user = await createTestUser();
      await expectHeldBy(`notification-channel:${user.id}:${kind}`, () =>
        saveChannel(user.id, kind, configs[kind]),
      );
    },
  );
});
