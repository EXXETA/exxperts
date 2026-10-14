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
// Pinned by digest for reproducibility (avoid mutable :latest); this one is
// 2026.10.7-6671d89be. To update:
//   docker pull searxng/searxng:<tag>
//   docker inspect --format '{{index .RepoDigests 0}}' searxng/searxng:<tag>
// then paste the new digest here. Search sites keep changing their pages, so
// an old pin slowly returns nothing (2026.6.5 lost Google in July 2026). An
// existing container on an older image is replaced on its next start or
// update. Override with SEARXNG_IMAGE if needed. The registry is named so
// Podman does not have to ask which one to search.
const IMAGE = process.env.SEARXNG_IMAGE || "docker.io/searxng/searxng@sha256:cc026dbee25b864d7f9731957cd5ef36ba2e2d61abd2996d57f1b863483e7409";
// The exxperts state tree: EXXPERTS_STATE_HOME names the folder that holds it
// (a loaded data profile, a moved data folder), the login home when unset. The
// docker lookups below stay on the login home on purpose: OrbStack and Docker
// Desktop install into the person's home, not into the exxperts data.
function stateHome() {
	const fromEnv = process.env.EXXPERTS_STATE_HOME;
	if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
	return os.homedir();
}
const CONFIG_DIR = path.join(stateHome(), ".exxperts", "app", "searxng");
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.yml");
const SETTINGS_LABEL = "exxperts.searxng.settings";

const isWindows = process.platform === "win32";
// How to invoke this helper, for messages — shell-appropriate per platform.
// When bin/exxperts.cjs intercepts `exxperts setup search` it sets
// EXXPERTS_SETUP=1 in this child's env; messages then name the product command
// the user actually typed instead of repo-script paths that only exist in a
// source checkout. Direct invocations keep the repo-script form.
const SELF = process.env.EXXPERTS_SETUP === "1"
	? "exxperts setup search"
	: isWindows ? "node scripts\\searxng.mjs" : "./scripts/searxng";

