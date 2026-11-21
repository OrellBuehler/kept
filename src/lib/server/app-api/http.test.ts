import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonMessage, readAppBody } from "./http";

const schema = z.object({ name: z.string() });
const json = { "content-type": "application/json" };
const post = (body: string, headers: Record<string, string> = json) =>
  new Request("http://localhost/x", { method: "POST", headers, body });

async function failure(result: unknown) {
  expect(result).toBeInstanceOf(Response);
  const res = result as Response;
  return { status: res.status, body: await res.json() };
}

describe("readAppBody", () => {
  it("parses a JSON body", async () => {
    expect(await readAppBody(post('{"name":"a"}'), schema)).toEqual({
      name: "a",
    });
  });

  it("answers JSON errors for a wrong content type, bad JSON and a wrong shape", async () => {
    expect(
      await failure(
        await readAppBody(post("{}", { "content-type": "text/plain" }), schema),
      ),
    ).toEqual({
      status: 415,
      body: { message: "Content-Type must be application/json." },
    });
    expect(
      (await failure(await readAppBody(post("{nope"), schema))).status,
    ).toBe(400);
    expect((await failure(await readAppBody(post("{}"), schema))).status).toBe(
      400,
    );
  });

  it("refuses a declared size over the limit before reading the body", async () => {
    const request = post("{}", { ...json, "content-length": "10001" });
    const result = await readAppBody(request, schema);
    expect((await failure(result)).status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a body over the limit that declared nothing", async () => {
    const big = JSON.stringify({ name: "a".repeat(10_000) });
    expect((await failure(await readAppBody(post(big), schema))).status).toBe(
      413,
    );
  });
});

describe("jsonMessage", () => {
  it("is JSON with the status and headers given", async () => {
    const res = jsonMessage("No.", 429, { "retry-after": "5" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ message: "No." });
  });
});
