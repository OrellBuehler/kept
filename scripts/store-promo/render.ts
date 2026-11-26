#!/usr/bin/env bun
/**
 * Renders the framed promo images for the app stores from the raw screenshots of the Store
 * Screenshots workflow: a headline above a phone showing the screen, per store size, plus the Play
 * feature graphic. Pages are HTML, pictures are taken by a headless Chromium.
 *
 *   bun scripts/store-promo/render.ts --android <dir> --ios <dir> [--out <dir>]
 *
 * The directories are the downloaded `android-store-screenshots` and `ios-store-screenshots`
 * artifacts; either may be left out. The pictures go to store/promo/out (gitignored) unless --out
 * says otherwise. CHROME names the browser binary (default: `chromium`).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

interface Slide {
  id: string;
  screen: string;
  /** `*word*` is set in the accent colour. */
  headline: string;
  subline: string;
  dark?: boolean;
}

interface Target {
  key: string;
  width: number;
  height: number;
  device: "android" | "ios";
}

const slides: Slide[] = [
  {
    id: "overview",
    screen: "overview",
    headline: "Your *net worth*, on your own server",
    subline: "Accounts, bills and budgets from the Kept server you host",
  },
  {
    id: "account",
    screen: "account",
    headline: "Every payment, *in its place*",
    subline: "Import statements, search, categorise and add notes",
  },
  {
    id: "bills",
    screen: "bills",
    headline: "Bills *matched* to their payments",
    subline: "Add one from a photo, a PDF or a Swiss QR-bill",
  },
  {
    id: "budgets",
    screen: "budgets",
    headline: "Budgets that show what is *left*",
    subline: "A monthly limit per category",
  },
  {
    id: "forecast",
    screen: "forecast",
    headline: "See where your balance is *heading*",
    subline: "From your recurring payments and planned items",
  },
  {
    id: "investments",
    screen: "investments",
    headline: "Investments and *pillar 3a*",
    subline: "Holdings, trades, contributions and returns",
  },
  {
    id: "private",
    screen: "overview-dark",
    headline: "Private *by design*",
    subline: "No ads, no tracking, no bank logins",
    dark: true,
  },
];

const targets: Target[] = [
  { key: "play-phone", width: 1080, height: 1920, device: "android" },
  { key: "ios-6.9", width: 1320, height: 2868, device: "ios" },
];

const feature = {
  width: 1024,
  height: 500,
  tagline: "Personal finance on the server you host",
  screens: ["overview", "budgets"],
};

const root = resolve(import.meta.dir, "../..");
const font = pathToFileURL(
  join(
    root,
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  ),
).href;

const SYMBOL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><rect x="36" y="36" width="36" height="184"/><rect x="160" y="36" width="64" height="24"/><rect x="124" y="76" width="64" height="24"/><rect x="88" y="116" width="64" height="24"/><rect x="124" y="156" width="64" height="24"/><rect x="160" y="196" width="64" height="24"/></svg>`;

/**
 * A clean status bar over the top of an emulator screenshot, which shows the real time and the
 * emulator's own notifications. In the coordinates of the 1080 px wide screenshot.
 */
function androidStatusBar(dark: boolean): string {
  const ground = dark ? "#0e0f13" : "#fafbfc";
  const ink = dark ? "#f3f4f6" : "#3c4043";
  return `<svg class="status" viewBox="0 0 1080 52"><rect width="1080" height="52" fill="${ground}"/>
<text x="44" y="43" font-family="Inter" font-weight="500" font-size="35" fill="${ink}">9:41</text>
<g fill="${ink}"><path d="M909 14c-14 0-25 6-33 13l33 21 33-21c-8-7-19-13-33-13z" transform="translate(-2 0)"/>
<path d="M966 14v32h-32z"/><rect x="986" y="18" width="18" height="28" rx="3"/><rect x="991" y="14" width="8" height="5" rx="1"/></g></svg>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function accented(text: string): string {
  return escapeHtml(text).replace(/\*(.+?)\*/g, "<em>$1</em>");
}

const base = `
@font-face { font-family: Inter; src: url("${font}") format("woff2"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body {
  font-family: Inter, sans-serif;
  background: linear-gradient(180deg, #f3f6f8 0%, #e3efec 100%);
  color: #14171f;
  --accent: #107f6d;
  --muted: #5b6472;
  --bezel: #14171f;
}
body.dark {
  background: linear-gradient(180deg, #0f1115 0%, #0e2420 100%);
  color: #f3f4f6;
  --accent: #26d9b5;
  --muted: #a4acb9;
  --bezel: #2a2f39;
}
em { font-style: normal; color: var(--accent); }
.phone { background: var(--bezel); box-shadow: 0 40px 90px rgba(15, 23, 42, 0.28); }
.screen { position: relative; overflow: hidden; }
.screen img { display: block; width: 100%; }
.status { position: absolute; top: 0; left: 0; width: 100%; }
`;