// The container command: `docker` from any engine (Docker Desktop, OrbStack,
// Colima, Rancher Desktop), else `podman`, which takes the same commands. If it
// isn't on PATH (an app opened from the Dock never sees Homebrew's folder, and
// a terminal opened before the install has an old PATH), look in the standard
// install locations so the user doesn't have to do anything.
// SEARXNG_CONTAINER_CLI names the command outright.
function resolveDocker() {
	const named = process.env.SEARXNG_CONTAINER_CLI?.trim();
	if (named) return named;
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const engines = [
		{
			command: "docker",
			candidates: isWindows
				? [path.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe")]
				: [
					path.join(os.homedir(), ".orbstack", "bin", "docker"),
					path.join(os.homedir(), ".docker", "bin", "docker"),
					"/Applications/Docker.app/Contents/Resources/bin/docker",
					"/usr/local/bin/docker",
					"/opt/homebrew/bin/docker",
					path.join(os.homedir(), ".rd", "bin", "docker"),
				],
		},
		{
			command: "podman",
			candidates: isWindows
				? [path.join(programFiles, "RedHat", "Podman", "podman.exe")]
				: ["/opt/podman/bin/podman", "/opt/homebrew/bin/podman", "/usr/local/bin/podman"],
		},
	];
	for (const { command, candidates } of engines) {
		const probe = spawnSync(isWindows ? "where" : "which", [command], { stdio: "ignore" });
		if (probe.status === 0) return command;
		const found = candidates.find((c) => fs.existsSync(c));
		if (found) return found;
	}
	return null;
}
const DOCKER = resolveDocker();
const isPodman = DOCKER !== null && path.basename(DOCKER).toLowerCase().startsWith("podman");
// The engine command runs with its own folder on PATH: docker fetches registry
// logins through helpers installed next to it (docker-credential-osxkeychain),
// and an app opened from the Dock would not find them.
const ENGINE_ENV = DOCKER && path.isAbsolute(DOCKER)
	? { ...process.env, PATH: [path.dirname(DOCKER), process.env.PATH].filter(Boolean).join(path.delimiter) }
	: process.env;

function docker(...args) {
	return spawnSync(DOCKER, args, { encoding: "utf8", env: ENGINE_ENV });
}

function usage(log = console.log) {
	log(`Usage: ${SELF} <start|stop|restart|update|status|url>

Starts a local SearXNG container for exxperts web_search, writes generated
SearXNG settings to ~/.exxperts/app/searxng/settings.yml, and writes the shared
web-search config to ~/.exxperts/app/web-search.json (read by both the global
\`exxperts\` command and the repo scripts). Just run \`start\`, then restart the app.
\`update\` brings an existing, running container to the pinned image and settings.

Environment:
  SEARXNG_PORT            Host port, default: 8888
  SEARXNG_CONTAINER_NAME  Container name, default: exxperts-searxng
  SEARXNG_CONTAINER_CLI   Container command, default: docker, else podman`);
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
Colima and Podman work too.
Install one, start it, then re-run: ${SELF} start`);
		process.exit(1);
	}
	if (!dockerRunning()) {
		console.error(`The container engine is installed but not running. Start it (${isWindows ? "Docker Desktop or Podman" : "OrbStack, Docker Desktop, Colima or Podman"}) and retry.`);
		process.exit(1);
	}
}

const listNames = (args) => docker(...args, "--format", "{{.Names}}").stdout?.split(/\r?\n/) ?? [];
const containerExists = () => listNames(["ps", "-a"]).includes(NAME);
const containerRunning = () => listNames(["ps"]).includes(NAME);

// SearXNG ships Bing and Yahoo switched off. They are the sites that still
// answer a home connection most reliably (Yahoo serves Bing's results through
// its own front end), so they back up Google when it refuses.
const ENGINES = `engines:
  - name: bing
    disabled: false
  - name: yahoo
    disabled: false
`;

// Writes the settings file, or brings one we wrote before up to date. True
// when the file changed, so a running container reads it again. A file
// written before the engines were added gets them appended, which keeps its
// secret key. A file that already names engines, or replaces SearXNG's
// defaults instead of adding to them, is someone's own and stays as it is.
function ensureSettings() {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	if (fs.existsSync(SETTINGS_FILE)) {
		const text = fs.readFileSync(SETTINGS_FILE, "utf8");
		if (/^engines\s*:/m.test(text) || !/^use_default_settings\s*:\s*true\s*$/m.test(text)) return false;
		fs.appendFileSync(SETTINGS_FILE, `${text.endsWith("\n") ? "" : "\n"}\n${ENGINES}`);
		return true;
	}
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

${ENGINES}`);
	return true;
}

// The image a container runs and the pinned one, compared by image id, which
// Docker and Podman both report the same way for both.
const imageIdOf = (...args) => {
	const res = docker(...args, "--format", "{{.Id}}");
	return res.status === 0 ? res.stdout.trim() : null;
};
const containerImageId = () => {
	const res = docker("container", "inspect", NAME, "--format", "{{.Image}}");
	return res.status === 0 ? res.stdout.trim() : null;
};

// A path in a form two spellings of one file share. On Windows the engines
// report a mounted host file as their Linux machine sees it (Docker Desktop:
// /run/desktop/mnt/host/c/..., Podman: /mnt/c/...), so the drive is put back
// and case is ignored, as Windows does.
function comparablePath(p) {
	if (!isWindows) {
		try { return fs.realpathSync(p); } catch { return path.resolve(p); }
	}
	const slashed = p.replace(/\\/g, "/");
	const linux = /^\/(?:run\/desktop\/mnt\/host\/|mnt\/|host_mnt\/)?([a-z])(\/.*)?$/i.exec(slashed);
	return path.win32.resolve(linux ? `${linux[1]}:${linux[2] ?? "/"}` : slashed).toLowerCase();
}

// Whether the container reads this data folder's settings file. Another data
// folder (a loaded profile, a test run) shares the machine's one container
// name but not its settings, and must not take the container over. Containers
// this helper creates carry the file in a label; older ones are recognised by
// their mount.
function containerUsesOurSettings() {
	const res = docker("container", "inspect", NAME, "--format", `{{index .Config.Labels "${SETTINGS_LABEL}"}}{{"\\n"}}{{range .Mounts}}{{.Source}}{{"\\n"}}{{end}}`);
	if (res.status !== 0) return false;
	const ours = comparablePath(SETTINGS_FILE);
	return res.stdout.split(/\r?\n/).some((source) => {
		const text = source.trim();
		return text && text !== "<no value>" && comparablePath(text) === ours;
	});
}

