/** The 16 bytes of an IPv6 address in any valid spelling, or null. */
export function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const v4 = tail.slice(1).map(Number);
    if (v4.some((n) => n > 255)) return null;
    const hex = (hi: number, lo: number) => (hi * 256 + lo).toString(16);
    text = `${text.slice(0, tail.index)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const fill = halves.length === 2 ? Array<string>(missing).fill("0") : [];
  const bytes: number[] = [];
  for (const g of [...head, ...fill, ...rest]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes.length === 16 ? bytes : null;
}
