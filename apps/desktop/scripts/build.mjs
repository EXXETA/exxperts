#!/usr/bin/env node
// Typecheck + bundle for the desktop shell.
//
// The shell's runtime code ships as ONE bundled dist/main.js (esbuild, with
// only electron external): the builder config deliberately packs no
// node_modules into the asar (electron-builder once resolved the workspace
// root through the lock file and packed the repo's entire hoisted tree - a
// 1.3 GB app), so a runtime dependency like electron-updater must ride inside
// the bundle instead. tsc stays as the type gate; esbuild does the emitting.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(pkgRoot, "package.json"));

const tsc = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
  cwd: pkgRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// Clean emit: stale per-file tsc output (or a prior smoke screenshot) must
// never ride into the asar next to the bundle.
fs.rmSync(path.join(pkgRoot, "dist"), { recursive: true, force: true });

const esbuild = require("esbuild");
await esbuild.build({
  absWorkingDir: pkgRoot,
  entryPoints: [path.join(pkgRoot, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  outfile: path.join(pkgRoot, "dist", "main.js"),
  sourcemap: true,
});
console.log("[build] dist/main.js bundled");
