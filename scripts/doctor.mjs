#!/usr/bin/env node
// Environment check for every exxperts install type: verifies the things that
// actually bite new setups and prints the fix for anything missing.
//
//   exxperts doctor [--profile <clone|global|archive>]
//   npm run doctor          (from a clone; same as --profile clone)
//
// Install types (auto-detected, overridable with --profile):
//   archive  prebuilt release archive (app/ next to vendor/node/)
//   global   the packed npm package installed under an npm prefix
//   clone    a git checkout (developers); gets the repo-specific checks too
//
// Exit code contract (CI depends on this): exit 0 when everything REQUIRED is
// healthy; optional layers (headless Chromium, web search, bash for the rooms
// shell tool, MCP connectors) print as warnings with their one-command fix and
// never fail the run. Network probes (outbound fetch decode) are warnings too,
// not failures: offline machines are a valid state. Nonzero only for genuinely
// broken required things (Node too old, unwritable state dirs, a clone with
// missing deps or an unbuilt runtime, a broken vendored node).
//
// Runs with plain node so it works even when `npm install` has not completed,
// every check degrades to a ✗ or ! with instructions instead of crashing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

// --- Install-type detection ---------------------------------------------------
// clone: a .git dir at root; checked FIRST because a clone is authoritative
// (archives and npm-global installs never ship .git), which keeps a clone that
// happens to sit under a node_modules-containing path, or next to a stray
// vendor/node dir, from being misclassified. archive: the packed package lives
// in <base>/exxperts/app with the vendored runtime as a sibling
// (<base>/exxperts/vendor/node); that sibling is the distinguishing artifact.
// global: the package sits under some node_modules of an npm prefix.
function detectProfile() {
	if (fs.existsSync(path.join(root, ".git"))) return "clone";
	if (fs.existsSync(path.join(root, "..", "vendor", "node"))) return "archive";
	if (root.split(path.sep).includes("node_modules")) return "global";
	return "clone";
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(`Usage: exxperts doctor [--profile <clone|global|archive>]

Health check for any exxperts install. Auto-detects the install type (git
clone, npm-global package, or prebuilt archive) and runs the checks that
apply: Node runtime, ~/.exxperts state dirs, disk space, install-type
specifics, the optional layers (headless Chromium, web search, bash for the
rooms shell tool, MCP connectors; warnings only), and outbound network.
--profile overrides the auto-detected install type. Exit 0 when everything
required is healthy; warnings never fail the run.`);
	process.exit(0);
}
let profile = null;
{
	const at = argv.indexOf("--profile");
	if (at !== -1) profile = argv[at + 1] ?? "";
	if (profile !== null && !["clone", "global", "archive"].includes(profile)) {
		console.error(`Usage: exxperts doctor [--profile <clone|global|archive>]`);
		process.exit(2);
	}
}
const profileForced = profile !== null;
profile = profile ?? detectProfile();
const isClone = profile === "clone";

let failures = 0;
let warnings = 0;
const ok = (label, detail = "") => console.log(`  ✓ ${label}${detail ? ` - ${detail}` : ""}`);
const bad = (label, fix) => {
	failures++;
	console.log(`  ✗ ${label}`);
	if (fix) console.log(`      fix: ${fix}`);
};
const warn = (label, hint) => {
	warnings++;
	console.log(`  ! ${label}`);
	if (hint) console.log(`      ${hint}`);
};
const section = (title) => console.log(`\n${title}`);

const isWindows = process.platform === "win32";

// npm version: only meaningful for the clone workflow. Under `npm run doctor`
// the parent npm always sets npm_config_user_agent; fall back to spawning npm
// when run directly.
const npmVersion = isClone
	? (() => {
		const agentMatch = (process.env.npm_config_user_agent ?? "").match(/\bnpm\/(\d+[^ ]*)/);
		if (agentMatch) return agentMatch[1];
		const probe = spawnSync("npm", ["--version"], { encoding: "utf8", shell: isWindows, timeout: 15_000 });
		return (probe.stdout ?? "").trim() || null;
	})()
	: null;

