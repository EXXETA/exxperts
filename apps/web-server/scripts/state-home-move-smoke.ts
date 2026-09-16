import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

// Pins the in-app move of the exxperts home (Settings → Profiles → Move):
//
// - migrateStateFamily moves EXACTLY the family (.exxperts and every
//   .exxperts-<name> dir), leaves everything else, and works copy-first:
//   sources are deleted only after every copy landed AND the move is already
//   authoritative, so an interruption at any point leaves at least one
//   complete copy and a re-run finishes the job (an entry that is finished at
//   the destination is kept as it is, only staging debris is copied again);
// - planHomeMove creates nothing, refuses the current home, folders inside
//   the family on REAL paths, and a family member that is a symbolic link,
//   and flips to mode "adopt" when the target already holds exxperts data;
// - the move rides the switch protocol: /plan discloses, /apply records the
//   intent and exits with the sentinel, the SUPERVISOR executes the move
//   between legs (performPendingHomeMove) and the next leg runs against the
//   new home with the pointer written, and moving back to the login home
//   removes the pointer;
// - adopt mode uses the target's data as-is and moves NOTHING;
// - a pointer naming a missing folder fails resolution loudly (a synced
//   drive that is not there must not silently look like data loss).

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const stateProfiles = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "state-profiles.cjs")) as {
	SWITCH_EXIT_CODE: number;
	adoptStateHome: (loginHome: string, env: Record<string, string | undefined>) => { home: string; source: string };
	resolveStateHome: (loginHome: string, env?: Record<string, string | undefined>) => { home: string; source: string };
	listStateFamily: (home: string) => string[];
	planHomeMove: (currentHome: string, target: string) => { dir: string; mode: string; moving: string[] };
	prepareHomeMove: (loginHome: string, currentHome: string, target: string) => { dir: string; mode: string; moving: string[]; token: string };
	migrateStateFamily: (fromHome: string, toDir: string) => void;
	performPendingHomeMove: (loginHome: string) => { to: string; mode: string } | null;
	homePointerPath: (loginHome: string) => string;
	homeMoveIntentPath: (loginHome: string) => string;
	writeHomePointer: (loginHome: string, dir: string | null) => void;
	readActiveProfile: (home: string) => string | null;
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-home-move-"));
const unit = path.join(tempRoot, "unit");

// 1. migrateStateFamily moves the family and only the family.
{
	const from = path.join(unit, "from");
	const to = path.join(unit, "to");
	fs.mkdirSync(path.join(from, ".exxperts", "app"), { recursive: true });
	fs.writeFileSync(path.join(from, ".exxperts", "app", "sentinel.txt"), "precious");
	fs.mkdirSync(path.join(from, ".exxperts-demo", ".exxperts"), { recursive: true });
	fs.mkdirSync(path.join(from, ".exxperts.deleting-husk"), { recursive: true });
	fs.mkdirSync(path.join(from, "unrelated"), { recursive: true });
	fs.writeFileSync(path.join(from, ".exxperts.home.json"), "{}");
	fs.mkdirSync(to, { recursive: true });
	assert(stateProfiles.listStateFamily(from).join(",") === ".exxperts,.exxperts-demo", "the family is the standard tree plus profiles, nothing dotted");
	stateProfiles.migrateStateFamily(from, to);
	assert(fs.readFileSync(path.join(to, ".exxperts", "app", "sentinel.txt"), "utf8") === "precious", "the standard tree must arrive with its data");
	assert(fs.existsSync(path.join(to, ".exxperts-demo")), "profiles must arrive too");
	assert(!fs.existsSync(path.join(from, ".exxperts")) && !fs.existsSync(path.join(from, ".exxperts-demo")), "the family must leave the old home");
	assert(fs.existsSync(path.join(from, ".exxperts.deleting-husk")) && fs.existsSync(path.join(from, "unrelated")) && fs.existsSync(path.join(from, ".exxperts.home.json")), "everything that is not the family must stay behind");

	// A resume after a stop DURING the source deletion: the destination carries
	// the entry under its final name, so it is the finished copy and is kept
	// exactly as it is: the source that outlived the deletion is half a tree
	// and rebuilding from it would be the data loss, not the repair.
	fs.mkdirSync(path.join(from, ".exxperts"), { recursive: true });
	fs.writeFileSync(path.join(from, ".exxperts", "leftover.txt"), "half a source");
	fs.mkdirSync(path.join(to, ".exxperts.copying-999-stale"), { recursive: true });
	stateProfiles.migrateStateFamily(from, to);
	assert(fs.existsSync(path.join(to, ".exxperts", "app", "sentinel.txt")), "a finished destination must keep its data instead of being rebuilt from a half-deleted source");
	assert(!fs.existsSync(path.join(to, ".exxperts", "leftover.txt")), "a finished destination is authoritative: nothing is copied over it");
	assert(!fs.existsSync(path.join(to, ".exxperts.copying-999-stale")), "staging debris must be swept");
	assert(!fs.existsSync(path.join(from, ".exxperts")), "a source whose entry is finished at the destination simply goes");

	// A resume after a stop DURING a copy: staging debris and no entry under
	// the final name, so that entry is copied again from the whole source.
	fs.mkdirSync(path.join(from, ".exxperts", "app"), { recursive: true });
	fs.writeFileSync(path.join(from, ".exxperts", "app", "again.txt"), "copied again");
	fs.rmSync(path.join(to, ".exxperts"), { recursive: true, force: true });
	fs.mkdirSync(path.join(to, ".exxperts.copying-998-stale"), { recursive: true });
	stateProfiles.migrateStateFamily(from, to);
	assert(fs.readFileSync(path.join(to, ".exxperts", "app", "again.txt"), "utf8") === "copied again", "an interrupted copy (staging debris, no finished entry) must be copied again from the source");
	assert(!fs.existsSync(path.join(to, ".exxperts.copying-998-stale")), "staging debris must be swept on the copy resume too");
	assert(!fs.existsSync(path.join(from, ".exxperts")), "the source must leave once its copy landed");
}

// 2. planHomeMove: refusals and mode detection.
{
	const home = path.join(unit, "plan-home");
	fs.mkdirSync(path.join(home, ".exxperts"), { recursive: true });
	let failure: Error | null = null;
	try {
		stateProfiles.planHomeMove(home, home);
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null && /already keeps/.test(failure.message), "the current home must be refused");
	failure = null;
	try {
		stateProfiles.planHomeMove(home, path.join(home, ".exxperts", "inside"));
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null && /inside/.test(failure.message), "a folder inside the family must be refused");
	const freshDir = path.join(unit, "plan-fresh", "deeper");
	const fresh = stateProfiles.planHomeMove(home, freshDir);
	assert(fresh.mode === "migrate" && fresh.moving.includes(".exxperts"), "a fresh folder plans a migration");
	// A plan only says what WOULD happen, so it must leave the disk as it
	// found it: offering the move must never scatter empty folders around.
	assert(!fs.existsSync(freshDir) && !fs.existsSync(path.dirname(freshDir)), "a plan must judge the folder, never create it");
	assert(!fs.existsSync(path.join(home, ".exxperts", "inside")), "a refused plan must create nothing either");
	const occupied = path.join(unit, "plan-occupied");
	fs.mkdirSync(path.join(occupied, ".exxperts"), { recursive: true });
	assert(stateProfiles.planHomeMove(home, occupied).mode === "adopt", "a folder that already holds exxperts data plans an adopt");
}

// 2b. The same place under another spelling is still the family. A case alias
// on a case-insensitive disk and a symlinked parent both read as "outside" to
// a textual compare, and the move then copies the data into itself until the
// filesystem gives up on the path length, a native error that ends the
// process with the intent still on disk, so every next start dies the same
// way. The comparison is therefore made on real paths.
{
	const home = path.join(unit, "alias-home");
	fs.mkdirSync(path.join(home, ".exxperts", "app"), { recursive: true });
	// Ask the disk whether it folds case instead of guessing from the platform.
	fs.writeFileSync(path.join(home, "case-probe"), "");
	if (fs.existsSync(path.join(home, "CASE-PROBE"))) {
		let failure: Error | null = null;
		try {
			stateProfiles.planHomeMove(home, path.join(home, ".EXXPERTS", "demo"));
		} catch (error) {
			failure = error as Error;
		}
		assert(failure !== null && /part of what would move/.test(failure.message), `a case alias of the family must be refused, got ${failure?.message}`);
		assert(!fs.existsSync(path.join(home, ".exxperts", "demo")), "the refused alias must not have been created inside the family");
	}
	const link = path.join(unit, "alias-link");
	fs.symlinkSync(path.join(home, ".exxperts"), link, "dir");
	let failure: Error | null = null;
	try {
		stateProfiles.planHomeMove(home, path.join(link, "inside"));
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null && /part of what would move/.test(failure.message), `a symlinked target that lands in the family must be refused, got ${failure?.message}`);
	// The other direction: a folder that would swallow the family is no home.
	failure = null;
	try {
		stateProfiles.planHomeMove(home, home);
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null && /already keeps/.test(failure.message), "the current home keeps its own message");
}

// 2c. An intent is data on disk, not a decision to trust: the supervisor
// judges the recorded target again before copying, and a refused one is
// dropped so the next start is not the same doomed copy.
{
	const login = path.join(unit, "intent-home");
	fs.mkdirSync(path.join(login, ".exxperts", "app"), { recursive: true });
	fs.writeFileSync(path.join(login, ".exxperts", "app", "keep.txt"), "still here");
	const swallowed = path.join(login, ".exxperts", "swallowed");
	fs.writeFileSync(stateProfiles.homeMoveIntentPath(login), JSON.stringify({ from: login, to: swallowed, mode: "migrate" }));
	let failure: Error | null = null;
	try {
		stateProfiles.performPendingHomeMove(login);
	} catch (error) {
		failure = error as Error;
	}
	assert(failure === null || /part of what would move/.test(failure.message), `a refused intent must explain itself in our own words, got ${failure?.message}`);
	assert(!fs.existsSync(stateProfiles.homeMoveIntentPath(login)) && !fs.existsSync(`${stateProfiles.homeMoveIntentPath(login)}.running`), "a refused intent must be dropped, or every next start repeats it");
	assert(!fs.existsSync(stateProfiles.homePointerPath(login)), "a refused move must not point the home anywhere");
	assert(fs.readFileSync(path.join(login, ".exxperts", "app", "keep.txt"), "utf8") === "still here", "a refused move must leave the data where it is");
	assert(!fs.existsSync(swallowed), "a refused move must copy nothing");
}

// 2d. A home that is a symbolic link (a setup that pointed ~/.exxperts at a
// synced folder by hand, long before this feature): it is still a family
// member, and the move is refused rather than copied through the link.
{
	const home = path.join(unit, "linked-home");
	const realTree = path.join(unit, "linked-real-tree");
	fs.mkdirSync(path.join(realTree, "app"), { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	fs.symlinkSync(realTree, path.join(home, ".exxperts"), "dir");
	assert(stateProfiles.listStateFamily(home).includes(".exxperts"), "a linked state tree is still a family member: a plan that cannot see it would move nothing and point the home at an empty folder");
	let failure: Error | null = null;
	try {
		stateProfiles.planHomeMove(home, path.join(unit, "linked-target"));
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null && /symbolic link/.test(failure.message), `a linked family member must refuse the move with an explanation, got ${failure?.message}`);
}

// 3. A pointer naming a missing folder fails loudly instead of falling back.
{
	const home = path.join(unit, "pointer-home");
	fs.mkdirSync(home, { recursive: true });
	stateProfiles.writeHomePointer(home, path.join(unit, "not-there"));
	let failure: Error | null = null;
	try {
		stateProfiles.resolveStateHome(home, {});
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null && /not there right now/.test(failure.message), "a missing configured home must refuse resolution loudly");
	stateProfiles.writeHomePointer(home, null);
	assert(stateProfiles.resolveStateHome(home, {}).home === home, "removing the pointer falls back to the login home");
}

// 4. A move while a NAMED profile is loaded carries it along: the
// active-profile pointer lives inside the standard tree and travels with it,
// and the reply token is the loaded profile's, whose value never changes.
{
	const login = path.join(unit, "loaded-login");
	const dest = path.join(unit, "loaded-dest");
	fs.mkdirSync(path.join(login, ".exxperts", "app", "run"), { recursive: true });
	fs.mkdirSync(path.join(login, ".exxperts-demo", ".exxperts", "app"), { recursive: true });
	fs.writeFileSync(path.join(login, ".exxperts", "app", "run", "active-profile.json"), JSON.stringify({ name: "demo" }));
	fs.writeFileSync(path.join(login, ".exxperts-demo", ".exxperts", "app", "auth-token"), "tok-demo\n");
	assert(stateProfiles.readActiveProfile(login) === "demo", "precondition: demo is loaded");
	const prepared = stateProfiles.prepareHomeMove(login, login, dest);
	assert(prepared.mode === "migrate" && prepared.token === "tok-demo", `the reply must carry the loaded profile's token, got ${JSON.stringify(prepared)}`);
	assert(stateProfiles.performPendingHomeMove(login)?.to === dest, "the supervisor must execute the move");
	assert(stateProfiles.readActiveProfile(dest) === "demo", "the loaded profile must still be loaded in the new home");
	assert(fs.readFileSync(path.join(dest, ".exxperts-demo", ".exxperts", "app", "auth-token"), "utf8").trim() === "tok-demo", "its token must travel unchanged");
	stateProfiles.writeHomePointer(login, null);
}

// 5. End to end, playing the supervisor: move out, run there, move back, adopt.
const loginHome = path.join(tempRoot, "login-home");
const standardApp = path.join(loginHome, ".exxperts", "app");
fs.mkdirSync(standardApp, { recursive: true });
fs.writeFileSync(path.join(standardApp, "smoke-sentinel.txt"), "my precious data");

function legEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: loginHome,
		USERPROFILE: loginHome,
		PORT: String(port),
		...SMOKE_SERVER_AUTH_ENV,
		EXXETA_HOME: repoRoot,
		EXXPERTS_SWITCH_SUPERVISED: "1",
		EXXPERTS_HOME_MOVE_SUPERVISED: "1",
		EXXPERTS_LOGIN_HOME: loginHome,
	};
	delete env.EXXPERTS_DATA_DIR;
	// What a supervisor does per leg: adopt the resolved home.
	const { home } = stateProfiles.adoptStateHome(loginHome, env);
	env.EXXPERTS_REAL_HOME = home;
	return env;
}

function spawnServer(): ChildProcessWithoutNullStreams {
	return spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: legEnv(),
	});
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 30000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function api(route: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${route}`, {
		...init,
		headers: { "content-type": "application/json", ...init.headers },
	});
	return { status: response.status, body: await response.json().catch(() => null) };
}

// Apply a move and wait for the sentinel exit, like the switch smoke does.
async function applyAndAwaitExit(server: ChildProcessWithoutNullStreams, dir: string): Promise<void> {
	const exited = new Promise<number | null>((resolve) => server.once("exit", (code) => resolve(code)));
	const response = await api("/api/settings/state-home/apply", { method: "POST", body: JSON.stringify({ dir }) });
	assert(response.status === 200 && response.body?.restarting === true, `apply: expected restarting reply, got ${response.status} ${JSON.stringify(response.body)}`);
	assert(response.body.signInPath === `/auth/session?token=${encodeURIComponent(SMOKE_AUTH_TOKEN)}`, `apply reply must carry the sign-in link, got ${response.body.signInPath}`);
	const code = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("server did not exit after apply")), 15000))]);
	assert(code === stateProfiles.SWITCH_EXIT_CODE, `server must exit with the sentinel code, got ${code}`);
	assert(fs.existsSync(stateProfiles.homeMoveIntentPath(loginHome)), "the move intent must be recorded for the supervisor");
}

const newHome = path.join(tempRoot, "new-home");
let server: ChildProcessWithoutNullStreams | null = null;
try {
	// Leg 1: default home. The payload names it and offers the move.
	server = spawnServer();
	await waitForServer(server);
	let listing = await api("/api/settings/state-profile");
	assert(listing.status === 200 && listing.body.home, "the listing must carry the home payload");
	assert(listing.body.home.dir === loginHome && listing.body.home.source === "default" && listing.body.home.canMove === true, `leg 1 home payload: ${JSON.stringify(listing.body.home)}`);
	assert((await api("/api/settings/state-profile/create", { method: "POST", body: JSON.stringify({ name: "Demo A" }) })).status === 200, "create Demo A must succeed");

	const plan = await api("/api/settings/state-home/plan", { method: "POST", body: JSON.stringify({ dir: newHome }) });
	assert(plan.status === 200 && plan.body.mode === "migrate", `plan must be a migration, got ${JSON.stringify(plan.body)}`);
	assert(plan.body.moving.includes(".exxperts") && plan.body.moving.includes(".exxperts-Demo A"), `the plan must disclose what moves, got ${JSON.stringify(plan.body.moving)}`);
	assert((await api("/api/settings/state-home/plan", { method: "POST", body: JSON.stringify({ dir: loginHome }) })).status === 409, "planning the current home must 409");

	// Apply, then play the supervisor: execute the move between legs.
	await applyAndAwaitExit(server, newHome);
	server = null;
	const moved = stateProfiles.performPendingHomeMove(loginHome);
	assert(moved !== null && moved.mode === "migrate", "the supervisor must execute a migration");
	assert(!fs.existsSync(stateProfiles.homeMoveIntentPath(loginHome)), "the executed intent must be cleared");
	assert(fs.readFileSync(path.join(newHome, ".exxperts", "app", "smoke-sentinel.txt"), "utf8") === "my precious data", "the standard tree must arrive with its data");
	assert(fs.existsSync(path.join(newHome, ".exxperts-Demo A")), "profiles must move along");
	assert(stateProfiles.listStateFamily(loginHome).length === 0, "the old home must hold no family anymore");

	// Leg 2: runs against the new home; profiles work there unchanged.
	server = spawnServer();
	await waitForServer(server);
	listing = await api("/api/settings/state-profile");
	assert(listing.body.home.dir === newHome && listing.body.home.source === "setting", `leg 2 home payload: ${JSON.stringify(listing.body.home)}`);
	assert(listing.body.profiles.some((p: any) => p.name === "Demo A"), "profiles must be listed from the new home");

	// Move back to the login home: the pointer disappears, data comes home.
	assert((await api("/api/settings/state-home/plan", { method: "POST", body: JSON.stringify({ dir: loginHome }) })).body.mode === "migrate", "moving back plans a migration");
	await applyAndAwaitExit(server, loginHome);
	server = null;
	assert(stateProfiles.performPendingHomeMove(loginHome)?.to === loginHome, "the supervisor must execute the move back");
	assert(!fs.existsSync(stateProfiles.homePointerPath(loginHome)), "moving back to the login home must remove the pointer");
	assert(fs.readFileSync(path.join(standardApp, "smoke-sentinel.txt"), "utf8") === "my precious data", "the data must come home intact");

	// Leg 3, adopt: a folder that already holds exxperts data (the second
	// computer against a synced folder) is used as-is; NOTHING moves.
	const synced = path.join(tempRoot, "synced");
	fs.mkdirSync(path.join(synced, ".exxperts", "app"), { recursive: true });
	fs.writeFileSync(path.join(synced, ".exxperts", "app", "theirs.txt"), "from the other computer");
	server = spawnServer();
	await waitForServer(server);
	const adoptPlan = await api("/api/settings/state-home/plan", { method: "POST", body: JSON.stringify({ dir: synced }) });
	assert(adoptPlan.status === 200 && adoptPlan.body.mode === "adopt" && adoptPlan.body.moving.length === 0, `adopt plan: ${JSON.stringify(adoptPlan.body)}`);
	await applyAndAwaitExit(server, synced);
	server = null;
	assert(stateProfiles.performPendingHomeMove(loginHome)?.mode === "adopt", "the supervisor must record an adopt");
	assert(fs.readFileSync(path.join(standardApp, "smoke-sentinel.txt"), "utf8") === "my precious data", "an adopt must move nothing out of the old home");
	assert(fs.readFileSync(path.join(synced, ".exxperts", "app", "theirs.txt"), "utf8") === "from the other computer", "an adopt must leave the target's data as it is");
	assert(stateProfiles.resolveStateHome(loginHome, {}).home === synced, "the pointer must now name the adopted folder");

	console.log("state-home-move smoke: OK");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
