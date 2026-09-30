import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent, outcome } from "$lib/testing/event";
import { actions } from "./+page.server";

describe("logout", () => {
  useTestDB();

  it("invalidates only the current session, clears the cookie, redirects", async () => {
    const u = await createTestUser();
    const current = loginTestUser(u);
    const other = loginTestUser(u);
    const event = createTestEvent({
      user: u,
      session: current.session,
      method: "POST",
      cookies: { [SESSION_COOKIE]: current.token },
    });
    expect(await outcome(() => actions.default(event as never))).toMatchObject({
      type: "redirect",
      location: "/login",
    });
    expect((event.cookies as unknown as FakeCookies).deleted).toContain(
      SESSION_COOKIE,
    );
    expect(validateSessionToken(current.token)).toBeNull();
    expect(validateSessionToken(other.token)).not.toBeNull();
  });

  it("is harmless without a session", async () => {
    expect(
      await outcome(() =>
        actions.default(createTestEvent({ method: "POST" }) as never),
      ),
    ).toMatchObject({ type: "redirect", location: "/login" });
  });
});
