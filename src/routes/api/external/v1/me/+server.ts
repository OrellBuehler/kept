import { eq } from "drizzle-orm";
import { first, getDB, users } from "$lib/server/db";
import { apiEndpoint, notFoundError } from "$lib/server/external-api/http";
import { getPreferences } from "$lib/server/preferences";

/** The token's owner and what the token may do (any valid token, no scope needed). */
export const GET = apiEndpoint(null, async ({ userId, token }) => {
  const user = await first(
    getDB()
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  );
  if (!user) throw notFoundError("User");
  const prefs = await getPreferences(userId);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    locale: prefs.locale,
    defaultCurrency: prefs.defaultCurrency,
    token: { scopes: token.scopes, categoryIds: token.categoryIds },
  };
});
