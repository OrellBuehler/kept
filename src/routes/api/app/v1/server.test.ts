import { afterEach, describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  appSignInLimiter,
  loginRateLimiter,
  passwordChangeLimiter,
  secondFactorLimiter,
} from "$lib/server/auth/rate-limit";
import {
  APP_SIGN_IN_TTL_MS,
  approveAppSignIn,
  createAppSignIn,
  isOpenAppSignIn,
  takeAppSignIn,
} from "$lib/server/auth/challenges";
import { validateSessionToken } from "$lib/server/auth/sessions";
import { listBudgets } from "$lib/server/categories/budgets";
import { createCategory } from "$lib/server/categories/categories";
import { createTestUser, enableTotp, loginTestUser } from "$lib/testing/auth";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { SIMPLE_CSV_PROFILE, uploadFixture } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { useTestStore } from "$lib/testing/store";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import {
  actions as approveActions,
  load as approveLoad,
} from "../../../login/app/+page.server";
import { POST as browserStart } from "./auth/browser/+server";
import { POST as browserToken } from "./auth/browser/token/+server";
import { POST as login } from "./auth/login/+server";
import { POST as logout } from "./auth/logout/+server";
import { POST as verify } from "./auth/verify/+server";
import {
  GET as endpointGet,
  POST as endpointPost,
} from "./endpoints/[...path]/+server";
import { GET as pageGet, POST as pagePost } from "./pages/[...path]/+server";
import { GET as remindersGet } from "./reminders/+server";
import { GET as serverGet } from "./server/+server";
import { GET as sessionGet } from "./session/+server";

type User = Awaited<ReturnType<typeof createTestUser>>;
type Handler = (event: never) => Response | Promise<Response>;

const json = { "content-type": "application/json" };

async function callRaw(
  handler: Handler,
  opts: Parameters<typeof createTestEvent>[0] & { json?: unknown } = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}> {
  const { json: payload, ...rest } = opts;
  const event = createTestEvent(
    payload === undefined
      ? rest
      : { ...rest, body: JSON.stringify(payload), headers: json },
  );
  let res: Response;
  try {
    res = await handler(event as never);
  } catch (err) {
    const e = err as { status?: number; body?: { message: string } };
    if (typeof e.status !== "number") throw err;
    return { status: e.status, body: e.body ?? {}, headers: new Headers() };
  }
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : {},
    headers: res.headers,
  };
}