// Environment header: the npm-gates week was debugged from screenshots, so
// doctor's output alone should identify the environment.
{
	const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]
		.filter((name) => process.env[name])
		.map((name) => `${name}=${process.env[name]}`);
	const profileLabel = {
		clone: "clone (git checkout, source install)",
		global: "global (npm package under an npm prefix)",
		archive: "archive (prebuilt release, vendored Node)",
	}[profile];
	console.log("exxperts doctor");
	console.log(`  install type: ${profileLabel}`);
	console.log(`  root: ${root}`);
	console.log(`  node ${process.version}${isClone ? ` | npm ${npmVersion ?? "(not detected)"}` : ""} | ${process.platform} ${process.arch}`);
	console.log(`  proxy: ${proxyVars.length ? proxyVars.join(" ") : "no proxy environment variables set"}`);
}

// fetch failures wrap the interesting code one or two levels deep (TypeError →
// cause, which is an AggregateError when a host resolves to several addresses).
const fetchErrorCode = (e) => e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.code ?? e.cause?.message ?? e.name;

section("Runtime and state");

// --- Node version -----------------------------------------------------------
{
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
	const required = String(pkg.engines?.node ?? ">=20.6.0").replace(/[^\d.]/g, "");
	const [reqMajor, reqMinor = 0] = required.split(".").map(Number);
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major > reqMajor || (major === reqMajor && minor >= reqMinor)) {
		ok(`Node ${process.version}`, `requires >=${required} (${process.execPath})`);
	} else {
		bad(`Node ${process.version} is older than the required >=${required}`, "install a newer Node (https://nodejs.org) and re-run the install");
	}
}

// --- ~/.exxperts state dirs (report only: the app creates them on first run) --
{
	const stateRoot = path.join(os.homedir(), ".exxperts");
	const dirs = [stateRoot, path.join(stateRoot, "app"), path.join(stateRoot, "agent")].filter((p) => fs.existsSync(p));
	if (dirs.length === 0) {
		ok("~/.exxperts state not created yet", "the first run creates it");
	} else {
		const blocked = dirs.filter((p) => {
			try {
				fs.accessSync(p, fs.constants.W_OK);
				return false;
			} catch {
				return true;
			}
		});
		if (blocked.length === 0) {
			ok(`~/.exxperts state dirs writable (${dirs.map((p) => path.relative(os.homedir(), p)).join(", ")})`);
		} else {
			bad(
				`state dirs not writable by this user: ${blocked.join(", ")} (usually left behind by a sudo'd run)`,
				`take them back: sudo chown -R "$(id -un)" "${stateRoot}"`,
			);
		}
	}
}

// --- Disk space ------------------------------------------------------------------
{
	try {
		const stat = fs.statfsSync(root);
		const freeBytes = stat.bavail * stat.bsize;
		const freeGB = freeBytes / 1024 ** 3;
		if (freeGB < 1) {
			bad(
				`only ${freeGB.toFixed(1)} GB free on this disk; installs and updates need about 3 GB and will die mid-way`,
				"free up disk space, then re-run the install",
			);
		} else if (freeGB < 3) {
			warn(`only ${freeGB.toFixed(1)} GB free on this disk; a full install/update uses about 3 GB`);
		} else {
			ok(`disk space (${freeGB.toFixed(0)} GB free)`);
		}
	} catch {
		// statfs unavailable on this platform/filesystem; not worth failing over
	}
}

// --- Profile-specific checks ---------------------------------------------------

