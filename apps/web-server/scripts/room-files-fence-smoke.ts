// Every room's six file tools stop at its folder and its Also allowed list, in
// Full access and in Bounded, on every platform: each tool works inside and is
// refused outside, whatever the path's spelling. A Can read folder reads and
// refuses a write, a list change reaches the next call, the names the box never
// lets a command change are refused from the box's own arrays, a link is
// refused, and a saved folder card the room already opens isn't shown. A path
// refused in the app's skills folder is named as a skill's folder; a key in a
// skill that is on, as a key. A path in the running answer's own temp for
// commands is named as that temp, with no step for the person and no folder
// ask; another room's temp and the rest of the app's data keep the secret-file
// line.
// Offline, in a throwaway HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-fence-")));
const home = path.join(tmp, "home");
const exxetaStateRoot = path.join(home, ".exxperts", "app");
const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, EXXETA_PERSISTENT_AGENTS_ROOT: process.env.EXXETA_PERSISTENT_AGENTS_ROOT };
// The room list's file and `~` are found from these, so they are set before the first import.
Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXETA_PERSISTENT_AGENTS_ROOT: persistentAgentsRoot });

const { createPersistentRoomCapabilityPolicy, hashPersistentRoomPath } = await import("../src/persistent-room-workspace-policy.js");
const { ownTempRefusal, ROOM_FOLDER_REFUSED } = await import("../src/room-files.js");
const { createPersistentRoomWorkspaceTools } = await import("../src/persistent-room-workspace-tools.js");
const { addAlsoAllowedFolder, saveAlsoAllowedFolders } = await import("../src/room-box/also-allowed.js");
const { NEVER_WRITABLE_FILES, NEVER_WRITABLE_FOLDERS, NEVER_WRITABLE_GLOBS } = await import("../src/room-box/box-rules.js");
const { stepOutcome } = await import("../../web-ui/src/step-lines.js");
const { agentSkillsDir } = await import("../src/skills-store.js");
const { readLibrarySkill } = await import("../src/skills-executable.js");
const { enablePersistentRoomSkill } = await import("../src/persistent-room-skill-settings.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const OUTSIDE = "is outside this room's folder and the folders allowed for it";
const READ_ONLY_FOLDER = "is in a folder this room can only read";
const NEVER_CHANGED = "can be read but not changed by rooms";
const LINK = "this room doesn't follow links";
const CLOSED = "looks like a secret file or the app's own data";
const SKILLS = "is in the app's skills folder. A room can't change a skill's folder, and reads only the folders of the skills that are on in it, which read_skill gives; write into the room's folder instead.";

const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

const documents = path.join(home, "Documents");
const sales = path.join(documents, "Sales");
const finance = path.join(documents, "Finance");
const shared = path.join(home, "Shared");
const canRead = path.join(shared, "Read");
const canChange = path.join(shared, "Change");
const repoRoot = path.join(tmp, "repo");
for (const dir of [repoRoot, persistentAgentsRoot]) fs.mkdirSync(dir, { recursive: true });
write(path.join(sales, "figures.md"), "sales figures\n");
write(path.join(sales, ".git", "config"), "[core]\n\tbare = false\n");
write(path.join(sales, "node_modules", "pkg", "package.json"), "{\"name\":\"pkg\"}\n");
write(path.join(finance, "salaries.md"), "finance salaries\n");
write(path.join(canRead, "brief.md"), "shared brief\n");
write(path.join(canChange, "draft.md"), "shared draft\n");
// A case-insensitive volume opens a path spelled in another case; elsewhere it names nothing.
const foldsCase = fs.existsSync(path.join(home, "documents", "sales"));
let links = true;
try {
	fs.symlinkSync(path.join(sales, "figures.md"), path.join(sales, "link-in.md"));
	fs.symlinkSync(finance, path.join(sales, "finance-link"), "dir");
} catch {
	links = false;
	console.log("SKIPPED: the link cases (this system does not allow links here)");
}

type Outcome = { text: string; error?: string };
function toolsFor(agentId: string, mode: "localFiles" | "bounded", root = sales, toolSelection?: unknown, options?: Parameters<typeof createPersistentRoomWorkspaceTools>[1]): (name: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<Outcome> {
	const policy = createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: "c_fence",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root,
		workspaceAccessMode: mode,
		source: "manual",
		...(toolSelection ? { toolSelection } : {}),
		now: new Date("2026-11-01T00:00:00.000Z"),
	} as any);
	const tools = new Map(createPersistentRoomWorkspaceTools(policy, options).map((tool) => [String(tool.name), tool as any]));
	return async (name, params, signal) => {
		const tool = tools.get(name);
		assert(tool, `the ${name} tool must be there`);
		try {
			const result = await tool.execute(`fence-${name}`, params, signal, undefined, {} as any);
			return { text: (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") };
		} catch (error) {
			return { text: "", error: (error as Error).message };
		}
	};
}

const opens = (outcome: Outcome, needle: string, what: string) => assert(!outcome.error && outcome.text.includes(needle), `${what} must open, got ${JSON.stringify(outcome).slice(0, 300)}`);
const refusedAs = (outcome: Outcome, words: string, what: string) => {
	const error = outcome.error ?? "";
	assert(error.includes(words), `${what} must be refused with "${words}", got ${JSON.stringify(outcome).slice(0, 300)}`);
	assert(error.includes("Tell the person") && !/command/i.test(error), `${what}: the refusal says to tell the person and offers no command, got ${error}`);
	assert(!/finance salaries|shared brief/.test(outcome.text), `${what} must show nothing`);
};

try {
	for (const mode of ["localFiles", "bounded"] as const) {
		const label = mode === "localFiles" ? "Full access" : "Bounded";
		const room = `fence-${mode.toLowerCase()}`;
		const run = toolsFor(room, mode);

		// ---- inside: every path form that lands in the room's folder -------
		opens(await run("read", { path: "figures.md" }), "sales figures", `${label}: a relative path`);
		opens(await run("read", { path: path.join(sales, "figures.md") }), "sales figures", `${label}: an absolute path inside`);
		opens(await run("read", { path: "~/Documents/Sales/figures.md" }), "sales figures", `${label}: a ~ path inside`);
		opens(await run("read", { path: "../Sales/figures.md" }), "sales figures", `${label}: a .. path that lands inside`);
		if (foldsCase) opens(await run("read", { path: "~/documents/SALES/Figures.md" }), "sales figures", `${label}: a path spelled in another case`);
		opens(await run("read", { path: ".git/config" }), "bare = false", `${label}: .git, which the stored policy still lists`);
		opens(await run("read", { path: "node_modules/pkg/package.json" }), "\"pkg\"", `${label}: node_modules, which the stored policy still lists`);
		opens(await run("ls", { path: "." }), "figures.md", `${label}: ls`);
		opens(await run("find", { pattern: "*.md" }), "figures.md", `${label}: find`);
		opens(await run("grep", { pattern: "figures" }), "figures.md", `${label}: grep`);
		assert(!(await run("write", { path: "made.md", content: "made here\n" })).error && fs.readFileSync(path.join(sales, "made.md"), "utf8") === "made here\n", `${label}: write inside must land`);
		assert(!(await run("edit", { path: "made.md", edits: [{ oldText: "made here", newText: "edited here" }] })).error && fs.readFileSync(path.join(sales, "made.md"), "utf8") === "edited here\n", `${label}: edit inside must land`);
		const overwrite = await run("write", { path: "made.md", content: "again\n", overwrite: true });
		assert(!overwrite.error && fs.readFileSync(path.join(sales, "made.md"), "utf8") === "again\n", `${label}: write keeps overwrite, got ${JSON.stringify(overwrite)}`);
		fs.rmSync(path.join(sales, "made.md"));

		// ---- calls that run at once, and Stop ---------------------------------
		write(path.join(sales, "shared.md"), "alpha\nbeta\n");
		const both = await Promise.all([run("edit", { path: "shared.md", edits: [{ oldText: "alpha", newText: "ALPHA" }] }), run("edit", { path: "shared.md", edits: [{ oldText: "beta", newText: "BETA" }] })]);
		assert(both.every((outcome) => !outcome.error) && fs.readFileSync(path.join(sales, "shared.md"), "utf8") === "ALPHA\nBETA\n", `${label}: two edits of one file at once both land, got ${JSON.stringify(both)} and ${JSON.stringify(fs.readFileSync(path.join(sales, "shared.md"), "utf8"))}`);
		for (let round = 0; round < 20; round += 1) {
			const target = `race-${round}/new.md`;
			const writes = await Promise.all([run("write", { path: target, content: "first\n" }), run("write", { path: target, content: "second\n" })]);
			const landed = writes.filter((outcome) => !outcome.error);
			const kept = fs.readFileSync(path.join(sales, target), "utf8");
			assert(landed.length === 1 && writes.some((outcome) => outcome.error?.includes("already exists")) && kept === (writes[0].error ? "second\n" : "first\n"), `${label}: of two new writes at once without overwrite, one lands and the other is refused, got ${JSON.stringify(writes)} and ${JSON.stringify(kept)}`);
			fs.rmSync(path.join(sales, `race-${round}`), { recursive: true });
		}
		const stopped = new AbortController();
		stopped.abort();
		assert((await run("write", { path: "after-stop.md", content: "x" }, stopped.signal)).error && !fs.existsSync(path.join(sales, "after-stop.md")), `${label}: a write after Stop saves nothing`);
		assert((await run("edit", { path: "shared.md", edits: [{ oldText: "ALPHA", newText: "stopped" }] }, stopped.signal)).error && fs.readFileSync(path.join(sales, "shared.md"), "utf8") === "ALPHA\nBETA\n", `${label}: an edit after Stop changes nothing`);
		fs.rmSync(path.join(sales, "shared.md"));
		opens(await run("grep", { pattern: "figures", path: "figures.md" }), "figures.md:1", `${label}: grep of one file`);

		// ---- what the step card says for a miss -------------------------------
		const card = (error: string | undefined, args: Record<string, unknown>) => stepOutcome(String(error), { name: "read", args });
		const missing = await run("read", { path: "nowhere/gone.md" });
		assert(card(missing.error, { path: "nowhere/gone.md" })?.line === "There is no file or folder called gone.md.", `${label}: a missing file's card says so, got ${JSON.stringify(missing)}`);
		const already = await run("write", { path: "figures.md", content: "x" });
		assert(card(already.error, { path: "figures.md" })?.line === "That file is already there; the room did not overwrite it." && already.error?.includes("figures.md"), `${label}: a file already there's card says so, got ${JSON.stringify(already)}`);

		// ---- grep's native options -------------------------------------------
		write(path.join(sales, "notes", "a.txt"), "one\n(a+b)\nthree\n");
		write(path.join(sales, "notes", "b.md"), "(a+b)\n");
		const literal = await run("grep", { pattern: "(a+b)", literal: true, path: "notes", glob: "*.txt", context: 1 });
		assert(!literal.error && literal.text.includes("a.txt:2: (a+b)") && literal.text.includes("a.txt-1- one") && literal.text.includes("a.txt-3- three") && !literal.text.includes("b.md"), `${label}: grep takes literal, glob and context, got ${JSON.stringify(literal)}`);
		fs.rmSync(path.join(sales, "notes"), { recursive: true });

		// ---- outside: each of the six tools, whatever the spelling -----------
		for (const [what, target] of [["an absolute path", path.join(finance, "salaries.md")], ["a ~ path", "~/Documents/Finance/salaries.md"], ["a .. path", "../Finance/salaries.md"], ["the home folder", "~"], ...(foldsCase ? [["another case", "~/DOCUMENTS/finance/salaries.md"]] : [])] as const) {
			refusedAs(await run("read", { path: target }), OUTSIDE, `${label}: read of ${what} outside`);
		}
		refusedAs(await run("ls", { path: finance }), OUTSIDE, `${label}: ls outside`);
		refusedAs(await run("find", { pattern: "*", path: finance }), OUTSIDE, `${label}: find outside`);
		refusedAs(await run("grep", { pattern: "salaries", path: documents }), OUTSIDE, `${label}: grep from above the room's folder`);
		refusedAs(await run("write", { path: path.join(finance, "planted.md"), content: "x" }), OUTSIDE, `${label}: write outside`);
		refusedAs(await run("edit", { path: "../Finance/salaries.md", edits: [{ oldText: "finance", newText: "x" }] }), OUTSIDE, `${label}: edit outside`);
		assert(!fs.existsSync(path.join(finance, "planted.md")) && fs.readFileSync(path.join(finance, "salaries.md"), "utf8") === "finance salaries\n", `${label}: nothing outside may change`);
		if (links) {
			refusedAs(await run("read", { path: "link-in.md" }), LINK, `${label}: a link inside the room's folder, even to a file there`);
			// A link in the room is refused where it sits, wherever it leads.
			refusedAs(await run("read", { path: "finance-link/salaries.md" }), LINK, `${label}: a link out of the room's folder`);
			refusedAs(await run("write", { path: "finance-link/planted.md", content: "x" }), LINK, `${label}: a write through a link out`);
		}

		// ---- the Also allowed list: read at each call ------------------------
		addAlsoAllowedFolder(room, canRead, "read");
		addAlsoAllowedFolder(room, canChange, "write");
		opens(await run("read", { path: path.join(canRead, "brief.md") }), "shared brief", `${label}: a Can read folder reads`);
		opens(await run("grep", { pattern: "brief", path: "~/Shared/Read" }), "brief.md", `${label}: grep in a Can read folder`);
		refusedAs(await run("write", { path: path.join(canRead, "brief.md"), content: "x" }), READ_ONLY_FOLDER, `${label}: a write into a Can read folder`);
		assert(!(await run("write", { path: path.join(canChange, "draft.md"), content: "changed\n", overwrite: true })).error && fs.readFileSync(path.join(canChange, "draft.md"), "utf8") === "changed\n", `${label}: a Can change folder takes a write`);
		write(path.join(canChange, "draft.md"), "shared draft\n");
		saveAlsoAllowedFolders(room, []);
		refusedAs(await run("read", { path: path.join(canRead, "brief.md") }), OUTSIDE, `${label}: a folder taken off the list, on the very next call of the same tools`);

		// ---- names the box never lets a command change, from its own arrays ---
		const neverWritable = [...NEVER_WRITABLE_FILES, ...NEVER_WRITABLE_FOLDERS.map((folder) => `${folder}/settings.json`), ...NEVER_WRITABLE_GLOBS.map((glob) => glob.replace("*", "team"))];
		for (const name of neverWritable) {
			// A name that is also a secret's, as .envrc, stays closed both ways: stricter, and true.
			const outcome = await run("write", { path: `sub/${name}`, content: "x" });
			refusedAs(outcome, outcome.error?.includes(CLOSED) ? CLOSED : NEVER_CHANGED, `${label}: writing ${name}`);
			assert(!fs.existsSync(path.join(sales, "sub", name)), `${label}: a refused write of ${name} leaves nothing`);
		}
		// A name the box gains reaches the fence on the next call: a copy of the list would miss it.
		(NEVER_WRITABLE_FILES as unknown as string[]).push(".fence-smoke-rc");
		try {
			refusedAs(await run("write", { path: ".fence-smoke-rc", content: "x" }), NEVER_CHANGED, `${label}: a name the box's list just gained`);
		} finally {
			(NEVER_WRITABLE_FILES as unknown as string[]).pop();
		}
		assert(!(await run("write", { path: ".fence-smoke-rc", content: "x\n" })).error, `${label}: the same name writes once the box's list drops it`);
		fs.rmSync(path.join(sales, ".fence-smoke-rc"));
	}

	// ---- a room's folder chosen inside a closed name stays closed -------------
	write(path.join(sales, ".pi", "mcp.json"), "{\"servers\":\"finance salaries\"}\n");
	write(path.join(sales, ".pi", "notes.md"), "pi notes\n");
	for (const mode of ["localFiles", "bounded"] as const) {
		const inPi = toolsFor(`fence-pi-${mode.toLowerCase()}`, mode, path.join(sales, ".pi"));
		refusedAs(await inPi("read", { path: "mcp.json" }), CLOSED, `${mode}: a file in a room folder chosen inside .pi`);
		refusedAs(await inPi("write", { path: "mcp.json", content: "x", overwrite: true }), CLOSED, `${mode}: a write in a room folder chosen inside .pi`);
		refusedAs(await inPi("ls", { path: "." }), CLOSED, `${mode}: ls of a room folder chosen as .pi`);
	}
	assert(fs.readFileSync(path.join(sales, ".pi", "mcp.json"), "utf8").includes("finance salaries"), "the .pi settings must be untouched");
	fs.rmSync(path.join(sales, ".pi"), { recursive: true });

	// ---- the same fence with the platform switch at Windows and at Linux ----
	const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
	for (const platform of ["win32", "linux"] as const) {
		// The room is chosen on this computer; only its tools' calls run under the switch.
		const run = toolsFor(`fence-${platform}`, "localFiles");
		Object.defineProperty(process, "platform", { ...realPlatform, value: platform });
		try {
			opens(await run("read", { path: path.join(sales, "figures.md") }), "sales figures", `${platform}: an absolute path inside`);
			refusedAs(await run("read", { path: path.join(finance, "salaries.md") }), OUTSIDE, `${platform}: a path outside`);
			refusedAs(await run("write", { path: "../Finance/planted.md", content: "x" }), OUTSIDE, `${platform}: a write outside`);
			if (links) refusedAs(await run("read", { path: "link-in.md" }), LINK, `${platform}: a link`);
		} finally {
			Object.defineProperty(process, "platform", realPlatform);
		}
	}

	// ---- a room's own folder, judged by the Also allowed list's rule at every call ----
	// Stored as an older room's is, before the rule: the folder as it was chosen, its hash matching.
	const storedOn = (folder: string) => {
		fs.mkdirSync(folder, { recursive: true });
		const real = fs.realpathSync.native(folder);
		const policy = createPersistentRoomCapabilityPolicy({ agentId: "fence-stored", conversationId: "c_fence", repoRoot, persistentAgentsRoot, exxetaStateRoot, root: sales, workspaceAccessMode: "localFiles", source: "manual" } as any);
		policy.roots = [{ ...policy.roots[0], path: real, realpath: real, basename: path.basename(real), pathHash: hashPersistentRoomPath(real) }];
		const tools = new Map(createPersistentRoomWorkspaceTools(policy).map((tool) => [String(tool.name), tool as any]));
		return async (name: string, params: Record<string, unknown>): Promise<Outcome> => {
			try {
				const result = await tools.get(name).execute(`fence-${name}`, params, undefined, undefined, {} as any);
				return { text: (result?.content ?? []).map((part: any) => String(part.text ?? "")).join("\n") };
			} catch (error) {
				return { text: "", error: (error as Error).message };
			}
		};
	};
	const refusedRoom = async (folder: string, what: string) => {
		write(path.join(folder, "note.md"), "inside a refused folder\n");
		const run = storedOn(folder);
		for (const [name, params] of [["read", { path: "note.md" }], ["ls", { path: "." }], ["write", { path: "planted.md", content: "x" }]] as const) {
			const outcome = await run(name, params);
			assert(outcome.error === ROOM_FOLDER_REFUSED && !outcome.text.includes("inside a refused folder"), `${what}: ${name} must stop with the refused folder's line, got ${JSON.stringify(outcome).slice(0, 300)}`);
		}
		assert(!fs.existsSync(path.join(folder, "planted.md")), `${what}: a write landed`);
	};
	await refusedRoom(home, "a room on the home folder");
	await refusedRoom(path.join(home, "Library", "Notes"), "a room inside ~/Library");
	await refusedRoom(path.join(home, ".local", "bin"), "a room on ~/.local/bin");
	await refusedRoom(path.join(home, ".cursor"), "a room on another tool's connector folder");
	await refusedRoom(path.join(home, ".cursor", "projects"), "a room inside another tool's connector folder");
	await refusedRoom(path.join(home, ".config"), "a room on a folder holding a closed place (.config/gh)");
	opens(await storedOn(sales)("read", { path: "figures.md" }), "sales figures", "a stored room on an ordinary folder");
	// No card draws a room's own folder, so a name only a card can't show is an ordinary folder.
	const marked = path.join(documents, "\u26a0\ufe0f Plans");
	write(path.join(marked, "plan.md"), "the plan\n");
	opens(await storedOn(marked)("read", { path: "plan.md" }), "the plan", "a stored room on a folder whose name holds an emoji");
	// Another tool's folder kept elsewhere through a link: its real folder, and a folder holding it, are judged as the folder itself.
	if (links) {
		const keptState = path.join(home, "Dotfolders", "windsurf-state");
		fs.mkdirSync(keptState, { recursive: true });
		fs.symlinkSync(keptState, path.join(home, ".windsurf"), "dir");
		await refusedRoom(keptState, "a room on the folder ~/.windsurf links to");
		await refusedRoom(path.dirname(keptState), "a room on a folder holding the one ~/.windsurf links to");
	}
	write(path.join(home, "Notes beside", "note.md"), "notes beside\n");
	opens(await storedOn(path.join(home, "Notes beside"))("read", { path: "note.md" }), "notes beside", "a stored room beside a linked tool folder");
	// A stored room whose folder came to hold a place other programs run from: refused from the next call, and fine again once it no longer does.
	const tools = path.join(documents, "Tools");
	write(path.join(tools, "readme.md"), "tools readme\n");
	const onTools = storedOn(tools);
	opens(await onTools("read", { path: "readme.md" }), "tools readme", "a stored room on a folder before it holds a program folder");
	const savedPath = process.env.PATH;
	process.env.PATH = [path.join(tools, "bin"), savedPath].join(path.delimiter);
	try {
		assert((await onTools("read", { path: "readme.md" })).error === ROOM_FOLDER_REFUSED, "a stored room whose folder now holds a folder on the search path must stop");
	} finally {
		process.env.PATH = savedPath;
	}
	opens(await onTools("read", { path: "readme.md" }), "tools readme", "the same room once its folder holds no program folder");

	// ---- the app's skills folder: what is refused there is named as a skill's folder, a key in a skill that is on still as a key ----
	const skillsRoot = agentSkillsDir();
	for (const name of ["on-skill", "off-skill"]) {
		write(path.join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: a skill\n---\n\nRun scripts/run.sh.\n`);
		write(path.join(skillsRoot, name, "scripts", "run.sh"), "echo ran\n");
		write(path.join(skillsRoot, name, ".env"), "TOKEN=synthetic\n");
	}
	const skillsRoom = "fence-skills";
	assert(enablePersistentRoomSkill(skillsRoom, "on-skill", readLibrarySkill).ok, "on-skill switches on");
	const inSkills = toolsFor(skillsRoom, "localFiles");
	// Every row runs, so one run names each answer that is wrong.
	const skillRowsFailed: string[] = [];
	const refusedAsSkills = (outcome: Outcome, shown: string, what: string) => {
		if (outcome.error !== `${shown} ${SKILLS}`) skillRowsFailed.push(`${what} must be refused as a skill's folder, got ${JSON.stringify(outcome).slice(0, 400)}`);
	};
	opens(await inSkills("read", { path: path.join(skillsRoot, "on-skill", "SKILL.md") }), "Run scripts/run.sh.", "a skill that is on: its SKILL.md");
	refusedAsSkills(await inSkills("ls", { path: skillsRoot }), skillsRoot, "listing the app's skills folder");
	refusedAsSkills(await inSkills("read", { path: path.join(skillsRoot, "off-skill", "SKILL.md") }), path.join(skillsRoot, "off-skill", "SKILL.md"), "a skill that is off");
	const intoSkill = path.join(skillsRoot, "on-skill", "notes.md");
	refusedAsSkills(await inSkills("write", { path: intoSkill, content: "x\n" }), intoSkill, "a write into a skill that is on");
	assert(!fs.existsSync(intoSkill), "the refused write left no file in the skill's folder");
	refusedAs(await inSkills("read", { path: path.join(skillsRoot, "on-skill", ".env") }), CLOSED, "a key inside a skill that is on");
	write(path.join(sales, ".env"), "TOKEN=synthetic\n");
	refusedAs(await inSkills("read", { path: path.join(sales, ".env") }), CLOSED, "a key in the room's folder");
	assert(skillRowsFailed.length === 0, skillRowsFailed.join("\n"));

	// ---- the running answer's own temp for commands: named as that temp; every other closed place as before ----
	const tempRoom = "fence-own-temp";
	const boxOf = (room: string) => path.join(persistentAgentsRoot, room, "runtime", "box");
	const ownTemp = path.join(boxOf(tempRoom), "temp-0a1b2c3d4e5f");
	const picture = path.join(ownTemp, "poster.png");
	write(picture, "not really a picture\n");
	const otherTemp = path.join(boxOf("fence-other-room"), "temp-0f1e2d3c4b5a");
	write(path.join(otherTemp, "poster.png"), "another room's picture\n");
	write(path.join(boxOf(tempRoom), "caches", "pip", "note.txt"), "a cache\n");
	// The folder ask is offered with someone there: a refusal of the room's own temp still sends the model to no ask.
	const inTempRoom = toolsFor(tempRoom, "localFiles", sales, undefined, { asks: () => true, commandsTemp: () => ownTemp });
	const tempRowsFailed: string[] = [];
	const refusedAsOwnTemp = (outcome: Outcome, shown: string, what: string) => {
		const error = outcome.error ?? "";
		if (error !== ownTempRefusal(shown)) tempRowsFailed.push(`${what} must be refused as the answer's own temp, got ${JSON.stringify(outcome).slice(0, 400)}`);
		if (/Tell the person|secret|open it themselves|Call ask_for_folder/.test(error)) tempRowsFailed.push(`${what}: the refusal names a secret file, a step for the person or the folder ask, got ${error}`);
	};
	opens(await inTempRoom("read", { path: "figures.md" }), "sales figures", "a room with a running temp: its own folder");
	refusedAsOwnTemp(await inTempRoom("read", { path: picture }), picture, "a read in the room's own temp");
	refusedAsOwnTemp(await inTempRoom("ls", { path: ownTemp }), ownTemp, "listing the room's own temp");
	const intoTemp = path.join(ownTemp, "result.png");
	refusedAsOwnTemp(await inTempRoom("write", { path: intoTemp, content: "x\n" }), intoTemp, "a write in the room's own temp");
	assert(!fs.existsSync(intoTemp), "the refused write left no file in the room's own temp");
	refusedAsOwnTemp(await inTempRoom("edit", { path: picture, edits: [{ oldText: "not really", newText: "really" }] }), picture, "an edit in the room's own temp");
	assert(fs.readFileSync(picture, "utf8") === "not really a picture\n", "the refused edit left the file as it was");
	const ownTempCard = stepOutcome(ownTempRefusal(picture), { name: "read", args: { path: picture } });
	if (ownTempCard?.line !== "Blocked: a secret file or the app's own data" || ownTempCard.refused !== true) tempRowsFailed.push(`the step card for the room's own temp must read as today's closed path, got ${JSON.stringify(ownTempCard)}`);
	assert(tempRowsFailed.length === 0, tempRowsFailed.join("\n"));
	refusedAs(await inTempRoom("read", { path: path.join(otherTemp, "poster.png") }), CLOSED, "a read in another room's temp");
	refusedAs(await inTempRoom("write", { path: path.join(otherTemp, "result.png"), content: "x\n" }), CLOSED, "a write in another room's temp");
	refusedAs(await inTempRoom("read", { path: path.join(boxOf(tempRoom), "caches", "pip", "note.txt") }), CLOSED, "the room's caches, outside its temp");
	refusedAs(await inTempRoom("read", { path: path.join(sales, ".env") }), CLOSED, "a key in the room's folder, with a running temp");
	// With no answer running there is no temp of its own: the same path reads as the app's data.
	refusedAs(await toolsFor(tempRoom, "localFiles")("read", { path: picture }), CLOSED, "the room's temp with no answer running");

	console.log("room-files-fence-smoke: OK");
} finally {
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	fs.rmSync(tmp, { recursive: true, force: true });
}
