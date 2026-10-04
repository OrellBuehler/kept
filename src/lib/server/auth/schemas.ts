import { z } from "zod";
import { USER_ROLES } from "$lib/server/schema";

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters.`);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters.")
  .max(32, "Username must be at most 32 characters.")
  .regex(
    /^[a-z0-9._-]+$/,
    "Username may only contain letters, digits, dots, underscores and hyphens.",
  );

export const displayNameSchema = z
  .string()
  .trim()
  .max(64, "Display name must be at most 64 characters.")
  .optional()
  .transform((v) => (v ? v : null));

export const roleSchema = z.enum(USER_ROLES);

/** Login accepts any non-empty input so malformed usernames are just "invalid credentials". */
export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, "Enter your username."),
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX),
  redirectTo: z.string().optional(),
});

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema,
  displayName: displayNameSchema,
});

export const deleteUserSchema = z.object({
  userId: z.string().min(1, "Missing user."),
});

export const changePasswordSchema = z.object({
  currentPassword: z
    .string()
    .min(1, "Enter your current password.")
    .max(PASSWORD_MAX),
  newPassword: passwordSchema,
});

const codeSchema = z
  .string()
  .trim()
  .min(1, "Enter a code.")
  .max(64, "That code is too long.");

export const secondFactorSchema = z.object({
  code: codeSchema,
  redirectTo: z.string().optional(),
});

export const totpConfirmSchema = z.object({
  code: codeSchema,
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX),
});

export const totpStartSchema = z.object({
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX),
});

export const twoFactorReauthSchema = z.object({
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX),
  code: codeSchema,
});

export const passkeyNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(64, "Name must be at most 64 characters.");

export const renamePasskeySchema = z.object({
  id: z.string().min(1, "Missing passkey."),
  name: passkeyNameSchema,
});

export const passkeyIdSchema = z.object({
  id: z.string().min(1, "Missing passkey."),
});

export const resetTwoFactorSchema = z.object({
  userId: z.string().min(1, "Missing user."),
});

const webauthnCredential = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
});

export const passkeyRegisterVerifySchema = z.object({
  challengeId: z.string().min(1).max(128),
  name: passkeyNameSchema,
  credential: webauthnCredential,
});

export const passkeyLoginVerifySchema = z.object({
  /** Absent for the second step of a password login (the pending cookie identifies the ceremony). */
  challengeId: z.string().min(1).max(128).optional(),
  credential: webauthnCredential,
  redirectTo: z.string().optional(),
});

export const passkeyLoginOptionsSchema = z.object({
  mode: z.enum(["passwordless", "second_factor"]),
});

export const stepUpSchema = z.object({
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX),
  code: z.string().trim().max(64).optional().default(""),
});

export const passkeyStepUpVerifySchema = z.object({
  challengeId: z.string().min(1).max(128),
  password: z.string().min(1).max(PASSWORD_MAX),
  credential: webauthnCredential,
});
