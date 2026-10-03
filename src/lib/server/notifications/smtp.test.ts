import { describe, expect, it } from "vitest";
import { readSmtpConfig } from "./smtp";

describe("readSmtpConfig", () => {
  it("is off without host and sender", () => {
    expect(readSmtpConfig({})).toBeNull();
    expect(readSmtpConfig({ KEPT_SMTP_HOST: "smtp.example.org" })).toBeNull();
  });

  it("reads host, sender and defaults", () => {
    expect(
      readSmtpConfig({
        KEPT_SMTP_HOST: "smtp.example.org",
        KEPT_SMTP_FROM: "kept@example.org",
      }),
    ).toEqual({
      host: "smtp.example.org",
      port: 587,
      secure: false,
      user: null,
      password: null,
      from: "kept@example.org",
    });
  });

  it("uses implicit TLS on 465 unless overridden", () => {
    const base = {
      KEPT_SMTP_HOST: "h.example.org",
      KEPT_SMTP_FROM: "k@example.org",
    };
    expect(readSmtpConfig({ ...base, KEPT_SMTP_PORT: "465" })?.secure).toBe(
      true,
    );
    expect(
      readSmtpConfig({
        ...base,
        KEPT_SMTP_PORT: "465",
        KEPT_SMTP_SECURE: "false",
      })?.secure,
    ).toBe(false);
  });

  it("rejects invalid values", () => {
    expect(() =>
      readSmtpConfig({
        KEPT_SMTP_HOST: "h.example.org",
        KEPT_SMTP_FROM: "k@example.org",
        KEPT_SMTP_PORT: "abc",
      }),
    ).toThrow(/Invalid SMTP configuration/);
  });
});
