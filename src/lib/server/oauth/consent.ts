import { z } from "zod";
import type { ApiScope } from "$lib/api-tokens";
import {
  accountIdsSchema,
  categoryIdsSchema,
  refuseScopeConflicts,
  scopesSchema,
} from "$lib/server/auth/api-tokens";
import { isWriteScope } from "./scopes";

/**
 * What the owner chose on the consent page: the same permission, restriction
 * and expiry rules as an API token (implied permissions added, a permission
 * that cannot honour a restriction refused), minus `links:write`, which no
 * connection can hold.
 */
export const consentAccessSchema = z
  .object({
    scopes: scopesSchema.refine((s) => !s.includes("links:write"), {
      message: "That permission is only available to API tokens.",
    }),
    categoryIds: categoryIdsSchema,
    accountIds: accountIdsSchema,
    expiresAt: z.date().nullable(),
  })
  .superRefine(refuseScopeConflicts);

/** Granting a permission that changes data needs the owner's password (and code), as creating an API token does. */
export const needsConfirmation = (scopes: readonly ApiScope[]): boolean =>
  scopes.some(isWriteScope);
