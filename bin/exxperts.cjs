#!/usr/bin/env node
// The one command: `exxperts` starts the local server and opens the app in
// the browser. Everything else a person does is in the app. Kept working but
// named in no help text: --version (installers and CI check an install with
// it), `web` (start-up scripts written for it keep working), --port and
// --no-open (web-launcher.cjs), `setup chromium` (the only repair for a
// missing headless Chromium), and `doctor` (the health check for an install
// without the desktop app, whose Health Check runs the same script).
const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V") {
  // The product version (from the packed root package.json), so "which
  // version am I on?" is answerable after an update.
  console.log(`exxperts ${require("../package.json").version}`);
  process.exit(0);
}
if (argv[0] === "doctor") {
  // scripts/ ships in every install type (clone, npm-global, prebuilt
  // archive), so this works everywhere the launcher does.
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const res = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "doctor.mjs"), ...argv.slice(1)], { stdio: "inherit" });
  if (res.error) console.error(`exxperts doctor: ${res.error.message}`);
  process.exit(res.status ?? 1);
}
if (argv[0] === "setup" && argv[1] === "chromium") {
  // EXXPERTS_SETUP=1 tells install-chromium it was asked for by a person:
  // a failed download exits 1 instead of the never-break-npm-install soft exit.
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  if (argv[2] === "--help" || argv[2] === "-h") {
    console.log("Usage: exxperts setup chromium");
    console.log("Downloads headless Chromium (~150 MB, one time) into the per-user Playwright cache for JS-rendered pages and HTML deck review.");
    process.exit(0);
  }
  if (argv.length > 2) {
    console.error(`exxperts setup chromium: unexpected argument "${argv[2]}" (this command takes none)`);
    process.exit(1);
  }
  console.log("Downloading headless Chromium (~150 MB, one time) into the per-user Playwright cache for JS-rendered pages and HTML deck review.");
  // The install script honors EXXETA_SKIP_BROWSER_INSTALL as an opt-out for
  // `npm install`; an explicit `setup chromium` must always download.
  const env = { ...process.env, EXXPERTS_SETUP: "1" };
  delete env.EXXETA_SKIP_BROWSER_INSTALL;
  const res = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "install-chromium.mjs")], { stdio: "inherit", env });
  if (res.error) console.error(`exxperts setup chromium: ${res.error.message}`);
  process.exit(res.status ?? 1);
}
require("./lib/web-launcher.cjs").main(argv[0] === "web" ? argv.slice(1) : argv, "exxperts");
