import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The cross-tool shared skills directory (~/.agents/skills): skills there LIST
// in the library (source "shared", read-only) and a room uses them only once
// enabled there; an external edit is used as it now is, and the store routes
// never write into the shared dir. Symlinked skill dirs (the common shape of
// ~/.agents/skills) must both list AND enable. A skill's files open to a room
// at its real folder, after every link, wherever that lies; a home folder or
// above it, and a place no room opens, keep the skill to its instructions and
// the pages say why.

// Isolated HOME: shared dir resolves to <HOME>/.agents/skills, the canonical
// user store to <HOME>/.exxperts/agent/skills.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-shared-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
// The rooms' data inside ~/.agents, so a skill whose real folder lies in it or holds it is judged.
const roomsData = path.join(tempHome, ".agents", "holder", "rooms");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = roomsData;

const sharedDir = path.join(tempHome, ".agents", "skills");
const canonicalDir = path.join(tempHome, ".exxperts", "agent", "skills");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The rows of fitted names and taken names each run, so one run names every answer that is wrong.
const failures: string[] = [];
function check(condition: unknown, message: string): void {
	if (!condition) failures.push(message);
}

function seedSkill(dir: string, id: string, instructions: string): string {
	const skillDir = path.join(dir, id);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${id}`, `displayName: ${id}`, `description: seeded ${id}`, "---", "", instructions, ""].join("\n"),
	);
	return skillDir;
}

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

// --- Pre-boot fixtures --------------------------------------------------------
// A shared-only skill; a name that exists in BOTH shared and the user store
// (user must win); and a skill dir symlinked INTO the shared dir, the common
// layout when other tools populate ~/.agents/skills.
seedSkill(sharedDir, "shared-cite", "SHARED cite instructions from ~/.agents/skills");
seedSkill(sharedDir, "collide", "SHARED body that must lose to the user store");
seedSkill(canonicalDir, "collide", "USER body that must win the collision");
const linkedTarget = seedSkill(path.join(tempHome, "elsewhere"), "linked-skill", "symlinked shared skill body");
// Junctions work on Windows without symlink privileges; "dir" everywhere else.
const LINK_KIND = process.platform === "win32" ? "junction" : "dir";
fs.symlinkSync(linkedTarget, path.join(sharedDir, "linked-skill"), LINK_KIND);
/** A skill folder at `dir` holding SKILL.md and, unless `alone`, one script. */
function seedWithFiles(dir: string, name: string, alone = false): string {
	fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), ["---", `name: ${name}`, `description: seeded ${name}`, "---", "", `Run scripts/run.sh for ${name}.`, ""].join("\n"));
	if (alone) fs.rmSync(path.join(dir, "scripts"), { recursive: true });
	else fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "echo ran\n", { mode: 0o755 });
	return dir;
}
// For the skill's own answer: one whose files open, one linked outside ~/.agents, which opens too, and one in the rooms' data, kept to its instructions.
seedWithFiles(path.join(sharedDir, "shared-files"), "shared-files");
fs.symlinkSync(seedWithFiles(path.join(tempHome, "elsewhere", "shared-outside"), "shared-outside"), path.join(sharedDir, "shared-outside"), LINK_KIND);
fs.symlinkSync(seedWithFiles(path.join(roomsData, "planted", "shared-kept"), "shared-kept"), path.join(sharedDir, "shared-kept"), LINK_KIND);

/** A shared-folder skill in `folder` whose SKILL.md writes `name` (none when null). */
function writeShared(folder: string, name: string | null, instructions: string): void {
	fs.mkdirSync(path.join(sharedDir, folder), { recursive: true });
	fs.writeFileSync(path.join(sharedDir, folder, "SKILL.md"), ["---", ...(name === null ? [] : [`name: ${name}`]), `description: seeded ${folder}`, "---", "", instructions, ""].join("\n"));
}
// Written names the standard doesn't allow, each fitted: one plain, one whose cut
// at 48 characters ends on a hyphen, one of which nothing fits (its folder's name).
writeShared("team_tools", "Team Tools", "TEAM TOOLS body");
const LONG_NAME = `${"a".repeat(47)} b`;
writeShared("long-one", LONG_NAME, "LONG body");
writeShared("unicode-folder", "日本語", "UNICODE body");
// A name written exactly so; two more fit onto it later, read before it and after it.
writeShared("z-exact", "team-helper", "EXACT team-helper body");
// Two that only fit onto one name no skill has as written: neither has it.
writeShared("pair-one", "Pair Skill", "PAIR one body");
writeShared("pair-two", "Pair_Skill", "PAIR two body");
// Names a room could switch on before names were fitted, each kept as that skill:
// one of the person's own placed by hand in a folder named otherwise (no record of
// its adding), with a shared skill of the same name; a shared name, and a shared
// unnamed folder, longer than the 48 characters fitting cuts to; and one of the
// person's own under that cut name.
const OWN_WRITTEN = "my-notes";
fs.mkdirSync(path.join(canonicalDir, "notes"), { recursive: true });
fs.writeFileSync(path.join(canonicalDir, "notes", "SKILL.md"), ["---", `name: ${OWN_WRITTEN}`, "description: placed by hand", "---", "", "OWN by-hand body", ""].join("\n"));
writeShared(OWN_WRITTEN, OWN_WRITTEN, "SHARED my-notes body");
const LONG_WRITTEN = `${"b".repeat(30)}-${"c".repeat(29)}`;
writeShared("long-written", LONG_WRITTEN, "LONG written body");
const LONG_FOLDER = "d".repeat(55);
writeShared(LONG_FOLDER, null, "LONG folder body");
seedSkill(canonicalDir, LONG_WRITTEN.slice(0, 48), "OWN cut-name body");

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
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
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 15000);

	// --- Listing: shared skills appear, read-only, no provenance sidecar -------
	const list = await requestJson("/api/skills");
	assert(list.status === 200, `GET /api/skills should succeed, got ${list.status}`);
	const byName = new Map<string, any>((list.body as any[]).map((s) => [s.name, s]));
	const shared = byName.get("shared-cite");
	assert(shared, "shared-dir skill should list in the library");
	assert(shared.source === "shared", `shared skill should carry source "shared", got ${shared.source}`);
	assert(shared.protected === true, "shared skill must be protected (not editable/deletable from the library)");
	assert(shared.provenance === null || shared.provenance === undefined, "shared skill must carry no provenance sidecar data");

	// Precedence: the user store wins a name collision with the shared dir.
	const collide = byName.get("collide");
	assert(collide, "colliding skill should list once");
	assert(collide.source === "user", `user store must win the collision, got source ${collide.source}`);
	assert(collide.body.includes("USER body"), "collision must surface the user-store body");

	// The symlinked shared skill lists too.
	assert(byName.get("linked-skill"), "symlinked shared skill should list in the library");

	// --- Read-only: no write route can touch the shared dir --------------------
	const edited = await requestJson("/api/skills/shared-cite", {
		method: "PUT",
		body: JSON.stringify({ id: "shared-cite", displayName: "x", description: "x", instructions: "overwritten" }),
	});
	assert(edited.status === 404, `PUT of a shared skill must 404, got ${edited.status}`);
	const deleted = await requestJson("/api/skills/shared-cite", { method: "DELETE" });
	assert(deleted.status === 404, `DELETE of a shared skill must 404, got ${deleted.status}`);
	const recreated = await requestJson("/api/skills", {
		method: "POST",
		body: JSON.stringify({ id: "shared-cite", displayName: "x", description: "x", instructions: "shadow attempt" }),
	});
	assert(recreated.status === 409, `POST with a shared skill's name must 409, got ${recreated.status}`);
	const sharedManifest = fs.readFileSync(path.join(sharedDir, "shared-cite", "SKILL.md"), "utf-8");
	assert(sharedManifest.includes("SHARED cite instructions"), "the shared dir file must be untouched by write attempts");
	assert(!fs.existsSync(path.join(sharedDir, "shared-cite", "provenance.json")), "no provenance sidecar may be written into the shared dir");

	// --- Enablement: the hash pin covers shared skills, symlinks included ------
	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({ displayName: "Shared Skills Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.status === 201, `room create should succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
	const agentId = String(created.body?.agent?.agentId ?? "");
	assert(agentId, "room create should return an agent id");

	const enableShared = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, {
		method: "PUT",
		body: JSON.stringify({ action: "enable", name: "shared-cite" }),
	});
	assert(enableShared.status === 200, `enabling a shared skill should succeed, got ${enableShared.status}: ${JSON.stringify(enableShared.body)}`);
	const sharedStatus = (enableShared.body.skills as any[]).find((s) => s.name === "shared-cite");
	assert(sharedStatus?.status === "ok", `freshly enabled shared skill should be status ok, got ${JSON.stringify(sharedStatus)}`);

	// Symlinked skills must ENABLE, not just list (the fingerprint resolves
	// through the link; the content hash is the integrity unit).
	const enableLinked = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, {
		method: "PUT",
		body: JSON.stringify({ action: "enable", name: "linked-skill" }),
	});
	assert(enableLinked.status === 200, `enabling a symlinked shared skill should succeed, got ${enableLinked.status}: ${JSON.stringify(enableLinked.body)}`);
	const linkedStatus = (enableLinked.body.skills as any[]).find((s) => s.name === "linked-skill");
	assert(linkedStatus?.status === "ok", `symlinked shared skill should enable with status ok, got ${JSON.stringify(linkedStatus)}`);

	// --- An external edit to a shared skill keeps it on, as it now is ----------
	fs.writeFileSync(
		path.join(sharedDir, "shared-cite", "SKILL.md"),
		["---", "name: shared-cite", "displayName: shared-cite", "description: seeded shared-cite", "---", "", "EDITED by another tool behind exxperts' back", ""].join("\n"),
	);
	const afterEdit = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`);
	assert(afterEdit.status === 200, `skill-settings read should succeed, got ${afterEdit.status}`);
	const editedStatus = (afterEdit.body.skills as any[]).find((s) => s.name === "shared-cite");
	assert(editedStatus?.status === "ok", `an externally edited shared skill stays on, as it now is, got ${JSON.stringify(editedStatus)}`);

	// --- Written names that don't fit: listed and switched on under their fitted names --
	const enable = (name: string) => requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name }) });
	const listed = async () => new Map<string, any>(((await requestJson("/api/skills")).body as any[]).map((skill) => [skill.name, skill]));
	const fitted = await listed();
	for (const [key, written, body] of [["team-tools", "Team Tools", "TEAM TOOLS body"], ["a".repeat(47), LONG_NAME, "LONG body"], ["unicode-folder", "日本語", "UNICODE body"]]) {
		const skill = fitted.get(key);
		check(skill?.source === "shared" && skill.displayName === written && skill.body.includes(body), `"${written}" is listed as ${key}, with its written name, got ${JSON.stringify(skill)}`);
		const on = await enable(key);
		const status = (on.body?.skills as any[] | undefined)?.find((entry) => entry.name === key)?.status;
		check(on.status === 200 && status === "ok", `"${written}" is switched on as ${key}, got ${on.status}: ${JSON.stringify(on.body)}`);
		const detail = await requestJson(`/api/skills/${encodeURIComponent(key)}`);
		check(detail.status === 200 && detail.body?.body?.includes(body), `${key}'s page opens, got ${detail.status}: ${JSON.stringify(detail.body)}`);
	}

	// --- A name a room has on stays that skill when others fit onto it --------------
	const helperOn = await enable("team-helper");
	check(helperOn.status === 200, `team-helper is switched on, got ${helperOn.status}: ${JSON.stringify(helperOn.body)}`);
	writeShared("a-fitted", "Team Helper", "FITTED before body");
	writeShared("zz-fitted", "Team_Helper", "FITTED after body");
	const collided = await listed();
	check(collided.get("team-helper")?.body.includes("EXACT team-helper body") && collided.get("team-helper")?.nameTaken === undefined, `team-helper is still the skill written so, got ${JSON.stringify(collided.get("team-helper"))}`);
	for (const [written, body] of [["Team Helper", "FITTED before body"], ["Team_Helper", "FITTED after body"]]) {
		const other = collided.get(written);
		check(other?.nameTaken === "team-helper" && other.body.includes(body), `"${written}" is listed under its written name and names /team-helper, got ${JSON.stringify(other)}`);
		check((await enable(written)).status !== 200, `"${written}" can't be switched on`);
		// Its row opens as itself, never as the skill that has the name.
		const page = await requestJson(`/api/skills/${encodeURIComponent(written)}`);
		check(page.status === 200 && page.body?.body?.includes(body) && page.body?.nameTaken === "team-helper", `"${written}"'s page opens as itself, got ${page.status}: ${JSON.stringify(page.body)}`);
	}
	const helperPage = await requestJson("/api/skills/team-helper");
	check(helperPage.status === 200 && helperPage.body?.body?.includes("EXACT team-helper body"), `team-helper's page opens the skill written so, got ${JSON.stringify(helperPage.body)}`);
	const roomNow = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`);
	const helperStatus = (roomNow.body?.skills as any[] | undefined)?.find((entry) => entry.name === "team-helper")?.status;
	check(helperStatus === "ok", `the room keeps team-helper on, got ${JSON.stringify(roomNow.body)}`);

	// --- Two that only fit onto one name: neither has it ------------------------------
	check(!collided.has("pair-skill"), `no skill is listed as pair-skill, got ${JSON.stringify(collided.get("pair-skill"))}`);
	for (const written of ["Pair Skill", "Pair_Skill"]) check(collided.get(written)?.nameTaken === "pair-skill", `"${written}" is listed under its written name and names /pair-skill, got ${JSON.stringify(collided.get(written))}`);
	check((await enable("pair-skill")).status !== 200, "pair-skill can't be switched on");

	// --- Names a room could switch on before fitting stay on, as the same skill --------
	const kept = await listed();
	for (const [name, body] of [[OWN_WRITTEN, "OWN by-hand body"], [LONG_WRITTEN, "LONG written body"], [LONG_FOLDER, "LONG folder body"], [LONG_WRITTEN.slice(0, 48), "OWN cut-name body"]]) {
		check(kept.get(name)?.body.includes(body), `${name} is listed as the same skill, got ${JSON.stringify(kept.get(name))}`);
		const on = await enable(name);
		const status = (on.body?.skills as any[] | undefined)?.find((entry) => entry.name === name)?.status;
		check(on.status === 200 && status === "ok", `${name} is switched on, got ${on.status}: ${JSON.stringify(on.body)}`);
		const page = await requestJson(`/api/skills/${encodeURIComponent(name)}`);
		check(page.status === 200 && page.body?.body?.includes(body), `${name}'s page opens the same skill, got ${page.status}: ${JSON.stringify(page.body)}`);
	}

	// --- The skill's own answer: an open skill's files, none for one kept to its instructions --
	const openAnswer = await requestJson("/api/skills/shared-files");
	check(openAnswer.status === 200 && openAnswer.body?.files?.some((file: any) => file.path === "scripts/run.sh") && openAnswer.body?.instructionsOnly === undefined, `an open shared-folder skill's answer lists its files, got ${JSON.stringify(openAnswer.body)}`);
	check(openAnswer.body?.filesAt === undefined, `a skill whose files are inside ~/.agents says nothing of where they are, got ${JSON.stringify(openAnswer.body?.filesAt)}`);
	const outsideAnswer = await requestJson("/api/skills/shared-outside");
	check(outsideAnswer.status === 200 && outsideAnswer.body?.files?.some((file: any) => file.path === "scripts/run.sh") && outsideAnswer.body?.instructionsOnly === undefined && outsideAnswer.body?.filesAt === "~/elsewhere/shared-outside", `a shared-folder skill linked outside ~/.agents lists its files and says where they are, got ${JSON.stringify(outsideAnswer.body)}`);
	const keptAnswer = await requestJson("/api/skills/shared-kept");
	check(keptAnswer.status === 200 && keptAnswer.body?.files?.length === 0 && keptAnswer.body?.instructionsOnly === "cant-open" && keptAnswer.body?.filesAt === undefined, `a shared-folder skill in the rooms' data lists no files and says "cant-open", got ${JSON.stringify(keptAnswer.body)}`);

	await stopSmokeServer(server);
	server = null;
	await roomFolderRows();

	assert(failures.length === 0, failures.join("\n"));

	console.log("skills shared-dir smoke passed: ~/.agents/skills lists as a read-only shared root (user store wins collisions, no route writes into it, no sidecars), symlinked skills list and enable, and an external edit to an enabled shared skill keeps it on");
} finally {
	if (server) await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}

