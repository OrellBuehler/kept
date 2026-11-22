/// <reference types="bun" />
/// <reference types="vite-plugin-pwa/client" />

import type { ApiTokenAuth } from "$lib/server/auth/api-tokens";
import type { Grant } from "$lib/server/auth/grant";
import type { SessionInfo, SessionUser } from "$lib/server/auth/types";

declare global {
  namespace App {
    interface Error {
      message: string;
      errorId?: string;
    }
    interface Locals {
      user: SessionUser | null;
      session: SessionInfo | null;
      /** Set only on `/api/external/v1/` requests that carried a valid bearer token. */
      apiToken: ApiTokenAuth | null;
      /** What the credential of a token request (`/api/external/v1/`, `/api/mcp`) may do; null elsewhere. */
      grant?: Grant | null;
      /** The registry path (`bills/[id]`) of the page or endpoint the app API bridge runs, for the error log. */
      appRoute?: string;
    }
  }
}

export {};
