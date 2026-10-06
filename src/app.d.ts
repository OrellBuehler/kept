/// <reference types="bun" />

import type { ApiTokenAuth } from "$lib/server/auth/api-tokens";
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
    }
  }
}

export {};
