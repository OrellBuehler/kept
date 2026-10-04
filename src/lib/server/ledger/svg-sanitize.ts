const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "symbol",
  "use",
  "title",
  "desc",
  "text",
  "tspan",
]);

const CANONICAL: Record<string, string> = {
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  clippath: "clipPath",
};

const TEXT_PARENTS = new Set(["text", "tspan", "title", "desc"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const entities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

const decode = (v: string) =>
  v.replace(/&(amp|lt|gt|quot|apos);/g, (m) => entities[m]!);
const escapeText = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (v: string) => escapeText(v).replace(/"/g, "&quot;");

export class UnsafeSvgError extends Error {
  override name = "UnsafeSvgError";
}

const DANGEROUS_VALUE =
  /url\(|expression|@import|javascript:|vbscript:|data:|behavior|-moz-binding/i;

function attributeAllowed(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("on")) return false;
  if (!/^[a-z][a-z0-9:_.-]*$/.test(n)) return false;
  if (n === "style") return !DANGEROUS_VALUE.test(value);
  if (n === "href" || n === "xlink:href") return /^#[\w.-]+$/.test(value);
  if (n === "xmlns") return value === SVG_NS;
  if (n === "xmlns:xlink") return value === XLINK_NS;
  if (n.startsWith("xmlns") || n.startsWith("xml:")) return false;
  if (/url\(/i.test(value)) {
    return /^url\(\s*['"]?#[\w.-]+['"]?\s*\)$/i.test(value);
  }
  return !DANGEROUS_VALUE.test(value);
}

function parseAttributes(raw: string): [string, string][] {
  const out: [string, string][] = [];
  const re =
    /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of raw.matchAll(re)) {
    out.push([m[1]!, decode(m[2] ?? m[3] ?? m[4] ?? "")]);
  }
  return out;
}

/**
 * Rebuilds an SVG from an allowlist of elements and attributes. Scripts,
 * event handlers, external references, styles, foreignObject, entities and
 * DOCTYPEs never reach the output. Throws when the input is not a usable SVG.
 */
export function sanitizeSvg(input: string): string {
  const src = input.replace(/^\ufeff/, "");
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(src)) {
    throw new UnsafeSvgError("The SVG uses entity declarations.");
  }
  const tokens = src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => escapeText(t))
    .split(/(<\/?[a-zA-Z][^>]*>)/);

  let out = "";
  const stack: string[] = [];
  let skipDepth = 0;
  let sawRoot = false;
  let closedRoot = false;

  for (const token of tokens) {
    if (token === "") continue;
    const tag = /^<(\/?)([a-zA-Z][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!tag) {
      if (skipDepth > 0 || stack.length === 0) continue;
      if (!TEXT_PARENTS.has(stack[stack.length - 1]!)) continue;
      out += escapeText(decode(token).replace(/&[#\w]+;/g, ""));
      continue;
    }
    const closing = tag[1] === "/";
    const name = tag[2]!.toLowerCase().replace(/^svg:/, "");
    const selfClosing = tag[4] === "/";

    if (closing) {
      if (skipDepth > 0) {
        skipDepth--;
        continue;
      }
      if (stack.pop() !== name) {
        throw new UnsafeSvgError("The SVG is malformed.");
      }
      out += `</${CANONICAL[name] ?? name}>`;
      if (stack.length === 0) closedRoot = true;
      continue;
    }

    if (skipDepth > 0) {
      if (!selfClosing) skipDepth++;
      continue;
    }
    if (!sawRoot && name !== "svg") {
      throw new UnsafeSvgError("The file is not an SVG image.");
    }
    if (closedRoot) throw new UnsafeSvgError("The SVG is malformed.");
    if (!ALLOWED_ELEMENTS.has(name) || (name === "svg" && sawRoot)) {
      if (!selfClosing) skipDepth++;
      continue;
    }
    sawRoot = true;
    const attrs = parseAttributes(tag[3]!)
      .filter(([k, v]) => attributeAllowed(k, v))
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join("");
    const el = CANONICAL[name] ?? name;
    if (selfClosing) {
      out += `<${el}${attrs}/>`;
      if (stack.length === 0) closedRoot = true;
    } else {
      out += `<${el}${attrs}>`;
      stack.push(name);
    }
  }

  if (!sawRoot || stack.length > 0 || skipDepth > 0) {
    throw new UnsafeSvgError("The SVG is malformed.");
  }
  if (!/\sxmlns="/.test(out.slice(0, out.indexOf(">")))) {
    out = out.replace(/^<svg/, `<svg xmlns="${SVG_NS}"`);
  }
  return out;
}
