#!/usr/bin/env node
// Builds a prebuilt per-OS release archive (phase 0): a self-contained
// directory with a launcher shim, the installed app tree, and a vendored
// Node runtime, so end users need neither Node nor npm nor git to run
// exxperts.
//
//   node scripts/bundle-release.mjs --target <win-x64|darwin-arm64|linux-x64> --out <dir>
//   node scripts/bundle-release.mjs --print-node-version
//
// Output: <out>/exxperts-<version>-<target>.tar.gz (POSIX targets) or .zip
// (win-x64), plus <archivename>.sha256 next to it (sha256sum format).
//
// The target MUST match the host platform/arch: esbuild and
// @mariozechner/clipboard install only the host platform's native binary, so
// cross-building would produce an archive whose native deps are for the
// wrong OS. Each target is built on a native runner or container.
//
// Archive layout (top-level directory "exxperts/"):
//   exxperts            POSIX sh shim (exxperts.cmd on win-x64)
//   app/                the installed npm package tree (fully dereferenced)
//   vendor/node/        pinned Node runtime, trimmed to the node binary + LICENSE
//
// The launcher chain is relocatable: bin/exxperts.cjs resolves the app root
// relative to itself, spawns all children via process.execPath, and resolves
// tsx via require.resolve, so a shim that invokes the vendored node with
// app/bin/exxperts.cjs makes everything downstream use the vendored node.
//
// Deliberately NOT bundled in phase 0: Chromium (a per-user cache download,
// playwright-dependent artifact preview degrades gracefully without it; users
// can fetch it later with "npx playwright install chromium") and git (stays a
// soft dependency for the skills-repo fetch).

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// npm is npm.cmd on Windows; a shell is required to spawn it there.
const shell = process.platform === "win32";

// With shell:true Node concatenates the args UNQUOTED into one cmd.exe line
// (DEP0190), so a repo or temp path containing a space, e.g. the tarball
// path or --prefix, splits into multiple args. Quote every arg carrying
// whitespace or cmd metacharacters ourselves; embedded quotes are escaped.
// Applied only when shell is true, so the POSIX shell:false path is
// untouched.
function quoteForShell(args) {
	if (!shell) return args;
	return args.map((arg) =>
		/[\s&()^%!"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg,
	);
}

// Windows PATH tar can be GNU tar from Git for Windows, which cannot read or
// write zip; System32 tar.exe is bsdtar and handles zip natively. Prefer the
// absolute bsdtar when present, fall back to PATH tar otherwise.
const tarBin =
	process.platform === "win32" &&
	fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"))
		? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
		: "tar";

// The pin file is the trust anchor for the vendored runtime: version plus
// the per-target sha256 of the nodejs.org archive, both reviewed in an MR.
const NODE_PIN = JSON.parse(
	fs.readFileSync(path.join(root, "scripts", "release-node-version.json"), "utf8"),
);
const NODE_VERSION = NODE_PIN.version;

// ---------------------------------------------------------------------------
// CLI parsing. The contract here is consumed by the release workflow; keep
// the flags and output filenames stable.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes("--print-node-version")) {
	console.log(NODE_VERSION);
	process.exit(0);
}

function argValue(flag) {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return null;
	return argv[i + 1];
}

const TARGETS = {
	"win-x64": { platform: "win32", arch: "x64", nodeDist: "win-x64", nodeExt: ".zip", archiveExt: ".zip" },
	"darwin-arm64": { platform: "darwin", arch: "arm64", nodeDist: "darwin-arm64", nodeExt: ".tar.gz", archiveExt: ".tar.gz" },
	"linux-x64": { platform: "linux", arch: "x64", nodeDist: "linux-x64", nodeExt: ".tar.xz", archiveExt: ".tar.gz" },
};

