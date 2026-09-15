import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

// Pins the data-profile unit (pointer + env indirection, NO renames):
//
// - the standard profile IS ~/.exxperts: it never moves, has no name
//   (active null), and is not addressable by the delete route;
// - EVERY ~/.exxperts-<name> directory is a profile: created empty here,
//   made by hand, or a raw copied state tree — any shape is normalized into
//   the nested .exxperts layout on first activation;
// - switching updates the active-profile pointer and exits with the sentinel
//   code; the supervisor restarts the server with the profile's env — the
//   standard tree is byte-untouched through any number of switches;
// - the switch reply carries the target's sign-in link (token pre-minted);
// - an unsupervised server refuses to switch instead of dying into a dead app.

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
	validateNewProfileName: (name: string) => string | null;
	readActiveProfile: (home: string) => string | null;
	writeActiveProfile: (home: string, name: string | null) => void;
	serverEnvForProfile: (home: string, name: string | null) => Record<string, string>;
	activePointerPath: (home: string) => string;
	profileTree: (home: string, name: string) => string;
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-state-profile-"));
const tempHome = path.join(tempRoot, "home");
const standardApp = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(standardApp, { recursive: true, mode: 0o700 });

// 1. Validation: free-form names in, filesystem hazards out.
assert(stateProfiles.validateNewProfileName("Demo 2026") === null, "spaces must be allowed");
assert(stateProfiles.validateNewProfileName("client-x_1.0") === null, "dots, dashes, underscores must be allowed");
for (const bad of ["", " x", "x ", "a/b", "a\\b", "a:b", "CON", "lpt1", ".hidden", "trailing.", "x".repeat(65)]) {
	assert(stateProfiles.validateNewProfileName(bad) !== null, `"${bad}" must be rejected`);
}

function spawnServer(opts: { supervised?: boolean; profile?: string | null } = {}): ChildProcessWithoutNullStreams {
	const { supervised = true, profile = null } = opts;
	return spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome,
			USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_REAL_HOME: tempHome,
			// The smoke acts as the supervisor: it restarts legs itself.
			...(supervised ? { EXXPERTS_SWITCH_SUPERVISED: "1" } : {}),
			// What a supervisor does per leg: point the env at the profile.
			...stateProfiles.serverEnvForProfile(tempHome, profile),
		},
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

// A switch answers 200 and then exits the process; the assertion is on both.
async function switchAndAwaitExit(server: ChildProcessWithoutNullStreams, target: string | null): Promise<void> {
	const exited = new Promise<number | null>((resolve) => server.once("exit", (code) => resolve(code)));
	const response = await api("/api/settings/state-profile/switch", { method: "POST", body: JSON.stringify({ name: target }) });
	assert(response.status === 200 && response.body?.restarting === true, `switch to ${JSON.stringify(target)}: expected restarting reply, got ${response.status} ${JSON.stringify(response.body)}`);
	// Env-pinned tokens never rotate, so the reply's sign-in link carries the pin.
	assert(response.body.signInPath === `/auth/session?token=${encodeURIComponent(SMOKE_AUTH_TOKEN)}`, `switch reply must carry the sign-in link, got ${response.body.signInPath}`);
	const code = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("server did not exit after switch")), 15000))]);
	// npx→tsx wrap the server, but both propagate the child's exit code.
	assert(code === stateProfiles.SWITCH_EXIT_CODE, `server must exit with the sentinel code, got ${code}`);
	assert(stateProfiles.readActiveProfile(tempHome) === target, `the pointer must name ${JSON.stringify(target)} after the switch`);
}

