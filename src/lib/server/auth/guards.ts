import { error } from "@sveltejs/kit";
import type { AuthLocals, SessionUser } from "./types";

export function requireUser(locals: Pick<AuthLocals, "user">): SessionUser {
  if (!locals.user) error(401, "Authentication required");
  return locals.user;
}

export function requireAdmin(locals: Pick<AuthLocals, "user">): SessionUser {
  const user = requireUser(locals);
  if (user.role !== "admin") error(403, "Administrator access required");
  return user;
}
