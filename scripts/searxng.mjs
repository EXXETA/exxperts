#!/usr/bin/env node
// Local SearXNG helper for exxperts web_search.
//
// Cross-platform Node port of the original bash helper so Windows users can run
// it from PowerShell or cmd (`node scripts/searxng.mjs start`). The bash entry
// point `./scripts/searxng` remains as a thin shim for mac/Linux/Git Bash.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = process.env.SEARXNG_CONTAINER_NAME || "exxperts-searxng";
const PORT = process.env.SEARXNG_PORT || "8888";
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Pinned by digest for reproducibility (avoid mutable :latest). To update:
//   docker pull searxng/searxng:latest
//   docker inspect --format '{{index .RepoDigests 0}}' searxng/searxng:latest
// then paste the new digest here. Override with SEARXNG_IMAGE if needed.
const IMAGE = process.env.SEARXNG_IMAGE || "searxng/searxng@sha256:cb6d9bdb1ffa3937c5959dd576fbbc80d3dbb13ca6d1b2c8b8ca5f49e9dfb9c7";
const CONFIG_DIR = path.join(os.homedir(), ".exxperts", "app", "searxng");
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.yml");

const isWindows = process.platform === "win32";
// How to invoke this helper, for messages — shell-appropriate per platform.
// When bin/exxperts.cjs intercepts `exxperts setup search` it sets
// EXXPERTS_SETUP=1 in this child's env; messages then name the product command
// the user actually typed instead of repo-script paths that only exist in a
// source checkout. Direct invocations keep the repo-script form.
const SELF = process.env.EXXPERTS_SETUP === "1"
	? "exxperts setup search"
	: isWindows ? "node scripts\\searxng.mjs" : "./scripts/searxng";

// If `docker` isn't on PATH yet (common right after installing OrbStack/Docker
// Desktop in an already-open terminal), look in the standard install locations
// so the user doesn't have to open a fresh shell first.
function resolveDocker() {
	const probe = spawnSync(isWindows ? "where" : "which", ["docker"], { stdio: "ignore" });
	if (probe.status === 0) return "docker";
	const candidates = isWindows
		? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe")]
		: [
			path.join(os.homedir(), ".orbstack", "bin", "docker"),
			path.join(os.homedir(), ".docker", "bin", "docker"),
			"/Applications/Docker.app/Contents/Resources/bin/docker",
			"/usr/local/bin/docker",
		];
	return candidates.find((c) => fs.existsSync(c)) ?? null;
}
const DOCKER = resolveDocker();

function docker(...args) {
	return spawnSync(DOCKER, args, { encoding: "utf8" });
}

function usage(log = console.log) {
	log(`Usage: ${SELF} <start|stop|restart|status|url>

Starts a local SearXNG Docker container for exxperts web_search, writes generated
SearXNG settings to ~/.exxperts/app/searxng/settings.yml, and writes the shared
web-search config to ~/.exxperts/app/web-search.json (read by both the global
\`exxperts\` command and the repo scripts). Just run \`start\`, then restart the app.

Environment:
  SEARXNG_PORT            Host port, default: 8888
  SEARXNG_CONTAINER_NAME  Container name, default: exxperts-searxng`);
}

const dockerRunning = () => docker("info").status === 0;

// Distinguish "Docker not installed" from "installed but daemon down", since the
// fix differs: install an engine vs. just start it. Docker is a one-time system
// prerequisite (like Node) — it cannot ship as an exxperts dependency.
function requireDocker() {
	if (!DOCKER) {
		const engines = isWindows
			? "  Docker Desktop             https://www.docker.com/products/docker-desktop/"
			: "  Docker Desktop             https://www.docker.com/products/docker-desktop/\n  OrbStack (lighter, macOS)  https://orbstack.dev";
		console.error(`Docker is not installed. SearXNG runs in a container, so you need a container
engine first (one-time setup, like installing Node):
${engines}
Install one, start it, then re-run: ${SELF} start`);
		process.exit(1);
	}
	if (!dockerRunning()) {
		console.error(`Docker is installed but not running. Start Docker${isWindows ? " Desktop" : " (or OrbStack)"} and retry.`);
		process.exit(1);
	}
}

const listNames = (args) => docker(...args, "--format", "{{.Names}}").stdout?.split(/\r?\n/) ?? [];
const containerExists = () => listNames(["ps", "-a"]).includes(NAME);
const containerRunning = () => listNames(["ps"]).includes(NAME);

