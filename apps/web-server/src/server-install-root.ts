import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.EXXETA_HOME ? path.resolve(process.env.EXXETA_HOME) : path.resolve(__dirname, "..", "..", "..");

const PKG = path.join(REPO_ROOT, "pi-package");

// Advisory room lock shared with the CLI (plain CJS so both can use it).
type RoomLockRecord = {
	surface: string;
	acquiredAt: number;
	lastSeen?: number;
	pid?: number;
	host?: string;
	connectionId?: string | null;
	lockId?: string | null;
	runId?: string | null;
	label?: string | null;
};

const roomLock = createRequire(import.meta.url)(path.join(REPO_ROOT, "bin", "lib", "room-lock.cjs")) as {
	tryAcquire: (agentId: string, owner: Record<string, unknown>) => { ok: boolean; heldBy?: RoomLockRecord };
	heartbeat: (agentId: string, owner: Record<string, unknown>) => void;
	release: (agentId: string, owner: Record<string, unknown>) => void;
	readLock: (agentId: string) => RoomLockRecord | null;
	isActive: (lock: unknown) => boolean;
};

function activeRoomLock(agentId: string): { surface: string; acquiredAt: number } | null {
	const lock = roomLock.readLock(agentId);
	return lock && roomLock.isActive(lock) ? { surface: lock.surface, acquiredAt: lock.acquiredAt } : null;
}

// Data profiles. The standard profile IS ~/.exxperts and never moves; other
// profiles live at ~/.exxperts-<name> and are activated via a pointer file
// plus env indirection, the same CJS module the launcher, desktop shell, and
// dev harness use. When a profile is active, THIS process runs with an
// overridden HOME, so profile management must address the REAL home, which
// the supervisor passes in EXXPERTS_REAL_HOME.
const stateProfiles = createRequire(import.meta.url)(path.join(REPO_ROOT, "bin", "lib", "state-profiles.cjs")) as {
	SWITCH_EXIT_CODE: number;
	validateNewProfileName: (name: string) => string | null;
	readActiveProfile: (home: string) => string | null;
	listProfiles: (home: string) => { name: string }[];
	createProfile: (home: string, name: string) => void;
	deleteProfile: (home: string, name: string) => void;
	prepareSwitch: (home: string, target: string | null) => string;
	resolveStateHome: (loginHome: string, env?: NodeJS.ProcessEnv) => { home: string; source: "env" | "setting" | "default" };
	planHomeMove: (currentHome: string, target: string) => { dir: string; mode: "migrate" | "adopt"; moving: string[] };
	prepareHomeMove: (loginHome: string, currentHome: string, target: string) => { dir: string; mode: "migrate" | "adopt"; moving: string[]; token: string };
};

function stateProfileRealHome(): string {
	return process.env.EXXPERTS_REAL_HOME?.trim() || os.homedir();
}

// Where the exxperts-home pointer and move intents live: the OS login home.
// This process may run under a repointed HOME (moved home, active profile),
// so the supervisor passes the login home in; os.userInfo() is the
// env-independent fallback for servers started some other way.
function stateProfileLoginHome(): string {
	const fromEnv = process.env.EXXPERTS_LOGIN_HOME?.trim();
	if (fromEnv) return fromEnv;
	try {
		const fromAccount = os.userInfo().homedir;
		if (fromAccount) return fromAccount;
	} catch {
		// No account record (some containers): fall through.
	}
	return os.homedir();
}

function roomLockBusyStatus(lock: Pick<RoomLockRecord, "surface"> | null | undefined): string {
	if (lock?.surface === "scheduler") return "working on a scheduled background task";
	return "open in another browser session";
}

function roomLockBusyInstruction(lock: Pick<RoomLockRecord, "surface"> | null | undefined): string {
	if (lock?.surface === "scheduler") return "Wait for it to finish before opening it, to avoid conflicting edits.";
	return "Close it there before opening it here, to avoid conflicting edits.";
}

export { PKG, REPO_ROOT, activeRoomLock, roomLock, roomLockBusyInstruction, roomLockBusyStatus, stateProfileLoginHome, stateProfileRealHome, stateProfiles };
