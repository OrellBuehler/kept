/// <reference types="bun" />

import type { SessionInfo, SessionUser } from "$lib/server/auth/types";

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
      session: SessionInfo | null;
    }
  }
}

export {};
