import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { load } from "./+page.server";

describe("/settings", () => {
  useTestDB();

  it("redirects to the account tab", async () => {
    const user = await createTestUser();
    expect(
      await outcome(() => load(createTestEvent({ user }) as never)),
    ).toEqual({ type: "redirect", status: 303, location: "/settings/account" });
  });
});
