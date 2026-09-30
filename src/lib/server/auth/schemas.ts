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
