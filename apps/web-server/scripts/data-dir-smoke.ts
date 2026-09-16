import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

// Pins EXXPERTS_DATA_DIR (issue #60): one configured directory carries the
// WHOLE state family (the standard tree at <dir>/.exxperts and every
// profile at <dir>/.exxperts-<name>) via the same env indirection profiles
// ride on (adoptStateHome, called first by every launcher):
//
// - unset: nothing changes (the default ~/.exxperts behavior);
// - set: the directory is created (relative paths resolve against cwd) and
//   named in EXXPERTS_STATE_HOME, while HOME stays the login home: only the
//   exxperts state moves, nothing else in the home;
// - unusable (a file in the way, not writable): adoption fails with an
//   actionable message instead of scattering state;
// - a server run against the data dir keeps its state inside it, leaves the
//   original home byte-untouched, and data profiles work inside it unchanged.

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
	readActiveProfile: (home: string) => string | null;
	profileTree: (home: string, name: string) => string;
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-data-dir-"));
const loginHome = path.join(tempRoot, "login-home");
fs.mkdirSync(loginHome, { recursive: true });

// 1. Unset (and blank): the login home stands and the env is untouched.
for (const raw of [undefined, "", "   "]) {
	const env: Record<string, string | undefined> = { EXXPERTS_DATA_DIR: raw, HOME: "/untouched" };
	const resolved = stateProfiles.adoptStateHome(loginHome, env);
	assert(resolved.home === loginHome && resolved.source === "default", "unset EXXPERTS_DATA_DIR must resolve to the login home");
	assert(env.HOME === "/untouched", "unset EXXPERTS_DATA_DIR must leave the env alone");
}

// 2. A configured path that does not exist yet: created (nested and all),
// env repointed at it.
const dataDir = path.join(tempRoot, "nested", "exxperts-data");
{
	const env: Record<string, string | undefined> = { EXXPERTS_DATA_DIR: dataDir };
	const resolved = stateProfiles.adoptStateHome(loginHome, env);
	assert(resolved.home === dataDir && resolved.source === "env", "adoption must return the resolved dir");
	assert(fs.statSync(dataDir).isDirectory(), "the configured directory must be created");
	// Only the state moves: EXXPERTS_STATE_HOME names the data dir and HOME is
	// left exactly as it was, so everything else in the home (browser cache,
	// dotfiles, shared skills folder, MCP config) stays where it is.
	assert(env.EXXPERTS_STATE_HOME === dataDir, `EXXPERTS_STATE_HOME must point at the data dir, got ${JSON.stringify(env.EXXPERTS_STATE_HOME)}`);
	assert(env.HOME === undefined && env.USERPROFILE === undefined, `adoption must leave HOME/USERPROFILE untouched, got HOME=${JSON.stringify(env.HOME)} USERPROFILE=${JSON.stringify(env.USERPROFILE)}`);
	assert(env.EXXPERTS_CODING_AGENT_DIR === path.join(dataDir, ".exxperts", "agent"), "the agent dir must land inside the data dir");
}

// 3. A relative path resolves against the cwd (documented; absolute is the
// recommendation).
{
	const env: Record<string, string | undefined> = { EXXPERTS_DATA_DIR: "./relative-data-dir" };
	const cwd = process.cwd();
	try {
		process.chdir(tempRoot);
		assert(stateProfiles.adoptStateHome(loginHome, env).home === path.join(fs.realpathSync(tempRoot), "relative-data-dir"), "a relative path must resolve against the cwd");
	} finally {
		process.chdir(cwd);
	}
}

// 4. A file where the directory should be: refused with an actionable message.
{
	const blocked = path.join(tempRoot, "occupied");
	fs.writeFileSync(blocked, "not a directory");
	let failure: Error | null = null;
	try {
		stateProfiles.adoptStateHome(loginHome, { EXXPERTS_DATA_DIR: blocked });
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null, "a file in the way must refuse adoption");
	assert(/EXXPERTS_DATA_DIR/.test(failure.message) && failure.message.includes(blocked), `the error must name the variable and the path, got: ${failure.message}`);
}

