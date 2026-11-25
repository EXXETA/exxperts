import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import fs from "node:fs";
import JSZip from "jszip";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../src/skills-store.js";

// The Skills library says what each skill carries and where it is used: the
// detail lists the files a room where it is on can run, and the list and the
// detail name the rooms that enable the skill, with its file count.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-usage-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const canonicalDir = path.join(tempHome, ".exxperts", "agent", "skills");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A library skill with bundled files in two folders, written as an import leaves
// it: the manifest, the files, then the provenance sidecar.
function writeLibrarySkill(name: string, description: string, files: string[], options: { frontmatterLicense?: string; recordLicense?: string; dir?: string; record?: boolean } = {}): void {
	const dir = options.dir ?? path.join(canonicalDir, name);
	fs.mkdirSync(dir, { recursive: true });
	const licenseLine = options.frontmatterLicense ? [`license: ${options.frontmatterLicense}`] : [];
	const manifest = ["---", `name: ${name}`, `description: ${description}`, ...licenseLine, "---", "", "Use the bundled files.", ""].join("\n");
	fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
	for (const file of files) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), `# ${file}\n`);
	}
	if (options.record === false) return;
	fs.writeFileSync(path.join(dir, "provenance.json"), `${JSON.stringify({ source: "local", importedAt: new Date().toISOString(), license: options.recordLicense ?? null, sha256: sha256(manifest) })}\n`);
}

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
// Rights taken away for a row, given back after it and before cleanup.
const locked = new Map<string, number>();
/** Takes a file's rights away; false, with the reason printed, where it still reads (Windows, a run as root). */
function lockAway(file: string, row: string): boolean {
	if (!canForceFsRefusal) {
		console.log(`skills-library-usage-smoke: skipped "${row}": taking rights away refuses no read on Windows or as root`);
		return false;
	}
	const folder = fs.statSync(file).isDirectory();
	locked.set(file, fs.statSync(file).mode & 0o777);
	fs.chmodSync(file, 0o000);
	try {
		if (folder) fs.readdirSync(file);
		else fs.readFileSync(file);
	} catch {
		return true;
	}
	unlock(file);
	console.log(`skills-library-usage-smoke: skipped "${row}": ${file} still reads with its rights taken away on this machine`);
	return false;
}
function unlock(file: string): void {
	const mode = locked.get(file);
	if (mode === undefined) return;
	fs.chmodSync(file, mode);
	locked.delete(file);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	const files = ["LICENSE.txt", "scripts/build.py", "scripts/helpers/theme.py"];
	writeLibrarySkill("deck-builder", "Builds slide decks", files);
	writeLibrarySkill("plain-notes", "Instructions only", []);
	// Licenses: a shared skill declares one in its SKILL.md; an import record's
	// license wins over the file's; a record without one falls back to the file.
	writeLibrarySkill("house-style", "Writes in the house style", [], { dir: path.join(tempHome, ".agents", "skills", "house-style"), frontmatterLicense: "MIT", record: false });
	writeLibrarySkill("recorded", "Carries a recorded license", [], { frontmatterLicense: "MIT", recordLicense: "Apache-2.0" });
	writeLibrarySkill("file-only", "Declares its license in the file", [], { frontmatterLicense: "BSD-3-Clause" });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot },
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 15000);

	// --- The detail lists the skill's files --------------------------------------
	let detail = await api("/api/skills/deck-builder");
	assert(detail.status === 200, `detail should load, got ${detail.status}`);
	// Every file with its kind, its SKILL.md included; the import record is not one of them.
	const expectedFiles = [{ path: "LICENSE.txt", kind: "documents" }, { path: "SKILL.md", kind: "instructions" }, { path: "scripts/build.py", kind: "scripts" }, { path: "scripts/helpers/theme.py", kind: "scripts" }];
	assert(JSON.stringify(detail.body.files) === JSON.stringify(expectedFiles), `the detail lists every file with its kind, got ${JSON.stringify(detail.body.files)}`);
	assert(detail.body.fileCount === files.length + 1, `the detail counts the files, its SKILL.md included, got ${detail.body.fileCount}`);
	assert(Array.isArray(detail.body.rooms) && detail.body.rooms.length === 0, "a skill no room enables has no rooms");
	const plain = await api("/api/skills/plain-notes");
	assert(plain.status === 200 && JSON.stringify(plain.body.files) === JSON.stringify([{ path: "SKILL.md", kind: "instructions" }]) && plain.body.fileCount === 1, "a skill without files lists its instructions alone");

	// --- The license a skill carries --------------------------------------------
	const listedNow = (await api("/api/skills")).body as Array<{ name: string; license: string | null; source: string }>;
	const byName = new Map(listedNow.map((skill) => [skill.name, skill] as const));
	assert(byName.get("house-style")?.source === "shared" && byName.get("house-style")?.license === "MIT", `a shared skill's own license shows in the list, got ${JSON.stringify(byName.get("house-style"))}`);
	assert((await api("/api/skills/house-style")).body.license === "MIT", "and in its detail");
	assert(byName.get("recorded")?.license === "Apache-2.0", `an import record's license wins over the file's, got ${JSON.stringify(byName.get("recorded"))}`);
	assert(byName.get("file-only")?.license === "BSD-3-Clause", `a record without a license falls back to the file's, got ${JSON.stringify(byName.get("file-only"))}`);
	assert(byName.get("plain-notes")?.license === null, "a skill that declares none has none");

	// --- Rooms that enable a skill appear in the list and the detail ------------
	const makeRoom = async (displayName: string): Promise<string> => {
		const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		const id = String(created.body?.agent?.id ?? "");
		assert(created.status < 300 && id, `room ${displayName} should be created, got ${created.status}`);
		return id;
	};
	const football = await makeRoom("Football");
	const discovery = await makeRoom("AI Discovery");
	const idle = await makeRoom("Idle Room");
	for (const room of [football, discovery]) {
		const enabled = await api(`/api/persistent-agents/${room}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: "deck-builder" }) });
		assert(enabled.status === 200, `enable in ${room} should succeed, got ${enabled.status}`);
	}

	const list = await api("/api/skills");
	assert(list.status === 200, `list should load, got ${list.status}`);
	const listed = list.body.find((skill: any) => skill.name === "deck-builder");
	assert(listed, "the list carries deck-builder");
	assert(JSON.stringify(listed.rooms) === JSON.stringify([{ id: discovery, name: "AI Discovery" }, { id: football, name: "Football" }]), `the list names both rooms by display name, sorted, got ${JSON.stringify(listed.rooms)}`);
	assert(listed.fileCount === files.length + 1, `the list counts the files, got ${listed.fileCount}`);
	assert(!listed.rooms.some((room: any) => room.id === idle), "a room that does not enable the skill is not listed");
	assert(list.body.find((skill: any) => skill.name === "plain-notes").rooms.length === 0, "an unused skill lists no rooms");

	detail = await api("/api/skills/deck-builder");
	assert(detail.body.rooms.map((room: any) => room.name).join(",") === "AI Discovery,Football", `the detail names the same rooms, got ${JSON.stringify(detail.body.rooms)}`);

	// Removing it from a room takes that room off the skill.
	await api(`/api/persistent-agents/${football}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "disable", name: "deck-builder" }) });
	detail = await api("/api/skills/deck-builder");
	assert(detail.body.rooms.map((room: any) => room.id).join(",") === discovery, `a disabled room leaves the skill's rooms, got ${JSON.stringify(detail.body.rooms)}`);

	// --- A part of a skill that can't be read stops only that skill --------------
	// Every check runs, so one run names each answer that is wrong.
	const failed: string[] = [];
	const check = (condition: unknown, message: string): void => {
		if (!condition) failed.push(message);
	};
	writeLibrarySkill("sealed-tool", "One of its folders can't be listed", ["scripts/run.py"]);
	writeLibrarySkill("open-tool", "Every file reads", ["scripts/run.py"]);
	const allowedRoom = await makeRoom("Allowed Room");
	for (const name of ["sealed-tool", "open-tool"]) {
		const changed = await api(`/api/persistent-agents/${allowedRoom}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name }) });
		assert(changed.status === 200, `enable ${name} should succeed, got ${changed.status}`);
	}
	const skillSettings = () => api(`/api/persistent-agents/${allowedRoom}/skill-settings`);
	const sealedFolder = path.join(canonicalDir, "sealed-tool", "scripts");
	const fileRow = "a folder of a skill that is on can't be listed";
	if (lockAway(sealedFolder, fileRow)) {
		try {
			const lockedList = await api("/api/skills");
			check(lockedList.status === 200, `${fileRow}: the library list answers 200, got ${lockedList.status} ${JSON.stringify(lockedList.body)}`);
			const sealedListed = Array.isArray(lockedList.body) ? lockedList.body.find((skill: any) => skill.name === "sealed-tool") : undefined;
			check(sealedListed && sealedListed.fileCount === 0, `${fileRow}: the list carries it with no files, got ${JSON.stringify(sealedListed)}`);
			const sealedDetail = await api("/api/skills/sealed-tool");
			check(sealedDetail.status === 200 && sealedDetail.body.fileCount === 0 && sealedDetail.body.files?.length === 0, `${fileRow}: the detail answers 200 with no files, got ${sealedDetail.status} ${JSON.stringify(sealedDetail.body)}`);
			const lockedSettings = await skillSettings();
			check(lockedSettings.status === 200, `${fileRow}: the room's skill settings answer 200, got ${lockedSettings.status} ${JSON.stringify(lockedSettings.body)}`);
			const stateOf = (name: string) => lockedSettings.body?.skills?.find((skill: any) => skill.name === name);
			check(stateOf("sealed-tool")?.status === "ok" && stateOf("open-tool")?.status === "ok", `${fileRow}: both skills stay on, got ${JSON.stringify(lockedSettings.body?.skills)}`);
		} finally {
			unlock(sealedFolder);
		}
		check(((await api("/api/skills")).body as any[]).find((skill) => skill.name === "sealed-tool")?.fileCount === 2, `${fileRow}: listed again, its files count again`);
	}
	writeLibrarySkill("sealed-manifest", "Its SKILL.md can't be read", []);
	const enabledManifest = await api(`/api/persistent-agents/${allowedRoom}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: "sealed-manifest" }) });
	assert(enabledManifest.status === 200, `enable sealed-manifest should succeed, got ${enabledManifest.status}`);
	const manifestFile = path.join(canonicalDir, "sealed-manifest", "SKILL.md");
	const manifestRow = "a skill's SKILL.md can't be read";
	if (lockAway(manifestFile, manifestRow)) {
		try {
			const lockedList = await api("/api/skills");
			check(lockedList.status === 200, `${manifestRow}: the library list answers 200, got ${lockedList.status} ${JSON.stringify(lockedList.body)}`);
			const sealedListed = Array.isArray(lockedList.body) ? lockedList.body.find((skill: any) => skill.name === "sealed-manifest") : undefined;
			check(sealedListed?.unreadable === true && sealedListed.body === "" && lockedList.body.some((skill: any) => skill.name === "open-tool"), `${manifestRow}: the list names it as one that can't be opened, with no text, and keeps the others, got ${JSON.stringify(lockedList.body)}`);
			const lockedSettings = await skillSettings();
			check(lockedSettings.status === 200, `${manifestRow}: the room's skill settings answer 200, got ${lockedSettings.status} ${JSON.stringify(lockedSettings.body)}`);
			// The room keeps its row, as a skill whose instructions it can't read; it stays enabled.
			const sealedState = lockedSettings.body?.skills?.find((skill: any) => skill.name === "sealed-manifest");
			check(sealedState?.status === "unreadable", `${manifestRow}: the room reads it as unreadable, got ${JSON.stringify(sealedState)}`);
			check(lockedSettings.body?.skills?.find((skill: any) => skill.name === "open-tool")?.status === "ok", `${manifestRow}: the room's other skill stays on`);
		} finally {
			unlock(manifestFile);
		}
		const readableAgain = (await skillSettings()).body?.skills?.find((skill: any) => skill.name === "sealed-manifest");
		check(readableAgain?.status === "ok", `${manifestRow}: readable again, the room uses it again, got ${JSON.stringify(readableAgain)}`);
	}

	// --- An off skill whose import record can't be read can't be opened ----------
	const brokenRecordRow = "an off skill's import record can't be read";
	writeLibrarySkill("broken-record", "Its record is not JSON", ["scripts/run.py"]);
	fs.writeFileSync(path.join(canonicalDir, "broken-record", "provenance.json"), "{ not json");
	const brokenListed = ((await api("/api/skills")).body as any[]).find((skill) => skill.name === "broken-record");
	check(brokenListed?.unreadable === true && brokenListed.body === "" && brokenListed.rooms.length === 0, `${brokenRecordRow}: the list names it as one that can't be opened, got ${JSON.stringify(brokenListed)}`);
	const brokenOn = await api(`/api/persistent-agents/${allowedRoom}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: "broken-record" }) });
	check(brokenOn.status >= 400, `${brokenRecordRow}: it can't be switched on, got ${brokenOn.status} ${JSON.stringify(brokenOn.body)}`);
	check(((await api("/api/skills")).body as any[]).find((skill) => skill.name === "open-tool")?.unreadable !== true, `${brokenRecordRow}: the others open`);

	// --- A skill deleted in Settings leaves the room; added again it starts off --
	const keptRoom = await makeRoom("Kept Room");
	const keptSettings = () => api(`/api/persistent-agents/${keptRoom}/skill-settings`);
	const keptRow = async (name: string) => (await keptSettings()).body?.skills?.find((skill: any) => skill.name === name);
	const keptChange = async (action: string, name: string) => {
		const changed = await api(`/api/persistent-agents/${keptRoom}/skill-settings`, { method: "PUT", body: JSON.stringify({ action, name }) });
		assert(changed.status === 200, `${action} ${name} in Kept Room should succeed, got ${changed.status} ${JSON.stringify(changed.body)}`);
	};
	const keptFile = path.join(
		tempHome,
		String((fs.readdirSync(tempHome, { recursive: true }) as string[]).find((rel) => rel.endsWith(path.join(keptRoom, "runtime"))) ?? ""),
		"skill-settings.json",
	);
	const recordOf = (name: string) => JSON.parse(fs.readFileSync(path.join(canonicalDir, name, "provenance.json"), "utf-8"));
	const notes = { id: "meeting-notes", displayName: "Meeting notes", description: "Writes meeting notes", instructions: "Write the notes, then run scripts/tidy.py." };
	const addNotes = async (): Promise<void> => {
		const created = await api("/api/skills", { method: "POST", body: JSON.stringify(notes) });
		assert(created.status === 201, `adding meeting-notes should succeed, got ${created.status} ${JSON.stringify(created.body)}`);
		fs.mkdirSync(path.join(canonicalDir, "meeting-notes", "scripts"), { recursive: true });
		fs.writeFileSync(path.join(canonicalDir, "meeting-notes", "scripts", "tidy.py"), "print('tidy')\n");
	};
	await addNotes();
	const firstIdentity = recordOf("meeting-notes").identity;
	check(typeof firstIdentity === "string" && firstIdentity.length > 0, `adding a skill gives it an identity, got ${JSON.stringify(recordOf("meeting-notes"))}`);
	await keptChange("enable", "meeting-notes");
	check((await keptRow("meeting-notes"))?.status === "ok", "meeting-notes is on in Kept Room");
	const keptBytes = fs.readFileSync(keptFile, "utf-8");

	const deleted = await api("/api/skills/meeting-notes", { method: "DELETE" });
	assert(deleted.status === 200, `deleting meeting-notes should succeed, got ${deleted.status}`);
	const afterDeleteRows = (await keptSettings()).body?.skills ?? [];
	check(!afterDeleteRows.some((skill: any) => skill.name === "meeting-notes"), `after a delete the room lists no row for it, got ${JSON.stringify(afterDeleteRows)}`);
	check(fs.readFileSync(keptFile, "utf-8") === keptBytes, "a delete writes nothing into the room's file");

	// Added again under its name, same SKILL.md, same files: off in the room, and used in no room.
	await addNotes();
	check(recordOf("meeting-notes").identity !== firstIdentity, "added again, it has a new identity");
	check((await keptRow("meeting-notes")) === undefined, `added again, it has no row in the room, got ${JSON.stringify(await keptRow("meeting-notes"))}`);
	const usedIn = (await api("/api/skills/meeting-notes")).body?.rooms;
	check(Array.isArray(usedIn) && usedIn.length === 0, `added again, its Used in names no room, got ${JSON.stringify(usedIn)}`);
	check(((await api("/api/skills")).body as any[]).find((skill) => skill.name === "meeting-notes")?.rooms?.length === 0, "nor does the list's");
	check(fs.readFileSync(keptFile, "utf-8") === keptBytes, "reading writes nothing into the room's file");
	await keptChange("enable", "meeting-notes");
	const switchedOn = await keptRow("meeting-notes");
	check(switchedOn?.status === "ok", `switched on again, it is on, got ${JSON.stringify(switchedOn)}`);
	check((await api("/api/skills/meeting-notes")).body?.rooms?.map((room: any) => room.id).join(",") === keptRoom, "switched on again, its Used in names the room");

	// An edit keeps the skill's identity, so the room keeps it on, as it now is.
	const edited = await api("/api/skills/meeting-notes", { method: "PUT", body: JSON.stringify({ ...notes, instructions: "Write shorter notes." }) });
	assert(edited.status === 200, `editing meeting-notes should succeed, got ${edited.status}`);
	const secondIdentity = recordOf("meeting-notes").identity;
	check(typeof secondIdentity === "string" && secondIdentity !== firstIdentity, "the skill added again carries its own identity");
	check((await keptRow("meeting-notes"))?.status === "ok", `an edit keeps the skill on in the room, got ${JSON.stringify(await keptRow("meeting-notes"))}`);
	// A skill added before identities stays without one through an edit, and stays in the room.
	await keptChange("enable", "plain-notes");
	const plainEdited = await api("/api/skills/plain-notes", { method: "PUT", body: JSON.stringify({ id: "plain-notes", displayName: "Plain notes", description: "Instructions only", instructions: "Use fewer files." }) });
	assert(plainEdited.status === 200, `editing plain-notes should succeed, got ${plainEdited.status}`);
	check(fs.existsSync(path.join(canonicalDir, "plain-notes", "provenance.json")) && !("identity" in recordOf("plain-notes")), `editing a skill with no identity gives it none, got ${JSON.stringify(recordOf("plain-notes"))}`);
	check((await keptRow("plain-notes"))?.status === "ok", `the room keeps it on, got ${JSON.stringify(await keptRow("plain-notes"))}`);

	// A record that can't be read is unreadable, never gone, and an edit leaves it as it was:
	// a fresh one would give the skill another identity and take it out of the room.
	const recordFile = path.join(canonicalDir, "meeting-notes", "provenance.json");
	const recordRow = "a skill's record can't be read";
	if (lockAway(recordFile, recordRow)) {
		try {
			check((await keptRow("meeting-notes"))?.status === "unreadable", `${recordRow}: the room keeps its row as unreadable, got ${JSON.stringify(await keptRow("meeting-notes"))}`);
			const editedLocked = await api("/api/skills/meeting-notes", { method: "PUT", body: JSON.stringify({ ...notes, instructions: "Write the shortest notes." }) });
			check(editedLocked.status === 200, `${recordRow}: an edit still saves, got ${editedLocked.status} ${JSON.stringify(editedLocked.body)}`);
		} finally {
			unlock(recordFile);
		}
		check(recordOf("meeting-notes").identity === secondIdentity, `${recordRow}: the edit left the record's identity as it was, got ${JSON.stringify(recordOf("meeting-notes"))}`);
		check((await keptRow("meeting-notes"))?.status === "ok", `${recordRow}: readable again, the room has it on, got ${JSON.stringify(await keptRow("meeting-notes"))}`);
	}

	// An add cut after its SKILL.md landed still carries an identity, so a room's entry
	// of that name made before identities doesn't take the new skill for its own.
	const cutRow = "an add cut after its SKILL.md";
	const oldRoom = await makeRoom("Old Room");
	const oldRoomRuntime = String((fs.readdirSync(tempHome, { recursive: true }) as string[]).find((rel) => rel.endsWith(path.join(oldRoom, "runtime"))) ?? "");
	const cutManifest = ["---", "name: cut-notes", "displayName: Cut notes", "description: Writes notes", "---", "", "Write the notes.", ""].join("\n");
	fs.writeFileSync(path.join(tempHome, oldRoomRuntime, "skill-settings.json"), `${JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "cut-notes", sha256: sha256(cutManifest) }], updatedAt: "" }, null, 2)}\n`);
	const zip = new JSZip();
	zip.file("cut-notes/SKILL.md", cutManifest);
	zip.file("cut-notes/scripts/cut-notes-run.py", "print('cut')\n");
	const uploaded = await api("/api/skills/upload", { method: "POST", body: JSON.stringify({ filename: "cut-notes.zip", contentBase64: (await zip.generateAsync({ type: "nodebuffer" })).toString("base64") }) });
	assert(uploaded.status === 200 && uploaded.body?.token, `the upload should give a candidate with its files kept, got ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
	const kept = fs.readdirSync(os.tmpdir())
		.filter((name) => name.startsWith("exxperts-skill-upload-"))
		.map((name) => path.join(os.tmpdir(), name, "scripts", "cut-notes-run.py"))
		.find((file) => fs.existsSync(file));
	assert(kept, "the upload's kept file should be in the temp folder");
	// The kept file can't be copied, so the accept stops after writing SKILL.md.
	if (lockAway(kept, cutRow)) {
		let accepted: { status: number; body: any };
		try {
			accepted = await api("/api/skills/accept", { method: "POST", body: JSON.stringify({ id: "cut-notes", displayName: uploaded.body.name, description: uploaded.body.description, instructions: uploaded.body.body, token: uploaded.body.token, source: "upload" }) });
		} finally {
			unlock(kept);
		}
		check(accepted.status >= 500 && fs.existsSync(path.join(canonicalDir, "cut-notes", "SKILL.md")), `${cutRow}: the accept stops after writing SKILL.md, got ${accepted.status} ${JSON.stringify(accepted.body)}`);
		const oldRows = (await api(`/api/persistent-agents/${oldRoom}/skill-settings`)).body?.skills ?? [];
		check(!oldRows.some((skill: any) => skill.name === "cut-notes"), `${cutRow}: a room's entry made before identities is not the new skill's, got ${JSON.stringify(oldRows)}`);
	}

	// A skill whose folder links elsewhere: an edit writes its record into the real
	// folder through the link, and leaves no file beside that folder.
	const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-linked-"));
	const linkedDir = path.join(linkedHome, "linked-notes");
	writeLibrarySkill("linked-notes", "Lives outside the store", [], { dir: linkedDir });
	// Junctions work on Windows without symlink privileges; "dir" everywhere else.
	fs.symlinkSync(linkedDir, path.join(canonicalDir, "linked-notes"), process.platform === "win32" ? "junction" : "dir");
	const linkedEdit = await api("/api/skills/linked-notes", { method: "PUT", body: JSON.stringify({ id: "linked-notes", displayName: "Linked notes", description: "Lives outside the store", instructions: "Edited through the link." }) });
	const linkedRecord = JSON.parse(fs.readFileSync(path.join(linkedDir, "provenance.json"), "utf-8"));
	check(linkedEdit.status === 200 && linkedRecord.sha256 === sha256(fs.readFileSync(path.join(linkedDir, "SKILL.md"), "utf-8")), `an edit through a linked folder writes its record there, got ${linkedEdit.status} ${JSON.stringify(linkedRecord)}`);
	check(fs.lstatSync(path.join(canonicalDir, "linked-notes")).isSymbolicLink(), "the edit keeps the linked folder a link");
	const linkedLeftovers = fs.readdirSync(linkedHome).filter((name) => name.endsWith(".tmp"));
	check(linkedLeftovers.length === 0, `no temporary record is left beside a linked folder, got ${JSON.stringify(linkedLeftovers)}`);
	fs.rmSync(path.join(canonicalDir, "linked-notes"), { recursive: true, force: true });
	fs.rmSync(linkedHome, { recursive: true, force: true });

	// A skill whose SKILL.md is a link, or a hard link, to a file outside: an edit
	// writes nothing into that file and is told there is no skill it can edit.
	const standIn = path.join(tempHome, "stand-in-elsewhere.txt");
	const standInText = "only the stand-in holds this line\n";
	for (const kind of ["link", "hard link"] as const) {
		fs.writeFileSync(standIn, standInText);
		writeLibrarySkill("pointed-notes", "Its SKILL.md points elsewhere", []);
		const manifestPath = path.join(canonicalDir, "pointed-notes", "SKILL.md");
		fs.rmSync(manifestPath);
		try {
			if (kind === "link") fs.symlinkSync(standIn, manifestPath);
			else fs.linkSync(standIn, manifestPath);
		} catch {
			console.log(`SKIPPED: an edit of a SKILL.md that is a ${kind} (this system does not allow one here)`);
			fs.rmSync(path.join(canonicalDir, "pointed-notes"), { recursive: true, force: true });
			continue;
		}
		const pointedEdit = await api("/api/skills/pointed-notes", { method: "PUT", body: JSON.stringify({ id: "pointed-notes", displayName: "Pointed notes", description: "Its SKILL.md points elsewhere", instructions: "Written into the link." }) });
		check(pointedEdit.status === 404 && fs.readFileSync(standIn, "utf-8") === standInText, `an edit of a SKILL.md that is a ${kind} to a file outside writes nothing there, got ${pointedEdit.status} ${JSON.stringify(pointedEdit.body)} and ${JSON.stringify(fs.readFileSync(standIn, "utf-8"))}`);
		fs.rmSync(path.join(canonicalDir, "pointed-notes"), { recursive: true, force: true });
	}

	// A skill whose SKILL.md someone emptied: an edit writes its text back.
	writeLibrarySkill("emptied-notes", "Its SKILL.md was emptied", []);
	fs.writeFileSync(path.join(canonicalDir, "emptied-notes", "SKILL.md"), "");
	const emptiedEdit = await api("/api/skills/emptied-notes", { method: "PUT", body: JSON.stringify({ id: "emptied-notes", displayName: "Emptied notes", description: "Its SKILL.md was emptied", instructions: "Written back." }) });
	check(emptiedEdit.status === 200 && fs.readFileSync(path.join(canonicalDir, "emptied-notes", "SKILL.md"), "utf-8").includes("Written back."), `an edit of an emptied SKILL.md writes its text back, got ${emptiedEdit.status} ${JSON.stringify(emptiedEdit.body)}`);
	fs.rmSync(path.join(canonicalDir, "emptied-notes"), { recursive: true, force: true });

	// A SKILL.md made read-only: the edit fails with the real error, never "not found".
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		writeLibrarySkill("read-only-notes", "Its SKILL.md is read-only", []);
		const readOnly = path.join(canonicalDir, "read-only-notes", "SKILL.md");
		fs.chmodSync(readOnly, 0o444);
		const readOnlyEdit = await api("/api/skills/read-only-notes", { method: "PUT", body: JSON.stringify({ id: "read-only-notes", displayName: "Read-only notes", description: "Its SKILL.md is read-only", instructions: "Not written." }) });
		check(readOnlyEdit.status >= 500 && !fs.readFileSync(readOnly, "utf-8").includes("Not written."), `an edit of a read-only SKILL.md fails as itself, not as a missing skill, got ${readOnlyEdit.status} ${JSON.stringify(readOnlyEdit.body)}`);
		fs.chmodSync(readOnly, 0o644);
		fs.rmSync(path.join(canonicalDir, "read-only-notes"), { recursive: true, force: true });
	} else console.log("SKIPPED: the read-only SKILL.md row (rights refuse no write on Windows or as root)");

	// Each record is written whole by a temporary file and a rename, which leaves none behind.
	const leftovers = fs.readdirSync(canonicalDir).filter((name) => name.endsWith(".tmp"));
	check(leftovers.length === 0, `no temporary record is left in the library, got ${JSON.stringify(leftovers)}`);

	assert(failed.length === 0, failed.join("\n"));

	console.log("skills-library-usage-smoke: OK");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-60).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	for (const file of [...locked.keys()]) unlock(file);
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
