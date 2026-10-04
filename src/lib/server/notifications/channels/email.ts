import nodemailer from "nodemailer";
import type { SmtpConfig } from "../smtp";
import { ChannelError, type Channel } from "../types";

export interface EmailConfig {
  to: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type SendMail = (message: MailMessage) => Promise<unknown>;

const TIMEOUT_MS = 10_000;

export function smtpSender(smtp: SmtpConfig): SendMail {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user
      ? { user: smtp.user, pass: smtp.password ?? "" }
      : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  return (message) => transport.sendMail(message);
}

function describe(err: unknown): ChannelError {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "unknown";
  if (code === "EAUTH") {
    return new ChannelError("smtp_auth", "The mail server rejected the login.");
  }
  if (code === "EENVELOPE") {
    return new ChannelError(
      "smtp_envelope",
      "The mail server refused the address.",
    );
  }
  return new ChannelError(
    `smtp_${code}`,
    "The mail server could not be reached or refused the message.",
  );
}

export function emailChannel(
  config: EmailConfig,
  smtp: SmtpConfig,
  sendMail: SendMail = smtpSender(smtp),
): Channel {
  return {
    async send({ title, body }) {
      try {
        await sendMail({
          from: smtp.from,
          to: config.to,
          subject: title,
          text: body,
        });
      } catch (err) {
        throw describe(err);
      }
    },
  };
}
