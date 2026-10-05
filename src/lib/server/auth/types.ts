import type { UserRole } from "$lib/server/db/schema";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
}

export interface SessionInfo {
  /** SHA-256 hex of the session token (never the token itself). */
  id: string;
  expiresAt: Date;
}

export type AuthLocals = {
  user: SessionUser | null;
  session: SessionInfo | null;
};

export class AuthError extends Error {
  constructor(
    readonly code:
      | "username_taken"
      | "setup_closed"
      | "invalid_credentials"
      | "user_not_found"
      | "cannot_delete_self"
      | "cannot_delete_last_admin"
      | "invalid_code"
      | "passkey_required"
      | "pending_expired"
      | "totp_already_enabled"
      | "totp_not_pending"
      | "totp_not_enabled"
      | "passkey_not_found"
      | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