function slidePage(target: Target, slide: Slide, screen: string): string {
  const w = target.width;
  const phone = Math.round(w * 0.8);
  const bezel = Math.round(w * 0.016);
  const radius = Math.round(w * (target.device === "ios" ? 0.1 : 0.06));
  return `<!doctype html><meta charset="utf-8"><style>${base}
.text { position: absolute; top: ${Math.round(target.height * 0.055)}px; left: 0; right: 0; padding: 0 ${Math.round(w * 0.08)}px; text-align: center; }
h1 { font-size: ${Math.round(w * 0.082)}px; line-height: 1.08; font-weight: 800; letter-spacing: -0.03em; text-wrap: balance; }
p { margin-top: ${Math.round(w * 0.028)}px; font-size: ${Math.round(w * 0.04)}px; line-height: 1.3; font-weight: 500; color: var(--muted); text-wrap: balance; }
.phone { position: absolute; left: ${Math.round((w - phone) / 2)}px; top: ${Math.round(target.height * (target.device === "ios" ? 0.24 : 0.3))}px; width: ${phone}px; padding: ${bezel}px; border-radius: ${radius}px; }
.screen { border-radius: ${radius - bezel}px; }
</style><body class="${slide.dark ? "dark" : ""}">
<div class="text"><h1>${accented(slide.headline)}</h1><p>${escapeHtml(slide.subline)}</p></div>
<div class="phone"><div class="screen"><img src="${screen}">${target.device === "android" ? androidStatusBar(slide.dark === true) : ""}</div></div>
</body>`;
}

function featurePage(screens: string[]): string {
  return `<!doctype html><meta charset="utf-8"><style>${base}
.brand { position: absolute; left: 64px; top: 120px; width: 470px; }
.mark { display: flex; align-items: center; gap: 20px; }
.mark svg { width: 84px; height: 84px; }
.mark span { font-size: 92px; font-weight: 800; letter-spacing: -0.04em; }
.brand p { margin-top: 26px; font-size: 34px; line-height: 1.2; font-weight: 600; color: var(--muted); text-wrap: balance; }
.phone { position: absolute; width: 230px; padding: 6px; border-radius: 26px; }
.screen { border-radius: 20px; }
.one { left: 560px; top: 56px; transform: rotate(-4deg); }
.two { left: 770px; top: 110px; transform: rotate(4deg); }
</style><body>
<div class="brand"><div class="mark">${SYMBOL}<span>Kept</span></div><p>${escapeHtml(feature.tagline)}</p></div>
<div class="phone one"><div class="screen"><img src="${screens[0]}">${androidStatusBar(false)}</div></div>
<div class="phone two"><div class="screen"><img src="${screens[1]}">${androidStatusBar(false)}</div></div>
</body>`;
}

async function shoot(
  html: string,
  file: string,
  width: number,
  height: number,
): Promise<void> {
  const page = `${file}.html`;
  await writeFile(page, html);
  const chrome = process.env.CHROME ?? "chromium";
  const run = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--allow-file-access-from-files",
      `--window-size=${width},${height}`,
      `--screenshot=${file}`,
      pathToFileURL(page).href,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const code = await run.exited;
  await rm(page);
  if (code !== 0 || !(await Bun.file(file).exists())) {
    throw new Error(
      `${chrome} failed for ${file}: ${await new Response(run.stderr).text()}`,
    );
  }
}

const { values } = parseArgs({
  options: {
    android: { type: "string" },
    ios: { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});
if (!values.android && !values.ios) {
  console.error(
    "usage: bun scripts/store-promo/render.ts [--android <dir>] [--ios <dir>] [--out <dir>]",
  );
  process.exit(2);
}
const out = resolve(values.out ?? join(root, "store/promo/out"));
const screenUrl = (dir: string, name: string) =>
  pathToFileURL(join(resolve(dir), `${name}.png`)).href;

for (const target of targets) {
  const dir = values[target.device];
  if (!dir) continue;
  await mkdir(join(out, target.key), { recursive: true });
  for (const [index, slide] of slides.entries()) {
    const file = join(out, target.key, `${index + 1}-${slide.id}.png`);
    await shoot(
      slidePage(target, slide, screenUrl(dir, slide.screen)),
      file,
      target.width,
      target.height,
    );
    console.log(file);
  }
}

if (values.android) {
  const dir = values.android;
  await mkdir(out, { recursive: true });
  const file = join(out, "play-feature.png");
  await shoot(
    featurePage(feature.screens.map((name) => screenUrl(dir, name))),
    file,
    feature.width,
    feature.height,
  );
  console.log(file);
}
