import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { createTestEvent, outcome } from "$lib/testing/event";
import { useTestDB } from "$lib/testing/db";
import { seedInstitution } from "$lib/testing/ledger";
import { LedgerError } from "./errors";
import { getInstitution } from "./institutions";
import {
  MAX_LOGO_BYTES,
  prepareLogo,
  readInstitutionLogo,
  removeInstitutionLogo,
  setInstitutionLogo,
  sniffLogo,
} from "./logos";
import { sanitizeSvg } from "./svg-sanitize";
import { actions } from "../../../routes/(app)/accounts/+page.server";
import { GET } from "../../../routes/(app)/institutions/[id]/logo/+server";

const png = (extra = 0) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new Array(extra).fill(0),
  ]);
const enc = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>';

async function code(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof LedgerError) return `${e.code}:${e.field}`;
    throw e;
  }
  return "none";
}

useTestDB();

describe("logo sniffing and validation", () => {
  it("detects types by content, ignoring names", () => {
    expect(sniffLogo(png(4))).toBe("image/png");
    expect(sniffLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe(
      "image/jpeg",
    );
    expect(sniffLogo(enc("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffLogo(enc(`<?xml version="1.0"?>\n${SAFE_SVG}`))).toBe(
      "image/svg+xml",
    );
    expect(sniffLogo(enc("%PDF-1.4 hello world"))).toBeNull();
    expect(sniffLogo(enc("<html><body>hi</body></html>"))).toBeNull();
  });

  it("rejects empty, oversized and unknown files", async () => {
    expect(await code(() => prepareLogo(new Uint8Array()))).toBe(
      "invalid:logo",
    );
    expect(await code(() => prepareLogo(png(MAX_LOGO_BYTES)))).toBe(
      "invalid:logo",
    );
    expect(await code(() => prepareLogo(enc("just text")))).toBe(
      "invalid:logo",
    );
    expect(await code(() => prepareLogo(png(10)))).toBe("none");
  });
});

describe("svg sanitizing", () => {
  it("keeps harmless shapes", () => {
    const out = sanitizeSvg(SAFE_SVG);
    expect(out).toContain("<rect");
    expect(out).toContain('fill="#123456"');
  });

  it("strips scripts, handlers, foreignObject, styles and external refs", () => {
    const out =
      sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script>
      <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
      <style>@import url(https://evil.example/x.css);</style>
      <image href="https://evil.example/a.png"/>
      <a href="javascript:alert(1)"><rect width="1" height="1" onclick="x()"/></a>
      <use xlink:href="https://evil.example/s.svg#a"/>
      <rect style="fill:url(https://evil.example/p)" width="2" height="2"/>
      <circle r="3" fill="url(#g)"/>
    </svg>`);
    for (const bad of [
      "script",
      "alert",
      "onload",
      "onclick",
      "foreignObject",
      "iframe",
      "evil.example",
      "javascript",
      "<style",
      "<image",
    ]) {
      expect(out.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    expect(out).toContain("<circle");
    expect(out).toContain('fill="url(#g)"');
  });

  it("rejects entities, non-svg roots and malformed input", async () => {
    const bad = (s: string) => () => sanitizeSvg(s);
    expect(bad('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>')).toThrow();
    expect(bad("<html></html>")).toThrow();
    expect(bad("<svg><g></svg>")).toThrow();
    expect(await code(() => prepareLogo(enc("<svg><g></svg>")))).toBe(
      "invalid:logo",
    );
  });

  it("stores the sanitized markup, not the upload", async () => {
    const u = await createTestUser();
    const i = await seedInstitution(u.id, "Inst");
    await setInstitutionLogo(
      u.id,
      i.id,
      enc(
        `<svg xmlns="http://www.w3.org/2000/svg"><script>x</script><rect width="1" height="1"/></svg>`,
      ),
    );
    const stored = await readInstitutionLogo(u.id, i.id);
    expect(stored.mime).toBe("image/svg+xml");
    expect(text(stored.bytes)).not.toContain("script");
  });
});

describe("institution logos", () => {
  it("sets, replaces (new version) and removes a logo", async () => {
    const u = await createTestUser();
    const i = await seedInstitution(u.id, "Inst");
    expect((await getInstitution(u.id, i.id)).logoVersion).toBeNull();
    const v1 = await setInstitutionLogo(u.id, i.id, png(1));
    const v2 = await setInstitutionLogo(u.id, i.id, png(2));
    expect(v1).not.toBe(v2);
    expect((await getInstitution(u.id, i.id)).logoVersion).toBe(v2);
    await removeInstitutionLogo(u.id, i.id);
    expect((await getInstitution(u.id, i.id)).logoVersion).toBeNull();
    expect(await code(() => readInstitutionLogo(u.id, i.id))).toBe(
      "not_found:undefined",
    );
  });

  it("another user cannot read, replace or remove it", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const i = await seedInstitution(a.id, "Inst");
    await setInstitutionLogo(a.id, i.id, png(1));
    expect(await code(() => readInstitutionLogo(b.id, i.id))).toBe(
      "not_found:undefined",
    );
    expect(await code(() => setInstitutionLogo(b.id, i.id, png(9)))).toBe(
      "not_found:undefined",
    );
    expect(await code(() => removeInstitutionLogo(b.id, i.id))).toBe(
      "not_found:undefined",
    );
    expect((await readInstitutionLogo(a.id, i.id)).bytes.length).toBe(9);

    const r = await outcome(() =>
      GET(createTestEvent({ user: b, params: { id: i.id } }) as never),
    );
    expect(r).toMatchObject({ type: "error", status: 404 });
  });

  it("serves with hardening headers, etag and 304", async () => {
    const u = await createTestUser();
    const i = await seedInstitution(u.id, "Inst");
    const version = await setInstitutionLogo(u.id, i.id, png(3));
    const r = await outcome(() =>
      GET(createTestEvent({ user: u, params: { id: i.id } }) as never),
    );
    const res = (r as { value: Response }).value;
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(res.headers.get("etag")).toBe(`"${version}"`);
    const cached = await outcome(() =>
      GET(
        createTestEvent({
          user: u,
          params: { id: i.id },
          headers: { "if-none-match": `"${version}"` },
        }) as never,
      ),
    );
    expect((cached as { value: Response }).value.status).toBe(304);
  });

  it("form actions upload, reject bad files, replace and remove", async () => {
    const u = await createTestUser();
    const bad = await outcome(() =>
      actions.createInstitution!(
        createTestEvent({
          user: u,
          form: { name: "Bad", logo: new File(["nope"], "x.png") },
        }) as never,
      ),
    );
    expect(bad).toMatchObject({ type: "fail", status: 400 });

    const created = await outcome(() =>
      actions.createInstitution!(
        createTestEvent({
          user: u,
          form: {
            name: "Good",
            logo: new File([png(2)], "x.png", { type: "text/plain" }),
          },
        }) as never,
      ),
    );
    const id = (created as { value: { id: string } }).value.id;
    expect((await getInstitution(u.id, id)).logoVersion).not.toBeNull();

    await outcome(() =>
      actions.updateInstitution!(
        createTestEvent({
          user: u,
          form: { id, name: "Good", removeLogo: "1" },
        }) as never,
      ),
    );
    expect((await getInstitution(u.id, id)).logoVersion).toBeNull();
  });
});