/**
 * Which shared-folder skills' folders a room opens (`roomSkillFolders`), and why
 * the pages say one keeps to its instructions, in this process: the homes, the
 * data folder and the agent folder are moved between rows.
 */
async function roomFolderRows(): Promise<void> {
	const { enablePersistentRoomSkill } = await import("../src/persistent-room-skill-settings.js");
	const { readLibrarySkill, roomSkillFolders, roomSkillInRoom, sharedPlaceKept } = await import("../src/skills-executable.js");
	const { librarySkillView, listSkills } = await import("../src/skills-library.js");
	const { roomSkillFilesView, skillFilesSection } = await import("../src/persistent-room-skill-tool.js");
	const room = "shared-folders-room";
	const real = (place: string): string => fs.realpathSync.native(place);
	const on = (name: string): void => {
		const result = enablePersistentRoomSkill(room, name, readLibrarySkill);
		check(result.ok, `${name} is switched on, got ${JSON.stringify(result)}`);
	};
	const opened = (name: string) => roomSkillFolders(room).find((skill) => skill.name === name);
	const reason = (name: string): unknown => {
		const skill = listSkills().find((item) => item.name === name);
		return skill ? librarySkillView(skill, new Map()).instructionsOnly : "not listed";
	};
	const filesAt = (name: string): unknown => {
		const skill = listSkills().find((item) => item.name === name);
		return skill ? (librarySkillView(skill, new Map()) as { filesAt?: string }).filesAt : "not listed";
	};
	/** A shared-folder skill linked from ~/.agents/skills/`name` to `target`, switched on. */
	const linked = (name: string, target: string, alone = false): string => {
		seedWithFiles(target, name, alone);
		fs.symlinkSync(target, path.join(sharedDir, name), LINK_KIND);
		on(name);
		return target;
	};
	const closed = (name: string, why: unknown, row: string): void => {
		check(opened(name) === undefined, `${row}: nothing opens, got ${JSON.stringify(opened(name))}`);
		check(reason(name) === why, `${row}: the library item says ${JSON.stringify(why)}, got ${JSON.stringify(reason(name))}`);
	};

	// A plain one, a linked one inside ~/.agents, and a link to a link ending inside it.
	seedWithFiles(path.join(sharedDir, "plain-tool"), "plain-tool");
	on("plain-tool");
	const plain = opened("plain-tool");
	check(plain?.skillDir === real(path.join(sharedDir, "plain-tool")) && plain.files.join(",") === "scripts/run.sh", `a plain shared-folder skill gives its folder and files, got ${JSON.stringify(plain)}`);
	check(reason("plain-tool") === undefined && filesAt("plain-tool") === undefined, "an open skill's item inside ~/.agents gives no reason and no place");
	const inside = linked("inside-tool", path.join(tempHome, ".agents", "store", "inside-tool"));
	check(opened("inside-tool")?.skillDir === real(inside), `a link inside ~/.agents gives the real folder, never the link, got ${JSON.stringify(opened("inside-tool"))}`);
	check(filesAt("inside-tool") === undefined, `a link inside ~/.agents says nothing of where its files are, got ${JSON.stringify(filesAt("inside-tool"))}`);
	const chainEnd = seedWithFiles(path.join(tempHome, ".agents", "store", "chain-end"), "chain-tool");
	fs.symlinkSync(chainEnd, path.join(tempHome, ".agents", "hop"), LINK_KIND);
	fs.symlinkSync(path.join(tempHome, ".agents", "hop"), path.join(sharedDir, "chain-tool"), LINK_KIND);
	on("chain-tool");
	check(opened("chain-tool")?.skillDir === real(chainEnd), `a link to a link gives the last real folder, got ${JSON.stringify(opened("chain-tool"))}`);

	// A link outside ~/.agents opens at its real folder, and the pages say where its files are; with SKILL.md alone, nothing to say.
	const away = linked("away-tool", path.join(tempHome, "projects", "away-tool"));
	const awayOpened = opened("away-tool");
	check(awayOpened?.skillDir === real(away) && awayOpened.files.join(",") === "scripts/run.sh", `a link outside ~/.agents gives its real folder and files, got ${JSON.stringify(awayOpened)}`);
	check(reason("away-tool") === undefined && filesAt("away-tool") === "~/projects/away-tool", `a link outside ~/.agents: no reason, its files' place with the home as ~, got ${JSON.stringify([reason("away-tool"), filesAt("away-tool")])}`);
	const awayAlone = linked("away-alone", path.join(tempHome, "projects", "away-alone"), true);
	check(opened("away-alone")?.skillDir === real(awayAlone) && reason("away-alone") === undefined && filesAt("away-alone") === undefined, `a link outside ~/.agents to SKILL.md alone opens with nothing to say, got ${JSON.stringify([opened("away-alone"), filesAt("away-alone")])}`);
	const awayView = roomSkillFilesView(room, "away-tool", "run", true);
	check(awayView?.kind === "open" && awayView.skillDir === real(away), `the model gets the folder of a skill linked outside ~/.agents, got ${JSON.stringify(awayView)}`);

	// A link into another tool's own folder opens by the same rule.
	const claude = linked("claude-tool", path.join(tempHome, ".claude", "skills", "claude-tool"));
	check(opened("claude-tool")?.skillDir === real(claude) && filesAt("claude-tool") === "~/.claude/skills/claude-tool", `a link into another tool's folder opens, got ${JSON.stringify([opened("claude-tool"), filesAt("claude-tool")])}`);

	// A link to the home folder: instructions only, with "home".
	linked("home-tool", tempHome);
	closed("home-tool", "home", "a link to the home folder");
	check(filesAt("home-tool") === undefined, "a skill kept to its instructions says nothing of where its files are");

	// A link changed after the skill was switched on: the next read follows it, and closes at a closed place.
	const turnA = linked("turn-tool", path.join(tempHome, ".agents", "store", "turn-a"));
	check(opened("turn-tool")?.skillDir === real(turnA), `before the change, the first real folder, got ${JSON.stringify(opened("turn-tool"))}`);
	const turnB = seedWithFiles(path.join(tempHome, "projects", "turn-b"), "turn-tool");
	fs.rmSync(path.join(sharedDir, "turn-tool"));
	fs.symlinkSync(turnB, path.join(sharedDir, "turn-tool"), LINK_KIND);
	check(opened("turn-tool")?.skillDir === real(turnB) && filesAt("turn-tool") === "~/projects/turn-b", `after the change, the new real folder, got ${JSON.stringify(opened("turn-tool"))}`);
	const turnC = seedWithFiles(path.join(roomsData, "planted", "turn-c"), "turn-tool");
	fs.rmSync(path.join(sharedDir, "turn-tool"));
	fs.symlinkSync(turnC, path.join(sharedDir, "turn-tool"), LINK_KIND);
	closed("turn-tool", "cant-open", "a link changed to a folder in the rooms' data");

	// A link whose target is gone: nothing opens, nothing throws.
	fs.symlinkSync(path.join(tempHome, "gone"), path.join(sharedDir, "gone-tool"), LINK_KIND);
	let goneThrew = false;
	try {
		roomSkillFolders(room);
		reason("gone-tool");
	} catch {
		goneThrew = true;
	}
	check(!goneThrew && opened("gone-tool") === undefined, "a link whose target is gone opens nothing and nothing throws");

	// A library skill of the same name wins, and the shared folder opens nothing.
	seedWithFiles(path.join(sharedDir, "twin-tool"), "twin-tool");
	const ownTwin = seedWithFiles(path.join(canonicalDir, "twin-tool"), "twin-tool");
	on("twin-tool");
	check(opened("twin-tool")?.skillDir === ownTwin, `the library's own copy wins over the shared one, got ${JSON.stringify(opened("twin-tool"))}`);

	// A place no room opens: in, or holding, the rooms' data or the app's data.
	linked("in-rooms", path.join(roomsData, "planted", "in-rooms"));
	closed("in-rooms", "cant-open", "a real folder in the rooms' data");
	const view = roomSkillFilesView(room, "in-rooms", "run", true);
	check(view !== null && skillFilesSection(view, false) === "This skill has 1 more file beside these instructions, and rooms can't open them. Work from the instructions alone.", `a skill kept to its instructions gets Task 2's line, got ${view ? skillFilesSection(view, false) : "nothing"}`);
	linked("holds-rooms", path.join(tempHome, ".agents", "holder"));
	closed("holds-rooms", "cant-open", "a real folder holding the rooms' data");
	const dataHome = path.join(tempHome, ".agents", "data");
	linked("in-data", path.join(dataHome, ".exxperts", "planted", "in-data"));
	linked("holds-data", dataHome);
	check(opened("in-data") !== undefined && opened("holds-data") !== undefined, "with the data folder elsewhere, those folders open");
	process.env.EXXPERTS_STATE_HOME = dataHome;
	try {
		closed("in-data", "cant-open", "a real folder in the app's data moved inside ~/.agents");
		closed("holds-data", "cant-open", "a real folder holding the app's data moved inside ~/.agents");
	} finally {
		delete process.env.EXXPERTS_STATE_HOME;
	}

	// A folder that can't be listed whole.
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		const locked = seedWithFiles(path.join(sharedDir, "locked-tool"), "locked-tool");
		on("locked-tool");
		fs.mkdirSync(path.join(locked, "private"));
		fs.chmodSync(path.join(locked, "private"), 0o000);
		try {
			closed("locked-tool", "cant-open", "a folder that can't be listed");
		} finally {
			fs.chmodSync(path.join(locked, "private"), 0o755);
		}
	} else console.log("SKIPPED: the folder that can't be listed (taking rights away refuses no read on Windows or as root)");

	// A network place by the fence's own test of its path (no such folder can be made here).
	const share = process.platform === "win32" ? "\\\\host\\share" : "/net/host/share";
	const judged = (place: string): unknown => {
		try {
			return sharedPlaceKept(place);
		} catch (error) {
			return `threw: ${(error as Error).message}`;
		}
	};
	check(judged(path.join(share, ".agents", "skills", "net-tool")) === "cant-open", "a real folder at a network place: can't open");
	// The home folder, a folder above it and the disk's top, by their real paths: "home".
	check(judged(real(tempHome)) === "home" && judged(path.dirname(real(tempHome))) === "home" && judged(path.parse(real(tempHome)).root) === "home", `home, above it and the disk's top are "home", got ${JSON.stringify([judged(real(tempHome)), judged(path.dirname(real(tempHome))), judged(path.parse(real(tempHome)).root)])}`);
	check(judged(path.join(real(tempHome), "projects")) === null, `a folder in the home folder opens, got ${JSON.stringify(judged(path.join(real(tempHome), "projects")))}`);

	// The path check: a real path that would change the model's text opens nothing; ordinary names open.
	if (process.platform !== "win32") {
		const store = path.join(tempHome, ".agents", "named");
		const refused: Array<[string, string]> = [
			["a line feed and a closing marker", path.join(store, "x\n[", "SKILL PICKED]")],
			["a carriage return", path.join(store, "cr\rname")],
			["a tab", path.join(store, "tab\tname")],
			["U+2028", path.join(store, "line\u2028sep")],
			["a zero-width space", path.join(store, "zero\u200bwidth")],
			["a consult handoff marker", path.join(store, "[CONSULT HANDOFF FROM x]")],
			["a specialist result marker", path.join(store, "[", "SPECIALIST RESULT: x]")],
			["the must-keep mark", path.join(store, "**must-keep**")],
			["a skill tag", path.join(store, "<skill>")],
		];
		refused.forEach(([row, target], index) => {
			linked(`named-${index}`, target);
			closed(`named-${index}`, "cant-open", `a real path holding ${row}`);
		});
		const fits: Array<[string, string]> = [["spaces", "with spaces"], ["brackets", "[draft]"], ["parentheses", "(v2)"], ["non-Latin letters", "日本語"]];
		fits.forEach(([row, folder], index) => {
			const target = linked(`fits-${index}`, path.join(store, folder));
			check(opened(`fits-${index}`)?.skillDir === real(target), `a real path with ${row} opens, got ${JSON.stringify(opened(`fits-${index}`))}`);
		});
		// A skill of the person's own under a data folder whose path holds a line feed.
		process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, "data\nfolder", "agent");
		try {
			seedWithFiles(path.join(process.env.EXXPERTS_CODING_AGENT_DIR, "skills", "own-tool"), "own-tool");
			on("own-tool");
			const ownView = roomSkillFilesView(room, "own-tool", "run", true);
			check(opened("own-tool") === undefined && !(ownView ? skillFilesSection(ownView, false) : "").includes("data\nfolder"), `the person's own skill under such a folder opens nothing and names no path, got ${JSON.stringify(opened("own-tool"))}`);
		} finally {
			delete process.env.EXXPERTS_CODING_AGENT_DIR;
		}
	} else console.log("SKIPPED: the path check's rows (Windows refuses those names)");

	// ~/.agents/skills itself a link to a folder outside ~/.agents, ~/.agents itself a link, and a link above the home folder.
	const homeOut = path.join(tempHome, "home-skills-out");
	fs.mkdirSync(path.join(homeOut, ".agents"), { recursive: true });
	seedWithFiles(path.join(homeOut, "other-skills", "moved-tool"), "moved-tool");
	fs.symlinkSync(path.join(homeOut, "other-skills"), path.join(homeOut, ".agents", "skills"), LINK_KIND);
	const homeLinked = path.join(tempHome, "home-agents-linked");
	fs.mkdirSync(homeLinked, { recursive: true });
	const agentsElsewhere = path.join(tempHome, "agents-elsewhere");
	seedWithFiles(path.join(agentsElsewhere, "skills", "far-tool"), "far-tool");
	fs.symlinkSync(agentsElsewhere, path.join(homeLinked, ".agents"), LINK_KIND);
	try {
		process.env.HOME = homeOut;
		process.env.USERPROFILE = homeOut;
		on("moved-tool");
		check(opened("moved-tool")?.skillDir === real(path.join(homeOut, "other-skills", "moved-tool")) && filesAt("moved-tool") === "~/other-skills/moved-tool", `~/.agents/skills a link to a folder outside ~/.agents: its skills open there, got ${JSON.stringify([opened("moved-tool"), filesAt("moved-tool")])}`);
		process.env.HOME = homeLinked;
		process.env.USERPROFILE = homeLinked;
		on("far-tool");
		check(opened("far-tool")?.skillDir === real(path.join(agentsElsewhere, "skills", "far-tool")), `~/.agents a link: its skills open at their real folders, got ${JSON.stringify(opened("far-tool"))}`);
		// A home inside a folder whose skill links to that folder, above the home.
		const above = path.join(tempHome, "above");
		const innerHome = path.join(above, "inner-home");
		fs.mkdirSync(path.join(innerHome, ".agents", "skills"), { recursive: true });
		fs.writeFileSync(path.join(above, "SKILL.md"), ["---", "name: above-tool", "description: seeded above-tool", "---", "", "Above the home.", ""].join("\n"));
		fs.writeFileSync(path.join(above, "notes.md"), "notes\n");
		fs.symlinkSync(above, path.join(innerHome, ".agents", "skills", "above-tool"), LINK_KIND);
		process.env.HOME = innerHome;
		process.env.USERPROFILE = innerHome;
		on("above-tool");
		closed("above-tool", "home", "a link to a folder above the home folder");
	} finally {
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	}

	// A skill's way entering a folder a room can write: from there on that room's commands could change it, so the
	// server opens nothing for it there and tells where the way enters; a room that can't write it opens the skill as before.
	const { createPersistentRoomDefaultCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
	const { addAlsoAllowedFolder, saveAlsoAllowedFolders } = await import("../src/room-box/also-allowed.js");
	const writerFolder = path.join(tempHome, "work", "writer-room");
	const otherFolder = path.join(tempHome, "work", "other-room");
	const roomOn = (roomId: string, roomFolder: string, names: readonly string[]): void => {
		fs.mkdirSync(roomFolder, { recursive: true });
		writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: roomId, repoRoot, root: roomFolder, workspaceAccessMode: "localFiles", displayLabel: roomId, source: "manual" }));
		for (const name of names) check(enablePersistentRoomSkill(roomId, name, readLibrarySkill).ok, `${name} is switched on in ${roomId}`);
	};
	const openedIn = (roomId: string, name: string) => roomSkillFolders(roomId).find((skill) => skill.name === name);
	const inWriter = seedWithFiles(path.join(writerFolder, "team", "in-room-tool"), "in-room-tool");
	fs.symlinkSync(inWriter, path.join(sharedDir, "in-room-tool"), LINK_KIND);
	const teamStore = path.join(tempHome, "team-store");
	const throughTarget = seedWithFiles(path.join(teamStore, "through-tool"), "through-tool");
	fs.mkdirSync(writerFolder, { recursive: true });
	fs.symlinkSync(teamStore, path.join(writerFolder, "store"), LINK_KIND);
	fs.symlinkSync(path.join(writerFolder, "store", "through-tool"), path.join(sharedDir, "through-tool"), LINK_KIND);
	const hopTarget = seedWithFiles(path.join(teamStore, "hop-tool"), "hop-tool");
	fs.symlinkSync(hopTarget, path.join(writerFolder, "hop-tool"), LINK_KIND);
	fs.symlinkSync(path.join(writerFolder, "hop-tool"), path.join(tempHome, ".agents", "hop-tool"), LINK_KIND);
	fs.symlinkSync(path.join(tempHome, ".agents", "hop-tool"), path.join(sharedDir, "hop-tool"), LINK_KIND);
	const names = ["in-room-tool", "through-tool", "hop-tool", ...(process.platform === "win32" ? [] : ["relative-tool"])];
	const relativeTarget = seedWithFiles(path.join(teamStore, "relative-tool"), "relative-tool");
	if (process.platform !== "win32") fs.symlinkSync(path.join("..", "..", "work", "writer-room", "store", "relative-tool"), path.join(sharedDir, "relative-tool"));
	roomOn("writer-room", writerFolder, names);
	roomOn("other-room", otherFolder, names);
	const writerReal = real(writerFolder);
	try {
		const told = (name: string) => [openedIn("writer-room", name), roomSkillInRoom("writer-room", name)];
		check(openedIn("writer-room", "in-room-tool") === undefined && roomSkillInRoom("writer-room", "in-room-tool") === real(inWriter), `a real folder in the room's own folder opens nothing from the server and is told where it is, got ${JSON.stringify(told("in-room-tool"))}`);
		check(openedIn("writer-room", "through-tool") === undefined && roomSkillInRoom("writer-room", "through-tool") === path.join(writerReal, "store", "through-tool"), `a skill reached through a link inside the room's folder opens nothing there, and is told where its way enters the room's folder, got ${JSON.stringify(told("through-tool"))}`);
		check(openedIn("writer-room", "hop-tool") === undefined && roomSkillInRoom("writer-room", "hop-tool") === path.join(writerReal, "hop-tool"), `a link to a link lying in the room's folder opens nothing there, got ${JSON.stringify(told("hop-tool"))}`);
		if (process.platform !== "win32") check(openedIn("writer-room", "relative-tool") === undefined && roomSkillInRoom("writer-room", "relative-tool") === path.join(writerReal, "store", "relative-tool"), `a relative link through the room's folder opens nothing there, got ${JSON.stringify(told("relative-tool"))}`);
		const keptView = roomSkillFilesView("writer-room", "through-tool", "run", true);
		const keptText = keptView ? skillFilesSection(keptView, false) : "nothing";
		check(keptText.startsWith(`This skill's bundled files live at:\n${path.join(writerReal, "store", "through-tool")}\n`) && keptText.includes("\nIt lies among this room's own folders: list it, or any folder in it, with the ls tool. If what is there is not this skill's folder, work from the instructions alone.\n") && !keptText.includes("Files:"), `the model is told where the skill lies in the room's folder, with no list of its files, got ${keptText}`);
		check(roomSkillFilesView("writer-room", "through-tool", "none", true)?.kind !== "open", "a room that can't read files is told no folder");
		// On Windows the room runs what lies in its own folders, a link elsewhere in them or not: only a skill folder outside them is judged for running.
		const { WINDOWS_SKILL_RUN_LINE } = await import("../src/room-box/windows/model-lines.js");
		check(keptView?.kind === "in-room" && skillFilesSection(keptView, true).includes(`\n${WINDOWS_SKILL_RUN_LINE} `), `a protected Windows room is told to run the skill's files where they lie in its folder, got ${keptView ? `${keptView.kind}: ${skillFilesSection(keptView, true)}` : "nothing"}`);
		for (const [name, target] of [["in-room-tool", inWriter], ["through-tool", throughTarget], ["hop-tool", hopTarget], ...(process.platform === "win32" ? [] : [["relative-tool", relativeTarget]])] as const) {
			check(openedIn("other-room", name)?.skillDir === real(target), `a room that can't write the link opens ${name} as before, got ${JSON.stringify(openedIn("other-room", name))}`);
		}
		// Can change files is a switch the person turns at any time: a link left while it was on stays, so the room's folder still counts.
		writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: "reading-room", repoRoot, root: writerFolder, workspaceAccessMode: "localFiles", displayLabel: "reading-room", source: "manual", toolSelection: { kind: "custom", allowedToolNames: ["ls", "find", "grep", "read"] } }));
		check(enablePersistentRoomSkill("reading-room", "through-tool", readLibrarySkill).ok, "through-tool is switched on in reading-room");
		check(openedIn("reading-room", "through-tool") === undefined, `a room that can't change files now still doesn't open a skill reached through a link in its folder, got ${JSON.stringify(openedIn("reading-room", "through-tool"))}`);
		addAlsoAllowedFolder("other-room", writerFolder, "read");
		check(openedIn("other-room", "through-tool")?.skillDir === real(throughTarget), `with the link's folder allowed for reading only, the skill opens, got ${JSON.stringify(openedIn("other-room", "through-tool"))}`);
		addAlsoAllowedFolder("other-room", writerFolder, "write");
		check(openedIn("other-room", "through-tool") === undefined && openedIn("other-room", "in-room-tool") === undefined && roomSkillInRoom("other-room", "in-room-tool") === real(inWriter), `with the link's folder allowed for writing, neither skill whose way enters it opens from the server, got ${JSON.stringify([openedIn("other-room", "through-tool"), openedIn("other-room", "in-room-tool")])}`);
	} finally {
		saveAlsoAllowedFolders("other-room", []);
	}
	// The skill's folder in the room a link to a folder outside whenever the server resolves a path, and a plain folder
	// when it looks at the name, as a job the room's command left running could time it: the room never gets that folder,
	// and the server resolves nothing inside the room's folder.
	if (process.platform !== "win32") {
		const flipTarget = seedWithFiles(path.join(tempHome, "flip-target"), "flip-tool");
		const flipIn = seedWithFiles(path.join(writerFolder, "team", "flip-tool"), "flip-tool");
		const flipEntry = path.join(sharedDir, "flip-tool");
		fs.symlinkSync(flipIn, flipEntry);
		check(enablePersistentRoomSkill("writer-room", "flip-tool", readLibrarySkill).ok, "flip-tool is switched on in writer-room");
		const resolve = fs.realpathSync.native;
		const flipInReal = resolve(flipIn);
		const flipTargetReal = resolve(flipTarget);
		const asLink = (place: fs.PathLike, rest: any[]) => {
			fs.renameSync(flipIn, `${flipIn}-real`);
			fs.symlinkSync(flipTarget, flipIn);
			try {
				return (resolve as any)(place, ...rest);
			} finally {
				fs.unlinkSync(flipIn);
				fs.renameSync(`${flipIn}-real`, flipIn);
			}
		};
		const resolved: string[] = [];
		fs.realpathSync.native = ((place: fs.PathLike, ...rest: any[]) => {
			if (String(place) === flipEntry || [writerReal, writerFolder].some((room) => String(place).startsWith(`${room}${path.sep}`))) {
				resolved.push(String(place));
				return asLink(place, rest);
			}
			return (resolve as any)(place, ...rest);
		}) as typeof fs.realpathSync.native;
		let got: unknown;
		let inRoom: string | undefined;
		try {
			got = roomSkillFolders("writer-room").find((skill) => skill.name === "flip-tool");
			inRoom = roomSkillInRoom("writer-room", "flip-tool");
		} finally {
			fs.realpathSync.native = resolve;
		}
		check(got === undefined && inRoom === flipInReal && inRoom !== flipTargetReal, `a folder outside opened through a link the room shows only while a path is resolved, got ${JSON.stringify([got, inRoom])}`);
		check(!resolved.some((place) => place !== flipEntry), `the server resolved a path inside the room's folder: ${JSON.stringify(resolved)}`);
		check(openedIn("writer-room", "flip-tool") === undefined && roomSkillInRoom("writer-room", "flip-tool") === flipInReal, `left as it is, the real folder in the room is told where it is and opens nothing from the server, got ${JSON.stringify(openedIn("writer-room", "flip-tool"))}`);
	} else console.log("SKIPPED: the folder turned into a link and back (a junction there is moved differently)");

	// A shared server: nothing opens, and no item gives a reason.
	const { registerServerHooks } = await import("../src/server-hooks.js");
	registerServerHooks({});
	check(opened("plain-tool") === undefined && opened("inside-tool") === undefined && opened("away-tool") === undefined, "on a shared server no shared-folder skill opens");
	check(reason("in-rooms") === undefined && reason("home-tool") === undefined && filesAt("away-tool") === undefined, "on a shared server no item gives a reason or a place");
}
