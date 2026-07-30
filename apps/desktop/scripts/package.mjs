#!/usr/bin/env node
// Packages the desktop app.
//
//   node scripts/package.mjs [--target darwin-arm64|win-x64] [--archive <release archive>] [--skip-bundle] [--sign-mac] [--sign-windows]
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
//
// --sign-windows (CI-only, win-x64 on a Windows host): packages through the
// electron-builder-win-signed.yml overlay so electron-builder signs every
// binary via Azure Trusted Signing during packaging, then verifies the
// Authenticode signatures on the packaged exes and fails the build if any is
// missing or invalid — a build that claimed to sign can never ship unsigned.
// Credentials come from the ambient Azure identity chain (azure/login in the
// release workflow); without them electron-builder's signing step errors out.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

// npx is npx.cmd on Windows; a shell is required to spawn it there. With
// shell:true Node concatenates the args UNQUOTED into one cmd.exe line
// (DEP0190), so any arg carrying whitespace or cmd metacharacters must be
// quoted ourselves (same pattern as scripts/bundle-release.mjs).
const shell = process.platform === "win32";
const quoteForShell = (args) => {
  if (!shell) return args;
  return args.map((arg) => (/[\s&()^%!"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
};

const HOST_TARGET = { darwin: "darwin-arm64", win32: "win-x64", linux: "linux-x64" }[process.platform];
const target = argValue("--target") ?? HOST_TARGET;
if (!["darwin-arm64", "win-x64"].includes(target)) {
  console.error(`[package] unsupported target "${target}" (darwin-arm64 or win-x64).`);
  process.exit(2);
}
const signWindows = argv.includes("--sign-windows");
if (signWindows && (target !== "win-x64" || process.platform !== "win32")) {
  console.error("[package] --sign-windows requires --target win-x64 on a Windows host (Azure Trusted Signing runs through the TrustedSigning PowerShell module).");
  process.exit(2);
}
const crossPayload = target !== HOST_TARGET;

// --sign-mac: Developer ID signing + notarization, macOS host only (codesign,
// notarytool and the keychain identity all live there). The overlay config
// carries the identity/entitlements/notarize settings; the credentials are
// resolved up front so a missing key file aborts before the long payload
// build rather than after it.
const signMac = argv.includes("--sign-mac");
if (signMac && (target !== "darwin-arm64" || process.platform !== "darwin")) {
  console.error("[package] --sign-mac requires --target darwin-arm64 on a macOS host.");
  process.exit(2);
}
if (signMac) {
  // The .p8 key file path may default (a local filesystem path publishes
  // fine), but the key ID and issuer ID are account identifiers that stay
  // out of the repo: they must arrive via the environment, and a missing one
  // aborts here, before the long build, like the missing-.p8 case.
  const apiKey = path.resolve(
    process.env.APPLE_API_KEY ?? path.join(os.homedir(), "exxperts-signing", "EXXConnect.p8")
  );
  if (!fs.existsSync(apiKey)) {
    console.error(`[package] --sign-mac: App Store Connect API key not found at ${apiKey}`);
    console.error("[package] place the .p8 there or point APPLE_API_KEY at it.");
    process.exit(1);
  }
  if (!process.env.APPLE_API_KEY_ID || !process.env.APPLE_API_ISSUER) {
    console.error("[package] --sign-mac: APPLE_API_KEY_ID and APPLE_API_ISSUER must be set in the environment");
    console.error("[package] export both (values accompany the .p8, e.g. under ~/exxperts-signing) and rerun.");
    process.exit(1);
  }
  process.env.APPLE_API_KEY = apiKey;
}
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

// --sign-windows preflight: every exe inside the payload is a third-party
// binary already signed by its publisher (our own binaries — exxperts.exe and
// the NSIS installer/uninstaller — are produced later by electron-builder),
// and Azure Trusted Signing rejects re-signing them (SignerSign() 0x80004005).
// Each must therefore be excluded via a signExts negative pattern in the
// signed overlay; a payload exe without one aborts here with the fix spelled
// out, instead of as an opaque Azure error halfway through the build.
if (signWindows) {
  const overlay = fs.readFileSync(path.join(desktopRoot, "electron-builder-win-signed.yml"), "utf8");
  const excluded = [...overlay.matchAll(/"!([^"]+)"/g)].map((m) => m[1]);
  const uncovered = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.toLowerCase().endsWith(".exe") && !excluded.some((suffix) => p.endsWith(suffix))) uncovered.push(p);
    }
  };
  walk(serverDir);
  if (uncovered.length > 0) {
    console.error("[package] --sign-windows: the payload carries executables with no signExts exclusion:");
    for (const p of uncovered) console.error(`[package]   ${path.relative(serverDir, p)}`);
    console.error('[package] add a "!<filename>" entry under win.signExts in electron-builder-win-signed.yml so each keeps its publisher\'s signature.');
    process.exit(1);
  }
}

