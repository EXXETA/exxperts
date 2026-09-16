// Moving the exxperts home under the REAL `exxperts web` supervisor, there and
// back again. The state-home-move smoke plays the supervisor by hand; this one
// spawns bin/exxperts.cjs and lets the launcher's own restart loop do the work,
// because the interesting failure lives in the supervisor and not in the move:
// a leg's environment must be built from the process's OWN start, never from a
// process.env that an earlier leg's adopt repointed. Otherwise moving the data
// out to a folder and then back home restarts the server against the folder it
// just left: a second, empty state tree there, a freshly minted token, no
// profiles, and the sign-in link the reply carried refused with 401, while the
// real data sits at home untouched and unreachable.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const stateProfiles = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "state-profiles.cjs")) as {
	resolveStateHome: (loginHome: string, env?: Record<string, string | undefined>) => { home: string; source: string };
	activeTokenPath: (home: string) => string;
	homePointerPath: (loginHome: string) => string;
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-launcher-home-move-"));
const loginHome = path.join(tempRoot, "login-home");
const movedHome = path.join(tempRoot, "moved");
const sentinelName = "launcher-move-sentinel.txt";
const sentinelText = "my precious data";
fs.mkdirSync(path.join(loginHome, ".exxperts", "app"), { recursive: true });
fs.writeFileSync(path.join(loginHome, ".exxperts", "app", sentinelName), sentinelText);

// Something in the login home that is NOT exxperts state: a skill in the
// cross-tool shared folder. A move relocates the exxperts data and nothing
// else, so this must still list from the leg that runs against the new home.
const sharedSkillName = "login-home-skill";
{
	const dir = path.join(loginHome, ".agents", "skills", sharedSkillName);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		["---", `name: ${sharedSkillName}`, `displayName: ${sharedSkillName}`, "description: seeded in the login home's shared skills folder", "---", "", "This skill lives in the login home and must survive a move of the data folder.", ""].join("\n"),
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The launcher mints real tokens per leg, so the smoke reads the ACTIVE
// profile's token out of whichever home the pointer currently names, exactly
// what an already-open page is handed by the apply reply. The env is pinned to
// {} so the smoke's own EXXPERTS_DATA_DIR (if the operator has one) cannot
// answer for the launcher, whose env has none.
function legToken(): string {
	const { home } = stateProfiles.resolveStateHome(loginHome, {});
	return fs.readFileSync(stateProfiles.activeTokenPath(home), "utf8").trim();
}

async function healthy(): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForHealth(want: boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await healthy()) === want) return;
		await sleep(50);
	}
	throw new Error(`${label}: the server was not ${want ? "up" : "down"} within ${timeoutMs}ms\n${launcherOutput}`);
}

async function api(route: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> {
	const response = await fetch(`${baseUrl}${route}`, {
		...init,
		headers: { "content-type": "application/json", "X-Exxperts-Auth": legToken() },
		signal: AbortSignal.timeout(15000),
	});
	return { status: response.status, body: await response.json().catch(() => null) };
}

// Apply a move and follow the restart the launcher performs for it: the leg
// that served the reply exits, and the next one comes up against the new home.
async function applyAndAwaitRestart(dir: string): Promise<void> {
	const response = await api("/api/settings/state-home/apply", { method: "POST", body: JSON.stringify({ dir }) });
	assert(response.status === 200 && response.body?.restarting === true, `apply ${dir}: expected a restarting reply, got ${response.status} ${JSON.stringify(response.body)}`);
	await waitForHealth(false, 30000, `apply ${dir}`);
	await waitForHealth(true, 120000, `apply ${dir}`);
}

let launcherOutput = "";
let launcher: ChildProcessWithoutNullStreams | null = null;
try {
	const env: Record<string, string | undefined> = { ...process.env, HOME: loginHome, USERPROFILE: loginHome };
	// The launcher must resolve its own home and mint its own tokens: a pinned
	// data dir would refuse the move outright, a pinned token would hide the
	// stale-home symptom behind a value that is the same everywhere.
	delete env.EXXPERTS_DATA_DIR;
	delete env.EXXPERTS_AUTH_TOKEN;
	const child = spawn(process.execPath, [path.join(repoRoot, "bin", "exxperts.cjs"), "web", "--no-open", "--port", String(port)], {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: loginHome,
		env,
		stdio: "pipe",
	});
	launcher = child;
	// The launcher never reads stdin; closing it keeps no pipe open behind the
	// smoke. Its output is kept for the failure messages.
	child.stdin.end();
	child.stdout.on("data", (chunk) => { launcherOutput += chunk; });
	child.stderr.on("data", (chunk) => { launcherOutput += chunk; });

	// Leg 1: the login home, the way every install starts.
	await waitForHealth(true, 120000, "first leg");
	let listing = await api("/api/settings/state-profile");
	assert(listing.status === 200 && listing.body?.home?.dir === loginHome, `first leg must run at the login home, got ${listing.status} ${JSON.stringify(listing.body?.home)}`);

	// Move out: the launcher executes the move between legs and follows it.
	await applyAndAwaitRestart(movedHome);
	listing = await api("/api/settings/state-profile");
	assert(listing.status === 200 && listing.body?.home?.dir === movedHome, `the leg after the move must run at the new home, got ${listing.status} ${JSON.stringify(listing.body?.home)}`);
	assert(fs.readFileSync(path.join(movedHome, ".exxperts", "app", sentinelName), "utf8") === sentinelText, "the data must arrive at the new home");
	// What moved is the exxperts data, not the home: the leg at the new folder
	// still reads the login home's shared skills folder, and the new folder is
	// a data folder rather than a second home, so it never grows one.
	const skills = await api("/api/skills");
	assert(skills.status === 200 && Array.isArray(skills.body), `GET /api/skills after the move must succeed, got ${skills.status}`);
	assert((skills.body as any[]).some((s) => s.name === sharedSkillName), `the login home's ~/.agents/skills must still list after the move, got ${JSON.stringify((skills.body as any[]).map((s) => s.name))}`);
	assert(!fs.existsSync(path.join(movedHome, ".agents")), `the moved data folder must not become a home, found ${path.join(movedHome, ".agents")}`);

	// Move back: the pointer goes, the data comes home, and so must the leg.
	await applyAndAwaitRestart(loginHome);
	assert(!fs.existsSync(stateProfiles.homePointerPath(loginHome)), "moving back to the login home must remove the pointer");
	assert(fs.readFileSync(path.join(loginHome, ".exxperts", "app", sentinelName), "utf8") === sentinelText, "the data must come home intact");
	listing = await api("/api/settings/state-profile");
	assert(listing.status === 200, `the leg after moving back must honor the login home's token, got ${listing.status} ${JSON.stringify(listing.body)}`);
	assert(listing.body?.home?.dir === loginHome, `the leg after moving back must run at the login home, got ${JSON.stringify(listing.body?.home)}`);
	assert(!fs.existsSync(path.join(movedHome, ".exxperts")), `the folder the data left must hold no state tree, found ${path.join(movedHome, ".exxperts")}`);

	console.log("web-launcher-home-move smoke: OK");
} finally {
	await stopSmokeServer(launcher);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
