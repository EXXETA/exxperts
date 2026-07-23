#!/usr/bin/env node
// End-to-end smoke of the PACKAGED app (macOS only; a cross-built Windows
// app cannot launch here): boots dist-app/mac-arm64/exxperts.app with the
// same scratch-home smoke env the dev smoke uses, so the vendored node and
// bundled payload are what actually run.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("[smoke:packaged] only the macOS app can be launched on this host.");
  process.exit(2);
}
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(desktopRoot, "dist-app", "mac-arm64", "exxperts.app", "Contents", "MacOS", "exxperts");
if (!fs.existsSync(binary)) {
  console.error(`[smoke:packaged] no packaged app at ${binary}; run npm run package first.`);
  process.exit(1);
}
const scratch = path.join(os.homedir(), ".exxperts-desktop-scratch");
fs.mkdirSync(scratch, { recursive: true });
const child = spawn(binary, process.argv.slice(2).includes("--hidden") ? ["--hidden"] : [], {
  stdio: "inherit",
  env: {
    ...process.env,
    EXXPERTS_DESKTOP_SMOKE: "1",
    EXXPERTS_DESKTOP_PORT: process.env.EXXPERTS_DESKTOP_PORT || "8790",
    EXXPERTS_DESKTOP_SCRATCH_HOME: scratch,
    EXXPERTS_DESKTOP_SMOKE_SHOT: path.join(desktopRoot, "dist-app", "packaged-smoke-shot.png"),
  },
});
child.on("exit", (code, signal) => {
  // Driver-side leak check, mirroring dev.mjs: no listeners may remain on
  // the smoke port after the app exits.
  const port = process.env.EXXPERTS_DESKTOP_PORT || "8790";
  const leak = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (leak.status === 0 && leak.stdout.trim()) {
    console.error(`[smoke:packaged] SMOKE FAIL: port ${port} still has listeners after exit: ${leak.stdout.trim().split("\n").join(", ")}`);
    process.exit(1);
  }
  console.log(`[smoke:packaged] port ${port} free after exit`);
  process.exit(code ?? (signal ? 1 : 0));
});