// Brings an existing container to the pinned image: the new image is
// downloaded first, while the old container keeps answering, and only then is
// the container replaced. A download that fails leaves the old one as it was.
// True when the container was removed and needs to be created again.
function replaceOutdatedContainer() {
	const running = containerImageId();
	if (!running) return false;
	let pinned = imageIdOf("image", "inspect", IMAGE);
	if (pinned === running) return false;
	if (!pinned) {
		console.log("Downloading a newer version of the search engine...");
		const pull = spawnSync(DOCKER, ["pull", IMAGE], { stdio: ["ignore", "inherit", "inherit"], env: ENGINE_ENV });
		pinned = pull.status === 0 ? imageIdOf("image", "inspect", IMAGE) : null;
		if (!pinned) {
			console.log("Could not download the newer version; keeping the current one.");
			return false;
		}
		if (pinned === running) return false;
	}
	// -v takes the container's unnamed volumes with it, which the image
	// creates on every run and nothing else uses.
	const removed = docker("rm", "-f", "-v", NAME);
	if (removed.status !== 0) {
		console.log("Could not replace the search engine container; keeping the current one.");
		return false;
	}
	// The old image is only taking space now, unless someone tagged it for
	// their own use. The engine refuses if anything else still runs it.
	const tags = docker("image", "inspect", running, "--format", "{{len .RepoTags}}");
	if (tags.status === 0 && tags.stdout.trim() === "0") docker("image", "rm", running);
	return true;
}

async function waitUntilReady() {
	const url = `${BASE_URL}/search?q=exxperts&format=json`;
	for (let i = 0; i < 30; i++) {
		try {
			// SearXNG answers once its slowest search site has answered or hit
			// its 3 s limit, so a shorter wait would never see it ready.
			const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
			if (res.ok) return true;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
}

// Write the web-search config into the shared product app state dir
// (~/.exxperts/app) so the user does not have to hand-edit anything. Both the
// global `exxperts` command and the repo `./scripts/exxperts-cli` read this same file,
// and it survives reinstalls.
//
// Non-destructive about the BACKEND choice, which is the thing this command is
// here to set: if somebody already chose one, it is left alone. It is not
// non-destructive about the file, because the file holds other settings now.
// The app's settings screen can write a file that says only "provider search
// off", and treating that as "a backend is already configured" would leave this
// command refusing to do the one job it was asked to do, on a machine with no
// backend configured at all.
function ensureSearchConfig() {
	const cfgDir = path.join(stateHome(), ".exxperts", "app");
	const cfgFile = path.join(cfgDir, "web-search.json");
	fs.mkdirSync(cfgDir, { recursive: true });
	let existing = null;
	if (fs.existsSync(cfgFile)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
		} catch {
			// A file we cannot read is not a choice we can honour, and not one we
			// are willing to overwrite either.
			console.log(`Web-search config at ${cfgFile} could not be read — leaving it alone.`);
			console.log("  Repair or delete it, then run this again.");
			return;
		}
	}
	if (existing && typeof existing.provider === "string" && existing.provider.trim()) {
		console.log(`Web-search backend already chosen in ${cfgFile} (provider=${existing.provider}) — left as-is.`);
		console.log(`  (If search is still off, check it points at ${BASE_URL}.)`);
	} else {
		// Everything already in the file survives; only the backend is filled in.
		const next = { ...(existing ?? {}), provider: "searxng", baseUrl: BASE_URL };
		fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2) + "\n");
		console.log(`Configured web search at ${cfgFile} (provider=searxng, baseUrl=${BASE_URL}).`);
	}
	console.log("A running app picks this up on its next search; no restart needed.");
	console.log("You can also see and change it in the app under Settings, Web search.");
	console.log("");
	if (isPodman) {
		console.log(`Tip: Podman does not restart the container after a reboot. Run ${SELF} start`);
		console.log("     again then, or press Start one on this computer in the app.");
		return;
	}
	const engine = isWindows ? "Docker Desktop" : "your container engine";
	console.log(`Tip: enable "Start at login" in ${engine} so search keeps working`);
	console.log("     after a reboot — the container restarts automatically with the engine.");
	console.log("     If search ever stops, the engine is probably not running: open it and");
	console.log(`     check with ${SELF} status.`);
}

