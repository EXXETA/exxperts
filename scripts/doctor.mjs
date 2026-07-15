#!/usr/bin/env node
// Environment check for a fresh exxperts clone: verifies the things that
// actually bite new setups and prints the fix for anything missing.
//
//   npm run doctor
//
// Runs with plain node so it works even when `npm install` has not completed —
// every check degrades to a ✗ with instructions instead of crashing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

let failures = 0;
let warnings = 0;
const ok = (label, detail = "") => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
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

// npm version: under `npm run doctor` the parent npm always sets
// npm_config_user_agent; fall back to spawning npm when run directly.
const npmVersion = (() => {
	const agentMatch = (process.env.npm_config_user_agent ?? "").match(/\bnpm\/(\d+[^ ]*)/);
	if (agentMatch) return agentMatch[1];
	const probe = spawnSync("npm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
	return (probe.stdout ?? "").trim() || null;
})();

// Environment header: the npm-gates week was debugged from screenshots, so
// doctor's output alone should identify the environment.
{
	const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]
		.filter((name) => process.env[name])
		.map((name) => `${name}=${process.env[name]}`);
	console.log("exxperts doctor");
	console.log(`  node ${process.version} | npm ${npmVersion ?? "(not detected)"} | ${process.platform} ${process.arch}`);
	console.log(`  proxy: ${proxyVars.length ? proxyVars.join(" ") : "no proxy environment variables set"}`);
	console.log("");
}

// fetch failures wrap the interesting code one or two levels deep (TypeError →
// cause, which is an AggregateError when a host resolves to several addresses).
const fetchErrorCode = (e) => e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.code ?? e.cause?.message ?? e.name;

const isWindows = process.platform === "win32";
const searxngStartHint = isWindows
	? "install Docker Desktop, then run `node scripts\\searxng.mjs start` (see docs/web-search.md)"
	: "run `./scripts/searxng start` (needs Docker/Podman)";

// --- Node version -----------------------------------------------------------
{
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
	const required = String(pkg.engines?.node ?? ">=20.6.0").replace(/[^\d.]/g, "");
	const [reqMajor, reqMinor = 0] = required.split(".").map(Number);
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major > reqMajor || (major === reqMajor && minor >= reqMinor)) {
		ok(`Node ${process.version}`, `requires >=${required}`);
	} else {
		bad(`Node ${process.version} is older than the required >=${required}`, "install a newer Node (https://nodejs.org) and re-run npm install");
	}
}

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
	const prefixRes = spawnSync("npm", ["config", "get", "prefix"], { encoding: "utf8" });
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
	const res = spawnSync("git", ["-C", root, "config", "--get", "core.longpaths"], { encoding: "utf8", shell: true });
	if ((res.stdout ?? "").trim() === "true") {
		ok("git core.longpaths enabled in this clone");
	} else {
		warn(
			"git core.longpaths is not enabled in this clone; deep node_modules paths can exceed Windows' 260-character limit",
			"run: git config core.longpaths true  (from this folder)",
		);
	}
}

// --- Git Bash (Windows only: the agent's shell tool runs through bash.exe) -----
// Same discovery as install.ps1 and the runtime shell resolvers: Git's
// recommended setup puts git.exe on PATH but never bash.exe, and no-admin
// (per-user) installs live under AppData, not Program Files - so derive bash
// from git's own install root first, then check the standard locations.
if (isWindows) {
	let bashPath = null;
	{
		// <install root>\cmd\git.exe -> <install root>\bin\bash.exe
		const where = spawnSync("where.exe", ["git.exe"], { encoding: "utf8" });
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
		ok("Git Bash found (agent shell)", bashPath);
	} else {
		bad(
			"Git Bash not found — the agent cannot run shell commands on Windows",
			"install Git for Windows (https://gitforwindows.org); no admin rights needed, its installer can install just for your user",
		);
	}
}

// --- Dependencies installed ---------------------------------------------------
let depsInstalled = true;
{
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
{
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

// --- Runtime built ------------------------------------------------------------
{
	const cliDist = path.join(root, "runtime", "packages", "coding-agent", "dist", "cli.js");
	if (fs.existsSync(cliDist)) {
		ok("runtime built (runtime/packages/coding-agent/dist)");
	} else {
		bad("runtime not built — the server and CLI will not start", "run `npm run build` from the repo root");
	}
}

// --- Headless Chromium (fetch_url JS rendering + deck visual review) ----------
{
	let found = false;
	if (depsInstalled) {
		try {
			const { chromium } = require("playwright");
			const exe = chromium.executablePath();
			found = Boolean(exe) && fs.existsSync(exe);
		} catch {
			found = false;
		}
	}
	if (found) {
		ok("headless Chromium installed (JS-rendered pages, HTML deck review)");
	} else {
		warn(
			"headless Chromium not installed — fetch_url cannot render JavaScript-heavy pages and HTML decks skip visual review",
			"optional: run `npx playwright install chromium` from the repo root (~150 MB, one time)",
		);
	}
}

// --- Web search (optional) -----------------------------------------------------
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
	if (provider !== "searxng") {
		warn("web search not configured — rooms cannot search the web", `optional: ${searxngStartHint}`);
	} else {
		try {
			const res = await fetch(new URL("/search?q=ping&format=json", baseUrl), { signal: AbortSignal.timeout(5000) });
			if (res.ok) ok("web search (SearXNG) reachable", baseUrl);
			else bad(`SearXNG at ${baseUrl} answered HTTP ${res.status}`, `${searxngStartHint} and make sure the container engine is running`);
		} catch (e) {
			bad(`SearXNG configured but not reachable at ${baseUrl} (${fetchErrorCode(e)})`, `${searxngStartHint} and make sure the container engine is running`);
		}
	}
}

// --- Outbound fetch sanity (proxy / TLS-inspection corruption) -----------------
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
			bad(
				"outbound web responses come back corrupted — a proxy or TLS-inspection layer on this network is likely mangling compressed responses",
				"try off VPN / a different network, or ask IT about the TLS-inspection proxy; the headless-browser fallback may work around it",
			);
		} else {
			ok("outbound web fetch decodes cleanly");
		}
	} catch (e) {
		bad(`outbound web fetch failed (${fetchErrorCode(e)}) — rooms cannot reach the internet`, "check your network/proxy settings");
	}
}

// --- MCP config (optional) ------------------------------------------------------
{
	const files = [
		path.join(os.homedir(), ".config", "mcp", "mcp.json"),
		path.join(os.homedir(), ".exxperts", "agent", "mcp.json"),
		path.join(process.cwd(), ".mcp.json"),
	];
	const servers = new Set();
	for (const file of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
			for (const name of Object.keys(parsed.mcpServers ?? parsed.servers ?? {})) servers.add(name);
		} catch {
			// missing or malformed files are fine — MCP is optional
		}
	}
	if (servers.size > 0) ok(`MCP servers configured (${[...servers].join(", ")})`);
	else warn("no MCP servers configured — rooms have no external connectors", "optional: see docs/mcp.md");
}

console.log("");
if (failures > 0) {
	console.log(`${failures} problem(s) found${warnings ? `, ${warnings} optional feature(s) not set up` : ""}.`);
	// Not process.exit(): a hard exit races undici's handle teardown after a
	// failed fetch and crashes libuv on Windows (UV_HANDLE_CLOSING assertion).
	process.exitCode = 1;
} else {
	console.log(`All required checks passed${warnings ? ` (${warnings} optional feature(s) not set up)` : ""}.`);
}