if (profile === "archive") {
	section("Prebuilt archive install");
	// vendor/node is the runtime the shim launches; prove it actually executes.
	const vendorDir = path.join(root, "..", "vendor", "node");
	const vendorNode = path.join(vendorDir, ...(isWindows ? ["node.exe"] : ["bin", "node"]));
	if (!fs.existsSync(vendorDir)) {
		// A real archive install always has this directory (it is how the archive
		// profile is detected); its absence means someone forced --profile archive
		// on a different tree, which is a diagnostic override, not a broken install.
		warn(`no vendor/node directory next to the app root (expected ${vendorDir}); this tree does not look like an archive install`);
	} else if (fs.existsSync(vendorNode)) {
		const res = spawnSync(vendorNode, ["--version"], { encoding: "utf8", timeout: 15_000 });
		const version = (res.stdout ?? "").trim();
		if (res.status === 0 && version) {
			ok(`vendored Node runtime works (${version})`, vendorNode);
		} else {
			bad(`vendored Node at ${vendorNode} failed to run (${res.error?.code ?? `exit ${res.status}`})`, "re-run the one-line installer to repair the install");
		}
	} else if (profileForced) {
		bad(`vendored Node runtime missing (expected ${vendorNode})`, "re-run the one-line installer to repair the install");
	} else {
		// Auto-detected archive from a vendor/node SIBLING dir alone: a stray
		// vendor/node next to a non-archive tree can land here, so a missing node
		// binary is a detection doubt, not proof of a broken install. A vendored
		// node that exists but fails to run (above) stays a hard failure.
		warn(
			`vendored Node runtime missing (expected ${vendorNode}); this may not actually be an archive install`,
			"if it is one, re-run the one-line installer to repair it; otherwise re-run with --profile <clone|global>",
		);
	}
	ok("updates", "re-run the one-line installer; it replaces this install in place");
}

if (profile === "global") {
	section("Global npm install");
	ok("installed at", root);
	ok("updates", "re-run the one-line installer (migrates to the prebuilt archive install), or from a clone: git pull && npm run install:global");
}

if (isClone) {
	section("Clone (source install)");

	// --- npm / Node compatibility ---------------------------------------------------
	// npm 12 refuses to run on Node outside its engines range (^22.22.2 || ^24.15.0
	// || >=26) and hard-fails mid-install. The one-line installers preflight this;
	// the manual install path and later updates land here instead.
	if (npmVersion) {
		const npmMajor = Number(npmVersion.split(".")[0]);
		const [major, minor, patch] = process.versions.node.split(".").map(Number);
		if (npmMajor >= 12) {
			const nodeOk = major >= 26
				|| (major === 24 && minor >= 15)
				|| (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)));
			if (nodeOk) {
				ok(`npm ${npmVersion} is compatible with this Node`);
			} else {
				bad(
					`npm ${npmVersion} requires Node 22.22.2+, 24.15+ (within 24.x), or 26+, but this is Node ${process.version}; npm will hard-fail mid-install`,
					"update Node from https://nodejs.org (or downgrade npm: npm install -g npm@11)",
				);
			}
		} else {
			ok(`npm ${npmVersion}`);
		}
	}

	// --- Clone owned by this user (a past sudo run leaves root-owned files) ----------
	{
		const probes = [root, path.join(root, ".git"), path.join(root, "node_modules")].filter((p) => fs.existsSync(p));
		const blocked = probes.filter((p) => {
			try {
				fs.accessSync(p, fs.constants.W_OK);
				return false;
			} catch {
				return true;
			}
		});
		if (blocked.length === 0) {
			ok("clone is writable by this user");
		} else {
			bad(
				`not writable by this user: ${blocked.join(", ")} (usually left behind by a sudo'd install)`,
				`take the clone back: sudo chown -R "$(id -un)" "${root}"  then re-run the install without sudo`,
			);
		}
	}

	// --- Global npm prefix writable (final `npm install -g` step) --------------------
	if (!isWindows) {
		const prefixRes = spawnSync("npm", ["config", "get", "prefix"], { encoding: "utf8", timeout: 15_000 });
		const prefix = prefixRes.status === 0 ? (prefixRes.stdout ?? "").trim() : "";
		if (prefix) {
			const probe = [path.join(prefix, "lib", "node_modules"), path.join(prefix, "lib"), prefix].find((p) => fs.existsSync(p));
			let writable = true;
			if (probe) {
				try {
					fs.accessSync(probe, fs.constants.W_OK);
				} catch {
					writable = false;
				}
			}
			if (writable) {
				ok(`global npm prefix writable (${prefix})`);
			} else {
				bad(
					`npm's global prefix (${prefix}) is not writable, so "npm install -g" will fail with EACCES; do NOT use sudo`,
					"switch npm to a user-level prefix (mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global, add ~/.npm-global/bin to PATH); details: docs/packaging-local.md",
				);
			}
		}
	}

	// --- Git long paths (Windows: node_modules trees exceed MAX_PATH) ----------------
	if (isWindows) {
		const res = spawnSync("git", ["-C", root, "config", "--get", "core.longpaths"], { encoding: "utf8", shell: true, timeout: 15_000 });
		if ((res.stdout ?? "").trim() === "true") {
			ok("git core.longpaths enabled in this clone");
		} else {
			warn(
				"git core.longpaths is not enabled in this clone; deep node_modules paths can exceed Windows' 260-character limit",
				"run: git config core.longpaths true  (from this folder)",
			);
		}
	}
}

