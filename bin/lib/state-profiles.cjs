// Data profiles: the same app pointed at different state trees (rooms, agents,
// history, wallet, memory) — the standard install and e.g. a curated demo.
//
// The standard profile IS ~/.exxperts and NEVER moves, renames, or gets a
// name — it is the anchor of the installation (backups, sync jobs, and every
// hardcoded path in the codebase point at it). Additional profiles are
// self-contained at ~/.exxperts-<name>: each is a small HOME of its own with
// its .exxperts tree nested inside (~/.exxperts-<name>/.exxperts/{app,agent}).
//
// Which profile is loaded is a pointer, not a directory move:
// ~/.exxperts/app/run/active-profile.json names the active profile (absent =
// standard). The supervisor (exxperts web launcher, desktop shell, dev
// harness) reads it on every server start and, for a non-standard profile,
// starts the server with HOME/USERPROFILE pointing at the profile dir — the
// same env indirection the desktop scratch mode and every smoke already use,
// so all state resolution lands inside the profile with zero path changes.
//
// A switch is therefore: server validates, updates the pointer, exits with
// SWITCH_EXIT_CODE; the supervisor restarts it against the new pointer.
// Nothing is ever renamed, so there is no crash window over user data. The
// pointer is desired state, not a command — replaying it is idempotent.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SWITCH_EXIT_CODE = 75;
const PROFILE_PREFIX = ".exxperts-";

function standardTree(home) {
	return path.join(home, ".exxperts");
}

/** The profile's own little HOME: ~/.exxperts-<name> */
function profileDir(home, name) {
	return path.join(home, `${PROFILE_PREFIX}${name}`);
}

/** The profile's state tree: ~/.exxperts-<name>/.exxperts */
function profileTree(home, name) {
	return path.join(profileDir(home, name), ".exxperts");
}

function activePointerPath(home) {
	return path.join(standardTree(home), "app", "run", "active-profile.json");
}

