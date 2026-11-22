/** The web page on which a signed-in user approves an app's sign-in. */
export const APP_SIGN_IN_PATH = "/login/app";

/**
 * Where the browser hands control back to the app. It carries only the public
 * request id: whoever receives it still needs the secret the app kept.
 */
export const APP_SIGN_IN_CALLBACK = "ch.orellbuehler.kept://signin";

export function appSignInCallback(request: string): string {
  return `${APP_SIGN_IN_CALLBACK}?request=${encodeURIComponent(request)}`;
}