async function call(
  handler: Handler,
  opts: Parameters<typeof createTestEvent>[0] & { json?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { status, body } = await callRaw(handler, opts);
  return { status, body };
}

const page = (
  user: User,
  path: string,
  opts: { query?: string; action?: string; json?: unknown } = {},
) => {
  const search = new URLSearchParams(opts.query ?? "");
  if (opts.action) search.set("_action", opts.action);
  return call(opts.action ? (pagePost as Handler) : (pageGet as Handler), {
    user,
    params: { path },
    url: `http://localhost/api/app/v1/pages/${path}?${search}`,
    method: opts.action ? "POST" : "GET",
    json: opts.action ? (opts.json ?? {}) : undefined,
  });
};

describe("app API: sign-in", () => {
  useTestDB();
  afterEach(() => loginRateLimiter.reset());

  it("tells an app what server it reached, and whether setup is still to do", async () => {
    const before = await call(serverGet as Handler);
    expect(before.body).toMatchObject({
      app: "kept",
      apiLevel: 1,
      setupRequired: true,
    });
    await createTestUser();
    expect((await call(serverGet as Handler)).body.setupRequired).toBe(false);
  });

  it("signs in with a password and hands out a working session token", async () => {
    const user = await createTestUser({ username: "alice" });
    const res = await call(login as Handler, {
      json: { username: " Alice ", password: user.password },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      user: { id: user.id, username: "alice" },
    });
    const validated = await validateSessionToken(res.body.token as string);
    expect(validated?.user.id).toBe(user.id);
  });

  it("refuses a wrong password and an unknown user alike", async () => {
    const user = await createTestUser({ username: "alice" });
    for (const body of [
      { username: "alice", password: "wrong-password-here" },
      { username: "nobody", password: user.password },
    ]) {
      const res = await call(login as Handler, { json: body });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Invalid username or password.");
    }
  });

  it("refuses a form post and a malformed body", async () => {
    expect(
      (await call(login as Handler, { form: { username: "a", password: "b" } }))
        .status,
    ).toBe(415);
    expect(
      (await call(login as Handler, { json: { username: "a" } })).status,
    ).toBe(400);
    expect(
      (await call(login as Handler, { body: "{nope", headers: json })).status,
    ).toBe(400);
  });

  it("asks for a code when the account has a second factor, and only then signs in", async () => {
    const user = await createTestUser({ username: "alice" });
    const codes = await enableTotp(user);
    const first = await call(login as Handler, {
      json: { username: "alice", password: user.password },
    });
    expect(first.body).toMatchObject({ status: "second_factor", totp: true });
    expect(first.body.token).toBeUndefined();
    const pendingToken = first.body.pendingToken as string;

    const wrong = await call(verify as Handler, {
      json: { pendingToken, code: "000000" },
    });
    expect(wrong.status).toBe(400);

    const ok = await call(verify as Handler, {
      json: { pendingToken, code: codes[0] },
    });
    expect(ok.body).toMatchObject({ status: "ok", user: { id: user.id } });
    expect((await validateSessionToken(ok.body.token as string))?.user.id).toBe(
      user.id,
    );

    const again = await call(verify as Handler, {
      json: { pendingToken, code: codes[1] },
    });
    expect(again.status).toBe(410);
  });

  it("logout ends the session it was called with", async () => {
    const user = await createTestUser();
    const { token, session } = await loginTestUser(user);
    const res = await call(logout as Handler, {
      user,
      session,
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await validateSessionToken(token)).toBeNull();
  });

  it("session answers the signed-in user with preferences", async () => {
    const user = await createTestUser();
    const { session } = await loginTestUser(user);
    const res = await call(sessionGet as Handler, { user, session });
    expect(res.body).toMatchObject({
      user: { id: user.id },
      overdueBills: 0,
      twoFactor: false,
      preferences: { defaultCurrency: "CHF" },
    });
    expect(res.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("app API: sign-in through the browser", () => {
  useTestDB();
  afterEach(() => appSignInLimiter.reset());

  const start = async () => {
    const res = await call(browserStart as Handler, { method: "POST" });
    expect(res.status).toBe(200);
    return res.body as { request: string; secret: string; path: string };
  };
  const approve = (user: User, request: string) =>
    outcome(() =>
      approveActions.default(
        createTestEvent({ user, form: { request } }) as never,
      ),
    );
  /** Approves and answers the code the return address carries. */
  const approved = async (user: User, request: string) => {
    const result = await approve(user, request);
    if (result.type !== "return") throw new Error("not approved");
    const callback = new URL((result.value as { callback: string }).callback);
    expect(callback.protocol).toBe("ch.orellbuehler.kept:");
    expect(callback.host).toBe("signin");
    expect(callback.searchParams.get("request")).toBe(request);
    return callback.searchParams.get("code")!;
  };
  const trade = (request: string, secret: string, code: string) =>
    call(browserToken as Handler, { json: { request, secret, code } });

  it("hands the app a session once the user approved the request on the web", async () => {
    const user = await createTestUser({ username: "alice" });
    const { request, secret, path } = await start();
    expect(path).toBe(`/login/app?request=${request}`);

    expect((await trade(request, secret, "early")).status).toBe(409);

    const page = (await approveLoad(
      createTestEvent({
        user,
        url: `http://localhost${path}`,
      }) as never,
    )) as { open: boolean; username: string };
    expect(page).toMatchObject({ open: true, username: "alice" });

    const code = await approved(user, request);

    const ok = await trade(request, secret, code);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "ok", user: { id: user.id } });
    expect((await validateSessionToken(ok.body.token as string))?.user.id).toBe(
      user.id,
    );

    expect((await trade(request, secret, code)).status).toBe(410);
  });

  it("gives nothing to whoever started the request but did not get the code of the approval", async () => {
    const user = await createTestUser();
    const { request, secret } = await start();
    const code = await approved(user, request);

    for (const guess of [secret, request, "x"]) {
      expect((await trade(request, secret, guess)).status).toBe(410);
    }
    expect((await trade(request, secret, code)).status).toBe(200);
  });

  it("gives nothing to whoever has the return address but not the secret", async () => {
    const user = await createTestUser();
    const mine = await start();
    const other = await start();
    const code = await approved(user, mine.request);

    expect((await trade(mine.request, other.secret, code)).status).toBe(410);
    expect((await trade(mine.request, code, code)).status).toBe(410);
    expect((await trade(other.request, other.secret, code)).status).toBe(409);
    expect((await trade(mine.request, mine.secret, code)).status).toBe(200);
  });

  it("answers a wrong secret alike whether the request is open or not, and leaves it usable", async () => {
    const user = await createTestUser();
    const { request, secret } = await start();
    expect((await trade(request, "wrong", "x")).status).toBe(410);
    expect((await trade("unknown", "wrong", "x")).status).toBe(410);
    const code = await approved(user, request);
    expect((await trade(request, secret, code)).status).toBe(200);
  });

  it("approves a request once, and never an unknown or expired one", async () => {
    const alice = await createTestUser({ username: "alice" });
    const bob = await createTestUser({ username: "bob" });
    const { request, secret } = await start();

    expect((await approve(alice, "nope")).type).toBe("fail");
    expect((await approve(alice, "x".repeat(201))).type).toBe("fail");
    const code = await approved(alice, request);
    expect((await approve(bob, request)).type).toBe("fail");
    expect((await trade(request, secret, code)).body).toMatchObject({
      user: { id: alice.id },
    });

    const late = await createAppSignIn(Date.now() - APP_SIGN_IN_TTL_MS - 1);
    expect((await approve(alice, late.request)).type).toBe("fail");
    expect((await trade(late.request, late.secret, "x")).status).toBe(410);
    const page = (await approveLoad(
      createTestEvent({
        user: alice,
        url: `http://localhost/login/app?request=${late.request}`,
      }) as never,
    )) as { open: boolean };
    expect(page.open).toBe(false);
  });

  it("lets one of two approvers and one of two takers through", async () => {
    const alice = await createTestUser({ username: "alice" });
    const bob = await createTestUser({ username: "bob" });
    const { request, secret } = await start();

    const codes = await Promise.all([
      approveAppSignIn(request, alice.id),
      approveAppSignIn(request, bob.id),
    ]);
    const winners = codes.filter((c) => c !== null);
    expect(winners).toHaveLength(1);

    const taken = await Promise.all([
      trade(request, secret, winners[0]),
      trade(request, secret, winners[0]),
    ]);
    expect(taken.map((t) => t.status).sort()).toEqual([200, 410]);
    const owner = codes[0] ? alice : bob;
    expect(taken.find((t) => t.status === 200)?.body).toMatchObject({
      user: { id: owner.id },
    });
  });

  it("refuses a request that was approved but ran out before the app came back", async () => {
    const user = await createTestUser();
    const started = await createAppSignIn();
    const code = await approveAppSignIn(started.request, user.id);
    expect(code).not.toBeNull();
    expect(
      await takeAppSignIn(
        started.request,
        started.secret,
        code!,
        started.expiresAt.getTime(),
      ),
    ).toBeNull();
    expect((await trade(started.request, started.secret, code!)).status).toBe(
      410,
    );
  });

  it("is not reachable with the tokens of the other half-finished sign-ins", async () => {
    const user = await createTestUser({ username: "alice" });
    await enableTotp(user);
    const first = await call(login as Handler, {
      json: { username: "alice", password: user.password },
    });
    const pendingToken = first.body.pendingToken as string;

    expect(await isOpenAppSignIn(pendingToken)).toBe(false);
    expect(await approveAppSignIn(pendingToken, user.id)).toBeNull();
    expect((await trade(pendingToken, pendingToken, "x")).status).toBe(410);

    const { request } = await start();
    const code = await approved(user, request);
    const asCode = await call(verify as Handler, {
      json: { pendingToken: request, code },
    });
    expect(asCode.status).toBe(410);
  });

  it("refuses a token request that is not the three values as JSON", async () => {
    const { request, secret } = await start();
    for (const body of [
      {},
      { request, secret },
      { request, secret, code: "" },
      { request, secret: "x".repeat(201), code: "x" },
    ]) {
      const res = await call(browserToken as Handler, { json: body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await call(browserToken as Handler, { form: { request, secret } }))
        .status,
    ).toBe(415);
  });

  it("limits how often an address can start one or ask for a token", async () => {
    for (let i = 0; i < 60; i++) await start();
    const res = await callRaw(browserStart as Handler, { method: "POST" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);

    for (let i = 0; i < 60; i++) await trade("a", "b", "c");
    const token = await callRaw(browserToken as Handler, {
      json: { request: "a", secret: "b", code: "c" },
    });
    expect(token.status).toBe(429);
  });
});

describe("app API: sign-in limits", () => {
  useTestDB();
  afterEach(() => {
    loginRateLimiter.reset();
    secondFactorLimiter.reset();
  });

  it("answers 429 with Retry-After and a JSON message after repeated wrong passwords", async () => {
    await createTestUser({ username: "alice" });
    const wrong = { username: "alice", password: "wrong-password-here" };
    for (let i = 0; i < 5; i++) {
      expect((await call(login as Handler, { json: wrong })).status).toBe(401);
    }
    const res = await callRaw(login as Handler, { json: wrong });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(typeof res.body.message).toBe("string");
  });

  it("answers 429 with Retry-After for repeated wrong codes", async () => {
    const user = await createTestUser({ username: "alice" });
    await enableTotp(user);
    const wrongCode = async () => {
      const first = await call(login as Handler, {
        json: { username: "alice", password: user.password },
      });
      return callRaw(verify as Handler, {
        json: { pendingToken: first.body.pendingToken, code: "000000" },
      });
    };
    let res = await wrongCode();
    for (let i = 0; i < 10 && res.status !== 429; i++) res = await wrongCode();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(typeof res.body.message).toBe("string");
  });

  it("refuses an oversized declared body with 413 before reading it", async () => {
    const res = await call(login as Handler, {
      body: "{}",
      headers: { ...json, "content-length": "10001" },
    });
    expect(res.status).toBe(413);
  });
});

describe("app API: pages", () => {
  useTestDB();

  it("answers a page's load data as plain JSON", async () => {
    const user = await createTestUser();
    const res = await page(user, "budgets", { query: "month=2026-03" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ month: "2026-03", categories: [] });
  });

  it("passes route parameters, and a missing row is a JSON 404", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const bill = await seedBill(other.id);
    expect((await page(other, `bills/${bill.id}`)).status).toBe(200);
    const res = await page(user, `bills/${bill.id}`);
    expect(res.status).toBe(404);
    expect(typeof res.body.message).toBe("string");
  });

  it("prefers a literal path over a parameter", async () => {
    const user = await createTestUser();
    const res = await page(user, "bills/new");
    expect(res.status).toBe(200);
  });

  it("runs a form action from JSON fields, scoped to the caller", async () => {
    const user = await createTestUser();
    const food = await createCategory(user.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    const res = await page(user, "budgets", {
      action: "createBudget",
      json: { categoryId: food.id, currency: "CHF", amount: "120.50" },
    });
    expect(res).toEqual({
      status: 200,
      body: { ok: true, data: { success: true, action: "createBudget" } },
    });
    expect(await listBudgets(user.id)).toMatchObject([
      { categoryId: food.id, amount: minor(12050) },
    ]);
  });

  it("answers a refused form with its status, a message and the field errors", async () => {
    const user = await createTestUser();
    const res = await page(user, "budgets", {
      action: "createBudget",
      json: { categoryId: "", currency: "CHF", amount: "abc" },
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.message).toBe("string");
    expect(
      (res.body.data as { errors: Record<string, string[]> }).errors,
    ).toBeTypeOf("object");
  });

  it("knows only listed pages and their own actions", async () => {
    const user = await createTestUser();
    expect((await page(user, "nope")).status).toBe(404);
    expect((await page(user, "budgets/extra")).status).toBe(404);
    for (const action of ["nope", "constructor", "__proto__"]) {
      expect((await page(user, "budgets", { action })).status, action).toBe(
        404,
      );
    }
  });

  it("refuses bodies that are not an object of form values", async () => {
    const user = await createTestUser();
    for (const body of [[1], { amount: 5 }, { nested: { a: "b" } }]) {
      const res = await page(user, "budgets", {
        action: "createBudget",
        json: body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("does not bridge the pages that manage credentials, integrations or the instance", async () => {
    const admin = await createTestUser({ role: "admin" });
    for (const path of [
      "settings/security",
      "settings/api-tokens",
      "settings/paperless",
      "admin/users",
      "admin/backup",
    ]) {
      expect((await page(admin, path)).status, path).toBe(404);
    }
  });

  it("uploads a file as base64 into the form", async () => {
    const user = await createTestUser();
    const res = await page(user, "bills/new", {
      action: "upload",
      json: {
        file: {
          $file: {
            name: "note.txt",
            type: "text/plain",
            base64: Buffer.from("hello").toString("base64"),
          },
        },
      },
    });
    // Not a PDF or image: the action itself answers, which shows the file arrived.
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("passes an endpoint through and keeps its errors JSON", async () => {
    const user = await createTestUser();
    const bill = await seedBill(user.id);
    const res = await call(endpointGet as Handler, {
      user,
      params: { path: `bills/${bill.id}/document` },
      url: `http://localhost/api/app/v1/endpoints/bills/${bill.id}/document`,
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("This bill has no document.");
  });
});

describe("app API: bridge details", () => {
  useTestDB();
  useTestStore();
  afterEach(() => passwordChangeLimiter.reset());

  it("accepts a bridged POST to the import mapping preview", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const res = await call(endpointPost as Handler, {
      user,
      params: { path: `imports/${id}/preview` },
      url: `http://localhost/api/app/v1/endpoints/imports/${id}/preview`,
      json: { profile: SIMPLE_CSV_PROFILE },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pendingId: id, errors: [], rowCount: 6 });
    const other = await createTestUser();
    const denied = await call(endpointPost as Handler, {
      user: other,
      params: { path: `imports/${id}/preview` },
      url: `http://localhost/api/app/v1/endpoints/imports/${id}/preview`,
      json: { profile: SIMPLE_CSV_PROFILE },
    });
    expect(denied.status).toBe(404);
  });

  it("changing the password keeps the caller's session and ends the others", async () => {
    const user = await createTestUser();
    const here = await loginTestUser(user);
    const elsewhere = await loginTestUser(user);
    const res = await call(pagePost as Handler, {
      user,
      session: here.session,
      params: { path: "settings/account" },
      url: "http://localhost/api/app/v1/pages/settings/account?_action=changePassword",
      method: "POST",
      json: {
        currentPassword: user.password,
        newPassword: "a-new-long-password-123",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { success: true } });
    expect((await validateSessionToken(here.token))?.user.id).toBe(user.id);
    expect(await validateSessionToken(elsewhere.token)).toBeNull();
  });

  it("route parameters with an encoded slash, a NUL or a double-encoded slash reach no row", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const mine = await seedBill(user.id);
    const theirs = await seedBill(other.id);
    for (const path of [
      `bills/${theirs.id}/x`,
      `bills/${theirs.id}\0`,
      `bills/${theirs.id}\0${mine.id}`,
      `bills/${theirs.id}%2F${mine.id}`,
      `bills/${mine.id}%2F`,
      `bills/${mine.id}\0`,
      `bills/..%2F${theirs.id}`,
    ]) {
      for (const asUser of [user, other]) {
        const res = await page(asUser, path);
        expect(res.status, path).toBe(404);
        expect(typeof res.body.message, path).toBe("string");
      }
    }
    for (const path of [`bills/${theirs.id}\0`, `bills/${theirs.id}%2F`]) {
      const res = await call(endpointGet as Handler, {
        user: other,
        params: { path: `${path}/document` },
        url: "http://localhost/api/app/v1/endpoints/x",
      });
      expect(res.status, path).toBe(404);
    }
  });
});

describe("app API: reminders", () => {
  useTestDB();

  const get = (user: User, query: string) =>
    call(remindersGet as Handler, {
      user,
      url: `http://localhost/api/app/v1/reminders?${query}`,
    });

  it("lists open bills and what is due, for the caller only", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const today = new Date().toISOString().slice(0, 10);
    const mine = await seedBill(user.id, { dueDate: "2020-01-15" });
    await seedBill(other.id, { dueDate: "2020-01-15" });

    const res = await get(user, "billOverdue=true&billDueDays=3");
    expect(res.status).toBe(200);
    const body = res.body as {
      today: string;
      events: { key: string; kind: string }[];
      bills: { id: string; dueDate: string }[];
    };
    expect(body.today.slice(0, 4)).toBe(today.slice(0, 4));
    expect(body.bills).toMatchObject([{ id: mine.id, dueDate: "2020-01-15" }]);
    expect(body.events).toMatchObject([
      { key: `bill-overdue:${mine.id}:2020-01-15`, kind: "bill-overdue" },
    ]);
  });

  it("a reminder that is not asked for is off", async () => {
    const user = await createTestUser();
    await seedBill(user.id, { dueDate: "2020-01-15" });
    const res = await get(user, "");
    expect(res.body.events).toEqual([]);
    expect((res.body.bills as unknown[]).length).toBe(1);
  });

  it("answers a refused query as JSON", async () => {
    const user = await createTestUser();
    const res = await get(user, "billDueDays=abc");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/billDueDays/);
  });

  it("refuses values out of range", async () => {
    const user = await createTestUser();
    expect((await get(user, "billDueDays=abc")).status).toBe(400);
    expect((await get(user, "budgetPercent=0")).status).toBe(400);
  });
});
