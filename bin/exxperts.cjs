#!/usr/bin/env node
// Public product launcher.
// `exxperts web` — the local browser workspace; `exxperts cli` — the rooms
// CLI/TUI; bare `exxperts` — an interactive picker between the two.
const onError = (err) => {
  console.error(err);
  process.exit(1);
};
const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V") {
  // The product version (from the packed root package.json), so "which
  // version am I on?" is answerable after an update; the CLI runtime keeps
  // its own versioning underneath.
  console.log(`exxperts ${require("../package.json").version}`);
  process.exit(0);
}
if (argv[0] === "doctor") {
  // Health check. scripts/ ships in every install type (clone, npm-global,
  // prebuilt archive), so this works everywhere the launcher does.
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const res = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "doctor.mjs"), ...argv.slice(1)], { stdio: "inherit" });
  if (res.error) console.error(`exxperts doctor: ${res.error.message}`);
  process.exit(res.status ?? 1);
}
if (argv[0] === "setup" && (argv.length === 1 || argv[1] === "--help" || argv[1] === "-h")) {
  // Bare `exxperts setup` / `exxperts setup --help`: print a usage that names
  // every setup target, including the runtime-owned one. We answer here instead
  // of delegating because the runtime's setup usage only knows its own target
  // (openai-compatible) and would not mention chromium/search.
  console.log(`Usage: exxperts setup <chromium|search|openai-compatible>

  chromium           download headless Chromium (~150 MB, one time) for JS-rendered pages and HTML deck review
  search             set up local web search (SearXNG container via Docker); subcommands: start|stop|restart|status|url
  openai-compatible  configure an OpenAI-compatible model gateway

Other model providers (Claude/ChatGPT sign-in, API keys) are set up in the web app under AI setup.`);
  process.exit(0);
}
if (argv[0] === "setup" && (argv[1] === "chromium" || argv[1] === "search")) {
  // Optional-layer setup. ONLY the literal subcommands "chromium" and "search"
  // are intercepted here: every other `exxperts setup <x>` (e.g.
  // `setup openai-compatible`) is a runtime CLI provider-setup command and must
  // keep routing to the CLI runtime below, unchanged.
  //
  // EXXPERTS_SETUP=1 in the child env tells the scripts they were invoked as
  // `exxperts setup ...` (not npm postinstall / repo script): install-chromium
  // switches to strict mode (a failed download exits 1 instead of the
  // never-break-npm-install soft exit), and searxng.mjs prints
  // `exxperts setup search` in its messages instead of repo-script paths.
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  if (argv[1] === "chromium") {
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
  const searchArgs = argv.length > 2 ? argv.slice(2) : ["start"];
  const res = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "searxng.mjs"), ...searchArgs], {
    stdio: "inherit",
    env: { ...process.env, EXXPERTS_SETUP: "1" },
  });
  if (res.error) console.error(`exxperts setup search: ${res.error.message}`);
  process.exit(res.status ?? 1);
}
if (argv[0] === "web" || argv[0] === "ui") {
  require("./lib/web-launcher.cjs").main(argv.slice(1), "exxperts web");
} else if (argv[0] === "cli") {
  Promise.resolve(require("./lib/exxcode-launcher.cjs").main(argv.slice(1), "exxperts cli")).catch(onError);
} else if (argv.length === 0) {
  if (process.stdin.isTTY) {
    Promise.resolve(require("./lib/surface-picker.cjs").main()).catch(onError);
  } else {
    console.error("exxperts: no interactive terminal. Run `exxperts web` (browser app) or `exxperts cli` (terminal rooms).");
    process.exit(1);
  }
} else {
  // Subcommands and flags (e.g. `exxperts setup ...`) keep routing to the CLI runtime.
  Promise.resolve(require("./lib/exxcode-launcher.cjs").main(argv, "exxperts")).catch(onError);
}
