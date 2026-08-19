// The one-time What's new window after an update, at module level: the
// changelog section parser and the show/record decision. What has to hold:
// a fresh install records the current version silently and shows nothing; an
// update from an acknowledged older version shows exactly the new version's
// changelog bullets; dismissing records and the window never returns for
// that version; a version the changelog says nothing about records silently,
// because an empty window helps nobody. And the ambiguous case: no record
// but prior app state on disk is an update into the first version carrying
// this feature, so it must show, not record until seen.
//
// Run: node scripts/run-smokes.mjs whats-new

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The acknowledged version persists under ~/.exxperts/app; isolate HOME
// before the module (and the state-path helper it uses) is loaded.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-whats-new-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const {
	acknowledgeWhatsNew,
	compareVersions,
	hasPriorInstallationState,
	parseChangelogEntries,
	readAcknowledgedVersion,
	recordAcknowledgedVersion,
	resolveWhatsNew,
	whatsNewStatePath,
} = await import("../src/whats-new.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	// --- Changelog parsing ---
	const changelog = [
		"# Changelog",
		"",
		"Prose above the first section is not an entry.",
		"",
		"## 0.9.3 (2026-08-15)",
		"",
		"- Fixed: a long paragraph about the newest release.",
		"",
		"- Rooms: a second bullet",
		"  that wraps onto a continuation line.",
		"",
		"## 0.9.2 (2026-08-14)",
		"",
		"- Fixed: the older release's only bullet.",
		"",
		"## 0.9.0 (2026-08-14)",
		"",
		"- Rooms: the last section in the file.",
		"- The app tells you a new version exists.",
		"",
	].join("\n");

	// Version present, in the middle: its bullets and only its bullets,
	// leading "- " stripped, wrapped lines joined.
	const middle = parseChangelogEntries(changelog, "0.9.3");
	assert(middle !== null, "0.9.3 section must be found");
	assert(middle.length === 2, `0.9.3 must have two entries, got ${middle.length}`);
	assert(middle[0] === "Fixed: a long paragraph about the newest release.", "first entry must lose its leading dash");
	assert(middle[1] === "Rooms: a second bullet that wraps onto a continuation line.", "a wrapped bullet must read as one entry");

	// The last section in the file: no trailing heading to stop at.
	const last = parseChangelogEntries(changelog, "0.9.0");
	assert(last !== null && last.length === 2, "the last section must be parsed to the end of the file");
	assert(last[1] === "The app tells you a new version exists.", "the last section's entries must be intact");

	// Version absent: null, not an empty list, so the caller can tell "no
	// section" from "a section with nothing in it".
	assert(parseChangelogEntries(changelog, "0.9.1") === null, "an absent version must parse to null");

	// --- Version comparison ---
	assert(compareVersions("0.9.3", "0.10.0") < 0, "0.9.3 must compare below 0.10.0");
	assert(compareVersions("0.10.0", "0.10.0") === 0, "equal versions must compare equal");
	assert(compareVersions("1.0.0", "0.10.0") > 0, "1.0.0 must compare above 0.10.0");

	// --- Show/record state logic against a synthetic package root ---
	const packageRoot = path.join(tempHome, "package-root");
	fs.mkdirSync(packageRoot, { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "x", version: "0.9.3" })}\n`);
	fs.writeFileSync(path.join(packageRoot, "CHANGELOG.md"), changelog);

	// Fresh install: no record exists AND the app state dir carries no trace
	// of prior use, so the current version is recorded on the spot and
	// nothing is shown; nothing here is new to a new user.
	assert(!fs.existsSync(whatsNewStatePath()), "the smoke must start with no state file");
	assert(hasPriorInstallationState() === false, "an empty home must read as a fresh install");
	// Boot stamps a dot-led migration marker inside personalized-agents on a
	// fresh install too; it must not read as prior life.
	const roomsDir = path.join(tempHome, ".exxperts", "app", "personalized-agents");
	fs.mkdirSync(roomsDir, { recursive: true });
	fs.writeFileSync(path.join(roomsDir, ".mcp-grants-migration.json"), "{}\n");
	assert(hasPriorInstallationState() === false, "boot-stamped dot entries must not read as prior installation state");
	const fresh = resolveWhatsNew(packageRoot);
	assert(fresh.show === false, "a fresh install must not be shown the window");
	assert(fresh.entries === null, "a fresh install must not receive entries");
	assert(readAcknowledgedVersion() === "0.9.3", "a fresh install must record the current version silently");

	// Same version again: still quiet.
	const again = resolveWhatsNew(packageRoot);
	assert(again.show === false, "an acknowledged version must stay quiet");

	// An update: the record is older, the changelog has a section, so the
	// window shows with exactly that section's entries.
	recordAcknowledgedVersion("0.9.0");
	const updated = resolveWhatsNew(packageRoot);
	assert(updated.show === true, "an update past the acknowledged version must show");
	assert(updated.version === "0.9.3", "the shown version must be the running one");
	assert(updated.entries !== null && updated.entries.length === 2, "the shown entries must be the running version's section");
	assert(readAcknowledgedVersion() === "0.9.0", "showing must not record; only dismissing does");

	// Asking again before dismissal: still shows. One-time means until seen,
	// not until fetched.
	assert(resolveWhatsNew(packageRoot).show === true, "an unseen window must survive a reload");

	// Dismissal: records the current version, idempotently, and the window
	// never returns for it.
	acknowledgeWhatsNew(packageRoot);
	assert(readAcknowledgedVersion() === "0.9.3", "seen must record the current version");
	acknowledgeWhatsNew(packageRoot);
	assert(readAcknowledgedVersion() === "0.9.3", "seen must be idempotent");
	assert(resolveWhatsNew(packageRoot).show === false, "a seen version must never show again");

	// An update whose changelog says nothing: recorded silently, never an
	// empty window, and the next update counts from here.
	fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "x", version: "0.9.4" })}\n`);
	const silent = resolveWhatsNew(packageRoot);
	assert(silent.show === false, "a version without a changelog section must not show");
	assert(readAcknowledgedVersion() === "0.9.4", "a sectionless version must be recorded so the next update counts from it");

	// A downgrade: the record is newer than the running version; quiet, and
	// the newer record stands.
	fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "x", version: "0.9.3" })}\n`);
	const downgraded = resolveWhatsNew(packageRoot);
	assert(downgraded.show === false, "a downgrade must not show the window");
	assert(readAcknowledgedVersion() === "0.9.4", "a downgrade must not rewrite the record");

	// --- Update into the first version that carries this feature ---
	// No record (the updated-from version never wrote one), but the state
	// dir shows prior life: that is an update, not a fresh install, and the
	// window must debut without recording until it is seen.
	fs.rmSync(whatsNewStatePath(), { force: true });
	const usageMarker = path.join(tempHome, ".exxperts", "app", "usage.jsonl");
	fs.mkdirSync(path.dirname(usageMarker), { recursive: true });
	fs.writeFileSync(usageMarker, "");
	assert(hasPriorInstallationState() === true, "a usage log must read as prior installation state");
	const debut = resolveWhatsNew(packageRoot);
	assert(debut.show === true, "an existing installation with no record must be shown the window");
	assert(debut.version === "0.9.3", "the debut must show the running version");
	assert(debut.entries !== null && debut.entries.length === 2, "the debut must carry the running version's entries");
	assert(readAcknowledgedVersion() === null, "the debut must not record until seen");
	assert(resolveWhatsNew(packageRoot).show === true, "the unseen debut must survive a reload");
	acknowledgeWhatsNew(packageRoot);
	assert(readAcknowledgedVersion() === "0.9.3", "dismissing the debut must record the current version");
	assert(resolveWhatsNew(packageRoot).show === false, "a seen debut must never return");

	console.log("whats-new smoke: all assertions passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
