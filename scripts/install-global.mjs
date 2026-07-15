#!/usr/bin/env node
// One-command packaged install: build → pack → npm install -g <exact tarball>.
//
//   npm run install:global
//
// Exists so the packaged install is a single command on every platform — the
// manual `npm install -g ./exxeta-exxperts-app-*.tgz` relies on shell glob
// expansion, which PowerShell/cmd don't do. Manual steps stay documented in
// docs/packaging-local.md.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// npm is npm.cmd on Windows; a shell is required to spawn it there.
const shell = process.platform === "win32";

function run(args, opts = {}) {
	const res = spawnSync("npm", args, { cwd: root, stdio: "inherit", shell, ...opts });
	if (res.status !== 0) process.exit(res.status ?? 1);
	return res;
}

// Fail fast when the final `npm install -g` would need sudo (system-wide Node
// installs own /usr/local), BEFORE minutes of building. Guides to the
// supported fix instead of letting people reach for sudo, which runs build
// scripts as root and leaves root-owned files in the clone.
if (process.platform !== "win32") {
	const prefixRes = spawnSync("npm", ["config", "get", "prefix"], { cwd: root, encoding: "utf8", shell });
	const prefix = prefixRes.status === 0 ? prefixRes.stdout.trim() : "";
	if (prefix) {
		const probe = [path.join(prefix, "lib", "node_modules"), path.join(prefix, "lib"), prefix].find((p) => fs.existsSync(p));
		let writable = true;
		if (probe) {
			try { fs.accessSync(probe, fs.constants.W_OK); } catch { writable = false; }
		}
		if (!writable) {
			console.error(`[exxperts] npm's global prefix (${prefix}) is not writable by your user, so the
[exxperts] final "npm install -g" step would fail with EACCES. Please do NOT
[exxperts] rerun with sudo: that runs build scripts as root and leaves
[exxperts] root-owned files in this clone that break future updates.
[exxperts]
[exxperts] One-time fix — switch npm to a user-level prefix:
[exxperts]
[exxperts]   mkdir -p ~/.npm-global
[exxperts]   npm config set prefix ~/.npm-global
[exxperts]   echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
[exxperts]   source ~/.zshrc          # bash: use ~/.bashrc or ~/.bash_profile
[exxperts]   npm run install:global
[exxperts]
[exxperts] Details: docs/packaging-local.md`);
			process.exit(1);
		}
	}
}

// Windows locks files a running app holds open, so replacing the global
// install fails with EBUSY halfway through. Probe the exact operation that
// breaks (a rename round-trip of the installed dir) BEFORE minutes of
// building, and name the real fix: close exxperts first.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (process.platform === "win32") {
	const prefixProbeEarly = spawnSync("npm", ["config", "get", "prefix"], { cwd: root, encoding: "utf8", shell });
	const prefixEarly = prefixProbeEarly.status === 0 ? (prefixProbeEarly.stdout ?? "").trim() : "";
	const installedRootEarly = prefixEarly ? path.join(prefixEarly, "node_modules", pkg.name) : "";
	if (installedRootEarly && fs.existsSync(installedRootEarly)) {
		const probeTarget = `${installedRootEarly}.update-probe`;
		let renamedAway = false;
		try {
			fs.renameSync(installedRootEarly, probeTarget);
			renamedAway = true;
			fs.renameSync(probeTarget, installedRootEarly);
			renamedAway = false;
		} catch {
			if (renamedAway) {
				// The round-trip half-failed; put the installed app back before erroring.
				try { fs.renameSync(probeTarget, installedRootEarly); renamedAway = false; } catch {}
			}
			if (renamedAway) {
				console.error(`[exxperts] the installed app could not be restored after an update probe.
[exxperts] Rename "${probeTarget}" back to "${installedRootEarly}" by hand, then re-run this command.`);
			} else {
				console.error(`[exxperts] the installed app at ${installedRootEarly}
[exxperts] is locked, which usually means exxperts is still running.
[exxperts] Close the exxperts app and any terminal running it, then re-run this command.
[exxperts] If it keeps failing with exxperts closed, an antivirus may be scanning that
[exxperts] folder; add an exclusion and re-run.`);
			}
			process.exit(1);
		}
	}
}

console.log("[exxperts] building…");
run(["run", "build"]);