function ensureSettings() {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	if (fs.existsSync(SETTINGS_FILE)) return;
	const secret = crypto.randomBytes(32).toString("hex");
	fs.writeFileSync(SETTINGS_FILE, `use_default_settings: true

server:
  secret_key: "${secret}"
  limiter: false
  public_instance: false

search:
  formats:
    - html
    - json
`);
}

async function waitUntilReady() {
	const url = `${BASE_URL}/search?q=exxperts&format=json`;
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return true;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
}

// Write the web-search config into the shared product app state dir
// (~/.exxperts/app) so the user does not have to hand-edit anything. Both the
// global `exxperts` command and the repo `./scripts/exxperts-cli` read this same file,
// and it survives reinstalls. Non-destructive: if a config already exists it is
// left as-is.
function ensureSearchConfig() {
	const cfgDir = path.join(os.homedir(), ".exxperts", "app");
	const cfgFile = path.join(cfgDir, "web-search.json");
	fs.mkdirSync(cfgDir, { recursive: true });
	if (fs.existsSync(cfgFile)) {
		console.log(`Web-search config already present at ${cfgFile} — left as-is.`);
		console.log(`  (If search is still off, check it points at ${BASE_URL}.)`);
	} else {
		fs.writeFileSync(cfgFile, JSON.stringify({ provider: "searxng", baseUrl: BASE_URL }, null, 2) + "\n");
		console.log(`Configured web search at ${cfgFile} (provider=searxng, baseUrl=${BASE_URL}).`);
	}
	console.log("Restart the app (exxperts web, exxperts cli, ./scripts/exxperts-web, or ./scripts/exxperts-cli) to pick it up.");
	console.log("");
	const engine = isWindows ? "Docker Desktop" : "OrbStack/Docker";
	console.log(`Tip: enable "Start at login" in ${engine} so search keeps working`);
	console.log("     after a reboot — the container restarts automatically with the engine.");
	console.log("     If search ever stops, the engine is probably not running: open it and");
	console.log(`     check with ${SELF} status.`);
}

async function start() {
	requireDocker();
	ensureSettings();
	if (containerRunning()) {
		console.log(`SearXNG already running at ${BASE_URL}`);
		ensureSearchConfig();
		return;
	}
	if (containerExists()) {
		const res = docker("start", NAME);
		if (res.status !== 0) {
			console.error(res.stderr?.trim() || `docker start ${NAME} failed`);
			process.exit(1);
		}
	} else {
		const res = spawnSync(DOCKER, [
			"run", "-d",
			"--name", NAME,
			"--restart", "unless-stopped",
			"-p", `127.0.0.1:${PORT}:8080`,
			"-e", `SEARXNG_BASE_URL=${BASE_URL}/`,
			"-v", `${SETTINGS_FILE}:/etc/searxng/settings.yml:ro`,
			IMAGE,
		], { stdio: ["ignore", "ignore", "inherit"] });
		if (res.status !== 0) process.exit(1);
	}
	if (await waitUntilReady()) {
		console.log(`SearXNG ready at ${BASE_URL}`);
		ensureSearchConfig();
	} else {
		console.error("SearXNG container started, but the JSON search endpoint did not become ready in time.");
		console.error(`Check logs with: docker logs ${NAME}`);
		process.exit(1);
	}
}

function stop() {
	requireDocker();
	if (containerRunning()) {
		docker("stop", NAME);
		console.log("SearXNG stopped.");
	} else {
		console.log("SearXNG is not running.");
	}
}

function status() {
	if (!DOCKER || !dockerRunning()) {
		console.log(`docker unavailable ${BASE_URL}`);
		return;
	}
	if (containerRunning()) console.log(`running ${BASE_URL}`);
	else if (containerExists()) console.log(`stopped ${BASE_URL}`);
	else console.log(`not installed ${BASE_URL}`);
}

const cmd = process.argv[2] ?? "";
switch (cmd) {
	case "start": await start(); break;
	case "stop": stop(); break;
	case "restart": stop(); await start(); break;
	case "status": status(); break;
	case "url": console.log(BASE_URL); break;
	case "--help": case "-h": case "": usage(); break;
	default:
		console.error(`Unknown command: ${cmd}`);
		usage(console.error);
		process.exit(2);
}
