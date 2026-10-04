import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { authEvents, getDB, passkeys } from "$lib/server/db";

const verifyReg = vi.fn();
const verifyAuth = vi.fn();
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: (o: unknown) => verifyReg(o),
  verifyAuthenticationResponse: (o: unknown) => verifyAuth(o),
}));

const {
  beginAuthentication,
  beginRegistration,
  deletePasskey,
  finishAuthentication,
  finishRegistration,
  listPasskeys,
  renamePasskey,
  webauthnConfig,
} = await import("./passkeys");

const config = { rpID: "kept.example.org", origin: "https://kept.example.org" };

const regResponse = { id: "cred-1" } as never;
const authResponse = { id: "cred-1" } as never;

function verifiedRegistration(id = "cred-1") {
  return {
    verified: true,
    registrationInfo: {
      credential: {
        id,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
      },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
    },
  };
}

describe("webauthnConfig", () => {
  it("derives rp id and origin from ORIGIN", () => {
    expect(
      webauthnConfig(
        new URL("http://internal:3000/x"),
        "https://kept.example.org/",
      ),
    ).toEqual(config);
  });

  it("falls back to the request url without ORIGIN", () => {
    expect(webauthnConfig(new URL("http://localhost:5173/x"), "")).toEqual({
      rpID: "localhost",
      origin: "http://localhost:5173",
    });
  });
});

describe("passkeys", () => {
  useTestDB();
  beforeEach(() => {
    verifyReg.mockReset();
    verifyAuth.mockReset();
  });

  it("registration options exclude existing credentials and require user verification", async () => {
    const u = await createTestUser();
    verifyReg.mockResolvedValue(verifiedRegistration());
    await finishRegistration(u.id, "Laptop", regResponse, "ch", config);
    const options = await beginRegistration(u, config);
    expect(options.rp.id).toBe(config.rpID);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual(["cred-1"]);
    expect(options.authenticatorSelection?.userVerification).toBe("required");
  });

  it("stores a verified registration with the expected origin and logs an event", async () => {
    const u = await createTestUser();
    verifyReg.mockResolvedValue(verifiedRegistration());
    const p = await finishRegistration(
      u.id,
      "Laptop",
      regResponse,
      "ch",
      config,
    );
    expect(p).toMatchObject({ name: "Laptop", deviceType: "multiDevice" });
    expect(verifyReg).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "ch",
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true,
      }),
    );
    expect(listPasskeys(u.id)).toHaveLength(1);
    expect(getDB().select().from(authEvents).all()[0]).toMatchObject({
      type: "passkey_added",
      userId: u.id,
    });
  });

  it("rejects unverified, throwing and duplicate registrations", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    verifyReg.mockResolvedValueOnce({ verified: false });
    expect(
      await finishRegistration(u.id, "x", regResponse, "ch", config),
    ).toBeNull();
    verifyReg.mockRejectedValueOnce(new Error("bad origin"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await finishRegistration(u.id, "x", regResponse, "ch", config),
    ).toBeNull();
    warn.mockRestore();
    verifyReg.mockResolvedValue(verifiedRegistration());
    expect(
      await finishRegistration(u.id, "a", regResponse, "ch", config),
    ).not.toBeNull();
    expect(
      await finishRegistration(other.id, "b", regResponse, "ch", config),
    ).toBeNull();
    expect(listPasskeys(other.id)).toHaveLength(0);
  });

  async function registered() {
    const u = await createTestUser();
    verifyReg.mockResolvedValue(verifiedRegistration());
    await finishRegistration(u.id, "Laptop", regResponse, "ch", config);
    return u;
  }

  it("authenticates a known credential and updates counter and last use", async () => {
    const u = await registered();
    verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 7 },
    });
    expect(await finishAuthentication(authResponse, "ch", config, null)).toBe(
      u.id,
    );
    expect(getDB().select().from(passkeys).all()[0]).toMatchObject({
      counter: 7,
    });
    expect(listPasskeys(u.id)[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it("refuses unknown credentials, other users' credentials and failed verification", async () => {
    const u = await registered();
    const other = await createTestUser();
    verifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });
    expect(
      await finishAuthentication(
        { id: "unknown" } as never,
        "ch",
        config,
        null,
      ),
    ).toBeNull();
    expect(
      await finishAuthentication(authResponse, "ch", config, other.id),
    ).toBeNull();
    expect(await finishAuthentication(authResponse, "ch", config, u.id)).toBe(
      u.id,
    );
    verifyAuth.mockResolvedValue({ verified: false });
    expect(
      await finishAuthentication(authResponse, "ch", config, null),
    ).toBeNull();
    verifyAuth.mockRejectedValue(new Error("counter"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await finishAuthentication(authResponse, "ch", config, null),
    ).toBeNull();
    warn.mockRestore();
  });

  it("scopes authentication options to the user's credentials", async () => {
    const u = await registered();
    const own = await beginAuthentication(u.id, config);
    expect(own.allowCredentials?.map((c) => c.id)).toEqual(["cred-1"]);
    expect(own.userVerification).toBe("required");
    const open = await beginAuthentication(null, config);
    expect(open.allowCredentials).toBeUndefined();
  });

  it("renames and deletes only the owner's passkeys", async () => {
    const u = await registered();
    const other = await createTestUser();
    const id = listPasskeys(u.id)[0].id;
    expect(() => renamePasskey(other.id, id, "x")).toThrow();
    expect(() => deletePasskey(other.id, id)).toThrow();
    renamePasskey(u.id, id, "Phone");
    expect(listPasskeys(u.id)[0].name).toBe("Phone");
    deletePasskey(u.id, id);
    expect(listPasskeys(u.id)).toHaveLength(0);
  });
});
