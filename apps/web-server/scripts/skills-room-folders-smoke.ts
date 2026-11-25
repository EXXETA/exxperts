import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Which skills' folders a room may open (`roomSkillFolders`), the one list both
// boxes, the file fence and read_skill's paths read: a skill on in the room, in
// the app's own skills folder, as a plain folder there, or in the folder shared
// with other tools at its real folder, one marked for picking by
// hand included, while it is on. No approval and no pin: an old entry and a changed skill are on as they
// now are. A project copy tells the model its files are out of every room's
// reach. Module level, in the smoke's own folders.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-skill-folders-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(root, "rooms");
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(root, "agent");
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
// The project skills folder, `<EXXETA_HOME>/.exxeta/skills`, in a project of the
// smoke's own that borrows the repository's bin folder, which the server loads.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
process.env.EXXETA_HOME = path.join(root, "project");
fs.mkdirSync(process.env.EXXETA_HOME, { recursive: true });
fs.symlinkSync(path.join(repoRoot, "bin"), path.join(process.env.EXXETA_HOME, "bin"), "junction");
fs.mkdirSync(process.env.HOME, { recursive: true });

const { disablePersistentRoomSkill, enablePersistentRoomSkill, effectiveEnabledSkills, persistentRoomSkillSettingsPath, readPersistentRoomSkillSettings } = await import("../src/persistent-room-skill-settings.js");
const { agentSkillsDir, sha256, sharedAgentsSkillsDir, writeSkillFileText, writeSkillProvenance } = await import("../src/skills-store.js");
const { librarySkillFolderView, readLibrarySkill, roomSkillFolders } = await import("../src/skills-executable.js");
const { getUserSkillFile, librarySkillFiles, listSkills } = await import("../src/skills-library.js");
const { setRoomBoxForTests } = await import("../src/room-box/box-available.js");
const { createReadSkillTool, roomSkillFilesView, skillFilesSection } = await import("../src/persistent-room-skill-tool.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// Every row runs, so one run names each answer that is wrong.
const failed: string[] = [];
const check = (condition: unknown, message: string): void => {
	if (!condition) failed.push(message);
};

const manifestOf = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: a test skill\n${extra}---\n\nRun scripts/run.sh.\n`;

/** A skill as the Skills page leaves it in a folder: SKILL.md, one script, and its record with a fresh identity. */
function plant(dir: string, name: string, options: { extra?: string; record?: boolean } = {}): string {
	const manifest = manifestOf(name, options.extra);
	fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
	fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "echo ran\n");
	if (options.record !== false) writeSkillProvenance(dir, { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest), identity: crypto.randomUUID() });
	return dir;
}
const inStore = (name: string, options?: { extra?: string; record?: boolean }): string => plant(path.join(agentSkillsDir(), name), name, options);
const switchOn = (room: string, name: string): void => assert(enablePersistentRoomSkill(room, name, readLibrarySkill).ok, `${name} was not switched on in ${room}`);
const folderNames = (room: string): string => roomSkillFolders(room).map((skill) => skill.name).sort().join(",");

const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
function canLink(): boolean {
	const probe = path.join(root, "link-probe");
	try {
		fs.symlinkSync(root, probe, "dir");
		fs.rmSync(probe);
		return true;
	} catch {
		console.log("SKIPPED: the link rows (this system does not allow links here)");
		return false;
	}
}
const linksAllowed = canLink();

try {
	// --- On is on: never approved, an old entry, a changed skill ------------------
	const room = "folders-room";
	const guide = inStore("guide");
	inStore("left-off");
	switchOn(room, "guide");
	check(folderNames(room) === "guide", `a skill switched on and never approved opens its folder, and one left off doesn't, got ${folderNames(room)}`);
	const guideFolder = roomSkillFolders(room).find((skill) => skill.name === "guide");
	check(guideFolder?.skillDir === guide && guideFolder.files.join(",") === "scripts/run.sh", `the folder and its files beside SKILL.md, the record left out, got ${JSON.stringify(guideFolder)}`);
	fs.appendFileSync(path.join(guide, "scripts", "run.sh"), "echo changed\n");
	fs.writeFileSync(path.join(guide, "SKILL.md"), manifestOf("guide").replace("Run scripts/run.sh.", "Run scripts/run.sh twice."));
	check(folderNames(room) === "guide", `a skill whose SKILL.md and script changed stays open, got ${folderNames(room)}`);

	// An entry written before this change: a hash that no longer matches and a run
	// approval. On, and nothing a reader does writes the room's file.
	const oldRoom = "folders-old-room";
	const settingsFile = persistentRoomSkillSettingsPath(oldRoom);
	const identity = JSON.parse(fs.readFileSync(path.join(guide, "provenance.json"), "utf-8")).identity;
	const oldShape = `${JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "guide", sha256: sha256("the text it had"), identity, executeApproval: { filesSha256: sha256("files it had"), approvedAt: "2026-11-01T10:00:00.000Z" } }], updatedAt: "2026-11-01T10:00:00.000Z" }, null, 2)}\n`;
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(settingsFile, oldShape);
	check(folderNames(oldRoom) === "guide", `an old entry with a stale hash and an approval opens the folder, got ${folderNames(oldRoom)}`);
	check(effectiveEnabledSkills(readPersistentRoomSkillSettings(oldRoom).enabledSkills, readLibrarySkill).map((skill) => skill.name).join(",") === "guide", "an old entry with a stale hash is in the room's index");
	check(fs.readFileSync(settingsFile, "utf-8") === oldShape, "reading the room's skills leaves its file byte for byte as it was");

	// --- The app's own library, as a plain folder in it, and the shared folder ----
	const shapes = "folders-shapes-room";
	// A copy in the folder other tools share, a real folder inside ~/.agents: it opens.
	plant(path.join(sharedAgentsSkillsDir(), "shared-tool"), "shared-tool", { record: false });
	switchOn(shapes, "shared-tool");
	// A project copy with a SKILL.md byte for byte the library's, and other files beside it: the project copy wins and opens nothing.
	const twin = inStore("twin-tool");
	const projectTwin = path.join(process.env.EXXETA_HOME, ".exxeta", "skills", "twin-tool");
	fs.mkdirSync(path.join(projectTwin, "scripts"), { recursive: true });
	fs.copyFileSync(path.join(twin, "SKILL.md"), path.join(projectTwin, "SKILL.md"));
	fs.writeFileSync(path.join(projectTwin, "scripts", "other.sh"), "echo other\n");
	switchOn(shapes, "twin-tool");
	// Marked by its author for picking by hand only: the person picks it in the room, so it opens as any skill that is on.
	inStore("by-hand", { extra: "disable-model-invocation: true\n" });
	switchOn(shapes, "by-hand");
	// A record-less skill added before records: still the app's own.
	inStore("no-record", { record: false });
	switchOn(shapes, "no-record");
	if (linksAllowed) {
		// A skill folder in the library that is itself a link, to a folder in the home.
		plant(path.join(process.env.HOME, "linked-target"), "linked-tool");
		fs.symlinkSync(path.join(process.env.HOME, "linked-target"), path.join(agentSkillsDir(), "linked-tool"), "dir");
		switchOn(shapes, "linked-tool");
		check(readLibrarySkill("linked-tool") !== null && !("unreadable" in (readLibrarySkill("linked-tool") ?? {})), "a linked skill folder still reads as instructions");
		check(librarySkillFolderView("linked-tool").folder === null, "the Skills pages list no files for a linked skill folder");
	}
	check(folderNames(shapes) === "by-hand,no-record,shared-tool", `plain folders in the app's own library open, one picked by hand only among them, and a shared copy inside ~/.agents: not a project twin or a linked folder in the library, got ${folderNames(shapes)}`);
	disablePersistentRoomSkill(shapes, "by-hand");
	check(folderNames(shapes) === "no-record,shared-tool", `a skill picked by hand only, switched off, opens nothing, got ${folderNames(shapes)}`);
	check(librarySkillFolderView("twin-tool").folder === null, "the Skills pages list no files for a project twin");
	check(librarySkillFolderView("shared-tool").folder?.files.join(",") === "scripts/run.sh", "the Skills pages list the files of a shared copy inside ~/.agents");
	check(librarySkillFolderView("by-hand").folder?.files.join(",") === "scripts/run.sh", "the Skills pages list the files of a skill picked by hand only");
	// On a Windows computer whose rooms run commands in their protection, a skill whose folder the protection isn't given
	// (`windowsSkillFolder`: a folder holding a link) has scripts a room there reads but can't run, and its page says so.
	// With the protection off, on a Mac, and for a skill with no scripts, nothing is said.
	if (linksAllowed) {
		const linkInside = plant(path.join(sharedAgentsSkillsDir(), "link-inside"), "link-inside", { record: false });
		fs.symlinkSync(path.join(linkInside, "scripts", "run.sh"), path.join(linkInside, "also-run.sh"));
		const notesOnly = path.join(sharedAgentsSkillsDir(), "notes-only");
		fs.mkdirSync(notesOnly, { recursive: true });
		fs.writeFileSync(path.join(notesOnly, "SKILL.md"), manifestOf("notes-only"));
		fs.writeFileSync(path.join(notesOnly, "notes.md"), "notes\n");
		const readOnly = (name: string) => librarySkillFiles(name).scriptsReadOnly;
		try {
			setRoomBoxForTests({ platform: "win32", windows: "on" });
			check(readOnly("link-inside") === true, `Windows with its protection: a skill whose folder holds a link has scripts that can't run, got ${readOnly("link-inside")}`);
			check(readOnly("notes-only") === undefined, `Windows with its protection: a skill with no scripts says nothing of them, got ${readOnly("notes-only")}`);
			// On Windows a plain local folder is given to the protection; elsewhere no path is a Windows one, so only Windows can show this neighbour.
			if (process.platform === "win32") check(readOnly("shared-tool") === undefined, `Windows with its protection: a skill whose folder holds no link runs its scripts, got ${readOnly("shared-tool")}`);
			setRoomBoxForTests({ platform: "win32", windows: "off" });
			check(readOnly("link-inside") === undefined, `Windows with its protection off: commands run as before and nothing is said, got ${readOnly("link-inside")}`);
		} finally {
			setRoomBoxForTests(null);
		}
		if (process.platform !== "win32") check(readOnly("link-inside") === undefined, `this computer, no Windows protection: nothing is said, got ${readOnly("link-inside")}`);
	}
	// What the model is told of them with a folder and commands on: a project twin is instructions only, with its count; the app's own and the shared copy open.
	const instructionsOnly = (count: number) => `This skill has ${count} more ${count === 1 ? "file" : "files"} beside these instructions, and rooms can't open them. Work from the instructions alone.`;
	const twinView = typeof roomSkillFilesView === "function" ? roomSkillFilesView(shapes, "twin-tool", "run", true) : null;
	check(twinView !== null && skillFilesSection(twinView, false) === instructionsOnly(1), `twin-tool with commands on: rooms get its instructions only, said with its count, got ${twinView ? skillFilesSection(twinView, false) : "nothing"}`);
	for (const [name, folder] of [["no-record", path.join(agentSkillsDir(), "no-record")], ["shared-tool", fs.realpathSync.native(path.join(sharedAgentsSkillsDir(), "shared-tool"))]]) {
		const view = typeof roomSkillFilesView === "function" ? roomSkillFilesView(shapes, name, "run", true) : null;
		check(view?.kind === "open" && view.skillDir === folder, `${name} with commands on gives its folder, got ${JSON.stringify(view)}`);
	}

	// --- No skill's text comes from a file outside its own folder -----------------
	// A library skill folder that links into a folder a room's command can write:
	// whatever the command makes of SKILL.md or of the folder itself, read_skill,
	// the index and the library page never hand on a file from outside it. A stand-in
	// for the app's sign-in file, outside every skill folder.
	if (linksAllowed) {
		const secretRoom = "folders-secret-room";
		const secret = path.join(process.env.HOME, "stand-in-sign-in.json");
		const NEEDLE = "only the stand-in holds this line";
		fs.writeFileSync(secret, `{"note":"${NEEDLE}"}\n`);
		const readTool = createReadSkillTool({ agentId: secretRoom, lookupSkill: readLibrarySkill }) as unknown as {
			execute(toolCallId: string, params: { name: string }): Promise<{ content: Array<{ text?: string }>; details?: { outcome?: string } }>;
		};
		const served = async (name: string): Promise<{ outcome?: string; text: string }> => {
			const result = await readTool.execute("t", { name });
			return { outcome: result.details?.outcome, text: result.content.map((part) => part.text ?? "").join("\n") };
		};
		const indexNames = (): string => effectiveEnabledSkills(readPersistentRoomSkillSettings(secretRoom).enabledSkills, readLibrarySkill).map((skill) => skill.name).sort().join(",");
		const libraryShows = (needle: string): boolean => JSON.stringify(listSkills()).includes(needle);
		const roomFolder = path.join(process.env.HOME, "room-a-folder");
		/** What a person and the assistant get of a skill whose SKILL.md now leads outside its folder. */
		const refused = async (name: string, row: string): Promise<void> => {
			const read = readLibrarySkill(name);
			check(read !== null && "unreadable" in read, `${row}: the skill reads as unreadable, never as absent or as the file's text, got ${JSON.stringify(read)}`);
			const answer = await served(name);
			check(answer.outcome === "unreadable" && !answer.text.includes(NEEDLE), `${row}: read_skill refuses it and serves none of the file, got ${answer.outcome}: ${answer.text}`);
			check(!indexNames().split(",").includes(name), `${row}: the skill leaves the room's index, got ${indexNames()}`);
			check(!libraryShows(NEEDLE), `${row}: the library page shows none of the file`);
			check(listSkills().find((skill) => skill.name === name)?.unreadable === true, `${row}: the library lists it by its folder's name as one that can't be opened, got ${JSON.stringify(listSkills().find((skill) => skill.name === name))}`);
		};

		plant(roomFolder, "room-linked");
		fs.symlinkSync(roomFolder, path.join(agentSkillsDir(), "room-linked"), "dir");
		switchOn(secretRoom, "room-linked");
		const before = await served("room-linked");
		check(before.outcome === "ok" && before.text.includes("Run scripts/run.sh."), `a linked skill folder reads as instructions while its SKILL.md is its own, got ${before.outcome}`);

		// The room's command: `ln -sf <the sign-in file> <that folder>/SKILL.md`.
		fs.rmSync(path.join(roomFolder, "SKILL.md"));
		fs.symlinkSync(secret, path.join(roomFolder, "SKILL.md"));
		await refused("room-linked", "its SKILL.md links to a file outside");
		const editable = getUserSkillFile("room-linked");
		check(editable !== null && editable.manifest === null, `an edit of the skill finds no text, so it never writes through the link, and a delete still finds it, got ${JSON.stringify(editable)}`);

		// The room's command swaps the folder for one of its own whose SKILL.md links outside.
		fs.rmSync(roomFolder, { recursive: true, force: true });
		fs.mkdirSync(roomFolder);
		fs.symlinkSync(secret, path.join(roomFolder, "SKILL.md"));
		await refused("room-linked", "the folder swapped for one whose SKILL.md links outside");

		// The same, its SKILL.md a hard link to the file.
		fs.rmSync(path.join(roomFolder, "SKILL.md"));
		fs.linkSync(secret, path.join(roomFolder, "SKILL.md"));
		await refused("room-linked", "the folder swapped for one whose SKILL.md is a hard link to a file outside");

		// An edit's write, when a link or a hard link to the file appears after its read: nothing is written there.
		const written = inStore("write-target");
		for (const kind of ["link", "hard link"] as const) {
			fs.rmSync(path.join(written, "SKILL.md"));
			if (kind === "link") fs.symlinkSync(secret, path.join(written, "SKILL.md"));
			else fs.linkSync(secret, path.join(written, "SKILL.md"));
			let threw = false;
			try {
				writeSkillFileText(written, "SKILL.md", "written into the link\n");
			} catch {
				threw = true;
			}
			check(threw && fs.readFileSync(secret, "utf-8").includes(NEEDLE), `a write to a SKILL.md that is a ${kind} to a file outside is refused and leaves that file`);
		}
		fs.rmSync(path.join(written, "SKILL.md"));
		fs.writeFileSync(path.join(written, "SKILL.md"), manifestOf("write-target"));
		writeSkillFileText(written, "SKILL.md", manifestOf("write-target", "license: MIT\n"));
		check(fs.readFileSync(path.join(written, "SKILL.md"), "utf-8") === manifestOf("write-target", "license: MIT\n"), "a write to a plain SKILL.md of its own replaces its text whole");

		// A named pipe at SKILL.md: unreadable, and the read never waits on it.
		if (process.platform !== "win32") {
			const piped = inStore("piped-tool");
			fs.rmSync(path.join(piped, "SKILL.md"));
			const made = spawnSync("mkfifo", [path.join(piped, "SKILL.md")]);
			if (made.status === 0) {
				const pipedRead = readLibrarySkill("piped-tool");
				check(pipedRead !== null && "unreadable" in pipedRead, `a named pipe at SKILL.md reads as unreadable, got ${JSON.stringify(pipedRead)}`);
			} else console.log("SKIPPED: the named pipe row (mkfifo is not here)");
		}

		// Its record linked outside: the skill is unreadable, never taken for one with no record.
		const recorded = inStore("record-linked");
		switchOn(secretRoom, "record-linked");
		fs.rmSync(path.join(recorded, "provenance.json"));
		fs.symlinkSync(secret, path.join(recorded, "provenance.json"));
		const recordRead = readLibrarySkill("record-linked");
		check(recordRead !== null && "unreadable" in recordRead, `a record that links outside makes the skill unreadable, got ${JSON.stringify(recordRead)}`);

		// Beside them: a plain linked folder in the folder other tools share still reads as instructions, and
		// gives its real folder when its target lies outside ~/.agents.
		plant(path.join(process.env.HOME, "shared-target"), "shared-linked", { record: false });
		fs.symlinkSync(path.join(process.env.HOME, "shared-target"), path.join(sharedAgentsSkillsDir(), "shared-linked"), "dir");
		switchOn(secretRoom, "shared-linked");
		const sharedAnswer = await served("shared-linked");
		check(sharedAnswer.outcome === "ok" && sharedAnswer.text.includes("Run scripts/run.sh."), `a plain linked folder in the shared folder reads as instructions, got ${sharedAnswer.outcome}: ${sharedAnswer.text}`);
		check(indexNames().split(",").includes("shared-linked") && libraryShows("shared-linked"), `the shared linked skill is in the index and the library, got ${indexNames()}`);
		const linkedFolder = roomSkillFolders(secretRoom).find((skill) => skill.name === "shared-linked");
		check(linkedFolder?.skillDir === fs.realpathSync.native(path.join(process.env.HOME, "shared-target")), `a shared linked folder whose target lies outside ~/.agents gives its real folder, got ${JSON.stringify(linkedFolder)}`);
		// One whose target lies inside ~/.agents gives its real folder.
		const insideTarget = plant(path.join(process.env.HOME, ".agents", "kept", "shared-inside"), "shared-inside", { record: false });
		fs.symlinkSync(insideTarget, path.join(sharedAgentsSkillsDir(), "shared-inside"), "dir");
		switchOn(secretRoom, "shared-inside");
		const insideFolder = roomSkillFolders(secretRoom).find((skill) => skill.name === "shared-inside");
		check(insideFolder?.skillDir === fs.realpathSync.native(insideTarget), `a shared linked folder whose target lies inside ~/.agents gives its real folder, got ${JSON.stringify(insideFolder)}`);

		// A plain folder in the shared folder whose SKILL.md is a link, to a file beside it or to one outside the
		// folder: both are listed as skills that can't be opened, and a room that had them on can't use them.
		for (const [name, where] of [["shared-file-beside", "beside it"], ["shared-file-outside", "outside its folder"]] as const) {
			const folder = path.join(sharedAgentsSkillsDir(), name);
			plant(folder, name, { record: false });
			switchOn(secretRoom, name);
			const target = where === "beside it" ? path.join(folder, "manifest.md") : path.join(process.env.HOME, `${name}.md`);
			fs.renameSync(path.join(folder, "SKILL.md"), target);
			fs.symlinkSync(target, path.join(folder, "SKILL.md"));
			await refused(name, `a shared skill whose SKILL.md links to a file ${where}`);
		}
	}

	// --- One skill that can't be read leaves the room's others --------------------
	const twoRoom = "folders-two-room";
	inStore("alpha-tool");
	const beta = inStore("beta-tool");
	switchOn(twoRoom, "alpha-tool");
	switchOn(twoRoom, "beta-tool");
	check(folderNames(twoRoom) === "alpha-tool,beta-tool", `both skills open while they read, got ${folderNames(twoRoom)}`);
	const cases = [
		{ row: "its SKILL.md can't be read", at: path.join(beta, "SKILL.md"), mode: 0o000 },
		{ row: "a folder in it can't be listed", at: path.join(beta, "scripts"), mode: 0o000 },
	];
	for (const { row, at, mode } of cases) {
		if (!canForceFsRefusal) {
			console.log(`SKIPPED: "${row}" (taking rights away refuses no read on Windows or as root)`);
			continue;
		}
		const before = fs.statSync(at).mode & 0o777;
		fs.chmodSync(at, mode);
		let seen: string;
		try {
			seen = folderNames(twoRoom);
		} catch (error) {
			seen = `a throw: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			fs.chmodSync(at, before);
		}
		check(seen === "alpha-tool", `${row}: only that skill closes and nothing throws, got ${seen}`);
		check(folderNames(twoRoom) === "alpha-tool,beta-tool", `${row}, readable again: open again, got ${folderNames(twoRoom)}`);
	}

	// --- Deleted and added again is off ---------------------------------------------
	// Same name, same text, same files: only the identity it was added with differs.
	const againRoom = "folders-again-room";
	const gamma = inStore("gamma-tool");
	inStore("delta-tool");
	switchOn(againRoom, "gamma-tool");
	switchOn(againRoom, "delta-tool");
	fs.rmSync(gamma, { recursive: true, force: true });
	inStore("gamma-tool");
	check(folderNames(againRoom) === "delta-tool", `a skill deleted and added again is off and its folder closed, the untouched one stays, got ${folderNames(againRoom)}`);

	assert(failed.length === 0, failed.join("\n"));
	console.log("skills-room-folders-smoke: OK");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