// --- Dependencies installed (clone; the packed installs ship node_modules) ------
let depsInstalled = true;
if (isClone) {
	const probes = ["undici", "jsdom", "typebox", "tsx"];
	const missing = probes.filter((name) => {
		try {
			require.resolve(name);
			return false;
		} catch {
			return true;
		}
	});
	if (missing.length === 0) {
		ok("npm dependencies installed");
	} else {
		depsInstalled = false;
		bad(`npm dependencies missing (${missing.join(", ")})`, "run `npm install` from the repo root");
	}
}

// --- xlsx (the one dependency fetched from cdn.sheetjs.com, not the npm registry;
// corporate proxies that block that host make npm install fail on exactly this) ---
if (isClone) {
	let xlsxInstalled = true;
	try {
		require.resolve("xlsx");
	} catch {
		xlsxInstalled = false;
	}
	if (xlsxInstalled) {
		ok("xlsx installed (spreadsheet support)");
	} else if (depsInstalled) {
		let cdnReachable = false;
		try {
			const res = await fetch("https://cdn.sheetjs.com/", { method: "HEAD", signal: AbortSignal.timeout(10_000) });
			cdnReachable = res.status > 0;
		} catch {
			cdnReachable = false;
		}
		if (cdnReachable) {
			bad("xlsx is missing although other dependencies installed", "run `npm install` from the repo root");
		} else {
			bad(
				"xlsx is missing and https://cdn.sheetjs.com is not reachable from here; xlsx is the one dependency that comes from that CDN instead of the npm registry, and this network (proxy/firewall) appears to block it",
				"ask IT to allow cdn.sheetjs.com, or run `npm install` once on a network that can reach it, then re-run the install",
			);
		}
	}
	// deps missing entirely: the dependencies check above already said "npm install"
}

// --- Runtime built (clone; the packed installs ship dist/) -----------------------
if (isClone) {
	const cliDist = path.join(root, "runtime", "packages", "coding-agent", "dist", "cli.js");
	if (fs.existsSync(cliDist)) {
		ok("runtime built (runtime/packages/coding-agent/dist)");
	} else {
		bad("runtime not built, the server and CLI will not start", "run `npm run build` from the repo root");
	}
}

section("Optional features");

