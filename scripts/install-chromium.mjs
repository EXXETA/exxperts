// Best-effort headless-Chromium fetch for the browser-backed features.
//
// A local Chromium (via Playwright) powers the HTML artifact visual-review loop (a vision-capable
// model renders and critiques HTML decks before you ever see a preview), fetch_url's JS-rendered
// page fallback, and task artifact thumbnails. The Chromium binary is a separate ~150 MB download
// that `npm install` does not pull on its own, so we fetch it here after install.
//
// As an npm postinstall this is intentionally NON-FATAL: if the download can't run (offline,
// corporate proxy, CI, `--ignore-scripts`, Playwright not installed), we never fail `npm install`.
// Everything still works without it (the visual-critique pass and browser fallbacks are just
// skipped), and the browser can be fetched later with `exxperts setup chromium` (any install type)
// or `npx playwright install chromium` (source installs).
//
// When invoked as `exxperts setup chromium`, bin/exxperts.cjs sets EXXPERTS_SETUP=1 in the child
// env; that switches this script to STRICT mode: the user explicitly asked for the download, so a
// resolution or download failure must exit 1 instead of pretending success.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const strict = process.env.EXXPERTS_SETUP === "1";

function skip(reason) {
	console.warn("");
	console.warn(`[exxperts] ${reason}`);
	if (strict) {
		console.warn("[exxperts] Check your network/proxy (corporate proxies often block the download),");
		console.warn("[exxperts] then re-run: exxperts setup chromium");
		console.warn("");
		process.exit(1); // the user explicitly asked for this download, so fail honestly
	}
	console.warn("[exxperts] HTML decks still work; the visual-critique pass is just skipped.");
	console.warn("[exxperts] To enable it later, run:  exxperts setup chromium");
	console.warn("[exxperts] (or, from a source install:  npx playwright install chromium)");
	console.warn("");
	process.exit(0); // postinstall mode: never block setup
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
	skip(strict ? "Could not download Chromium." : "Could not download Chromium right now, and that's OK.");
}

process.exit(0);
