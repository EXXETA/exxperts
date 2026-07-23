// Generates build/icon.icns from the approved option-D composition: black
// squircle tile (#0d0d0f to #1c1c26, 135deg), white "xx" in BandeinsStrange
// Bold (the same face the web favicon uses, rendered from the font so every
// size is crisp), Lila glow that tapers with size and drops out below 64px
// (at tray/list sizes the glow just smears).
//
// Run from the REPO ROOT (playwright resolves from the root node_modules):
//   npx tsx apps/desktop/scripts/generate-icon.mts
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const fontPath = path.join(repoRoot, "apps", "web-ui", "public", "fonts", "BandeinsStrange-Bold.otf");
const iconsetDir = path.join(desktopRoot, "build", "icon.iconset");
const icnsPath = path.join(desktopRoot, "build", "icon.icns");

// macOS supplies no masking: the rounded tile with transparent margins must
// be baked in. Proportions follow the Apple icon grid (tile ~81% of canvas,
// corner radius ~22.3% of the tile).
type RenderOpts = {
  // Force the glow off regardless of size (favicons: browsers scale one file
  // down to 16/32px where the glow only smears).
  noGlow?: boolean;
  // Glyph only, no tile: the macOS menu-bar template image (black + alpha,
  // the OS inverts it per appearance).
  flatGlyph?: boolean;
  // Unread/finished-task dot, top-right. Black on template images (the OS
  // inverts), Lila on the tile.
  badge?: boolean;
};

function iconHtml(size: number, opts: RenderOpts = {}): string {
  const tile = Math.round(size * 0.8125);
  const radius = Math.round(tile * 0.223);
  const glow = opts.noGlow || opts.flatGlyph ? ""
    : size >= 256 ? `filter: drop-shadow(0 0 ${Math.round(size * 0.045)}px rgba(140,165,255,.55));`
    : size >= 64 ? `filter: drop-shadow(0 0 ${Math.round(size * 0.03)}px rgba(140,165,255,.45));`
    : "";
  const glyphBox = opts.flatGlyph
    ? `.tile { width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center; }
       .glyph { font-family: Bandeins; font-size: ${Math.round(size * 0.62)}px; color: #000000; line-height: 1; }`
    : `.tile { width: ${tile}px; height: ${tile}px; border-radius: ${radius}px;
            background: linear-gradient(135deg, #0d0d0f, #1c1c26);
            display: flex; align-items: center; justify-content: center; }
       .glyph { font-family: Bandeins; font-size: ${Math.round(tile * 0.56)}px; color: #ffffff;
             line-height: 1; transform: translateY(-${tile * 0.02}px); ${glow} }`;
  const dot = opts.badge
    ? `.dot { position: absolute; top: 0; right: 0; width: ${Math.round(size * 0.34)}px; height: ${Math.round(size * 0.34)}px;
             border-radius: 50%; background: ${opts.flatGlyph ? "#000000" : "#8CA5FF"}; }`
    : "";
  return `<!doctype html><html><head><style>
    @font-face { font-family: Bandeins; src: url("file://${fontPath}") format("opentype"); }
    html, body { margin: 0; background: transparent; }
    .canvas { width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center; position: relative; }
    ${glyphBox}
    ${dot}
  </style></head><body><div class="canvas"><div class="tile"><span class="glyph">xx</span></div>${opts.badge ? '<div class="dot"></div>' : ""}</div></body></html>`;
}

// (iconset filename, pixel size) per Apple's naming; identical pixel sizes
// are rendered once and written to every name that needs them.
const ICONSET: Array<[string, number]> = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

fs.rmSync(iconsetDir, { recursive: true, force: true });
fs.mkdirSync(iconsetDir, { recursive: true });

// Windows .ico sizes (256 is the ICO maximum; entries are PNG-compressed,
// supported since Vista). 48 is Windows-specific (Explorer medium icons).
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

const browser = await chromium.launch();
async function render(size: number, opts: RenderOpts = {}): Promise<Buffer> {
  // Loaded via a real file:// navigation: from about:blank (setContent) the
  // file:// @font-face is cross-origin and silently falls back to a serif.
  const htmlFile = path.join(iconsetDir, `render-${size}${opts.flatGlyph ? "-flat" : ""}${opts.noGlow ? "-noglow" : ""}.html`);
  fs.writeFileSync(htmlFile, iconHtml(size, opts));
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlFile}`);
  await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
  const fontLoaded = await page.evaluate(() => (document as unknown as { fonts: { check(f: string): boolean } }).fonts.check("16px Bandeins"));
  if (!fontLoaded) throw new Error(`BandeinsStrange did not load for size ${size}; refusing to render a fallback face.`);
  const shot = await page.screenshot({ omitBackground: true });
  await page.close();
  fs.rmSync(htmlFile);
  return shot;
}
const rendered = new Map<number, Buffer>();
for (const size of [...new Set([...ICONSET.map(([, s]) => s), ...ICO_SIZES])]) {
  rendered.set(size, await render(size));
}

// The unified brand mark: browser tab = Dock = taskbar = tray, all the same
// tile. The favicon is the no-glow tile (its own background makes one file
// serve light and dark tabs; both filenames stay because index.html links
// both). The macOS menu bar alone keeps a flat template glyph, per platform
// convention.
const webBrandDir = path.join(repoRoot, "apps", "web-ui", "public", "brand");
const faviconTile = await render(128, { noGlow: true });
fs.writeFileSync(path.join(webBrandDir, "favicon.png"), faviconTile);
fs.writeFileSync(path.join(webBrandDir, "favicon-dark.png"), faviconTile);
console.log(`[generate-icon] wrote ${path.join(webBrandDir, "favicon.png")} (+favicon-dark.png, same tile)`);

const assetsDir = path.join(desktopRoot, "assets");
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "tray-template.png"), await render(36, { flatGlyph: true }));
fs.writeFileSync(path.join(assetsDir, "tray-template-badge.png"), await render(36, { flatGlyph: true, badge: true }));
// Badged tile for the Windows/Linux tray (the unbadged base is the payload
// favicon; same composition, same generator).
fs.writeFileSync(path.join(assetsDir, "tray-tile-badge.png"), await render(32, { noGlow: true, badge: true }));
console.log(`[generate-icon] wrote tray-template.png, tray-template-badge.png, tray-tile-badge.png in ${assetsDir}`);
await browser.close();

for (const [name, size] of ICONSET) {
  fs.writeFileSync(path.join(iconsetDir, name), rendered.get(size)!);
}
fs.writeFileSync(path.join(desktopRoot, "build", "icon-1024-preview.png"), rendered.get(1024)!);
execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath]);
console.log(`[generate-icon] wrote ${icnsPath}`);

// ICO container with PNG-compressed entries: 6-byte header, 16-byte directory
// entry per image, then the raw PNG payloads.
const icoEntries = ICO_SIZES.map((size) => ({ size, png: rendered.get(size)! }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(icoEntries.length, 4);
let offset = 6 + 16 * icoEntries.length;
const directory: Buffer[] = [];
for (const { size, png } of icoEntries) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0); // width; 0 encodes 256
  entry.writeUInt8(size === 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  directory.push(entry);
  offset += png.length;
}
const icoPath = path.join(desktopRoot, "build", "icon.ico");
fs.writeFileSync(icoPath, Buffer.concat([header, ...directory, ...icoEntries.map((e) => e.png)]));
console.log(`[generate-icon] wrote ${icoPath}`);
