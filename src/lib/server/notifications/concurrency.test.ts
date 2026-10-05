/**
 * Saving a channel keeps the stored secret the form left blank, which is a read
 * followed by a write: two saves of one channel take turns on a lock.
 */
import { describe, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { expectHeldBy } from "$lib/testing/locks";
import { saveChannel } from "./store";

useTestDB();

describe("notifications", () => {
  it("saving a channel takes that channel's lock", async () => {
    const user = await createTestUser();
    await expectHeldBy(`notification-channel:${user.id}:webhook`, () =>
      saveChannel(user.id, "webhook", { url: "http://127.0.0.1:9000/hook" }),
    );
  });
});