const target = argValue("--target");
const outDirArg = argValue("--out");
if (!target || !outDirArg) {
	console.error("Usage: node scripts/bundle-release.mjs --target <win-x64|darwin-arm64|linux-x64> --out <dir>");
	console.error("       node scripts/bundle-release.mjs --print-node-version");
	process.exit(2);
}
const spec = TARGETS[target];
if (!spec) {
	console.error(`[bundle-release] unknown target "${target}" (expected one of: ${Object.keys(TARGETS).join(", ")})`);
	process.exit(2);
}
if (spec.platform !== process.platform || spec.arch !== process.arch) {
	console.error(`[bundle-release] target ${target} cannot be built on this host (${process.platform}-${process.arch}).`);
	console.error("[bundle-release] Native deps (esbuild, clipboard) install only the host platform's binary, so each target must be built on a matching runner or container.");
	process.exit(1);
}

const outDir = path.resolve(root, outDirArg);
const isWin = spec.platform === "win32";

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const archiveName = `exxperts-${pkg.version}-${target}${spec.archiveExt}`;
const archivePath = path.join(outDir, archiveName);

function log(msg) {
	console.log(`[bundle-release] ${msg}`);
}

function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
	if (res.status !== 0) {
		console.error(`[bundle-release] command failed (exit ${res.status ?? "signal"}): ${cmd} ${args.join(" ")}`);
		process.exit(res.status ?? 1);
	}
	return res;
}

// The workflow contract is exactly one archive plus checksum per run; a
// dirty out dir left by a build at an older version must not leave stale
// artifacts next to the fresh ones for the upload glob to pick up.
if (fs.existsSync(outDir)) {
	for (const entry of fs.readdirSync(outDir)) {
		if (/^exxperts-.*(\.tar\.gz|\.zip|\.sha256)$/.test(entry)) {
			fs.rmSync(path.join(outDir, entry));
			log(`removed stale ${entry} from the out dir`);
		}
	}
}