// Creation names are user-facing and must be safe on every filesystem the
// app ships to. Switch targets are laxer (isSwitchableName) so directories
// people made by hand are always reachable.
function validateNewProfileName(name) {
	if (typeof name !== "string" || !name.length) return "Give the profile a name.";
	if (name !== name.trim()) return "The name cannot start or end with spaces.";
	if (name.length > 64) return "Keep the name at 64 characters or fewer.";
	if (/[\/\\:*?"<>|\x00-\x1f]/.test(name)) return 'The name cannot contain / \\ : * ? " < > | or control characters.';
	if (name.startsWith(".") || name.endsWith(".")) return "The name cannot start or end with a dot.";
	if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) return "That name is reserved on Windows.";
	return null;
}

function isSwitchableName(name) {
	if (typeof name !== "string" || !name.length) return false;
	if (name === "." || name === "..") return false;
	return !/[\/\\\x00]/.test(name);
}

/** The loaded profile's name, or null for the standard ~/.exxperts. */
function readActiveProfile(home) {
	try {
		const parsed = JSON.parse(fs.readFileSync(activePointerPath(home), "utf8"));
		if (isSwitchableName(parsed.name) && fs.existsSync(profileDir(home, parsed.name))) return parsed.name;
	} catch {
		// No pointer: the standard profile.
	}
	return null;
}

/** Point the app at a profile (name) or back at the standard tree (null). */
function writeActiveProfile(home, name) {
	const file = activePointerPath(home);
	if (name === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ name }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

// The env a supervisor gives the server for the active profile. For the
// standard profile: nothing. For a named one: the same whole-tree relocation
// the desktop scratch mode uses — HOME/USERPROFILE plus the one runtime dir
// that has its own env override.
function serverEnvForProfile(home, name) {
	if (name === null) return {};
	const dir = profileDir(home, name);
	return {
		HOME: dir,
		USERPROFILE: dir,
		EXXPERTS_CODING_AGENT_DIR: path.join(dir, ".exxperts", "agent"),
	};
}

// EVERY ~/.exxperts-<name> directory is a profile — including ones made by
// hand or copied there (a raw `cp -r ~/.exxperts ~/.exxperts-snapshot`
// included). Whatever shape it has, normalizeProfileDir gives it the nested
// layout on first activation. Loaded one included; the standard ~/.exxperts
// is not in this list (it has no name).
function listProfiles(home) {
	let entries;
	try {
		entries = fs.readdirSync(home, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isDirectory() && e.name.startsWith(PROFILE_PREFIX) && e.name.length > PROFILE_PREFIX.length)
		.map((e) => ({ name: e.name.slice(PROFILE_PREFIX.length) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// The filesystem aliases names (case-insensitive APFS, Windows trailing-dot
// stripping), so an exact-compare guard plus existsSync would let "demo"
// address ~/.exxperts-Demo — including for deletion while it is loaded.
// Every destructive or activating call therefore resolves the requested
// name to the exact directory-entry spelling first, or refuses.
function resolveListedName(home, name) {
	if (!isSwitchableName(name)) return null;
	return listProfiles(home).some((p) => p.name === name) ? name : null;
}

// A profile dir can arrive in any shape: empty (created here or by hand), a
// raw copied state tree (app/agent at its root), or with its nested .exxperts
// already in place. Normalizing wraps whatever is there into the nested
// layout, so every ~/.exxperts-<name> dir is loadable as-is.
function normalizeProfileDir(dir) {
	const tree = path.join(dir, ".exxperts");
	if (fs.existsSync(tree)) return;
	// Staged: entries move into a temp dir first and the finished tree is
	// renamed into place last, so a failure mid-move (Windows AV holding a
	// file, say) never leaves a half-tree that the existsSync guard above
	// would then freeze forever. On failure the moved entries go back.
	const staging = path.join(dir, `.exxperts.tmp-${process.pid}`);
	fs.mkdirSync(staging, { mode: 0o700 });
	const entries = fs.readdirSync(dir).filter((e) => e !== path.basename(staging));
	const moved = [];
	try {
		for (const entry of entries) {
			fs.renameSync(path.join(dir, entry), path.join(staging, entry));
			moved.push(entry);
		}
		fs.renameSync(staging, tree);
	} catch (err) {
		for (const entry of moved) {
			try {
				fs.renameSync(path.join(staging, entry), path.join(dir, entry));
			} catch {}
		}
		try {
			fs.rmSync(staging, { recursive: true, force: true });
		} catch {}
		throw err;
	}
}

// Empty on purpose: the first boot as the active profile lazily seeds the
// nested tree like any fresh install.
function createProfile(home, name) {
	const invalid = validateNewProfileName(name);
	if (invalid) throw new Error(invalid);
	const dir = profileDir(home, name);
	if (fs.existsSync(dir)) throw new Error(`A profile named "${name}" already exists.`);
	fs.mkdirSync(path.join(dir, ".exxperts"), { recursive: true, mode: 0o700 });
}

// Deleting is forever, so the guards live here and not only in the screen.
// The standard profile has no name and can never be addressed by this call.
// The dir is renamed aside instantly (gone from listings and unreachable by
// the prefix) and the recursive delete runs afterwards off the caller's
// thread — a copied 300MB tree must not stall the server's event loop.
function deleteProfile(home, name) {
	const listed = resolveListedName(home, name);
	if (listed === null) throw new Error(`There is no profile named "${name}".`);
	if (listed === readActiveProfile(home)) throw new Error("The loaded profile cannot be deleted.");
	const dir = profileDir(home, listed);
	const doomed = path.join(home, `.exxperts.deleting-${Date.now().toString(36)}-${process.pid}`);
	fs.renameSync(dir, doomed);
	void fs.promises.rm(doomed, { recursive: true, force: true }).catch(() => {});
	// A crash between rename and rm leaves a .exxperts.deleting-* husk; the
	// next delete sweeps them. (The dot after "exxperts" keeps them out of
	// the profile prefix, so they can never be listed.)
	for (const entry of fs.readdirSync(home)) {
		if (entry.startsWith(".exxperts.deleting-") && path.join(home, entry) !== doomed) {
			void fs.promises.rm(path.join(home, entry), { recursive: true, force: true }).catch(() => {});
		}
	}
}

// The sign-in token lives inside each profile's tree, so a switch rotates it
// and the already-open page could never follow the restart on its own.
// Minting the target's token BEFORE the restart lets the switch reply carry
// the new sign-in link; the next boot reads this same file instead of
// minting another. name null = the standard tree's token.
function ensureProfileToken(home, name) {
	const appDir = path.join(name === null ? standardTree(home) : profileTree(home, name), "app");
	const tokenFile = path.join(appDir, "auth-token");
	try {
		const existing = fs.readFileSync(tokenFile, "utf8").trim();
		if (existing) return existing;
	} catch {
		// No token yet: first activation of this profile.
	}
	const minted = crypto.randomBytes(32).toString("hex");
	fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(tokenFile, `${minted}\n`, { mode: 0o600 });
	return minted;
}

/** Where the ACTIVE profile's sign-in token lives (for supervisors). */
function activeTokenPath(home) {
	const active = readActiveProfile(home);
	return path.join(active === null ? standardTree(home) : profileTree(home, active), "app", "auth-token");
}

// Server side, all of it BEFORE the route replies: validate while we can
// still answer 409, point the app at the target, hand back its token.
// target null = back to the standard profile.
function prepareSwitch(home, target) {
	const active = readActiveProfile(home);
	if (target === null) {
		if (active === null) throw new Error("The standard profile is already loaded.");
	} else {
		const listed = resolveListedName(home, target);
		if (listed === null) throw new Error(`There is no profile named "${target}".`);
		target = listed;
		if (target === active) throw new Error(`"${target}" is already the loaded profile.`);
		normalizeProfileDir(profileDir(home, target));
	}
	const token = ensureProfileToken(home, target);
	writeActiveProfile(home, target);
	return token;
}

module.exports = {
	SWITCH_EXIT_CODE,
	PROFILE_PREFIX,
	standardTree,
	profileDir,
	profileTree,
	activePointerPath,
	activeTokenPath,
	validateNewProfileName,
	isSwitchableName,
	readActiveProfile,
	writeActiveProfile,
	serverEnvForProfile,
	listProfiles,
	createProfile,
	deleteProfile,
	ensureProfileToken,
	prepareSwitch,
};
