import { json } from "@sveltejs/kit";
import { countUsers } from "$lib/server/auth/users";
import { version } from "../../../../../../package.json";
import type { RequestHandler } from "./$types";

/** The version of the `/api/app/v1` contract; raised when an app has to know that something was added. */
const API_LEVEL = 1;

/** Public: lets an app check that the address it was given is a Kept server before it asks for a password. */
export const GET: RequestHandler = async () =>
  json({
    app: "kept",
    version,
    apiLevel: API_LEVEL,
    setupRequired: (await countUsers()) === 0,
  });