function runContainer() {
	const res = spawnSync(DOCKER, [
		"run", "-d",
		"--name", NAME,
		"--restart", "unless-stopped",
		"-p", `127.0.0.1:${PORT}:8080`,
		"-e", `SEARXNG_BASE_URL=${BASE_URL}/`,
		"--label", `${SETTINGS_LABEL}=${SETTINGS_FILE}`,
		"-v", `${SETTINGS_FILE}:/etc/searxng/settings.yml:ro`,
		IMAGE,
	], { stdio: ["ignore", "ignore", "inherit"], env: ENGINE_ENV });
	if (res.status !== 0) process.exit(1);
}

// Makes the existing container current: the pinned image and the settings
// this helper writes. The container's state stays otherwise as it was.
// "replaced" when it was removed for a new image (and needs creating again),
// "restarted" when it re-read new settings, "kept" when nothing changed,
// "foreign" when it belongs to another data folder and was left alone.
function refreshContainer() {
	if (!containerUsesOurSettings()) return "foreign";
	const settingsChanged = ensureSettings();
	if (replaceOutdatedContainer()) return "replaced";
	if (settingsChanged && containerRunning()) {
		docker("restart", NAME);
		return "restarted";
	}
	return "kept";
}

async function start() {
	requireDocker();
	if (containerExists() && refreshContainer() === "replaced") {
		runContainer();
	} else if (containerRunning()) {
		// "The container is up" is not "search works". Ask the engine itself
		// before claiming anything; when it is healthy the first probe answers
		// straight away and this costs nothing.
		if (await waitUntilReady()) {
			console.log(`SearXNG already running at ${BASE_URL}`);
			ensureSearchConfig();
		} else {
			console.error(`The SearXNG container is running, but its search endpoint at ${BASE_URL} did not become ready.`);
			console.error(`Check logs with: ${isPodman ? "podman" : "docker"} logs ${NAME}`);
			process.exit(1);
		}
		return;
	} else if (containerExists()) {
		const res = docker("start", NAME);
		if (res.status !== 0) {
			console.error(res.stderr?.trim() || `docker start ${NAME} failed`);
			process.exit(1);
		}
	} else {
		ensureSettings();
		runContainer();
	}
	if (await waitUntilReady()) {
		console.log(`SearXNG ready at ${BASE_URL}`);
		ensureSearchConfig();
	} else {
		console.error("SearXNG container started, but the JSON search endpoint did not become ready in time.");
		console.error(`Check logs with: ${isPodman ? "podman" : "docker"} logs ${NAME}`);
		process.exit(1);
	}
}

// Only for a container that already runs: the app asks this when it starts,
// and nothing that is stopped, or was never set up, is started by it.
async function update() {
	if (!DOCKER || !dockerRunning() || !containerRunning()) {
		console.log("Nothing to update: no search engine container is running.");
		return;
	}
	const outcome = refreshContainer();
	// Nothing changed: no test search, which every search site would see.
	if (outcome === "kept" || outcome === "foreign") {
		console.log(outcome === "kept"
			? "The search engine is up to date."
			: "The search engine container belongs to another exxperts data folder; left as it is.");
		return;
	}
	if (outcome === "replaced") runContainer();
	if (await waitUntilReady()) {
		console.log(`SearXNG ready at ${BASE_URL}`);
	} else {
		console.error("SearXNG container started, but the JSON search endpoint did not become ready in time.");
		console.error(`Check logs with: ${isPodman ? "podman" : "docker"} logs ${NAME}`);
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
	case "update": await update(); break;
	case "runtime":
		// One word for the app's settings pane: is a container runtime there at
		// all, and is its daemon answering. The same resolveDocker split that
		// requireDocker uses, without the prose.
		if (!DOCKER) console.log("missing");
		else console.log(spawnSync(DOCKER, ["info"], { stdio: "ignore", timeout: 4000, env: ENGINE_ENV }).status === 0 ? "up" : "stopped");
		break;
	case "status": status(); break;
	case "url": console.log(BASE_URL); break;
	case "--help": case "-h": case "": usage(); break;
	default:
		console.error(`Unknown command: ${cmd}`);
		usage(console.error);
		process.exit(2);
}
