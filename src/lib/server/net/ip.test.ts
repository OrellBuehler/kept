import { describe, expect, it } from "vitest";
import { ipv6Bytes } from "./ip";

describe("ipv6Bytes", () => {
  it("parses compressed, full and dotted spellings to the same bytes", () => {
    const a = ipv6Bytes("2001:db8::1");
    expect(a).toHaveLength(16);
    expect(ipv6Bytes("2001:0DB8:0:0:0:0:0:1")).toEqual(a);
    expect(ipv6Bytes("::ffff:1.2.3.4")).toEqual(ipv6Bytes("::ffff:102:304"));
  });

  it("rejects malformed input", () => {
    expect(ipv6Bytes("1::2::3")).toBeNull();
    expect(ipv6Bytes("12345::")).toBeNull();
    expect(ipv6Bytes("1:2:3")).toBeNull();
  });
});
