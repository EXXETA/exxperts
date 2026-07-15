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
