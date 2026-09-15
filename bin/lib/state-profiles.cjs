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

// ---------------------------------------------------------------------------
// The exxperts home: the ONE directory holding the whole state family — the
// standard .exxperts tree plus every .exxperts-<name> profile. Default: the
// OS login home. It can be relocated (issue #60), resolved in this order:
//
//   1. EXXPERTS_DATA_DIR (env): operator pinning for containers/automation.
//      While set, the in-app move is refused — the operator owns the location.
//   2. <loginHome>/.exxperts.home.json: written by Settings → Profiles →
//      "Move". The dotted name keeps it outside the .exxperts-<name> profile
//      namespace, same trick as .exxperts.deleting-*.
//   3. Neither: the login home itself, unchanged from before this feature.
//
// Everything downstream rides on the same env indirection profiles use:
// entry points adopt the home into HOME/USERPROFILE once, and every
// homedir()-based state resolution in the process and its children follows.
//
// An in-app move reuses the switch protocol's shape: the server validates,
// writes an intent file next to the pointer, replies with the sign-in link,
// and exits with the sentinel; the SUPERVISOR executes the move while
// nothing has the trees open, updates the pointer, and starts the next leg
// against the new home. performPendingHomeMove is also called by supervisors
// at cold start, so an intent stranded by a crash heals on the next launch.
// ---------------------------------------------------------------------------

function homePointerPath(loginHome) {
	return path.join(loginHome, ".exxperts.home.json");
}

function homeMoveIntentPath(loginHome) {
	return path.join(loginHome, ".exxperts.home-move.json");
}

function readHomePointer(loginHome) {
	try {
		const parsed = JSON.parse(fs.readFileSync(homePointerPath(loginHome), "utf8"));
		if (typeof parsed.dir === "string" && parsed.dir.trim()) return path.resolve(parsed.dir.trim());
	} catch {
		// No or unreadable pointer: the default home.
	}
	return null;
}

function writeHomePointer(loginHome, dir) {
	const file = homePointerPath(loginHome);
	if (dir === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ dir }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Where the state family lives, and why: {home, source: env|setting|default}. */
function resolveStateHome(loginHome, env = process.env) {
	const raw = env.EXXPERTS_DATA_DIR;
	if (raw && raw.trim()) return { home: path.resolve(raw.trim()), source: "env" };
	const pointed = readHomePointer(loginHome);
	if (pointed !== null) {
		// Never fall back silently: booting against the login home while the
		// data sits elsewhere would look exactly like data loss.
		if (!fs.existsSync(pointed)) {
			throw new Error(`Your exxperts home is set to "${pointed}" (in ${homePointerPath(loginHome)}), but that folder is not there right now. Reconnect the drive or cloud folder it lives on — or delete that file to start over against "${loginHome}".`);
		}
		return { home: pointed, source: "setting" };
	}
	return { home: loginHome, source: "default" };
}

// Create-if-missing plus a writability gate, with an actionable message.
function ensureUsableHome(dir, pointsAt) {
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.accessSync(dir, fs.constants.W_OK);
	} catch (err) {
		let problem = `cannot be created (${err.code || err.message})`;
		try {
			problem = !fs.statSync(dir).isDirectory()
				? "is a file, not a directory"
				: (err.code === "EACCES" || err.code === "EPERM" ? "is not writable" : `is not usable (${err.code || err.message})`);
		} catch {
			// Nothing there: the mkdir failure message stands.
		}
		throw new Error(`${pointsAt} points at "${dir}", but that directory ${problem}. Point it at a writable directory, or fall back to the default ~/.exxperts.`);
	}
}

// Entry points call this FIRST, before anything resolves a state path
// (os.homedir() reads env per call): resolves the home, validates it, and
// repoints the env at it. loginHome must be the REAL login home, captured
// before any repointing. Returns {home, source}.
function adoptStateHome(loginHome, env = process.env) {
	const resolved = resolveStateHome(loginHome, env);
	if (resolved.home !== loginHome) {
		ensureUsableHome(resolved.home, resolved.source === "env" ? "EXXPERTS_DATA_DIR" : `Your exxperts home setting (${homePointerPath(loginHome)})`);
		Object.assign(env, {
			HOME: resolved.home,
			USERPROFILE: resolved.home,
			EXXPERTS_CODING_AGENT_DIR: path.join(resolved.home, ".exxperts", "agent"),
		});
	}
	return resolved;
}

