import { error } from "@sveltejs/kit";
import { matchRoute, runEndpoint } from "$lib/server/app-api/bridge";
import { requireUser } from "$lib/server/auth/guards";
import { endpoints } from "../../registry";
import type { RequestHandler } from "./$types";

function find(path: string) {
  const match = matchRoute(endpoints, path);
  if (!match) error(404, "Not found");
  return match;
}

export const GET: RequestHandler = async (event) => {
  requireUser(event.locals);
  return runEndpoint(event, find(event.params.path), "GET");
};

export const POST: RequestHandler = async (event) => {
  requireUser(event.locals);
  return runEndpoint(event, find(event.params.path), "POST");
};