// Step 3: icons, regenerated every run (an only-if-missing check let icon
// changes silently not ship).
console.log("[package] generating icons...");
execFileSync("npx", quoteForShell(["tsx", path.join(desktopRoot, "scripts", "generate-icon.mts")]), { cwd: repoRoot, stdio: "inherit", shell });

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

// Step 5: compile + electron-builder. --sign-mac / --sign-windows swap in
// the matching signed config overlay; every other path stays on the unsigned
// base config.
const run = (cmd, args) => {
  const res = spawnSync(cmd, quoteForShell(args), { cwd: desktopRoot, stdio: "inherit", shell });
  if (res.status !== 0) process.exit(res.status ?? 1);
};
const builderConfig = signMac ? "electron-builder-mac-signed.yml" : signWindows ? "electron-builder-win-signed.yml" : "electron-builder.yml";
run("node", [path.join(desktopRoot, "scripts", "build.mjs")]);
// --publish never, always: the publish config in electron-builder.yml exists
// ONLY so the update metadata (latest.yml / latest-mac.yml + app-update.yml
// in resources) gets generated; no build path may ever upload anywhere.
run("npx", ["electron-builder", target === "win-x64" ? "--win" : "--mac", "--config", builderConfig, "--publish", "never"]);

// The one-click updater is only as good as its metadata: a build without the
// channel file would ship apps that can never see the next release, so its
// absence fails the build here instead of surfacing as a field bug.
const channelFile = path.join(desktopRoot, "dist-app", target === "win-x64" ? "latest.yml" : "latest-mac.yml");
if (!fs.existsSync(channelFile)) {
  console.error(`[package] update metadata missing: ${channelFile} was not generated (check the publish config in electron-builder.yml).`);
  process.exit(1);
}

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

  // Fail closed: a --sign-windows build must never ship unsigned binaries.
  // Verify the Authenticode signature on the app exe (also the exe inside the
  // zip artifact — the zip is packed from win-unpacked after signing) and on
  // the NSIS setup exe; anything but a Valid chain aborts the build.
  if (signWindows) {
    const distApp = path.join(desktopRoot, "dist-app");
    const setupExe = fs.readdirSync(distApp).find((f) => /^exxperts-setup-.*\.exe$/.test(f));
    if (!setupExe) {
      console.error("[package] --sign-windows: no exxperts-setup-*.exe found in dist-app to verify.");
      process.exit(1);
    }
    // pwsh, not powershell.exe: on the hosted runner Windows PowerShell 5.1
    // fails to autoload Microsoft.PowerShell.Security in a -Command
    // invocation (CouldNotAutoloadMatchingModule), which aborted the check on
    // genuinely signed binaries. PowerShell 7 ships on windows-latest; the
    // explicit Import-Module is belt-and-suspenders. Any script error,
    // non-Valid status, or signer other than Exxeta AG exits non-zero.
    for (const exe of [path.join(unpacked, "exxperts.exe"), path.join(distApp, setupExe)]) {
      const psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `Import-Module Microsoft.PowerShell.Security`,
        `$sig = Get-AuthenticodeSignature -FilePath '${exe.replace(/'/g, "''")}'`,
        `Write-Output ("status=" + $sig.Status + " subject=" + $sig.SignerCertificate.Subject)`,
        `if ($sig.Status -ne 'Valid') { exit 1 }`,
        `if ($null -eq $sig.SignerCertificate -or $sig.SignerCertificate.Subject -notlike '*CN=Exxeta AG*') { exit 1 }`,
      ].join("; ");
      const res = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", psScript], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
      const report = (res.stdout ?? "").trim();
      if (res.status !== 0) {
        console.error(`[package] --sign-windows: ${path.basename(exe)} is NOT a valid Exxeta AG-signed binary (${report || "no signature status"}); refusing to ship it.`);
        process.exit(1);
      }
      console.log(`[package] signature verified on ${path.basename(exe)} (${report})`);
    }
  }
}

