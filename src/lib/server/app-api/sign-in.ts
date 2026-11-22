/** The web page on which a signed-in user approves an app's sign-in. */
export const APP_SIGN_IN_PATH = "/login/app";

/** Where the browser hands control back to the app. */
export const APP_SIGN_IN_CALLBACK = "ch.orellbuehler.kept://signin";

/**
 * The return address of an approved request. `code` reaches only the device
 * the approval happened on; the app there adds the secret it kept.
 */
export function appSignInCallback(request: string, code: string): string {
  const query = new URLSearchParams({ request, code });
  return `${APP_SIGN_IN_CALLBACK}?${query}`;
}
