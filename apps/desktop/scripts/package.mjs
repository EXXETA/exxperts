#!/usr/bin/env node
// Packages the desktop app.
//
//   node scripts/package.mjs [--target darwin-arm64|win-x64] [--archive <release archive>] [--skip-bundle]
//
// darwin-arm64 (default on macOS): payload built here via the repo's
// scripts/bundle-release.mjs unless --skip-bundle reuses a version-matching
// one from build/payload. win-x64: cross-built app shell (electron-builder
// supports it); the payload CANNOT be built on this host (bundle-release
// refuses cross-builds because native modules are per-platform), so a
// win-x64 release archive must sit in build/payload or be passed via
// --archive — grab it from the GitHub release, e.g.:
//   gh release download v<version> --repo EXXETA/exxperts --pattern "*win-x64.zip" --dir build/payload
//
// Steps: (1) resolve the payload archive, hard-matched to the root
// package.json version (no lexicographic latest: 0.6.10 sorts under 0.6.8);
// (2) stage its app/ + vendor/node/ tree into build/server; (3) regenerate
// the icons every run so icon changes always ship; (4) sync the shell version
// to the root version so artifacts carry the product version; (5) run
// electron-builder for the target.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const buildDir = path.join(desktopRoot, "build");
const argv = process.argv.slice(2);

const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

const HOST_TARGET = { darwin: "darwin-arm64", win32: "win-x64", linux: "linux-x64" }[process.platform];
const target = argValue("--target") ?? HOST_TARGET;
if (!["darwin-arm64", "win-x64"].includes(target)) {
  console.error(`[package] unsupported target "${target}" (darwin-arm64 or win-x64).`);
  process.exit(2);
}
const crossPayload = target !== HOST_TARGET;
const archiveExt = target === "win-x64" ? ".zip" : ".tar.gz";

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const wantedArchive = `exxperts-${rootPkg.version}-${target}${archiveExt}`;

// Step 1: the server payload archive, exact-version only.
let archivePath = argValue("--archive");
const payloadDir = path.join(buildDir, "payload");
if (!archivePath) {
  const candidate = path.join(payloadDir, wantedArchive);
  if (fs.existsSync(candidate) && (argv.includes("--skip-bundle") || crossPayload)) {
    archivePath = candidate;
    console.log(`[package] reusing payload ${archivePath}`);
  } else if (crossPayload) {
    console.error(`[package] no ${wantedArchive} in build/payload and it cannot be built on this host.`);
    console.error(`[package] download it: gh release download v${rootPkg.version} --repo EXXETA/exxperts --pattern "*${target}*" --dir apps/desktop/build/payload`);
    process.exit(1);
  } else {
    console.log("[package] building the server payload (scripts/bundle-release.mjs)...");
    execFileSync("node", [path.join(repoRoot, "scripts", "bundle-release.mjs"), "--target", target, "--out", payloadDir], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    archivePath = path.join(payloadDir, wantedArchive);
  }
}
archivePath = path.resolve(archivePath);
if (!fs.existsSync(archivePath)) {
  console.error(`[package] payload archive not found: ${archivePath}`);
  process.exit(1);
}
if (!path.basename(archivePath).startsWith(`exxperts-${rootPkg.version}-${target}`)) {
  console.error(`[package] payload ${path.basename(archivePath)} does not match version ${rootPkg.version} and target ${target}; refusing a stale or wrong-platform payload.`);
  process.exit(1);
}

// Step 2: stage app/ + vendor/node/ into build/server. Extracted fresh every
// run so a stale tree can never ship. tar -xf autodetects tar.gz and zip
// (macOS bsdtar; Windows System32 tar.exe likewise).
const stageDir = path.join(buildDir, "server-stage");
const serverDir = path.join(buildDir, "server");
fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(serverDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
console.log(`[package] extracting ${path.basename(archivePath)}...`);
execFileSync("tar", ["-xf", archivePath, "-C", stageDir], { stdio: "inherit" });
const topDir = path.join(stageDir, "exxperts");
for (const part of ["app", "vendor"]) {
  if (!fs.existsSync(path.join(topDir, part))) {
    console.error(`[package] payload archive is missing ${part}/; not a release archive?`);
    process.exit(1);
  }
}
fs.mkdirSync(serverDir, { recursive: true });
fs.renameSync(path.join(topDir, "app"), path.join(serverDir, "app"));
fs.renameSync(path.join(topDir, "vendor"), path.join(serverDir, "vendor"));
fs.rmSync(stageDir, { recursive: true, force: true });
const vendoredNode = target === "win-x64"
  ? path.join(serverDir, "vendor", "node", "node.exe")
  : path.join(serverDir, "vendor", "node", "bin", "node");
if (!fs.existsSync(vendoredNode)) {
  console.error(`[package] staged payload has no vendored node at ${vendoredNode}.`);
  process.exit(1);
}

// Step 3: icons, regenerated every run (an only-if-missing check let icon
// changes silently not ship).
console.log("[package] generating icons...");
execFileSync("npx", ["tsx", path.join(desktopRoot, "scripts", "generate-icon.mts")], { cwd: repoRoot, stdio: "inherit" });

// Step 4: the shell's package.json version follows the product version so
// artifact names carry it; a change lands in git status and rides the next
// commit.
const desktopPkgPath = path.join(desktopRoot, "package.json");
const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, "utf8"));
if (desktopPkg.version !== rootPkg.version) {
  desktopPkg.version = rootPkg.version;
  fs.writeFileSync(desktopPkgPath, `${JSON.stringify(desktopPkg, null, 2)}\n`);
  // Keep the lockfile's own version stamps in step (npm records the package
  // version in the root and "" entries).
  const lockPath = path.join(desktopRoot, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = rootPkg.version;
  if (lock.packages?.[""]) lock.packages[""].version = rootPkg.version;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`[package] synced shell version to ${rootPkg.version} (commit the package.json + package-lock.json change)`);
}

// Step 5: compile + electron-builder.
const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { cwd: desktopRoot, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
};
run("npx", ["tsc", "-p", "tsconfig.json"]);
run("npx", ["electron-builder", target === "win-x64" ? "--win" : "--mac", "--config", "electron-builder.yml"]);

// Cross-built output cannot be launched here; assert the layout instead.
if (target === "win-x64") {
  const unpacked = path.join(desktopRoot, "dist-app", "win-unpacked");
  for (const rel of ["exxperts.exe", path.join("resources", "server", "vendor", "node", "node.exe"), path.join("resources", "server", "app", "bin", "exxperts.cjs"), path.join("resources", "app.asar")]) {
    const p = path.join(unpacked, rel);
    if (!fs.existsSync(p)) {
      console.error(`[package] win-unpacked is missing ${rel}`);
      process.exit(1);
    }
  }
  console.log("[package] win-unpacked layout verified (exe, asar, payload, vendored node.exe)");
}
console.log("[package] done; artifacts in dist-app/");