console.log("[exxperts] packing…");
const pack = spawnSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", shell });
if (pack.status !== 0) {
	process.stderr.write(pack.stderr ?? "");
	process.exit(pack.status ?? 1);
}
// npm <=11 prints an array of pack reports; npm 12 prints an object keyed by
// package name. Accept both.
const packReport = JSON.parse(pack.stdout);
const packEntry = Array.isArray(packReport) ? packReport[0] : Object.values(packReport ?? {})[0];
const filename = packEntry?.filename;
if (!filename) {
	console.error("[exxperts] npm pack did not report a tarball filename");
	process.exit(1);
}

// Replacing a large installed tree in place hits npm ENOTEMPTY/tar races on
// Windows; uninstalling first is reliable there and harmless elsewhere.
console.log("[exxperts] removing any previous global install…");
spawnSync("npm", ["uninstall", "-g", "@exxeta/exxperts-app"], { cwd: root, stdio: "inherit", shell });

console.log(`[exxperts] installing ${filename} globally…`);
// npm reads neither the project .npmrc nor package.json allowScripts in
// global mode, so npm 12's gates need explicit flags on this one step:
// allow-remote for the SheetJS CDN tarball (root scoping cannot apply here,
// the tarball itself is the root so xlsx counts as non-root) and
// allow-scripts so the package's own postinstall and native deps still run.
// allow-scripts name entries only match registry deps; a local tarball is
// matched by its exact path, so the tarball path itself must be an entry or
// the package's own postinstall is silently skipped.
// Version detection: under `npm run`, the parent npm always sets
// npm_config_user_agent ("npm/12.0.1 node/…"), which survives shell and PATH
// differences that a spawned `npm --version` may not.
function detectNpm() {
	const agentMatch = (process.env.npm_config_user_agent ?? "").match(/\bnpm\/(\d+[^ ]*)/);
	if (agentMatch) return agentMatch[1];
	const probe = spawnSync("npm", ["--version"], { cwd: root, encoding: "utf8", shell });
	return (probe.stdout ?? "").trim();
}
// The gates ship in npm >= 11.14 as well as npm 12 (a live install on
// 11.16 taught us that), so the allow settings are passed UNCONDITIONALLY:
// npms without the gates accept the unknown config with at worst a warning
// (verified on 10.9 and 11.11), gated npms need it. CLI flags plus the same
// values via environment, so a shell layer dropping one leaves the other.
const npmVersionString = detectNpm();
const tarball = path.join(root, filename);
const scriptAllows = [tarball, pkg.name, ...Object.keys(pkg.allowScripts ?? {})];
const installArgs = ["install", "-g", tarball, "--allow-remote=all", ...scriptAllows.map((entry) => `--allow-scripts=${entry}`)];
const installEnv = { ...process.env, npm_config_allow_remote: "all", npm_config_allow_scripts: scriptAllows.join(",") };
console.log(`[exxperts] npm ${npmVersionString || "(version not detected)"}: allowing the tarball's remote dependency and install scripts for the global step`);
run(installArgs, { env: installEnv });

// npm's allow-scripts matching for a local tarball root is inconsistent
// across versions and platforms (npm 11.14+ on Windows skips the package's
// own postinstall no matter which entry form is passed, and npm runs it
// silently elsewhere), so the postinstall is run directly in the installed
// copy: the same two scripts the manifest names, both idempotent, no gate.
const prefixProbe = spawnSync("npm", ["config", "get", "prefix"], { cwd: root, encoding: "utf8", shell });
const globalPrefix = (prefixProbe.stdout ?? "").trim();
const installedRoot = process.platform === "win32"
	? path.join(globalPrefix, "node_modules", pkg.name)
	: path.join(globalPrefix, "lib", "node_modules", pkg.name);
if (globalPrefix && fs.existsSync(installedRoot)) {
	console.log("[exxperts] running the package postinstall in the installed copy…");
	for (const script of ["scripts/patch-mcp-adapter.mjs", "scripts/install-chromium.mjs"]) {
		const res = spawnSync(process.execPath, [path.join(installedRoot, script)], { cwd: installedRoot, stdio: "inherit" });
		if (res.status !== 0) {
			console.error(`[exxperts] ${script} failed in the installed copy; run "npm run doctor" from the clone to diagnose.`);
			process.exit(res.status ?? 1);
		}
	}
} else {
	console.error(`[exxperts] could not locate the installed copy under ${installedRoot} to run its postinstall`);
	process.exit(1);
}

console.log(`[exxperts] installed version ${pkg.version} (check anytime with: exxperts --version)`);
console.log("[exxperts] done — run: exxperts web  (web app)  or: exxperts cli  (CLI/TUI)");
