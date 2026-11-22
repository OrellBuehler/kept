import { describe, expect, it } from "vitest";
import { safeRedirectTo } from "$lib/server/auth/routing";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import {
  BASE,
  LOOPBACK,
  authorizeQuery,
  pkce,
  registerTestClient,
} from "$lib/testing/oauth";
import { SESSION_COOKIE } from "$lib/server/auth/sessions";
import { handle } from "../../../hooks.server";
import { load as loginLoad } from "../../../routes/login/+page.server";

useTestDB();

async function authorizeUrl(): Promise<string> {
  const { clientId } = await registerTestClient();
  const query = authorizeQuery({
    clientId,
    challenge: pkce().challenge,
    state: "a&b=c d",
    scope: "bills:read transactions:read",
  });
  return `/oauth/authorize?${query}`;
}

describe("consent needs a signed-in owner", () => {
  it("sends an anonymous browser to the login page and keeps the whole request for the way back", async () => {
    await createTestUser();
    const path = await authorizeUrl();
    const event = createTestEvent({ url: `${BASE}${path}` });
    const res = await handle({
      event: event as never,
      resolve: (async () => new Response("reached")) as never,
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location.startsWith("/login?redirectTo=")).toBe(true);
    const back = new URL(location, BASE).searchParams.get("redirectTo")!;
    expect(back).toBe(path);
    // The login page hands exactly that on, and the post-login redirect accepts it.
    expect(safeRedirectTo(back)).toBe(path);
    const page = await outcome(() =>
      loginLoad(createTestEvent({ url: `${BASE}${location}` }) as never),
    );
    expect(page).toEqual({
      type: "return",
      value: { redirectTo: path },
    });
  });

  it("serves the page to a signed-in owner", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const event = createTestEvent({
      url: `${BASE}/oauth/authorize?consent=x`,
      cookies: { [SESSION_COOKIE]: token },
    });
    const res = await handle({
      event: event as never,
      resolve: (async () => new Response("reached")) as never,
    });
    expect(await res.text()).toBe("reached");
  });

  it("does not let the way back lead off the site", async () => {
    for (const evil of [
      "https://evil.example.org/oauth/authorize",
      "//evil.example.org/oauth/authorize",
      "/\\evil.example.org",
      `${LOOPBACK}`,
      "javascript:alert(1)",
      "/oauth/authorize\r\nx: y",
    ]) {
      expect(safeRedirectTo(evil), evil).toBe("/");
      const page = await outcome(() =>
        loginLoad(
          createTestEvent({
            url: `${BASE}/login?redirectTo=${encodeURIComponent(evil)}`,
          }) as never,
        ),
      );
      expect(page).toEqual({ type: "return", value: { redirectTo: "/" } });
    }
  });
});
