import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Two state trees on one machine, and neither may write a byte into the other.
//
// The state-profile smoke proves a profile's own state is fresh and that the
// standard tree survives a switch. This one asks the harder question the
// EXXPERTS_STATE_HOME contract raises: a server leg now runs with the LOGIN
// home's HOME whatever profile is loaded, so any path builder that still
// resolves state through os.homedir() would quietly land in the standard tree
// while a profile is loaded: the one leak the old HOME override could not
// have. So a leg does the three things that write state (mint its sign-in
// token, create a room, save a setting) under a loaded profile, and the other
// tree is compared byte for byte, name by name, before and after. Then the
// same three things on the standard profile, with the profile's tree watched.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const stateProfiles = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "state-profiles.cjs")) as {
	createProfile: (home: string, name: string) => void;
	profileDir: (home: string, name: string) => string;
	profileTree: (home: string, name: string) => string;
	serverEnvForProfile: (home: string, name: string | null) => Record<string, string>;
	standardTree: (home: string) => string;
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-profile-leakage-"));
const loginHome = path.join(tempRoot, "login-home");
const profileName = "Demo";
fs.mkdirSync(path.join(loginHome, ".exxperts", "app"), { recursive: true, mode: 0o700 });
// A non-trivial standard tree to watch: files a real install would hold, so a
// stray write has somewhere to be noticed among.
fs.writeFileSync(path.join(loginHome, ".exxperts", "app", "smoke-sentinel.txt"), "my precious data");
fs.mkdirSync(path.join(loginHome, ".exxperts", "app", "agents"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(loginHome, ".exxperts", "app", "agents", "seeded.json"), `${JSON.stringify({ seeded: true }, null, 2)}\n`);
fs.mkdirSync(path.join(loginHome, ".exxperts", "agent"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(loginHome, ".exxperts", "agent", "auth.json"), `${JSON.stringify({ seeded: "provider tokens" }, null, 2)}\n`);
stateProfiles.createProfile(loginHome, profileName);

/** Every file under a tree as "<relative path> <size> <sha256>", sorted. */
function listing(root: string): string[] {
	const lines: string[] = [];
	const walk = (dir: string, rel: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			const next = rel ? `${rel}/${entry.name}` : entry.name;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				lines.push(`${next}/`);
				walk(abs, next);
				continue;
			}
			let bytes: Buffer;
			try {
				bytes = fs.readFileSync(abs);
			} catch {
				lines.push(`${next} unreadable`);
				continue;
			}
			lines.push(`${next} ${bytes.length} ${crypto.createHash("sha256").update(bytes).digest("hex")}`);
		}
	};
	walk(root, "");
	return lines;
}

/** The first line that differs, said in a way that names the file. */
function firstDifference(before: string[], after: string[]): string | null {
	for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
		if (before[i] !== after[i]) return `before: ${before[i] ?? "(nothing)"} / after: ${after[i] ?? "(nothing)"}`;
	}
	return null;
}

function legEnv(profile: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		// The login home, for every leg. Under this contract that is the point:
		// what a profile moves is the state, not the home.
		HOME: loginHome,
		USERPROFILE: loginHome,
		PORT: String(port),
		EXXETA_HOME: repoRoot,
		EXXPERTS_REAL_HOME: loginHome,
		EXXPERTS_LOGIN_HOME: loginHome,
		EXXPERTS_SWITCH_SUPERVISED: "1",
		...stateProfiles.serverEnvForProfile(loginHome, profile),
	};
	// The token has to be MINTED for this to mean anything, and the data folder
	// has to be the smoke's, not the operator's.
	delete env.EXXPERTS_AUTH_TOKEN;
	delete env.EXXPERTS_DATA_DIR;
	return env;
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

// Room names are unique within a tree, so each leg brings its own: a repeated
// name would 409 on the second standard leg and say nothing about leakage.
let legCount = 0;

/** Start a leg, run the three writing operations on it, stop it again. */
async function runWritingLeg(profile: string | null): Promise<void> {
	legCount += 1;
	const roomName = `Leakage Smoke Room ${legCount}`;
	const tree = profile === null ? stateProfiles.standardTree(loginHome) : stateProfiles.profileTree(loginHome, profile);
	const server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: legEnv(profile),
	});
	try {
		await waitForServer(server);
		// 1. The sign-in token: minted by the leg, into its own tree.
		const tokenFile = path.join(tree, "app", "auth-token");
		assert(fs.existsSync(tokenFile), `the leg must mint its token inside its own tree (${tokenFile})`);
		const token = fs.readFileSync(tokenFile, "utf8").trim();
		assert(token.length > 0, "the minted token must not be empty");
		const api = async (route: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> => {
			const response = await fetch(`${baseUrl}${route}`, {
				...init,
				headers: { "content-type": "application/json", "X-Exxperts-Auth": token },
				signal: AbortSignal.timeout(30000),
			});
			return { status: response.status, body: await response.json().catch(() => null) };
		};
		// 2. A room.
		const created = await api("/api/persistent-agents", {
			method: "POST",
			body: JSON.stringify({ displayName: roomName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
		});
		assert(created.status === 201, `room create must succeed on the ${profile ?? "standard"} leg, got ${created.status} ${JSON.stringify(created.body)}`);
		// 3. A setting.
		const saved = await api("/api/settings/web-search", { method: "PUT", body: JSON.stringify({ provider: "searxng", baseUrl: "http://127.0.0.1:8899" }) });
		assert(saved.status === 200, `saving a setting must succeed on the ${profile ?? "standard"} leg, got ${saved.status} ${JSON.stringify(saved.body)}`);
	} finally {
		await stopSmokeServer(server);
	}
}

try {
	// A first standard leg, so the standard tree holds what a real install's
	// does before anything is watched.
	await runWritingLeg(null);

	// The profile writes; the standard tree must not move a byte.
	const standardBefore = listing(stateProfiles.standardTree(loginHome));
	assert(standardBefore.length > 5, `the watched standard tree must be non-trivial, got ${standardBefore.length} entries`);
	await runWritingLeg(profileName);
	const standardAfter = listing(stateProfiles.standardTree(loginHome));
	const standardDrift = firstDifference(standardBefore, standardAfter);
	assert(standardDrift === null, `a loaded profile must not write into the standard tree: ${standardDrift}`);

	// And the other way round: the standard profile writes, the profile's tree
	// must not move a byte.
	const profileBefore = listing(stateProfiles.profileTree(loginHome, profileName));
	assert(profileBefore.length > 5, `the watched profile tree must be non-trivial, got ${profileBefore.length} entries`);
	await runWritingLeg(null);
	const profileAfter = listing(stateProfiles.profileTree(loginHome, profileName));
	const profileDrift = firstDifference(profileBefore, profileAfter);
	assert(profileDrift === null, `the standard profile must not write into a profile's tree: ${profileDrift}`);

	console.log("state-profile-leakage smoke: OK");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
