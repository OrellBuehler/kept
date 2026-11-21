import { error } from "@sveltejs/kit";
import { matchRoute, runAction, runLoad } from "$lib/server/app-api/bridge";
import { requireUser } from "$lib/server/auth/guards";
import { pages } from "../../registry";
import type { RequestHandler } from "./$types";

function find(path: string) {
  const match = matchRoute(pages, path);
  if (!match) error(404, "Not found");
  return match;
}

/** A page's data: what its `load` returns on the web. */
export const GET: RequestHandler = async (event) => {
  requireUser(event.locals);
  return runLoad(event, find(event.params.path));
};

/** A page's form action, named by `?_action=`. */
export const POST: RequestHandler = async (event) => {
  requireUser(event.locals);
  return runAction(event, find(event.params.path));
};