// Scratch space lives under os.tmpdir(): a fresh dir per run, removed at the
// end. Kept out of the repo so a failed run never leaves half-staged trees
// where git or editors trip over them.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-bundle-"));
process.on("exit", () => {
	try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Step 1: build + pack, mirroring scripts/install-global.mjs.
// ---------------------------------------------------------------------------

log(`building ${pkg.name}@${pkg.version} for ${target} (Node pin ${NODE_VERSION})`);
run("npm", quoteForShell(["run", "build"]), { shell });

log("packing...");
const pack = spawnSync("npm", quoteForShell(["pack", "--json"]), { cwd: root, encoding: "utf8", shell });
if (pack.status !== 0) {
	process.stderr.write(pack.stderr ?? "");
	process.exit(pack.status ?? 1);
}
// npm <=11 prints an array of pack reports; npm 12 prints an object keyed by
// package name. Accept both (same handling as install-global.mjs).
const packReport = JSON.parse(pack.stdout);
const packEntry = Array.isArray(packReport) ? packReport[0] : Object.values(packReport ?? {})[0];
const tarballName = packEntry?.filename;
if (!tarballName) {
	console.error("[bundle-release] npm pack did not report a tarball filename");
	process.exit(1);
}
const tarball = path.join(root, tarballName);

// ---------------------------------------------------------------------------
// Step 2: install the tarball into a TEMP npm prefix. This is the same
// pipeline install-global.mjs uses for the real global install, just pointed
// at a throwaway prefix, so the staged tree is exactly what a global install
// would produce (prod deps only, hoisted node_modules, bin links).
// ---------------------------------------------------------------------------

const npmPrefix = path.join(work, "prefix");
fs.mkdirSync(npmPrefix, { recursive: true });

// npm reads neither the project .npmrc nor package.json allowScripts in
// global mode, so npm 12's gates need explicit flags: allow-remote for the
// SheetJS CDN tarball and allow-scripts for native deps. allow-scripts name
// entries only match registry deps; the local tarball is matched by its exact
// path, so the tarball path itself is an entry too. Passed unconditionally,
// both as CLI flags and npm_config_* env: ungated npms accept the unknown
// config with at worst a warning, gated npms need it (see install-global.mjs
// for the full history).
const scriptAllows = [tarball, pkg.name, ...Object.keys(pkg.allowScripts ?? {})];
log(`installing ${tarballName} into a temp prefix...`);
run(
	"npm",
	quoteForShell([
		"install",
		"-g",
		tarball,
		`--prefix=${npmPrefix}`,
		"--allow-remote=all",
		...scriptAllows.map((entry) => `--allow-scripts=${entry}`),
	]),
	{
		shell,
		env: {
			...process.env,
			npm_config_allow_remote: "all",
			npm_config_allow_scripts: scriptAllows.join(","),
			// Chromium is deliberately not bundled (per-user cache download);
			// keep npm's own lifecycle from fetching it if it does run scripts.
			EXXETA_SKIP_BROWSER_INSTALL: "1",
		},
	},
);

// POSIX global installs land in <prefix>/lib/node_modules/<name>, Windows in
// <prefix>/node_modules/<name>.
const installedRoot = isWin
	? path.join(npmPrefix, "node_modules", pkg.name)
	: path.join(npmPrefix, "lib", "node_modules", pkg.name);
if (!fs.existsSync(installedRoot)) {
	console.error(`[bundle-release] the installed copy was not found at ${installedRoot}`);
	process.exit(1);
}

// npm's allow-scripts matching for a local tarball root is inconsistent
// across versions and platforms, so the package postinstall is replayed
// directly in the installed copy (both scripts are idempotent).
// EXXETA_SKIP_BROWSER_INSTALL=1 makes install-chromium.mjs a no-op.
log("replaying the package postinstall in the temp install...");
for (const script of ["scripts/patch-mcp-adapter.mjs", "scripts/install-chromium.mjs"]) {
	const res = spawnSync(process.execPath, [path.join(installedRoot, script)], {
		cwd: installedRoot,
		stdio: "inherit",
		env: { ...process.env, EXXETA_SKIP_BROWSER_INSTALL: "1" },
	});
	if (res.status !== 0) {
		console.error(`[bundle-release] ${script} failed in the temp install`);
		process.exit(res.status ?? 1);
	}
}

// The pack tarball has served its purpose; keep the repo tidy.
try { fs.rmSync(tarball); } catch {}

// ---------------------------------------------------------------------------
// Step 3: assemble the staging tree.
// ---------------------------------------------------------------------------

const staging = path.join(work, "staging");
const stagingTop = path.join(staging, "exxperts");
const appDir = path.join(stagingTop, "app");
fs.mkdirSync(stagingTop, { recursive: true });

// The installed tree contains symlinks (file: workspace deps, node_modules/
// .bin entries on POSIX). Archives must contain NO symlinks: zip cannot
// represent them portably, and npm's links point at absolute paths inside
// the temp prefix that stops existing after this run. fs.cpSync's
// dereference option is NOT trusted here: on Node 24 it left nested
// symlinks in place (rewritten to absolute targets), which shipped a broken
// archive, so the copy walks the tree itself, always following links, and
// then asserts the invariant.
log("staging app/ (dereferencing symlinks)...");
copyDereferenced(installedRoot, appDir);
const leftoverLinks = findSymlinks(appDir);
if (leftoverLinks.length > 0) {
	console.error(`[bundle-release] ${leftoverLinks.length} symlink(s) survived staging; the archive would be broken:`);
	for (const link of leftoverLinks.slice(0, 10)) console.error(`[bundle-release]   ${link}`);
	process.exit(1);
}

// Supply-chain guard: the npm files allowlist ships all of docs/ and
// scripts/, so an archive built from the INTERNAL tree would stage
// internal-only files into app/ and ship them to the public release. Which
// files those are is defined in ONE place, the exclusion manifest in
// scripts/cut-mirror.mjs — stripInternalPaths reads it from there. The
// public mirror checkout has no cut-mirror.mjs (and none of those files),
// so its builds no-op here; naming the files in this comment would itself
// trip the mirror's forbidden-pattern scan, which is why it does not.
stripInternalPaths(appDir);

// Vendored Node runtime, verified against the pinned checksum.
await stageVendoredNode();

// Launcher shims. Minimal on purpose: resolve their own directory, then hand
// off to the vendored node with app/bin/exxperts.cjs. Everything else
// (EXXETA_HOME, tsx resolution, child spawning) is the launcher's job and
// already relocatable.
if (isWin) {
	// %~dp0 is the shim's own directory with a trailing backslash; quoting
	// keeps paths with spaces intact.
	fs.writeFileSync(
		path.join(stagingTop, "exxperts.cmd"),
		'@echo off\r\n"%~dp0vendor\\node\\node.exe" "%~dp0app\\bin\\exxperts.cjs" %*\r\n',
	);
} else {
	// CDPATH= guards against a user CDPATH making `cd` print the target dir;
	// `exec` replaces the shell so signals reach node directly.
	fs.writeFileSync(
		path.join(stagingTop, "exxperts"),
		'#!/bin/sh\n# exxperts launcher: runs the app with the vendored Node runtime.\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/vendor/node/bin/node" "$dir/app/bin/exxperts.cjs" "$@"\n',
		{ mode: 0o755 },
	);
}

// ---------------------------------------------------------------------------
// Step 4: archive + checksum.
// ---------------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });
try { fs.rmSync(archivePath); } catch {}

log(`creating ${archiveName}...`);
if (spec.archiveExt === ".zip") {
	// Windows-only path (win-x64 is only buildable on a Windows host, checked
	// above). tarBin resolves the System32 bsdtar, whose -a flag picks the
	// format from the extension (.zip); PATH tar could be GNU tar from Git
	// for Windows, which cannot write zip. If bsdtar is unavailable, fall
	// back to PowerShell Compress-Archive; PowerShell 5.1's Compress-Archive
	// writes backslash entry names, acceptable for the Windows-only zip, but
	// bsdtar output is cleaner, so it stays the preferred tool. Neither
	// preserves POSIX permissions, which is fine: the Windows tree has no
	// executable-bit semantics and no symlinks (dereferenced above).
	const tarRes = spawnSync(tarBin, ["-a", "-cf", archivePath, "exxperts"], { cwd: staging, stdio: "inherit" });
	if (tarRes.status !== 0 || !fs.existsSync(archivePath)) {
		log("tar -a failed; falling back to PowerShell Compress-Archive...");
		run("powershell", [
			"-NoProfile",
			"-Command",
			// -Path exxperts keeps the top-level "exxperts/" directory in the zip.
			`Compress-Archive -Path 'exxperts' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`,
		], { cwd: staging });
	}
} else {
	// System tar exists on all three CI OSes. The staging tree is already
	// fully dereferenced, so no -h needed; plain -czf keeps GNU/bsd tar
	// behavior identical.
	run(tarBin, ["-czf", archivePath, "exxperts"], { cwd: staging });
}

const archiveBytes = fs.readFileSync(archivePath);
const sha256 = crypto.createHash("sha256").update(archiveBytes).digest("hex");
// sha256sum format: "<hex>  <name>" with two spaces, so `sha256sum -c` and
// `shasum -a 256 -c` both accept the file as-is from the archive's directory.
fs.writeFileSync(path.join(outDir, `${archiveName}.sha256`), `${sha256}  ${archiveName}\n`);

const sizeMb = (archiveBytes.length / (1024 * 1024)).toFixed(1);
log("done");
log(`  archive: ${archivePath}`);
log(`  size:    ${sizeMb} MB (${archiveBytes.length} bytes)`);
log(`  sha256:  ${sha256}`);

// ---------------------------------------------------------------------------
// Vendored Node: download the pinned build from nodejs.org and verify its
// sha256 against the PINNED hash in scripts/release-node-version.json (hard
// fail on mismatch), then trim to just the node binary + LICENSE. The pin
// file, reviewed in an MR, is the trust anchor: a live SHASUMS256.txt fetch
// would trust whatever nodejs.org serves at build time, while the pinned
// values were taken from SHASUMS256.txt once and can be independently
// verified against its PGP-signed SHASUMS256.txt.asc. npm, corepack and
// headers are dead weight here: the product never shells out to npm at
// runtime, and dropping them saves ~60 MB unpacked.
// ---------------------------------------------------------------------------

async function stageVendoredNode() {
	const distBase = `https://nodejs.org/dist/v${NODE_VERSION}`;
	const nodeDirName = `node-v${NODE_VERSION}-${spec.nodeDist}`;
	const nodeArchiveName = `${nodeDirName}${spec.nodeExt}`;

	const expected = NODE_PIN.sha256?.[spec.nodeDist];
	if (!/^[0-9a-f]{64}$/.test(expected ?? "")) {
		console.error(`[bundle-release] scripts/release-node-version.json has no sha256 pin for ${spec.nodeDist}`);
		console.error('[bundle-release] Expected shape: {"version":"X.Y.Z","sha256":{"win-x64":"<hex>","darwin-arm64":"<hex>","linux-x64":"<hex>"}}');
		process.exit(1);
	}

	log(`downloading ${nodeArchiveName}...`);
	const archiveBuf = await fetchBuffer(`${distBase}/${nodeArchiveName}`);

	const actual = crypto.createHash("sha256").update(archiveBuf).digest("hex");
	if (actual !== expected) {
		console.error(`[bundle-release] sha256 MISMATCH for ${nodeArchiveName}`);
		console.error(`[bundle-release]   expected ${expected} (pinned in scripts/release-node-version.json)`);
		console.error(`[bundle-release]   actual   ${actual}`);
		process.exit(1);
	}
	log(`sha256 verified against the pin file (${expected.slice(0, 12)}...)`);

	const nodeArchivePath = path.join(work, nodeArchiveName);
	fs.writeFileSync(nodeArchivePath, archiveBuf);

	const extractDir = path.join(work, "node-extract");
	fs.mkdirSync(extractDir, { recursive: true });
	// tarBin handles all three formats: gzip/xz autodetected by GNU and bsd
	// tar (-xf), and the zip case only runs on Windows, where tarBin resolves
	// the System32 bsdtar (PATH tar could be GNU tar, which cannot read zip).
	run(tarBin, ["-xf", nodeArchivePath, "-C", extractDir]);
	const extractedRoot = path.join(extractDir, nodeDirName);

	const vendorDir = path.join(stagingTop, "vendor", "node");
	if (isWin) {
		// Windows layout: vendor/node/node.exe (no bin/ subdir upstream either).
		fs.mkdirSync(vendorDir, { recursive: true });
		fs.copyFileSync(path.join(extractedRoot, "node.exe"), path.join(vendorDir, "node.exe"));
	} else {
		fs.mkdirSync(path.join(vendorDir, "bin"), { recursive: true });
		fs.copyFileSync(path.join(extractedRoot, "bin", "node"), path.join(vendorDir, "bin", "node"));
		fs.chmodSync(path.join(vendorDir, "bin", "node"), 0o755);
	}
	fs.copyFileSync(path.join(extractedRoot, "LICENSE"), path.join(vendorDir, "LICENSE"));
	log(`vendored node v${NODE_VERSION} staged (trimmed to the binary + LICENSE)`);
}

// Strip internal-only paths from the staged app/ tree, driven by the cut
// manifest in scripts/cut-mirror.mjs so the two lists cannot drift. That
// script only exists in the internal repo (it is on its own exclusion list);
// when absent the build runs from the public mirror and there is nothing to
// strip. The manifest is parsed FROM THE FILE TEXT, never imported: the
// module executes a cut on import. A manifest refactor that breaks the parse
// hard-fails the build instead of silently disabling the guard.
function stripInternalPaths(appDir) {
	const cutMirrorPath = path.join(root, "scripts", "cut-mirror.mjs");
	if (!fs.existsSync(cutMirrorPath)) {
		log("scripts/cut-mirror.mjs not present (public mirror checkout); nothing internal to strip");
		return;
	}
	const text = fs.readFileSync(cutMirrorPath, "utf8");
	const arrayMatch = text.match(/const EXCLUDED_PATHS = \[([\s\S]*?)\];/);
	const headingMatch = text.match(/const INTERNAL_DOCS_HEADING = "([^"]+)";/);
	const excluded = arrayMatch ? [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
	if (excluded.length === 0 || !headingMatch) {
		console.error("[bundle-release] could not parse EXCLUDED_PATHS / INTERNAL_DOCS_HEADING from scripts/cut-mirror.mjs");
		console.error("[bundle-release] The internal-docs guard must not be silently disabled by a manifest refactor; update the parse here alongside it.");
		process.exit(1);
	}

	// cut-mirror.mjs is in its own manifest, but its removal must never
	// depend on that staying true.
	let removed = 0;
	for (const rel of new Set([...excluded, "scripts/cut-mirror.mjs"])) {
		const target = path.join(appDir, rel);
		if (fs.existsSync(target)) {
			fs.rmSync(target, { recursive: true, force: true });
			removed++;
		}
	}

	// docs/README.md: everything from the marked heading to the end of the
	// file is the internal block.
	const docsIndexPath = path.join(appDir, "docs", "README.md");
	if (fs.existsSync(docsIndexPath)) {
		const docsIndex = fs.readFileSync(docsIndexPath, "utf8");
		const headingAt = docsIndex.indexOf(headingMatch[1]);
		if (headingAt !== -1) {
			fs.writeFileSync(docsIndexPath, docsIndex.slice(0, headingAt).replace(/\s+$/, "") + "\n");
			removed++;
		}
	}

	const leftover = excluded.filter((rel) => fs.existsSync(path.join(appDir, rel)));
	if (leftover.length > 0) {
		console.error(`[bundle-release] internal paths survived the strip: ${leftover.join(", ")}`);
		process.exit(1);
	}
	log(`internal-docs guard: removed ${removed} internal path(s)/block(s) from app/`);
}

// Recursive copy that ALWAYS follows symlinks (statSync, not lstatSync):
// link targets are copied as real files/directories, so the result has no
// links at all. Modes are preserved from the target (matters for the .bin
// scripts' executable bits). Broken links and directory-symlink cycles fail
// with a clear error, which is what we want: either one in the installed
// tree means the install itself is bad, and a cycle would otherwise recurse
// until ENAMETOOLONG.
function copyDereferenced(src, dest, ancestors = new Set()) {
	let stat;
	try {
		stat = fs.statSync(src); // follows symlinks
	} catch (err) {
		if (err.code === "ENOENT" && fs.lstatSync(src, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`dangling symlink in the installed tree: ${src} (its target does not exist; the install is broken)`);
		}
		throw err;
	}
	if (stat.isDirectory()) {
		// The ancestor chain (added before recursing, removed after) catches
		// cycles without rejecting two distinct links to the same directory.
		const real = fs.realpathSync(src);
		if (ancestors.has(real)) {
			throw new Error(`directory symlink cycle in the installed tree at ${src} (resolves to already-visited ${real})`);
		}
		ancestors.add(real);
		fs.mkdirSync(dest, { recursive: true });
		for (const entry of fs.readdirSync(src)) {
			copyDereferenced(path.join(src, entry), path.join(dest, entry), ancestors);
		}
		ancestors.delete(real);
	} else {
		fs.copyFileSync(src, dest);
		fs.chmodSync(dest, stat.mode);
	}
}

function findSymlinks(dir) {
	const links = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) links.push(full);
		else if (entry.isDirectory()) links.push(...findSymlinks(full));
	}
	return links;
}

async function fetchBuffer(url) {
	// Node's global fetch follows redirects; nodejs.org serves directly. The
	// timeout is generous (the Node archive is ~30-50 MB) but bounds a stalled
	// connection instead of hanging the build forever; it covers the body
	// read too, not just the response headers.
	const timeoutMs = 300_000;
	let res;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) {
			console.error(`[bundle-release] download failed: ${url} (HTTP ${res.status})`);
			process.exit(1);
		}
		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		const reason = err.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : (err.cause?.message ?? err.message);
		console.error(`[bundle-release] download failed: ${url} (${reason})`);
		process.exit(1);
	}
}