// --- Headless Chromium (fetch_url JS rendering + deck visual review) ----------
// Presence check on the per-user Playwright browser cache, not a playwright
// import: it works identically on all install types and without node_modules.
// Warning-only by design; note a stale cached revision (Playwright bumped its
// pinned Chromium since the last download) can still false-positive here,
// which is acceptable at warn level.
{
	if (process.env.PLAYWRIGHT_BROWSERS_PATH === "0") {
		// The documented sentinel value: Playwright manages browsers inside the
		// package's own node_modules tree, not a directory literally named "0".
		ok("headless Chromium: PLAYWRIGHT_BROWSERS_PATH=0, Playwright manages browsers inside node_modules");
	} else {
		const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH
			|| (isWindows
				? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright")
				: process.platform === "darwin"
					? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
					: path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright"));
		let found = false;
		try {
			// chromium* also matches chromium_headless_shell-<rev>, which is what
			// newer Playwright downloads for headless-only use.
			found = fs.readdirSync(cacheDir).some((name) => name.startsWith("chromium"));
		} catch {
			found = false;
		}
		if (found) {
			ok("headless Chromium installed (JS-rendered pages, HTML deck review)", cacheDir);
		} else {
			warn(
				"headless Chromium not installed; fetch_url cannot render JavaScript-heavy pages and HTML decks skip visual review",
				"optional: run `exxperts setup chromium` (~150 MB one-time download into the per-user Playwright cache)",
			);
		}
	}
}

// --- Web search (SearXNG in a local container) -----------------------------------
{
	let provider = String(process.env.EXXETA_SEARCH_PROVIDER ?? "").trim();
	let baseUrl = String(process.env.EXXETA_SEARCH_BASE_URL ?? "").trim();
	try {
		const shared = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".exxperts", "app", "web-search.json"), "utf-8"));
		provider = provider || String(shared.provider ?? "");
		baseUrl = baseUrl || String(shared.baseUrl ?? "");
	} catch {
		// unconfigured is a valid state
	}
	// One source of truth with `exxperts setup search`: spawn searxng.mjs (a CLI
	// script, so spawn it rather than import it) and interpret its `status` line.
	// Its resolveDocker() knows the OrbStack/Docker Desktop off-PATH install
	// locations that a bare which/where docker probe misses.
	const containerName = process.env.SEARXNG_CONTAINER_NAME || "exxperts-searxng";
	const searxngProbe = spawnSync(process.execPath, [path.join(root, "scripts", "searxng.mjs"), "status"], { encoding: "utf8", timeout: 15_000 });
	const statusLine = (searxngProbe.stdout ?? "").trim();
	const dockerFound = !searxngProbe.error && searxngProbe.status === 0 && statusLine !== "" && !statusLine.startsWith("docker unavailable");
	const containerRunning = dockerFound && statusLine.startsWith("running");
	if (provider === "searxng") {
		let reachable = false;
		let detail = "";
		try {
			const res = await fetch(new URL("/search?q=ping&format=json", baseUrl), { signal: AbortSignal.timeout(5000) });
			reachable = res.ok;
			detail = res.ok ? "" : `HTTP ${res.status}`;
		} catch (e) {
			detail = String(fetchErrorCode(e));
		}
		if (reachable) {
			ok("web search (SearXNG) reachable", baseUrl);
		} else {
			warn(
				`web search configured but SearXNG is not answering at ${baseUrl} (${detail})`,
				"run `exxperts setup search` and make sure the container engine (Docker Desktop/OrbStack) is running",
			);
		}
	} else if (!dockerFound) {
		warn(
			"web search not set up (rooms cannot search the web); no working docker (not installed, or the engine is not running)",
			"optional: web search needs Docker Desktop or OrbStack installed and running, then run `exxperts setup search`",
		);
	} else if (containerRunning) {
		warn(
			`web search not configured although the ${containerName} container is running`,
			"run `exxperts setup search` to write the config, then restart the app",
		);
	} else {
		warn(
			"web search not set up (rooms cannot search the web)",
			"optional: run `exxperts setup search` (one-time local SearXNG container via Docker)",
		);
	}
}