// 5. A non-writable directory: refused. (POSIX-only: chmod is advisory on
// Windows, and root ignores modes.)
if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
	const readOnly = path.join(tempRoot, "read-only");
	fs.mkdirSync(readOnly, { mode: 0o500 });
	let failure: Error | null = null;
	try {
		stateProfiles.adoptStateHome(loginHome, { EXXPERTS_DATA_DIR: readOnly });
	} catch (error) {
		failure = error as Error;
	}
	assert(failure !== null && /not writable/.test(failure.message), `a non-writable dir must refuse adoption with a writable hint, got: ${failure?.message}`);
}

// 6. End to end: a server run against the data dir. The decoy home stays this
// leg's HOME the whole way through, and must stay byte-untouched, because the
// state it would otherwise hold now lives in the data dir.
const decoyHome = path.join(tempRoot, "decoy-home");
fs.mkdirSync(decoyHome, { recursive: true });
const serverEnv: Record<string, string | undefined> = {
	...process.env,
	HOME: decoyHome,
	USERPROFILE: decoyHome,
	PORT: String(port),
	...SMOKE_SERVER_AUTH_ENV,
	EXXETA_HOME: repoRoot,
	EXXPERTS_SWITCH_SUPERVISED: "1",
	EXXPERTS_DATA_DIR: dataDir,
};
// What every launcher does first; EXXPERTS_REAL_HOME follows the adopted home.
const adopted = stateProfiles.adoptStateHome(decoyHome, serverEnv);
serverEnv.EXXPERTS_REAL_HOME = adopted.home;
serverEnv.EXXPERTS_LOGIN_HOME = decoyHome;

async function api(route: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${route}`, {
		...init,
		headers: { "content-type": "application/json", ...init.headers },
	});
	return { status: response.status, body: await response.json().catch(() => null) };
}

let server: ChildProcessWithoutNullStreams | null = null;
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: serverEnv,
	});
	const deadline = Date.now() + 30000;
	let ready = false;
	while (!ready && Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		ready = await fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false);
		if (!ready) await new Promise((resolve) => setTimeout(resolve, 150));
	}
	assert(ready, "server did not become ready against the data dir");

	// The state family lives inside the data dir…
	assert(fs.existsSync(path.join(dataDir, ".exxperts", "app")), "the standard tree must live inside the data dir");
	// …the env pin is reported and the in-app move is refused while it holds…
	const pinned = await api("/api/settings/state-profile");
	assert(pinned.body?.home?.source === "env" && pinned.body.home.canMove === false, `an env-pinned home must report itself, got ${JSON.stringify(pinned.body?.home)}`);
	assert((await api("/api/settings/state-home/plan", { method: "POST", body: JSON.stringify({ dir: path.join(tempRoot, "elsewhere") }) })).status === 409, "planning a move must be refused while EXXPERTS_DATA_DIR pins the location");
	// …and data profiles compose with it unchanged.
	const created = await api("/api/settings/state-profile/create", { method: "POST", body: JSON.stringify({ name: "Demo" }) });
	assert(created.status === 200, `profile create must work against the data dir, got ${created.status} ${JSON.stringify(created.body)}`);
	assert(fs.existsSync(stateProfiles.profileTree(dataDir, "Demo")), "the created profile must live inside the data dir");
	const exited = new Promise<number | null>((resolve) => server!.once("exit", (code) => resolve(code)));
	const switched = await api("/api/settings/state-profile/switch", { method: "POST", body: JSON.stringify({ name: "Demo" }) });
	assert(switched.status === 200 && switched.body?.restarting === true, `switch must work against the data dir, got ${switched.status} ${JSON.stringify(switched.body)}`);
	const code = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("server did not exit after switch")), 15000))]);
	assert(code === stateProfiles.SWITCH_EXIT_CODE, `switch must exit with the sentinel code, got ${code}`);
	server = null;
	assert(stateProfiles.readActiveProfile(dataDir) === "Demo", "the active-profile pointer must live inside the data dir");
	assert(fs.readdirSync(decoyHome).length === 0, "the original home must stay byte-untouched");

	console.log("data-dir smoke: OK");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
