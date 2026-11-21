import { afterEach, describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { loginRateLimiter } from "$lib/server/auth/rate-limit";
import { validateSessionToken } from "$lib/server/auth/sessions";
import { listBudgets } from "$lib/server/categories/budgets";
import { createCategory } from "$lib/server/categories/categories";
import { createTestUser, enableTotp, loginTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent } from "$lib/testing/event";
import { POST as login } from "./auth/login/+server";
import { POST as logout } from "./auth/logout/+server";
import { POST as verify } from "./auth/verify/+server";
import { GET as endpointGet } from "./endpoints/[...path]/+server";
import { GET as pageGet, POST as pagePost } from "./pages/[...path]/+server";
import { GET as remindersGet } from "./reminders/+server";
import { GET as serverGet } from "./server/+server";
import { GET as sessionGet } from "./session/+server";

type User = Awaited<ReturnType<typeof createTestUser>>;
type Handler = (event: never) => Response | Promise<Response>;

const json = { "content-type": "application/json" };

async function call(
  handler: Handler,
  opts: Parameters<typeof createTestEvent>[0] & { json?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
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
    return { status: e.status, body: e.body ?? {} };
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
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

  it("keeps admin pages for admins", async () => {
    const member = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    expect((await page(member, "admin/users")).status).toBe(403);
    expect((await page(admin, "admin/users")).status).toBe(200);
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

  it("refuses values out of range", async () => {
    const user = await createTestUser();
    expect((await get(user, "billDueDays=abc")).status).toBe(400);
    expect((await get(user, "budgetPercent=0")).status).toBe(400);
  });
});
