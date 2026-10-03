import { z } from "zod";

const configSchema = z.object({
  KEPT_SMTP_HOST: z.string().trim().min(1).optional(),
  KEPT_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  KEPT_SMTP_SECURE: z.enum(["true", "false"]).optional(),
  KEPT_SMTP_USER: z.string().min(1).optional(),
  KEPT_SMTP_PASSWORD: z.string().min(1).optional(),
  KEPT_SMTP_FROM: z.string().trim().min(3).optional(),
});

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (usually port 465); otherwise STARTTLS is used when offered. */
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

/** The email channel is off unless `KEPT_SMTP_HOST` and `KEPT_SMTP_FROM` are set. Invalid values throw. */
export function readSmtpConfig(
  env: Record<string, string | undefined> = process.env,
): SmtpConfig | null {
  const pick = (k: string) => env[k] || undefined;
  const parsed = configSchema.safeParse({
    KEPT_SMTP_HOST: pick("KEPT_SMTP_HOST"),
    KEPT_SMTP_PORT: pick("KEPT_SMTP_PORT"),
    KEPT_SMTP_SECURE: pick("KEPT_SMTP_SECURE"),
    KEPT_SMTP_USER: pick("KEPT_SMTP_USER"),
    KEPT_SMTP_PASSWORD: pick("KEPT_SMTP_PASSWORD"),
    KEPT_SMTP_FROM: pick("KEPT_SMTP_FROM"),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid SMTP configuration (${problems})`);
  }
  const c = parsed.data;
  if (!c.KEPT_SMTP_HOST || !c.KEPT_SMTP_FROM) return null;
  return {
    host: c.KEPT_SMTP_HOST,
    port: c.KEPT_SMTP_PORT,
    secure: c.KEPT_SMTP_SECURE
      ? c.KEPT_SMTP_SECURE === "true"
      : c.KEPT_SMTP_PORT === 465,
    user: c.KEPT_SMTP_USER ?? null,
    password: c.KEPT_SMTP_PASSWORD ?? null,
    from: c.KEPT_SMTP_FROM,
  };
}
