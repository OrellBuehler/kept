import { z } from "zod";
import type { ApiScope, RestrictionKind } from "$lib/api-tokens";
import type { Grant } from "$lib/server/auth/grant";
import {
  accountAllowed,
  assertTransactionVisible,
  categoryAllowed,
} from "$lib/server/ledger/visibility";
import { notFound } from "$lib/server/ledger/errors";

/**
 * What a tool gets: the grant (never the request) and a few facts about the
 * deployment. Tools filter every read through `ctx.grant` (it is a
 * `Visibility`), and call the `require…` helpers before a write.
 */
export interface ToolContext {
  readonly grant: Grant;
  /** The owner: every query is scoped to this id. */
  readonly userId: string;
  /** The public URL of this Kept instance, for links in results. */
  readonly origin: string;
  /** Today in the server's local calendar, `YYYY-MM-DD`. */
  readonly today: string;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  /** Only meaningful when not read-only. */
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case, unique. */
  name: string;
  title: string;
  /** Written for a model: what it returns, units, and how ids connect to other tools. */
  description: string;
  /**
   * Every scope the tool needs; the grant must hold all of them. Only
   * `whoami` may leave this empty (any valid credential may ask what it can do).
   */
  scopes: readonly ApiScope[];
  /**
   * Restrictions this tool cannot honour: a grant with one of them does not
   * see the tool and cannot call it, even when it holds the scope.
   */
  unavailableWhen?: readonly RestrictionKind[];
  annotations: ToolAnnotations;
  input: S;
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

export type AnyTool = ToolDef<z.ZodRawShape>;

export function defineTool<S extends z.ZodRawShape>(
  def: ToolDef<S>,
): ToolDef<S> {
  return def;
}

/** Whether the grant may see and call the tool. The one decision point for listing and calling. */
export function toolAvailable(tool: AnyTool, grant: Grant): boolean {
  if (!tool.scopes.every((s) => grant.scopes.includes(s))) return false;
  for (const restriction of tool.unavailableWhen ?? []) {
    if (restriction === "accounts" && grant.accountIds !== null) return false;
    if (restriction === "categories" && grant.categoryIds !== null) {
      return false;
    }
  }
  return true;
}

/** Throws "Transaction not found" for a payment of another user or outside the grant's accounts and categories. */
export function requireTransaction(
  ctx: ToolContext,
  id: string,
): Promise<void> {
  return assertTransactionVisible(ctx.userId, ctx.grant, id);
}

/** Throws "Account not found" for an account outside the grant. */
export function requireAccount(ctx: ToolContext, id: string): void {
  if (!accountAllowed(ctx.grant, id)) throw notFound("Account");
}

/** Throws "Category not found" for a category outside the grant. */
export function requireCategory(ctx: ToolContext, id: string): void {
  if (!categoryAllowed(ctx.grant, id)) throw notFound("Category");
}

/**
 * Whether the connection holds a scope. A tool that returns something that
 * belongs to another scope (a payment inside a bill, an account's name inside
 * a balance) returns it only when the connection holds that scope too.
 */
export function holds(ctx: ToolContext, scope: ApiScope): boolean {
  return ctx.grant.scopes.includes(scope);
}