/** The family members present in a home: ".exxperts" and every ".exxperts-<name>". */
function listStateFamily(home) {
	let entries;
	try {
		entries = fs.readdirSync(home, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isDirectory() && (e.name === ".exxperts" || (e.name.startsWith(PROFILE_PREFIX) && e.name.length > PROFILE_PREFIX.length)))
		.map((e) => e.name)
		.sort();
}

function sameDir(a, b) {
	try {
		return fs.realpathSync(a) === fs.realpathSync(b);
	} catch {
		return path.resolve(a) === path.resolve(b);
	}
}

// Validate a move target and say what a confirmation must disclose:
// {dir, mode, moving}. mode "migrate" moves the family there; mode "adopt"
// means the target already holds exxperts data (the other-computer case for
// a cloud-synced folder) — it is used as-is and NOTHING is moved or merged.
function planHomeMove(currentHome, target) {
	const raw = typeof target === "string" ? target.trim() : "";
	if (!raw) throw new Error("Choose a folder.");
	const dir = path.resolve(raw);
	ensureUsableHome(dir, "The chosen folder");
	if (sameDir(dir, currentHome)) throw new Error(`Exxperts already keeps its data in "${dir}".`);
	for (const name of listStateFamily(currentHome)) {
		const tree = path.join(currentHome, name);
		if (sameDir(dir, tree) || dir.startsWith(tree + path.sep)) {
			throw new Error(`"${dir}" is inside "${tree}", which is part of what would move. Choose a folder outside the exxperts data.`);
		}
	}
	const mode = listStateFamily(dir).length > 0 ? "adopt" : "migrate";
	return { dir, mode, moving: mode === "migrate" ? listStateFamily(currentHome) : [] };
}

// Move every family member from one home to another — by COPYING everything
// first and deleting the sources only after every copy landed. Never a
// rename: the old home stays complete until the very last step, so a crash,
// a Ctrl+C, or a pulled cable at ANY point leaves at least one whole copy of
// the data, and re-running simply starts the copy phase over.
//
// Per entry, the copy goes into a dotted staging dir and is renamed into its
// final name only when complete, so a half-copied tree can never be mistaken
// for a finished one. A destination entry that already exists is the debris
// of an interrupted earlier run (migrate mode only ever targets a folder
// that held no exxperts data when the move was decided) and is rebuilt from
// the still-complete source. A failure removes what this run created and
// throws; the old home was never touched.
function migrateStateFamily(fromHome, toDir) {
	const names = listStateFamily(fromHome);
	// Debris of interrupted earlier runs.
	for (const entry of fs.readdirSync(toDir)) {
		if (entry.startsWith(".exxperts.copying-")) fs.rmSync(path.join(toDir, entry), { recursive: true, force: true });
	}
	const copied = [];
	try {
		for (const name of names) {
			const src = path.join(fromHome, name);
			const dest = path.join(toDir, name);
			fs.rmSync(dest, { recursive: true, force: true });
			const staging = path.join(toDir, `.exxperts.copying-${process.pid}-${name.replace(/[^\w.-]+/g, "_")}`);
			fs.cpSync(src, staging, { recursive: true, verbatimSymlinks: true });
			fs.renameSync(staging, dest);
			copied.push(name);
		}
	} catch (err) {
		for (const name of copied) {
			try {
				fs.rmSync(path.join(toDir, name), { recursive: true, force: true });
			} catch {
				// Best effort; the sources were never touched.
			}
		}
		throw err;
	}
	// Every copy landed: only now do the sources go. A source that refuses to
	// delete (a file held open, say) stays behind as an inert duplicate — the
	// new home is complete and authoritative either way.
	for (const name of names) {
		try {
			fs.rmSync(path.join(fromHome, name), { recursive: true, force: true });
		} catch {
			// See above.
		}
	}
}

// Server side of a move, BEFORE the exit (mirrors prepareSwitch): validate,
// record the intent for the supervisor, hand back the sign-in token the
// restarted leg will honor. For a migrate the token travels with the tree
// (same value); for an adopt it is the target's own token, minted now if
// that home never ran.
function prepareHomeMove(loginHome, currentHome, target) {
	const plan = planHomeMove(currentHome, target);
	const tokenHome = plan.mode === "adopt" ? plan.dir : currentHome;
	const token = ensureProfileToken(tokenHome, readActiveProfile(tokenHome));
	const file = homeMoveIntentPath(loginHome);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ from: currentHome, to: plan.dir, mode: plan.mode }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
	return { ...plan, token };
}

// Supervisor side: execute a recorded move, point the home at the target,
// clear the intent. Returns {to, mode} when something happened, null when
// there was nothing to do. A failed migration rolls back, drops the intent
// (retry is a fresh decision in the UI, not a crash loop), and rethrows so
// the supervisor can say what happened; the pointer then still names the old
// home, which is intact.
function performPendingHomeMove(loginHome) {
	let intent;
	try {
		intent = JSON.parse(fs.readFileSync(homeMoveIntentPath(loginHome), "utf8"));
	} catch {
		return null;
	}
	const to = typeof intent.to === "string" && intent.to.trim() ? path.resolve(intent.to.trim()) : null;
	// The source is recorded in the intent, so a resume stays exact whatever
	// state the crash left behind.
	const fromHome = typeof intent.from === "string" && intent.from.trim() ? path.resolve(intent.from.trim()) : null;
	if (to === null || fromHome === null) {
		fs.rmSync(homeMoveIntentPath(loginHome), { force: true });
		return null;
	}
	try {
		fs.mkdirSync(to, { recursive: true, mode: 0o700 });
		if (intent.mode !== "adopt" && fs.existsSync(fromHome) && !sameDir(fromHome, to)) migrateStateFamily(fromHome, to);
	} catch (err) {
		fs.rmSync(homeMoveIntentPath(loginHome), { force: true });
		throw err;
	}
	writeHomePointer(loginHome, sameDir(to, loginHome) ? null : to);
	fs.rmSync(homeMoveIntentPath(loginHome), { force: true });
	return { to, mode: intent.mode === "adopt" ? "adopt" : "migrate" };
}

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
	homePointerPath,
	homeMoveIntentPath,
	readHomePointer,
	writeHomePointer,
	resolveStateHome,
	adoptStateHome,
	listStateFamily,
	planHomeMove,
	migrateStateFamily,
	prepareHomeMove,
	performPendingHomeMove,
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
