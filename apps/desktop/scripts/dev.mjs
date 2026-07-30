#!/usr/bin/env node
// Dev/test launcher for the desktop shell.
//
//   npm run dev             build + launch against a SCRATCH state dir
//   npm run dev -- --real-state   use the real ~/.exxperts (only once trusted)
//   npm run smoke           headless-ish end-to-end check: boots the app,
//                           asserts the window landed signed-in, screenshots,
//                           quits (and stops the server it spawned)
//
// Scratch mode relocates HOME for the spawned server so dev runs never touch
// the real ~/.exxperts; the scratch dir survives runs for faster re-testing.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const require = createRequire(path.join(pkgRoot, "package.json"));
const argv = process.argv.slice(2);
const smoke = argv.includes("--smoke");
const realState = argv.includes("--real-state");

const build = spawnSync("node", [path.join(here, "build.mjs")], { cwd: pkgRoot, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const env = { ...process.env };
if (!realState && !env.EXXPERTS_DESKTOP_SCRATCH_HOME) {
  const scratch = path.join(os.homedir(), ".exxperts-desktop-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  env.EXXPERTS_DESKTOP_SCRATCH_HOME = scratch;
  console.log(`[desktop dev] scratch state home: ${scratch}`);
}
if (smoke) {
  env.EXXPERTS_DESKTOP_SMOKE = "1";
  env.EXXPERTS_DESKTOP_PORT = env.EXXPERTS_DESKTOP_PORT || "8790";
  env.EXXPERTS_DESKTOP_SMOKE_SHOT = env.EXXPERTS_DESKTOP_SMOKE_SHOT || path.join(pkgRoot, "dist", "smoke-shot.png");
}

// --fake-update-feed: serve a v9.9.9 release locally and require the smoke
// to detect it (the update-notice positive path, scripted). The same server
// answers electron-updater's generic-provider requests (latest-mac.yml /
// latest.yml) so the one-click updater's check stage is exercised too.
let fakeFeed = null;
if (argv.includes("--fake-update-feed")) {
  const fakeYml = (file) => [
    "version: 9.9.9",
    "files:",
    `  - url: ${file}`,
    "    sha512: aGVsbG8=",
    "    size: 1",
    `path: ${file}`,
    "sha512: aGVsbG8=",
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    "",
  ].join("\n");
  fakeFeed = http.createServer((req, res) => {
    // electron-updater appends a ?noCache=... query; match the path only.
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname.endsWith("latest-mac.yml")) {
      res.setHeader("content-type", "text/yaml");
      res.end(fakeYml("exxperts-desktop-9.9.9-mac-arm64.zip"));
      return;
    }
    if (pathname.endsWith("latest.yml")) {
      res.setHeader("content-type", "text/yaml");
      res.end(fakeYml("exxperts-setup-9.9.9.exe"));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tag_name: "v9.9.9", prerelease: false, draft: false }));
  });
  await new Promise((resolve) => fakeFeed.listen(8793, "127.0.0.1", resolve));
  env.EXXPERTS_DESKTOP_UPDATE_FEED = "http://127.0.0.1:8793/";
  env.EXXPERTS_DESKTOP_EXPECT_UPDATE = "1";
  console.log("[desktop dev] fake update feed on 127.0.0.1:8793 (v9.9.9)");
}

const electronBinary = require("electron");
const child = spawn(electronBinary, ["."].concat(argv.includes("--hidden") ? ["--hidden"] : []), { cwd: pkgRoot, stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (fakeFeed) fakeFeed.close();
  if (smoke) console.log(`[desktop dev] app exited code=${code} signal=${signal}`);
  // Driver-side leak check: nothing may still be listening on the smoke port
  // after the app exits (the in-app watchdog proof cannot see an orphaned
  // grandchild; this can - it caught exactly that once).
  if (smoke && process.platform !== "win32") {
    const port = env.EXXPERTS_DESKTOP_PORT || "8790";
    const leak = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (leak.status === 0 && leak.stdout.trim()) {
      console.error(`[desktop dev] SMOKE FAIL: port ${port} still has listeners after exit: ${leak.stdout.trim().split("\n").join(", ")}`);
      process.exit(1);
    }
    console.log(`[desktop dev] port ${port} free after exit`);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