let server: ChildProcessWithoutNullStreams | null = null;
try {
	// A raw copied state tree (app/ at its root, the `cp -r ~/.exxperts …`
	// case) must be listed and get normalized on first activation.
	fs.mkdirSync(path.join(tempHome, ".exxperts-rawcopy", "app"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(tempHome, ".exxperts-rawcopy", "app", "copied.txt"), "copied state");

	// Data in the standard tree that must never move or change.
	const sentinel = path.join(standardApp, "smoke-sentinel.txt");
	fs.writeFileSync(sentinel, "my precious data");

	// 2. Fresh boot: the standard profile reads as active null; every
	// .exxperts-* dir is listed.
	server = spawnServer();
	await waitForServer(server);
	let listing = await api("/api/settings/state-profile");
	assert(listing.status === 200, `listing: expected 200, got ${listing.status}`);
	assert(listing.body.active === null, `standard profile must read as active null, got "${listing.body.active}"`);
	assert(listing.body.profiles.length === 1 && listing.body.profiles[0].name === "rawcopy", "every .exxperts-* dir must be listed, whatever its shape");
	assert((await api("/api/settings/state-profile/switch", { method: "POST", body: JSON.stringify({ name: "ghost" }) })).status === 409, "switching to a missing profile must 409");
	assert((await api("/api/settings/state-profile/switch", { method: "POST", body: JSON.stringify({ name: null }) })).status === 409, "switching to the already-loaded standard profile must 409");

	// 3. Create: a self-contained dir with an empty nested tree.
	const created = await api("/api/settings/state-profile/create", { method: "POST", body: JSON.stringify({ name: "Demo A" }) });
	assert(created.status === 200, `create: expected 200, got ${created.status} ${JSON.stringify(created.body)}`);
	assert(created.body.profiles.some((p: any) => p.name === "Demo A"), "created profile must be listed");
	const demoTree = stateProfiles.profileTree(tempHome, "Demo A");
	assert(fs.existsSync(demoTree) && fs.readdirSync(demoTree).length === 0, "created profile must hold an empty nested .exxperts tree");
	assert((await api("/api/settings/state-profile/create", { method: "POST", body: JSON.stringify({ name: "Demo A" }) })).status === 409, "duplicate create must 409");
	assert((await api("/api/settings/state-profile/create", { method: "POST", body: JSON.stringify({ name: "a/b" }) })).status === 400, "invalid name must 400");

	// 4. Delete: works on a non-active profile; refuses ghosts and non-profiles.
	// The standard profile has no name, so no delete request can address it.
	assert((await api("/api/settings/state-profile/create", { method: "POST", body: JSON.stringify({ name: "Doomed" }) })).status === 200, "create Doomed must succeed");
	const deleted = await api("/api/settings/state-profile/delete", { method: "POST", body: JSON.stringify({ name: "Doomed" }) });
	assert(deleted.status === 200 && !deleted.body.profiles.some((p: any) => p.name === "Doomed"), "deleted profile must leave the list");
	assert(!fs.existsSync(path.join(tempHome, ".exxperts-Doomed")), "deleted profile must leave the disk");
	assert((await api("/api/settings/state-profile/delete", { method: "POST", body: JSON.stringify({ name: "ghost" }) })).status === 409, "deleting a missing profile must 409");

	// 5. Switch to Demo A: pointer written, sentinel exit, token pre-minted in
	// the profile tree, standard tree untouched.
	await switchAndAwaitExit(server, "Demo A");
	server = null;
	assert(fs.existsSync(path.join(demoTree, "app", "auth-token")), "the target's sign-in token must be pre-minted");
	assert(fs.readFileSync(sentinel, "utf8") === "my precious data", "the standard tree must be untouched by the switch");

	// 6. The new leg runs against the profile via env indirection.
	server = spawnServer({ profile: "Demo A" });
	await waitForServer(server);
	listing = await api("/api/settings/state-profile");
	assert(listing.body.active === "Demo A", `active must be "Demo A", got "${listing.body.active}"`);
	assert(!listing.body.profiles.some((p: any) => p.name === "Demo A"), "the loaded profile must not appear in the switch list");
	assert((await api("/api/settings/state-profile/delete", { method: "POST", body: JSON.stringify({ name: "Demo A" }) })).status === 409, "deleting the loaded profile must 409");
	// The fresh-start guarantee: the profile's own state is empty.
	const rooms = await api("/api/persistent-agents");
	assert(rooms.status === 200 && Array.isArray(rooms.body) && rooms.body.length === 0, "a fresh profile must have no rooms");

	// 7. Switch back to the standard profile: pointer removed, data intact.
	await switchAndAwaitExit(server, null);
	server = null;
	assert(!fs.existsSync(stateProfiles.activePointerPath(tempHome)), "switching to standard must remove the pointer");
	server = spawnServer();
	await waitForServer(server);
	listing = await api("/api/settings/state-profile");
	assert(listing.body.active === null, "back on the standard profile");
	assert(fs.readFileSync(sentinel, "utf8") === "my precious data", "the standard tree must be byte-identical after the round trip");

	// 8. Hand-made empty dir: listed and switchable. The raw copied tree gets
	// wrapped into the nested layout by its first activation.
	fs.mkdirSync(path.join(tempHome, ".exxperts-handmade"), { mode: 0o700 });
	listing = await api("/api/settings/state-profile");
	assert(listing.body.profiles.some((p: any) => p.name === "handmade"), "a hand-made empty dir must be listed");
	await switchAndAwaitExit(server, "rawcopy");
	server = null;
	assert(fs.readFileSync(path.join(stateProfiles.profileTree(tempHome, "rawcopy"), "app", "copied.txt"), "utf8") === "copied state", "a raw copied tree must be normalized into the nested layout with its data intact");
	stateProfiles.writeActiveProfile(tempHome, null);

	// 9. Unsupervised server (no launcher/desktop/harness): the switch route
	// fails closed with a reason instead of dying into a dead app.
	server = spawnServer({ supervised: false });
	await waitForServer(server);
	const unsupervised = await api("/api/settings/state-profile/switch", { method: "POST", body: JSON.stringify({ name: "Demo A" }) });
	assert(unsupervised.status === 409 && /supervisor/.test(String(unsupervised.body?.error)), `unsupervised switch must 409 with a reason, got ${unsupervised.status} ${JSON.stringify(unsupervised.body)}`);
	assert(server.exitCode === null, "an unsupervised switch attempt must not exit the server");

	console.log("state-profile smoke: OK");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
