// The one-time What's new window after an update, at module level: the
// changelog section parser and the show/record decision. What has to hold:
// a fresh install records the current version silently and shows nothing;
// the window speaks in minors — what it shows is the changelog section of
// the running version's x.y.0 base, so a pure patch update inside a seen
// minor records silently and an update crossing a minor boundary shows the
// x.y.0 bullets under the running version; dismissing records and the
// window never returns for that version; a version the changelog says
// nothing about (its base's section missing and its own too) records
// silently, because an empty window helps nobody. And the ambiguous case:
// no record but prior app state on disk is an update into the first version
// carrying this feature, so it must show, not record until seen.
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
	minorBase,
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
	assert(minorBase("0.10.1") === "0.10.0", "a patch must base at its minor's x.y.0");
	assert(minorBase("0.10.0") === "0.10.0", "an x.y.0 must be its own base");
	assert(minorBase("1.2.3") === "1.2.0", "the base must keep major and minor");

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

	// An update crossing a minor boundary: the record is older than the
	// running version's x.y.0 base, so the window shows — with the base
	// section's bullets, because the window speaks in minors — under the
	// running version.
	recordAcknowledgedVersion("0.8.2");
	const updated = resolveWhatsNew(packageRoot);
	assert(updated.show === true, "an update past the acknowledged minor must show");
	assert(updated.version === "0.9.3", "the shown version must be the running one");
	assert(updated.entries !== null && updated.entries.length === 2, "the shown entries must be the minor base's section");
	assert(updated.entries[0] === "Rooms: the last section in the file.", "the entries must come from the 0.9.0 section");
	assert(readAcknowledgedVersion() === "0.8.2", "showing must not record; only dismissing does");

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

	// A pure patch update inside the seen minor: CHANGELOG.md still
	// documents it, only the window stays quiet, and the record advances so
	// the next update counts from here.
	fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "x", version: "0.9.4" })}\n`);
	const silent = resolveWhatsNew(packageRoot);
	assert(silent.show === false, "a patch inside an acknowledged minor must not show");
	assert(readAcknowledgedVersion() === "0.9.4", "a quiet patch must be recorded so the next update counts from it");

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
	assert(debut.entries !== null && debut.entries.length === 2, "the debut must carry the minor base's entries");
	assert(debut.entries[0] === "Rooms: the last section in the file.", "the debut's entries must come from the 0.9.0 section");
	assert(readAcknowledgedVersion() === null, "the debut must not record until seen");
	assert(resolveWhatsNew(packageRoot).show === true, "the unseen debut must survive a reload");
	acknowledgeWhatsNew(packageRoot);
	assert(readAcknowledgedVersion() === "0.9.3", "dismissing the debut must record the current version");
	assert(resolveWhatsNew(packageRoot).show === false, "a seen debut must never return");

	// --- The window speaks in minors, on a changelog with a patch on top ---
	const minorChangelog = [
		"# Changelog",
		"",
		"## 0.10.1 (2026-08-20)",
		"",
		"- Fixed: a patch-sized correction.",
		"",
		"## 0.10.0 (2026-08-19)",
		"",
		"- Rooms: the minor's headline feature.",
		"- Fixed: the minor's second bullet.",
		"",
		"## 0.9.2 (2026-08-14)",
		"",
		"- Fixed: an old bullet.",
		"",
	].join("\n");
	fs.writeFileSync(path.join(packageRoot, "CHANGELOG.md"), minorChangelog);

	// Running an x.y.0 exactly: nothing about the minor rule changes what an
	// older acknowledged version sees — its own section, shown.
	fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "x", version: "0.10.0" })}\n`);
	recordAcknowledgedVersion("0.9.2");
	const atBase = resolveWhatsNew(packageRoot);
	assert(atBase.show === true, "an update to an x.y.0 must show");
	assert(atBase.version === "0.10.0", "the x.y.0 must be shown as itself");
	assert(atBase.entries !== null && atBase.entries.length === 2 && atBase.entries[0] === "Rooms: the minor's headline feature.", "the x.y.0 must show its own section");
	assert(readAcknowledgedVersion() === "0.9.2", "showing an x.y.0 must not record");

	// A pure patch update: the minor was acknowledged, so the window stays
	// quiet even though the changelog has a 0.10.1 section, and the record
	// advances to the running version.
	fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "x", version: "0.10.1" })}\n`);
	recordAcknowledgedVersion("0.10.0");
	const patch = resolveWhatsNew(packageRoot);
	assert(patch.show === false, "a patch on an acknowledged minor must not show");
	assert(patch.entries === null, "a quiet patch must carry no entries");
	assert(readAcknowledgedVersion() === "0.10.1", "a quiet patch must advance the record to the running version");

	// An update crossing the minor boundary while a patch runs: the 0.10.0
	// section's bullets, under the running 0.10.1.
	recordAcknowledgedVersion("0.9.2");
	const crossed = resolveWhatsNew(packageRoot);
	assert(crossed.show === true, "crossing a minor boundary must show");
	assert(crossed.version === "0.10.1", "the payload version must stay the running one");
	assert(crossed.entries !== null && crossed.entries.length === 2, "the crossing update must carry the x.y.0 section");
	assert(crossed.entries[0] === "Rooms: the minor's headline feature.", "the bullets must be the 0.10.0 section's, not the patch's");
	assert(readAcknowledgedVersion() === "0.9.2", "crossing must not record until seen");
	acknowledgeWhatsNew(packageRoot);
	assert(readAcknowledgedVersion() === "0.10.1", "dismissing must record the running version");
	assert(resolveWhatsNew(packageRoot).show === false, "a dismissed crossing update must never return");

	// Fallback honesty: no 0.10.0 section, but the running 0.10.1 has one of
	// its own — that beats saying nothing.
	fs.writeFileSync(path.join(packageRoot, "CHANGELOG.md"), ["# Changelog", "", "## 0.10.1 (2026-08-20)", "", "- Fixed: a patch-sized correction.", ""].join("\n"));
	recordAcknowledgedVersion("0.9.2");
	const fallback = resolveWhatsNew(packageRoot);
	assert(fallback.show === true, "a missing x.y.0 section must fall back to the running version's own");
	assert(fallback.entries !== null && fallback.entries.length === 1 && fallback.entries[0] === "Fixed: a patch-sized correction.", "the fallback must carry the running version's entries");
	assert(readAcknowledgedVersion() === "0.9.2", "the fallback must not record until seen");

	// Neither section exists: recorded silently, never an empty window.
	fs.writeFileSync(path.join(packageRoot, "CHANGELOG.md"), ["# Changelog", "", "## 0.9.2 (2026-08-14)", "", "- Fixed: an old bullet.", ""].join("\n"));
	const sectionless = resolveWhatsNew(packageRoot);
	assert(sectionless.show === false, "a version without any section to show must not show");
	assert(readAcknowledgedVersion() === "0.10.1", "a sectionless version must be recorded so the next update counts from it");

	console.log("whats-new smoke: all assertions passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
