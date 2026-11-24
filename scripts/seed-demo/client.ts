import { z } from "zod";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly errors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

export interface FilePart {
  $file: { name: string; type: string; base64: string };
}

export type Fields = Record<string, string | string[] | FilePart | null>;

export interface ActionResult {
  data: Record<string, unknown>;
  redirect: string | null;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const API = "/api/app/v1";

const loginAnswer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), token: z.string().min(1) }),
  z.object({ status: z.literal("second_factor") }),
]);

const answer = z.object({
  message: z.string().optional(),
  ok: z.boolean().optional(),
  data: z.unknown().optional(),
  redirect: z.string().optional(),
});

const isLocalHost = (host: string) =>
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "[::1]" ||
  host.endsWith(".localhost");

/** The server's origin; refuses a plain-http address that is not on this machine, because the password would travel in clear. */
export function parseServerUrl(input: string): URL {
  if (!URL.canParse(input)) {
    throw new Error(
      "--url must be an address such as https://kept.example.org",
    );
  }
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("--url must start with https:// or http://");
  }
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new Error(
      "--url must use https:// unless the server is on this machine",
    );
  }
  return new URL(url.origin);
}

export class Client {
  private token: string | null = null;

  constructor(
    private readonly origin: URL,
    private readonly request: Fetch = fetch,
  ) {}

  private async send(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    bearer: string | null = this.token,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      accept: "application/json",
      origin: this.origin.origin,
    };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.request(new URL(path, this.origin).href, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        throw new ApiError(
          `${method} ${path.split("?")[0]}: the server did not answer with JSON (status ${response.status})`,
          response.status,
        );
      }
    }
    return { status: response.status, body: parsed };
  }

  async signIn(username: string, password: string): Promise<void> {
    const { status, body } = await this.send(
      "POST",
      `${API}/auth/login`,
      { username, password },
      null,
    );
    if (status === 429) {
      throw new ApiError("Too many sign-in attempts, try again later.", status);
    }
    if (status !== 200) {
      const message = answer.safeParse(body);
      throw new ApiError(
        (message.success && message.data.message) || "Sign-in failed.",
        status,
      );
    }
    const result = loginAnswer.parse(body);
    if (result.status === "second_factor") {
      throw new ApiError(
        "This account uses two-step sign-in, which the seed script cannot complete. Use an account without it.",
        status,
      );
    }
    this.token = result.token;
  }

  get signedIn(): boolean {
    return this.token !== null;
  }

  /** Ends the session and checks that its token no longer works. Returns whether the token was really revoked. */
  async signOut(): Promise<boolean> {
    const token = this.token;
    if (token === null) return true;
    this.token = null;
    const out = await this.send("POST", `${API}/auth/logout`, undefined, token);
    if (out.status !== 200) return false;
    const after = await this.send("GET", `${API}/session`, undefined, token);
    return after.status === 401;
  }

  private fail(method: string, path: string, status: number, body: unknown) {
    const parsed = answer.safeParse(body);
    const data = parsed.success ? parsed.data : {};
    const errors = z
      .object({ errors: z.record(z.string(), z.array(z.string())) })
      .safeParse(data.data);
    return new ApiError(
      `${method} ${path.split("?")[0]} failed (${status}): ${data.message ?? "no message"}`,
      status,
      errors.success ? errors.data.errors : {},
    );
  }

  /** The `data` of a page's `load`. */
  async page<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Record<string, string> = {},
  ): Promise<z.output<S>> {
    const qs = new URLSearchParams(query).toString();
    const url = `${API}/pages/${path}${qs ? `?${qs}` : ""}`;
    const { status, body } = await this.send("GET", url);
    if (status !== 200) throw this.fail("GET", url, status, body);
    const parsed = answer.parse(body);
    if (parsed.redirect !== undefined) {
      throw new ApiError(`GET ${path}: the page redirected`, status);
    }
    return schema.parse(parsed.data);
  }

  async action(
    path: string,
    name: string,
    fields: Fields = {},
  ): Promise<ActionResult> {
    const url = `${API}/pages/${path}?_action=${encodeURIComponent(name)}`;
    const { status, body } = await this.send("POST", url, fields);
    if (status !== 200) throw this.fail("POST", url, status, body);
    const parsed = answer.parse(body);
    const data = z.record(z.string(), z.unknown()).safeParse(parsed.data);
    return {
      data: data.success ? data.data : {},
      redirect: parsed.redirect ?? null,
    };
  }

  async session(): Promise<{ today: string }> {
    const { status, body } = await this.send("GET", `${API}/session`);
    if (status !== 200) throw this.fail("GET", `${API}/session`, status, body);
    return z.object({ today: z.string() }).parse(body);
  }
}
