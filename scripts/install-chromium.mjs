// Best-effort headless-Chromium fetch for the browser-backed features.
//
// A local Chromium (via Playwright) powers the HTML artifact visual-review loop (a vision-capable
// model renders and critiques HTML decks before you ever see a preview), fetch_url's JS-rendered
// page fallback, and task artifact thumbnails. The Chromium binary is a separate ~150 MB download
// that `npm install` does not pull on its own, so we fetch it here after install.
//
// This is intentionally NON-FATAL: if the download can't run (offline, corporate proxy, CI,
// `--ignore-scripts`, Playwright not installed), we never fail `npm install`. Everything still works
// without it — the visual-critique pass and browser fallbacks are just skipped — and the browser can
// be fetched later with `npx playwright install chromium`.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

function skip(reason) {
	console.warn("");
	console.warn(`[exxperts] ${reason}`);
	console.warn("[exxperts] HTML decks still work; the visual-critique pass is just skipped.");
	console.warn("[exxperts] To enable it later, run:  npx playwright install chromium");
	console.warn("");
	process.exit(0); // never block setup
}

// `npm install --ignore-scripts`, CI, or anyone who just wants a fast install can opt out.
if (process.env.EXXETA_SKIP_BROWSER_INSTALL === "1") {
	console.log("[exxperts] EXXETA_SKIP_BROWSER_INSTALL=1 — skipping Chromium download.");
	process.exit(0);
}

// Resolve Playwright's CLI by file path rather than relying on `playwright` being on PATH
// (it is only on PATH during npm lifecycle scripts, not when this file is run directly).
const require = createRequire(import.meta.url);
let cli;
for (const pkg of ["playwright", "playwright-core"]) {
	try {
		const candidate = join(dirname(require.resolve(`${pkg}/package.json`)), "cli.js");
		if (existsSync(candidate)) { cli = candidate; break; }
	} catch { /* not installed under this name — try the next */ }
}
if (!cli) skip("Playwright is not installed, so Chromium can't be fetched.");

console.log("[exxperts] Fetching headless Chromium for visual deck review and browser-backed tools (one-time, ~150 MB)…");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });

if (result.error || result.status !== 0) {
	skip("Could not download Chromium right now — that's OK.");
}

process.exit(0);