// --- bash / shell for the rooms shell tool (warning-only) -------------------------
// Needed only for the rooms' shell tool and for source installs; the product
// itself runs fine without it.
if (isWindows) {
	// Same discovery as install.ps1 and the runtime shell resolvers: Git's
	// recommended setup puts git.exe on PATH but never bash.exe, and no-admin
	// (per-user) installs live under AppData, not Program Files - so derive bash
	// from git's own install root first, then check the standard locations.
	let bashPath = null;
	{
		// <install root>\cmd\git.exe -> <install root>\bin\bash.exe
		const where = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", timeout: 15_000 });
		const gitPath = (where.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
		if (gitPath) {
			const derived = path.join(path.dirname(path.dirname(gitPath)), "bin", "bash.exe");
			if (fs.existsSync(derived)) bashPath = derived;
		}
	}
	if (!bashPath) {
		const candidates = [
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
			process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
			process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
		].filter(Boolean);
		bashPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
	}
	if (!bashPath) {
		for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
			if (dir && fs.existsSync(path.join(dir, "bash.exe"))) {
				bashPath = path.join(dir, "bash.exe");
				break;
			}
		}
	}
	if (bashPath) {
		ok("bash found (rooms shell tool)", bashPath);
	} else {
		warn(
			"bash not found (needed only for the rooms' shell tool and source installs)",
			"install Git for Windows (https://gitforwindows.org; no admin rights needed, per-user install works); a WSL bash on PATH also works, shell commands then run inside the WSL Linux environment",
		);
	}
} else {
	const probe = spawnSync("which", ["bash"], { encoding: "utf8", timeout: 15_000 });
	const bashPath = probe.status === 0 ? (probe.stdout ?? "").trim() : "";
	if (bashPath) {
		ok("bash found (rooms shell tool)", bashPath);
	} else {
		warn("bash not found (needed only for the rooms' shell tool and source installs)", "install bash via your system package manager");
	}
}

// --- MCP config (optional) ------------------------------------------------------
{
	// process.cwd() can fail (EPERM in sandboxes, deleted directories); the
	// project-local .mcp.json is then simply skipped.
	const cwd = (() => {
		try {
			return process.cwd();
		} catch {
			return null;
		}
	})();
	const files = [
		path.join(os.homedir(), ".config", "mcp", "mcp.json"),
		path.join(os.homedir(), ".exxperts", "agent", "mcp.json"),
		...(cwd ? [path.join(cwd, ".mcp.json")] : []),
	];
	const servers = new Set();
	for (const file of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
			for (const name of Object.keys(parsed.mcpServers ?? parsed.servers ?? {})) servers.add(name);
		} catch {
			// missing or malformed files are fine; MCP is optional
		}
	}
	if (servers.size > 0) ok(`MCP servers configured (${[...servers].join(", ")})`);
	else warn("no MCP servers configured (rooms have no external connectors)", "optional: see docs/mcp.md");
}

section("Network");

// --- Outbound fetch sanity (proxy / TLS-inspection corruption) -----------------
// Warning-only: an offline machine is a valid state and must not fail doctor.
{
	const looksGarbled = (text) => {
		const sample = text.slice(0, 4000);
		if (sample.length < 64) return false;
		let junk = 0;
		for (const ch of sample) {
			const code = ch.codePointAt(0) ?? 0;
			if (ch === "�" || (code < 32 && code !== 9 && code !== 10 && code !== 13)) junk++;
		}
		return junk / sample.length > 0.1;
	};
	try {
		const res = await fetch("https://example.com/", {
			headers: { "accept-encoding": "gzip, deflate, br" },
			signal: AbortSignal.timeout(10_000),
		});
		const text = await res.text();
		if (!res.ok) {
			warn(`outbound fetch check: https://example.com answered HTTP ${res.status}`);
		} else if (looksGarbled(text) || !/<html/i.test(text)) {
			warn(
				"outbound web responses come back corrupted; a proxy or TLS-inspection layer on this network is likely mangling compressed responses",
				"try off VPN / a different network, or ask IT about the TLS-inspection proxy; the headless-browser fallback may work around it",
			);
		} else {
			ok("outbound web fetch decodes cleanly");
		}
	} catch (e) {
		warn(`outbound web fetch failed (${fetchErrorCode(e)}); rooms cannot reach the internet from here`, "check your network/proxy settings (on an offline machine this is expected)");
	}
}

console.log("");
if (failures > 0) {
	console.log(`${failures} problem(s) found${warnings ? `, ${warnings} warning(s)` : ""}.`);
	// Not process.exit(): a hard exit races undici's handle teardown after a
	// failed fetch and crashes libuv on Windows (UV_HANDLE_CLOSING assertion).
	process.exitCode = 1;
} else {
	console.log(`All required checks passed${warnings ? ` (${warnings} warning(s) / optional feature(s) not set up)` : ""}.`);
}
