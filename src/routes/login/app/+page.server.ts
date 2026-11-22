import { fail } from "@sveltejs/kit";
import { appSignInCallback } from "$lib/server/app-api/sign-in";
import { requireUser } from "$lib/server/auth/guards";
import { approveAppSignIn, isOpenAppSignIn } from "$lib/server/auth/challenges";
import type { Actions, PageServerLoad } from "./$types";

const EXPIRED =
  "This sign-in has expired or was already used. Go back to the app and start again.";

/**
 * The web half of an app's sign-in through the browser. The hook has already
 * sent anyone without a session to /login (and back here), so whoever sees
 * this page is signed in, by whatever means the web offers.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const request = url.searchParams.get("request");
  return {
    request,
    open: await isOpenAppSignIn(request),
    name: user.displayName ?? user.username,
    username: user.username,
  };
};

export const actions: Actions = {
  default: async ({ locals, request, url }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const id = form.get("request") ?? url.searchParams.get("request");
    if (typeof id !== "string" || !(await approveAppSignIn(id, user.id))) {
      return fail(400, { errors: { form: [EXPIRED] } });
    }
    // Not a redirect: the page's form-action policy only allows this origin,
    // so the page itself opens the app (and offers a link when that fails).
    return { callback: appSignInCallback(id) };
  },
};
