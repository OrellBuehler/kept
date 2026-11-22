import { and, asc, eq, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import {
  first,
  getDB,
  mcpConnections,
  oauthClients,
  transaction,
} from "$lib/server/db";
import {
  CLIENT_NAME_MAX,
  CLIENT_URI_MAX,
  MAX_CLIENTS,
  MAX_REDIRECT_URIS,
  REDIRECT_URI_MAX,
  UNUSED_CLIENT_TTL_MS,
} from "./config";
import { OAuthError } from "./errors";
import { checkRedirectUri } from "./redirect-uri";

export type OAuthClient = typeof oauthClients.$inferSelect;

const GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

/**
 * Client metadata of a registration request (RFC 7591). Only what Kept acts
 * on is read; everything else (logo, policy links, software ids, scope) is
 * ignored and never stored or shown. What Kept would have to refuse
 * (a secret-based authentication method, other grant types) is an error, not
 * silently dropped, so a client never believes it holds something it does not.
 */
export const registrationSchema = z.object({
  redirect_uris: z
    .array(z.string().max(REDIRECT_URI_MAX))
    .min(1, "At least one redirect URI is required.")
    .max(MAX_REDIRECT_URIS, `At most ${MAX_REDIRECT_URIS} redirect URIs.`),
  client_name: z.string().max(1000).optional(),
  client_uri: z.string().max(CLIENT_URI_MAX).optional(),
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: z.array(z.string().max(100)).max(10).optional(),
  response_types: z.array(z.string().max(100)).max(10).optional(),
});

/**
 * Names are shown to the owner as the application's own words: control and
 * formatting characters (a right-to-left override, zero-width characters) are
 * removed, whitespace collapsed and the length bounded.
 */
export function cleanClientName(raw: string | undefined): string {
  const cleaned = (raw ?? "")
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, CLIENT_NAME_MAX).trim() || "Unnamed application";
}

function invalidMetadata(description: string): OAuthError {
  return new OAuthError("invalid_client_metadata", description);
}

export interface ClientMetadata {
  name: string;
  redirectUris: string[];
  clientUri: string | null;
}

/** Validates a parsed registration body; throws OAuthError (`invalid_redirect_uri`, `invalid_client_metadata`). */
export function parseRegistration(body: unknown): ClientMetadata {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    if (field === "redirect_uris") {
      throw new OAuthError(
        "invalid_redirect_uri",
        issue?.message ?? "redirect_uris is invalid.",
      );
    }
    throw invalidMetadata(
      `${typeof field === "string" ? field : "The request"} is invalid.`,
    );
  }
  const input = parsed.data;
  const method = input.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    throw invalidMetadata(
      "Only public clients are supported: token_endpoint_auth_method must be none.",
    );
  }
  for (const grant of input.grant_types ?? ["authorization_code"]) {
    if (!(GRANT_TYPES as readonly string[]).includes(grant)) {
      throw invalidMetadata(
        "Only the authorization_code and refresh_token grant types are supported.",
      );
    }
  }
  if (input.grant_types && !input.grant_types.includes("authorization_code")) {
    throw invalidMetadata("The authorization_code grant type is required.");
  }
  for (const type of input.response_types ?? ["code"]) {
    if (type !== "code") {
      throw invalidMetadata("Only the code response type is supported.");
    }
  }
  const redirectUris = [...new Set(input.redirect_uris)];
  for (const uri of redirectUris) {
    const checked = checkRedirectUri(uri);
    if (!checked.ok) {
      throw new OAuthError(
        "invalid_redirect_uri",
        `A redirect URI ${checked.reason}.`,
      );
    }
  }
  let clientUri: string | null = null;
  if (input.client_uri !== undefined && input.client_uri !== "") {
    let url: URL | null = null;
    try {
      url = new URL(input.client_uri);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw invalidMetadata("client_uri must be an http or https URL.");
    }
    clientUri = url.href;
  }
  return {
    name: cleanClientName(input.client_name),
    redirectUris,
    clientUri,
  };
}

/**
 * Stores a client. Registration is open, so the table is bounded: unused
 * clients are swept first, then a full table evicts the oldest client without a
 * connection, and refuses only when every client has one.
 */
export async function registerClient(
  meta: ClientMetadata,
  now: number = Date.now(),
): Promise<OAuthClient> {
  return await transaction(
    async (tx) => {
      await deleteUnusedClients(tx, now);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(oauthClients);
      if (count >= MAX_CLIENTS) {
        // Open registration must not be a way to lock everyone else out for a
        // day: the oldest client nobody has connected through makes room.
        const oldest = await first(
          tx
            .select({ id: oauthClients.id })
            .from(oauthClients)
            .where(
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(mcpConnections)
                  .where(eq(mcpConnections.clientId, oauthClients.id)),
              ),
            )
            .orderBy(asc(oauthClients.createdAt), asc(oauthClients.id))
            .limit(1),
        );
        if (!oldest) {
          throw new OAuthError(
            "temporarily_unavailable",
            "Too many applications are registered. Try again later.",
            503,
            { "retry-after": "3600" },
          );
        }
        await tx.delete(oauthClients).where(eq(oauthClients.id, oldest.id));
      }
      return (await first(
        tx
          .insert(oauthClients)
          .values({
            name: meta.name,
            redirectUris: meta.redirectUris,
            clientUri: meta.clientUri,
          })
          .returning(),
      ))!;
    },
    { lock: "oauth-clients" },
  );
}

export async function getClient(id: string): Promise<OAuthClient | null> {
  if (id.length === 0 || id.length > 128) return null;
  return (
    (await first(
      getDB().select().from(oauthClients).where(eq(oauthClients.id, id)),
    )) ?? null
  );
}

async function deleteUnusedClients(
  db: Pick<ReturnType<typeof getDB>, "delete" | "select">,
  now: number,
): Promise<void> {
  await db.delete(oauthClients).where(
    and(
      lt(oauthClients.createdAt, new Date(now - UNUSED_CLIENT_TTL_MS)),
      notExists(
        db
          .select({ one: sql`1` })
          .from(mcpConnections)
          .where(eq(mcpConnections.clientId, oauthClients.id)),
      ),
    ),
  );
}

/** Removes clients nobody connected through after UNUSED_CLIENT_TTL_MS. */
export async function sweepUnusedClients(
  now: number = Date.now(),
): Promise<void> {
  await deleteUnusedClients(getDB(), now);
}