// --sign-mac fail-closed verification: electron-builder already signed,
// notarized and stapled the .app (so the zip artifact carries the ticket),
// but the dmg container itself is not notarized by electron-builder — it is
// submitted and stapled here so a downloaded dmg passes Gatekeeper offline.
// Every check aborts the build on failure: a --sign-mac build can never
// finish while shipping an unsigned or un-notarized artifact.
if (signMac) {
  const appPath = path.join(desktopRoot, "dist-app", "mac-arm64", "exxperts.app");
  const dmgPath = path.join(desktopRoot, "dist-app", `exxperts-desktop-${rootPkg.version}-mac-arm64.dmg`);
  const verify = (title, cmd, args) => {
    console.log(`[package] verify: ${title}`);
    try {
      execFileSync(cmd, args, { stdio: "inherit" });
    } catch {
      console.error(`[package] SIGNING VERIFICATION FAILED: ${title}`);
      process.exit(1);
    }
  };
  for (const p of [appPath, dmgPath]) {
    if (!fs.existsSync(p)) {
      console.error(`[package] expected signed artifact missing: ${p}`);
      process.exit(1);
    }
  }
  verify("codesign (deep, strict) on the .app", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  verify("stapler validate on the .app", "xcrun", ["stapler", "validate", appPath]);
  // Gatekeeper's own verdict — rejects a signed-but-not-notarized app.
  verify("spctl --assess (Gatekeeper) on the .app", "spctl", ["--assess", "--type", "exec", "--verbose=2", appPath]);
  console.log("[package] notarizing the dmg (notarytool submit --wait)...");
  let submitOut = "";
  try {
    submitOut = execFileSync("xcrun", [
      "notarytool", "submit", dmgPath,
      "--key", process.env.APPLE_API_KEY,
      "--key-id", process.env.APPLE_API_KEY_ID,
      "--issuer", process.env.APPLE_API_ISSUER,
      "--wait",
    ], { encoding: "utf8" });
  } catch (err) {
    console.error(err.stdout ?? "");
    console.error("[package] SIGNING VERIFICATION FAILED: dmg notarization submission errored");
    process.exit(1);
  }
  console.log(submitOut);
  // notarytool exits 0 even when the verdict is Invalid; the verdict is text.
  if (!/status: Accepted/.test(submitOut)) {
    console.error("[package] SIGNING VERIFICATION FAILED: dmg notarization was not Accepted (see log id above; fetch details with `xcrun notarytool log`)");
    process.exit(1);
  }
  verify("stapler staple on the dmg", "xcrun", ["stapler", "staple", dmgPath]);
  verify("stapler validate on the dmg", "xcrun", ["stapler", "validate", dmgPath]);
  verify("spctl --assess (Gatekeeper) on the dmg", "spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmgPath]);
  console.log("[package] signed, notarized and stapled: .app (inside dmg and zip) and dmg verified");
}
console.log("[package] done; artifacts in dist-app/");
