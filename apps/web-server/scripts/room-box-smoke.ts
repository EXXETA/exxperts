// A room's commands in the box, on a Mac. Every row runs a real command in a real
// box through the room's own tools and reads what a person or the model would get.
// Each refused row has an allowed neighbour.
//
// It plants dotfiles and git settings in the home it runs under, so it refuses to
// start anywhere but the throwaway home `npm run smokes` makes.
//
// On any other computer each row says it was skipped, by name, and the rows that
// hold the other computers' behaviour still run.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { addAlsoAllowedFolder, addAlsoAllowedSite, AnswerSites, readAlsoAllowed, removeAlsoAllowedEntry, saveAlsoAllowedFolders, writeRoomJson } from "../src/room-box/also-allowed.js";
import { appDataPlaces, neverOpened, realPathOf } from "../src/room-box/box-closed.js";
import { boxRules } from "../src/room-box/box-rules.js";
import { BoxProcess, COMMAND_FOLDER_MOVED } from "../src/room-box/box-process.js";
import { BOX_FAULT_SENTENCE, BOX_GIT_CLAUSE, boxModelLine, BOX_FILE_HOMES_LINE, CLOSED_ON_PURPOSE, FREE_PRIVATE_REFUSAL } from "../src/room-box/card-text.js";
import { RoomBox, roomBoxAvailable, type BoxWatcher } from "../src/room-box/box-session.js";
import { RUN_OUTSIDE_BOX_TOOL_NAME } from "../src/room-box/card-text.js";
import { commandAsShown, OUTSIDE_COMMAND_MAX_CHARS, pathHoldsHidden } from "../src/room-box/card-text.js";
import { folderGrantable, soundFolders } from "../src/room-box/folder-offer.js";
import { commandDeclined, nobodyToApprove } from "../../web-ui/src/step-lines.js";
import { commandRan, createPersistentRoomBashApprovalExtension } from "../src/persistent-room-bash-approval.js";
import { registerServerHooks } from "../src/server-hooks.js";
import { createWebUiContext, QuestionDeclined } from "../src/web-ui-context.js";
import { createRoomWebReaderExtension } from "../src/room-web-reader.js";
import { moveSpill } from "../src/room-box/spill.js";
import { getPersistentRoomToolPolicy } from "../src/persistent-room-tool-policy.js";
import { createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, resolvePersistentRoomCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } from "../src/persistent-room-workspace-policy.js";
import { createPersistentRoomWorkspaceTools } from "../src/persistent-room-workspace-tools.js";
import { ROOM_FOLDER_REFUSED } from "../src/room-files.js";
import { createRoomCommandTools, type RoomCommandTools } from "../src/room-command-tool.js";
import { persistentRoomSkillSettingsPath } from "../src/persistent-room-skill-settings.js";
import { roomSkillFolders } from "../src/skills-executable.js";
import { agentSkillsDir, sha256, writeSkillProvenance } from "../src/skills-store.js";

const home = fs.realpathSync(os.homedir());
const sharedTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(home) !== sharedTemp || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`room box smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- room-box`);
	process.exit(1);
}

const onMac = process.platform === "darwin";
const onWindows = process.platform === "win32";
let passed = 0;
const failures: string[] = [];

const webServerRoot = path.resolve(import.meta.dirname, "..");

async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

async function macRow(name: string, body: () => Promise<void> | void): Promise<void> {
	if (!onMac) {
		console.log(`  skip ${name} (needs a Mac)`);
		return;
	}
	await row(name, body);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const ROOM_ID = "box-smoke-room";
fs.mkdirSync(persistentAgentRootPath(ROOM_ID), { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(home, "room-folder-")));
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(home, "elsewhere-")));
// Chosen as a person chooses a room's folder: a command runs only in the folder the room has stored.
const chooseFolder = (room: string, root = folder) => writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: room, repoRoot: path.resolve(import.meta.dirname, "..", "..", ".."), root, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));
chooseFolder(ROOM_ID);
chooseFolder("box-smoke-probe-room");

type Asked = { host: string; port: number; lasting: boolean };
const person = {
	watcher: "computer" as BoxWatcher,
	siteAnswer: "decline" as "once" | "room" | "decline",
	answeredBy: "computer" as BoxWatcher,
	outsideAnswer: false,
	siteCards: [] as Asked[],
	outsideCards: [] as { command: string; reason: string }[],
	canChangeFiles: true,
	skillFolders: [] as string[],
	heldSite: undefined as Promise<{ choice: "room"; answeredBy: BoxWatcher }> | undefined,
	siteCardsClosed: 0,
	/** The person sends a message while a site card waits, instead of pressing a button. */
	siteMessage: false,
	offered: true,
	onSiteCard: undefined as (() => void) | undefined,
	/** The room's own folder ask: offered, and answered in this turn. */
	folderAskOffered: false,
};
// Read through a call: an assert narrows a field to the value it checked, and these change between asserts.
const seen = () => ({ siteCards: person.siteCards.length, outsideCards: person.outsideCards.length, offered: person.offered });
const questions = {
	watcher: () => person.watcher,
	// A yes is applied as the bridge applies it, before the answer comes back: a late one too.
	askSite: async (card: Asked, apply: (choice: "once" | "room", answeredBy: "computer" | "phone") => unknown) => {
		person.siteCards.push(card);
		person.onSiteCard?.();
		if (person.siteMessage) throw new QuestionDeclined("the person sent a message");
		const answer = person.heldSite ? await person.heldSite : { choice: person.siteAnswer, answeredBy: person.answeredBy };
		if (answer.choice !== "decline" && answer.answeredBy !== "none") apply(answer.choice, answer.answeredBy);
		return answer;
	},
	closeSiteCards: () => { person.siteCardsClosed += 1; },
	askOutside: async (card: { command: string; reason: string }) => {
		person.outsideCards.push(card);
		return person.outsideAnswer;
	},
};

// The running answer's sites, as the room's connection holds them: commands and pages share them, and the next turn starts afresh.
let answerSites = new AnswerSites();
/** Whether the next box starts on Auto, as the room's connection reads it when an answer starts. */
let boxFree = false;

function newBox(): { box: RoomBox; tools: RoomCommandTools } {
	const box = new RoomBox({
		sites: () => answerSites,
		roomId: ROOM_ID,
		conversationId: () => "conversation-a",
		questions: questions as any,
		rights: () => ({ canChangeFiles: person.canChangeFiles, skillFolders: person.skillFolders }),
		warn: () => {},
		folderAsk: { offered: () => person.folderAskOffered },
		free: () => boxFree,
	});
	return { box, tools: createRoomCommandTools(folder, { box, outside: { questions: questions as any, setOffered: (offered) => { person.offered = offered; } } }) };
}

let callNumber = 0;
async function call(tools: RoomCommandTools, name: string, input: Record<string, unknown>): Promise<{ text: string; failed: boolean; id: string }> {
	const tool = tools.tools.find((candidate) => candidate.name === name);
	assert(tool, `no ${name} tool`);
	const id = `call-${++callNumber}`;
	try {
		const result: any = await tool.execute(id, input as any, undefined as any, undefined as any, undefined as any);
		return { text: (result.content ?? []).map((part: any) => part.text ?? "").join(""), failed: false, id };
	} catch (error) {
		return { text: (error as Error).message, failed: true, id };
	}
}

const outsideRoom = (name: string) => path.join(elsewhere, name);
const inRoom = (...names: string[]) => path.join(folder, ...names);
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Shared-folder skills linked from ~/.agents/skills to their real folders and on
 * in `room`; `body` runs commands in that room's box with the folders the room
 * opens by skill name. Everything made is removed after.
 */
async function withSharedSkills(room: string, roomFolder: string, skills: readonly (readonly [string, string])[], canChangeFiles: boolean, body: (run: (command: string) => ReturnType<typeof call>, opened: Map<string, string>) => Promise<void>, afterRights: () => void = () => {}): Promise<void> {
	const skillsAt = path.join(home, ".agents", "skills");
	fs.mkdirSync(skillsAt, { recursive: true });
	for (const [real, name] of skills) {
		fs.mkdirSync(path.join(real, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(real, "SKILL.md"), `---\nname: ${name}\ndescription: a shared test skill\n---\n\nRun scripts/run.sh.\n`);
		// portability-ok: only macRows call this, each skipped by name on any other computer
		fs.writeFileSync(path.join(real, "scripts", "run.sh"), `#!/bin/sh\necho ${name}-ran\n`, { mode: 0o755 });
		fs.symlinkSync(real, path.join(skillsAt, name), "dir");
	}
	const settingsFile = persistentRoomSkillSettingsPath(room);
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(settingsFile, `${JSON.stringify({ schemaVersion: 1, enabledSkills: skills.map(([, name]) => ({ name })), updatedAt: "2026-11-21T10:00:00.000Z" }, null, 2)}\n`);
	// `afterRights`: what a job left running could do once the next command's rights are read and before its box starts.
	const rights = () => {
		const now = { canChangeFiles, skillFolders: roomSkillFolders(room).map((skill) => skill.skillDir) };
		afterRights();
		return now;
	};
	const box = new RoomBox({ roomId: room, conversationId: () => `conversation-${room}`, questions: questions as any, rights, warn: () => {} });
	const tools = createRoomCommandTools(roomFolder, { box, outside: { questions: questions as any, setOffered: () => {} } });
	try {
		await body((command) => call(tools, "bash", { command }), new Map(roomSkillFolders(room).map((skill) => [skill.name, skill.skillDir])));
	} finally {
		await box.endTurn();
		fs.rmSync(settingsFile, { force: true });
		fs.rmSync(path.join(home, ".agents"), { recursive: true, force: true });
		for (const [real] of skills) fs.rmSync(real, { recursive: true, force: true });
	}
}

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=s", "-c", "user.email=s@s", ...args], { cwd, encoding: "utf8" });

let tools: RoomCommandTools;
let box: RoomBox;
const bash = (command: string) => call(tools, "bash", { command });
/** Ends the turn: the next command starts a fresh box. */
const nextTurn = async () => {
	await box.endTurn();
	answerSites.end();
	answerSites = new AnswerSites();
	({ box, tools } = newBox());
	person.siteCards.length = 0;
};

async function main(): Promise<void> {
	console.log("room box smoke");

	await row("the box runs only on a person's Mac", () => {
		assert(roomBoxAvailable() === onMac, "available by platform");
		const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		for (const other of ["linux", "win32"]) {
			Object.defineProperty(process, "platform", { ...platform, value: other });
			try {
				assert(!roomBoxAvailable(), `no box on ${other}`);
			} finally {
				Object.defineProperty(process, "platform", platform);
			}
		}
	});

	await row("a smoke acting as another platform gets that platform's commands, and only with both test switches", () => {
		const saved = { introspection: process.env.EXXPERTS_TEST_INTROSPECTION, platform: process.env.EXXPERTS_TEST_SHELL_PLATFORM };
		try {
			process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
			assert(roomBoxAvailable() === onMac, "one switch alone changed something");
			process.env.EXXPERTS_TEST_INTROSPECTION = "1";
			assert(!roomBoxAvailable(), "acting as Linux kept the box");
		} finally {
			for (const [name, value] of [["EXXPERTS_TEST_INTROSPECTION", saved.introspection], ["EXXPERTS_TEST_SHELL_PLATFORM", saved.platform]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	await row("a room with no box gets plain commands and no way out", async () => {
		const plain = createRoomCommandTools(folder);
		assert(plain.tools.length === 1 && plain.tools[0].name === "bash", "only bash");
		const started = BoxProcess.start;
		BoxProcess.start = (async () => { throw new Error("the proxy's code was reached"); }) as typeof BoxProcess.start;
		try {
			const { text, failed } = await call(plain, "bash", { command: "echo plain-run" });
			assert(!failed && text.includes("plain-run"), `plain run: ${text}`);
		} finally {
			BoxProcess.start = started;
		}
	});

	await macRow("a box that fails to start stops the command with the plain line", async () => {
		const started = BoxProcess.start;
		BoxProcess.start = (async () => { throw new Error("no worker"); }) as typeof BoxProcess.start;
		const broken = newBox();
		try {
			const { text, failed } = await call(broken.tools, "bash", { command: `echo ran > ${quoted(inRoom("bare-run"))}` });
			assert(failed && text === BOX_FAULT_SENTENCE, `words: ${text}`);
			assert(!fs.existsSync(inRoom("bare-run")), "the command ran bare");
		} finally {
			BoxProcess.start = started;
		}
	});

	await macRow("a box that starts and doesn't hold stops the command", async () => {
		const request = BoxProcess.prototype.request;
		BoxProcess.prototype.request = async function (this: BoxProcess, kind: string, body: any) {
			if (kind === "wrap") return { wrapped: body.command } as any;
			return request.call(this, kind, body);
		} as typeof BoxProcess.prototype.request;
		const broken = newBox();
		try {
			const { text, failed, id } = await call(broken.tools, "bash", { command: `echo ran > ${quoted(inRoom("bare-run"))}` });
			assert(failed && text === BOX_FAULT_SENTENCE, `words: ${text}`);
			assert(!fs.existsSync(inRoom("bare-run")), "the command ran bare");
			assert(!broken.tools.started(id), "recorded as started");
		} finally {
			BoxProcess.prototype.request = request;
			await broken.box.endTurn();
		}
	});

	if (onMac) ({ box, tools } = newBox());

	fs.writeFileSync(path.join(home, "secret.txt"), "home-secret");
	fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = person\n");
	fs.writeFileSync(inRoom("notes.txt"), "room-notes");

	await macRow("reads: home is closed, the room, ~/.gitconfig and system folders open", async () => {
		const closed = await bash(`/bin/cat ${quoted(path.join(home, "secret.txt"))}`);
		assert(closed.failed && !closed.text.includes("home-secret"), `home read: ${closed.text}`);
		for (const [command, expected] of [["/bin/cat notes.txt", "room-notes"], [`/bin/cat ${quoted(path.join(home, ".gitconfig"))}`, "person"], ["/bin/cat /etc/hosts", "localhost"]]) {
			const open = await bash(command);
			assert(!open.failed && open.text.includes(expected), `${command}: ${open.text}`);
		}
	});

	await macRow("git: its home settings read with no warning and no card, its stored logins stay closed", async () => {
		fs.mkdirSync(path.join(home, ".config/git"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config/git/ignore"), "ignored-by-person\n");
		fs.writeFileSync(path.join(home, ".config/git/credentials"), "https://person:stored-login@example.com\n");
		git(inRoom(), "init", "-q");
		fs.writeFileSync(inRoom("ignored-by-person"), "");
		await nextTurn();
		const status = await bash("git status --porcelain --ignored");
		assert(!status.failed && !status.text.includes("warning") && !status.text.includes("protection") && status.text.includes("!! ignored-by-person"), `git status: ${status.text}`);
		const login = await bash(`/bin/cat ${quoted(path.join(home, ".config/git/credentials"))}`);
		assert(login.failed && !login.text.includes("stored-login"), `stored login: ${login.text}`);
		fs.rmSync(inRoom(".git"), { recursive: true, force: true });
		fs.rmSync(inRoom("ignored-by-person"));
	});

	await macRow("writes: the room yes, home and elsewhere no", async () => {
		const room = await bash("echo written > made.txt");
		assert(!room.failed && fs.readFileSync(inRoom("made.txt"), "utf8") === "written\n", `room write: ${room.text}`);
		const out = await bash(`echo x > ${quoted(path.join(home, "planted.txt"))}`);
		assert(out.failed && !fs.existsSync(path.join(home, "planted.txt")), "home write landed");
	});

	await macRow("Also allowed: a folder on the list is read and written, with the same closed names", async () => {
		const extra = outsideRoom("extra");
		fs.mkdirSync(extra, { recursive: true });
		fs.writeFileSync(path.join(extra, "note.txt"), "extra-note");
		const before = await bash(`/bin/cat ${quoted(path.join(extra, "note.txt"))}`);
		assert(before.failed, "read before the yes");
		addAlsoAllowedFolder(ROOM_ID, extra, "write");
		const read = await bash(`/bin/cat ${quoted(path.join(extra, "note.txt"))}`);
		assert(!read.failed && read.text.includes("extra-note"), `read after the yes: ${read.text}`);
		const wrote = await bash(`echo y > ${quoted(path.join(extra, "new.txt"))}`);
		assert(!wrote.failed && fs.existsSync(path.join(extra, "new.txt")), `write after the yes: ${wrote.text}`);
		const closed = await bash(`mkdir -p ${quoted(path.join(extra, ".vscode"))}; echo y > ${quoted(path.join(extra, ".vscode", "tasks.json"))}`);
		assert(closed.failed && !fs.existsSync(path.join(extra, ".vscode", "tasks.json")), "closed name in an Also allowed folder");
	});

	await macRow("Also allowed for reading only: a read opens, a write doesn't", async () => {
		const readOnly = outsideRoom("read-only");
		fs.mkdirSync(readOnly, { recursive: true });
		fs.writeFileSync(path.join(readOnly, "note.txt"), "read-note");
		addAlsoAllowedFolder(ROOM_ID, readOnly, "read");
		const read = await bash(`/bin/cat ${quoted(path.join(readOnly, "note.txt"))}`);
		assert(!read.failed && read.text.includes("read-note"), `read: ${read.text}`);
		const wrote = await bash(`echo y > ${quoted(path.join(readOnly, "new.txt"))}`);
		assert(wrote.failed && !fs.existsSync(path.join(readOnly, "new.txt")), "a read yes opened writing");
	});

	await row("the model's standing line says commands read git's own folders and a commit or a clone runs outside, claims no closed secret files, and sends a failure to the folder ask only where the room may ask", () => {
		const line = boxModelLine({ folders: [], sites: [] }, false);
		assert(line.includes(BOX_GIT_CLAUSE) && !line.includes(".env"), `the line: ${line}`);
		// Where the room may ask for a folder, and only there, a failure that may be the box's sends the model to the ask first.
		const ask = "If a command fails or gives nothing useful and may have touched a place outside the room's folder, call ask_for_folder for that place first.";
		assert(!line.includes("ask_for_folder") && boxModelLine({ folders: [], sites: [] }, true).includes(ask), "the ask's sentence");
	});

	await macRow("Can change files off: the room reads and doesn't write", async () => {
		person.canChangeFiles = false;
		try {
			const read = await bash("/bin/cat notes.txt");
			assert(!read.failed && read.text.includes("room-notes"), `read: ${read.text}`);
			const wrote = await bash("echo x > read-only-room.txt");
			assert(wrote.failed && !fs.existsSync(inRoom("read-only-room.txt")), "a read-only room took a write");
		} finally {
			person.canChangeFiles = true;
		}
	});

	await macRow("temp: TMPDIR, mktemp and a heredoc stay private, the shared temp and /tmp are closed", async () => {
		const shared = fs.mkdtempSync(path.join(sharedTemp, "box-shared-"));
		fs.writeFileSync(path.join(shared, "staged.txt"), "staged-skill");
		// The places the model's line names: a folder made under $TMPDIR takes a write, the same under /tmp doesn't.
		const inSlashTmp = `/tmp/box-line-${process.pid}`;
		assert(BOX_FILE_HOMES_LINE.includes("under $TMPDIR") && BOX_FILE_HOMES_LINE.includes("/tmp is closed"), BOX_FILE_HOMES_LINE);
		try {
			const made = await bash('f=$(mktemp); echo private > "$f"; /bin/cat "$f"; echo "at:$f"; cat <<END\nheredoc-ok\nEND');
			assert(!made.failed && made.text.includes("private") && made.text.includes("heredoc-ok"), `private temp: ${made.text}`);
			const box = fs.realpathSync(path.join(persistentAgentRootPath(ROOM_ID), "runtime", "box"));
			assert(made.text.includes(`at:${box}`), `where: ${made.text}`);
			const named = await bash('mkdir -p "$TMPDIR/lib" && echo kept > "$TMPDIR/lib/x" && /bin/cat "$TMPDIR/lib/x" && echo "at:$TMPDIR"');
			assert(!named.failed && named.text.includes("kept") && named.text.includes(`at:${box}`), `under $TMPDIR: ${named.text}`);
			const slashTmp = await bash(`mkdir -p ${inSlashTmp}/lib && echo x > ${inSlashTmp}/lib/x`);
			assert(slashTmp.failed && !fs.existsSync(inSlashTmp), `/tmp took a write: ${slashTmp.text}`);
			const read = await bash(`/bin/cat ${quoted(path.join(shared, "staged.txt"))}`);
			assert(read.failed && !read.text.includes("staged-skill"), "the shared temp was read");
			const wrote = await bash(`echo x > ${quoted(path.join(shared, "planted"))}`);
			assert(wrote.failed && !fs.existsSync(path.join(shared, "planted")), "the shared temp took a write");
		} finally {
			fs.rmSync(shared, { recursive: true, force: true });
			fs.rmSync(inSlashTmp, { recursive: true, force: true });
		}
	});

	await macRow("package caches: the room's own takes writes, the person's doesn't", async () => {
		const own = await bash('mkdir -p "$npm_config_cache" && echo x > "$npm_config_cache/entry" && /bin/cat "$npm_config_cache/entry"');
		assert(!own.failed && own.text.includes("x"), `own cache: ${own.text}`);
		fs.mkdirSync(path.join(home, ".npm"), { recursive: true });
		const theirs = await bash(`echo x > ${quoted(path.join(home, ".npm", "planted"))}`);
		assert(theirs.failed && !fs.existsSync(path.join(home, ".npm", "planted")), "the person's cache took a write");
	});

	await macRow("Python: a plain pip install lands in the room's caches and imports in the next answer with no path given, and an externally managed Python may install there", async () => {
		const caches = fs.realpathSync(path.join(persistentAgentRootPath(ROOM_ID), "runtime", "box", "caches"));
		// A one-module wheel made in the command's temp, so the install needs no site.
		const makeWheel = [
			"import os, zipfile",
			'with zipfile.ZipFile(os.path.join(os.environ["TMPDIR"], "kept_mark-1.0-py3-none-any.whl"), "w") as wheel:',
			"    wheel.writestr('kept_mark.py', 'print(\"kept-mark\")\\n')",
			"    wheel.writestr('kept_mark-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: kept-mark\\nVersion: 1.0\\n')",
			"    wheel.writestr('kept_mark-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: smoke\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
			"    wheel.writestr('kept_mark-1.0.dist-info/RECORD', 'kept_mark.py,,\\nkept_mark-1.0.dist-info/METADATA,,\\nkept_mark-1.0.dist-info/WHEEL,,\\nkept_mark-1.0.dist-info/RECORD,,\\n')",
		].join("\n");
		try {
			const installed = await bash(`python3 - <<'PY'\n${makeWheel}\nPY\npython3 -m pip install --no-index --disable-pip-version-check "$TMPDIR/kept_mark-1.0-py3-none-any.whl" && python3 -c "import kept_mark; print('at:' + kept_mark.__file__)"; echo "break:$PIP_BREAK_SYSTEM_PACKAGES"`);
			assert(!installed.failed && installed.text.includes(`at:${caches}/`), `first answer: ${installed.text}`);
			assert(installed.text.includes("break:1"), `an externally managed Python would refuse the install: ${installed.text}`);
			await nextTurn();
			const imported = await bash("python3 -c 'import kept_mark'");
			assert(!imported.failed && imported.text.includes("kept-mark"), `next answer: ${imported.text}`);
		} finally {
			fs.rmSync(path.join(caches, "python"), { recursive: true, force: true });
		}
	});

	for (const name of [".vscode/tasks.json", ".idea/x.xml", ".zed/settings.json", ".devcontainer/devcontainer.json", ".claude/settings.json", ".cursor/rules", ".codex/config.toml", ".gemini/settings.json", ".agents/x", ".windsurf/x", ".exxperts/settings.json", ".envrc", ".gitmodules", ".ripgreprc", ".gitconfig", ".mcp.json", ".zshrc", ".bashrc", "deep/down/.vscode/tasks.json", "deep/.zshenv", ".VSCODE/tasks.json", ".GitModules"]) {
		await macRow(`never writable: ${name}`, async () => {
			const target = inRoom(name);
			const { failed } = await bash(`mkdir -p ${quoted(path.dirname(target))}; echo x > ${quoted(target)}`);
			assert(failed && !fs.existsSync(target), `${name} was written`);
		});
	}

	await macRow("never writable: neighbours of the closed names stay open", async () => {
		const { failed, text } = await bash("mkdir -p .vscodium .gitlab sub/git && echo x > .vscodium/a && echo x > .gitlab/b && echo x > sub/git/c && echo x > .gitignore");
		assert(!failed, `neighbours: ${text}`);
	});

	await macRow("a prepared folder can't be moved in with a closed file already inside", async () => {
		const { failed } = await bash("mkdir -p prepared && echo x > prepared/tasks.json && mv prepared .vscode");
		assert(failed && !fs.existsSync(inRoom(".vscode")), "the prepared folder moved in");
	});

	// git takes a folder for a repository only with a HEAD in it: that, objects and refs are closed at the top, and every git name where the folder already holds them.
	const GIT_NAMES = ["HEAD", "config", "config.worktree", "hooks", "objects", "refs", "packed-refs", "commondir", "gitdir", "worktrees", "modules", "rebase-merge", "rebase-apply", "sequencer"];
	const topNames = (place: string) => fs.readdirSync(place).map((name) => name.toLowerCase());

	await macRow("git: a project's config, hooks and modules are made at the room's top, git's layout is not, and deeper every name is ordinary", async () => {
		await nextTurn();
		try {
			const made = await bash("mkdir config hooks modules && echo x > config/settings.yml && echo x > hooks/use-auth.ts && echo x > modules/auth.js && echo exit=$?");
			assert(!made.failed && ["config/settings.yml", "hooks/use-auth.ts", "modules/auth.js"].every((rel) => fs.existsSync(inRoom(rel))), `a project's own folders: ${made.text}`);
			for (const command of [
				"echo x > HEAD",
				'echo "ref: refs/heads/main" > "$TMPDIR/HEAD" && mv "$TMPDIR/HEAD" HEAD',
				"echo x > a-file && ln a-file HEAD",
				"ln -s a-file HEAD",
				"echo x > head",
				"mkdir -p sub && echo x > sub/../HEAD",
				"mkdir objects",
				"mkdir refs",
			]) {
				const blocked = await bash(command);
				assert(blocked.failed && !["head", "objects", "refs"].some((name) => topNames(folder).includes(name)), `${command}: ${blocked.text}`);
			}
			const deep = await bash("mkdir -p a-project && echo x > a-project/config && echo x > a-project/HEAD && mkdir a-project/objects a-project/refs a-project/hooks && echo exit=$?");
			assert(!deep.failed && ["config", "HEAD", "objects", "refs", "hooks"].every((name) => fs.existsSync(inRoom("a-project", name))), `deeper the same names are ordinary: ${deep.text}`);
		} finally {
			for (const name of ["config", "hooks", "modules", "HEAD", "objects", "refs", "a-file", "sub", "a-project"]) fs.rmSync(inRoom(name), { recursive: true, force: true });
		}
	});

	await macRow("git: where the room's top already holds HEAD, or objects and refs, no git name can be made there", async () => {
		await nextTurn();
		for (const layout of [["HEAD"], ["objects", "refs"]]) {
			try {
				for (const name of layout) {
					if (name === "HEAD") fs.writeFileSync(inRoom(name), "any content\n");
					else fs.mkdirSync(inRoom(name));
				}
				for (const name of GIT_NAMES.filter((gitName) => !layout.includes(gitName))) {
					const blocked = await bash(`echo x > ${quoted(name)}`);
					assert(blocked.failed && !topNames(folder).includes(name.toLowerCase()), `${name} beside ${layout.join(" and ")}: ${blocked.text}`);
				}
				const hook = await bash("echo x > hooks/pre-commit || mkdir hooks");
				assert(hook.failed && !topNames(folder).includes("hooks"), `hooks beside ${layout.join(" and ")}: ${hook.text}`);
				const beside = await bash("echo x > notes.md && echo exit=$?");
				assert(!beside.failed && fs.existsSync(inRoom("notes.md")), `an ordinary file beside ${layout.join(" and ")}: ${beside.text}`);
			} finally {
				for (const name of [...GIT_NAMES, "notes.md"]) fs.rmSync(inRoom(name), { recursive: true, force: true });
			}
		}
	});

	await macRow("git: an Also allowed folder that can be changed follows the room's rule at its top", async () => {
		await nextTurn();
		const plain = outsideRoom("top-names-plain");
		const held = outsideRoom("top-names-held");
		for (const place of [plain, held]) fs.mkdirSync(place, { recursive: true });
		fs.writeFileSync(path.join(held, "HEAD"), "ref: refs/heads/main\n");
		saveAlsoAllowedFolders(ROOM_ID, [{ path: plain, access: "write" }, { path: held, access: "write" }]);
		try {
			const made = await bash(`mkdir ${quoted(path.join(plain, "config"))} && echo x > ${quoted(path.join(plain, "config", "settings.yml"))} && echo exit=$?`);
			assert(!made.failed && fs.existsSync(path.join(plain, "config", "settings.yml")), `config in a plain Also allowed folder: ${made.text}`);
			for (const name of ["HEAD", "objects", "refs"]) {
				const blocked = await bash(`echo x > ${quoted(path.join(plain, name))}`);
				assert(blocked.failed && !topNames(plain).includes(name.toLowerCase()), `${name} in a plain Also allowed folder: ${blocked.text}`);
			}
			for (const name of ["config", "hooks"]) {
				const blocked = await bash(`echo x > ${quoted(path.join(held, name))}`);
				assert(blocked.failed && !topNames(held).includes(name), `${name} in an Also allowed folder holding HEAD: ${blocked.text}`);
			}
		} finally {
			saveAlsoAllowedFolders(ROOM_ID, []);
			for (const place of [plain, held]) fs.rmSync(place, { recursive: true, force: true });
		}
	});

	// Where the folder's own git settings lead git to its top's hooks or config, every git name stays closed there; elsewhere they are the project's.
	const gitSettings = (text: string, file = "config", root = folder) => () => {
		fs.mkdirSync(path.join(root, ".git"), { recursive: true });
		fs.writeFileSync(path.join(root, ".git", file), text);
	};
	const hooksPathOf = (value: string, root = folder) => gitSettings(`[core]\n\trepositoryformatversion = 0\n\thooksPath = ${value}\n`, "config", root);
	const SETTINGS_LEFTOVERS = [".git", "hooks", "hooks-old", "config", "modules", "src", "x", "githooks", "notes.md", "HEAD"];

	await macRow("git: where the room's own git settings lead git to the top's hooks or config, a command can't change them", async () => {
		const elsewhereGit = outsideRoom("settings-elsewhere");
		gitSettings("[core]\n\tbare = false\n", "config", elsewhereGit)();
		const pointing: Array<[string, () => void]> = [
			["a hooks path of hooks", hooksPathOf("hooks")],
			["an include", gitSettings("[include]\n\tpath = ../config\n")],
			["an includeIf", gitSettings('[includeIf "gitdir:~/"]\n\tpath = ../config\n')],
			["a hooks path through src/..", () => {
				hooksPathOf("src/../hooks")();
				fs.mkdirSync(inRoom("src"));
			}],
			["[CORE] HooksPath=hooks", gitSettings("[CORE] HooksPath=hooks\n")],
			["a quoted hooks path that starts with a space", gitSettings("[core]\n\thooksPath = \" githooks\"\n")],
			["a second hooks path with another value", gitSettings("[core]\n\thooksPath = .githooks\n\thooksPath = .husky/_\n")],
			["a hooks path in config.worktree", gitSettings("[core]\n\thooksPath = hooks\n", "config.worktree")],
			["a link at the top that leads to hooks", () => {
				hooksPathOf("githooks")();
				fs.symlinkSync("hooks", inRoom("githooks"));
			}],
			["a .git file", () => fs.writeFileSync(inRoom(".git"), "gitdir: ../elsewhere/.git\n")],
			["a .git folder with a commondir", () => {
				gitSettings("ref: refs/heads/main\n", "HEAD")();
				fs.writeFileSync(inRoom(".git", "commondir"), "../elsewhere/.git\n");
			}],
			["a .git that is a link", () => fs.symlinkSync(path.join(elsewhereGit, ".git"), inRoom(".git"))],
			["a settings file that is a link", () => {
				fs.mkdirSync(inRoom(".git"));
				fs.symlinkSync(path.join(elsewhereGit, ".git", "config"), inRoom(".git", "config"));
			}],
			["a settings file that is a folder", () => fs.mkdirSync(inRoom(".git", "config"), { recursive: true })],
			["a settings file over the limit", gitSettings(`[core]\n${"# filler line for the size limit\n".repeat(3000)}`)],
			// git walks `x/L/..` on the disk: with `x/L` a link to the top's `src`, that is the top.
			["a hooks path through a link and ..", () => {
				hooksPathOf("x/L/../hooks")();
				fs.mkdirSync(inRoom("src"));
				fs.mkdirSync(inRoom("x"));
				fs.symlinkSync("../src", inRoom("x", "L"));
			}],
			// Any absolute hooks path, or one in the person's home: another spelling can name the folder's own `hooks`.
			["a hooks path outside the folder", hooksPathOf(outsideRoom("shared-hooks"))],
			["a hooks path in the home", hooksPathOf("~/x")],
			// A key of `worktree` moves the place git starts a relative hooks path from.
			["a worktree setting", gitSettings(`[core]\n\tworktree = ${path.dirname(folder)}\n\thooksPath = ${path.basename(folder)}/hooks\n`)],
			["a worktree setting spelt WorkTree=../..", gitSettings("[core]\n\tWorkTree=../..\n")],
			["a worktree setting after headers on its line", gitSettings('[x "]a=1"] [CORE] worktree = ..\n')],
		];
		// The data volume's spelling of the room's folder, which its real path leaves as it is.
		if (fs.existsSync(`/System/Volumes/Data${folder}`)) pointing.push(["a hooks path into the folder through the data volume", hooksPathOf(`/System/Volumes/Data${folder}/hooks`)]);
		// Root reads a file whatever its mode; the row runs on a Mac only.
		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			pointing.push(["a settings file that can't be read", () => {
				gitSettings("[core]\n\tbare = false\n")();
				fs.chmodSync(inRoom(".git", "config"), 0o000);
			}]);
		}
		try {
			for (const [label, setUp] of pointing) {
				try {
					setUp();
					fs.mkdirSync(inRoom("hooks"), { recursive: true });
					fs.writeFileSync(inRoom("hooks", "pre-commit"), "exit 0\n", { mode: 0o755 });
					await nextTurn();
					for (const command of ["echo x >> hooks/pre-commit", "echo x > hooks/post-commit", 'echo x > "$TMPDIR/post-merge" && mv "$TMPDIR/post-merge" hooks/post-merge', "mv hooks hooks-old", "echo x > config", "mkdir modules"]) {
						const blocked = await bash(command);
						assert(blocked.failed, `${label}: ${command}: ${blocked.text}`);
					}
					assert(fs.readFileSync(inRoom("hooks", "pre-commit"), "utf8") === "exit 0\n" && fs.readdirSync(inRoom("hooks")).join() === "pre-commit", `${label}: the hooks changed`);
					assert(!["config", "modules", "hooks-old"].some((name) => topNames(folder).includes(name)), `${label}: a name landed at the top: ${topNames(folder).join(", ")}`);
					const beside = await bash("echo x > notes.md && echo exit=$?");
					assert(!beside.failed && fs.existsSync(inRoom("notes.md")), `${label}: an ordinary file: ${beside.text}`);
				} finally {
					try {
						// The unreadable case's file, so the folder can go.
						fs.chmodSync(inRoom(".git", "config"), 0o700);
					} catch {}
					for (const name of SETTINGS_LEFTOVERS) fs.rmSync(inRoom(name), { recursive: true, force: true });
				}
			}
		} finally {
			fs.rmSync(elsewhereGit, { recursive: true, force: true });
		}
	});

	await macRow("git: where the room's own git settings point elsewhere, a command makes config, hooks and modules at the top", async () => {
		const pointingElsewhere: Array<[string, () => void]> = [
			["a husky hooks path", hooksPathOf(".husky/_")],
			["a .githooks hooks path", hooksPathOf(".githooks")],
			["a quoted husky hooks path", gitSettings("[core]\n\thooksPath = \".husky/_\"\n")],
			["settings with no hooks path", gitSettings("[core]\n\trepositoryformatversion = 0\n\tbare = false\n")],
			["an extensions.worktreeConfig setting", gitSettings("[core]\n\tbare = false\n[extensions]\n\tworktreeConfig = true\n")],
			["a value that holds the word worktree", gitSettings('[remote "origin"]\n\turl = https://example.invalid/worktree.git\n')],
		];
		for (const [label, setUp] of pointingElsewhere) {
			try {
				setUp();
				await nextTurn();
				const made = await bash("mkdir config hooks modules && echo x > config/settings.yml && echo x > hooks/use-auth.ts && echo x > modules/auth.js && echo exit=$?");
				assert(!made.failed && ["config/settings.yml", "hooks/use-auth.ts", "modules/auth.js"].every((rel) => fs.existsSync(inRoom(rel))), `${label}: ${made.text}`);
				const head = await bash("echo x > HEAD");
				assert(head.failed && !topNames(folder).includes("head"), `${label}: HEAD: ${head.text}`);
			} finally {
				for (const name of SETTINGS_LEFTOVERS) fs.rmSync(inRoom(name), { recursive: true, force: true });
			}
		}
	});

	await macRow("git: an Also allowed folder is judged by its own git settings", async () => {
		await nextTurn();
		const hooked = outsideRoom("top-names-hooked");
		const husky = outsideRoom("top-names-husky");
		hooksPathOf("hooks", hooked)();
		hooksPathOf(".husky/_", husky)();
		saveAlsoAllowedFolders(ROOM_ID, [{ path: hooked, access: "write" }, { path: husky, access: "write" }]);
		try {
			for (const name of ["config", "hooks", "modules"]) {
				const blocked = await bash(`mkdir ${quoted(path.join(hooked, name))}`);
				assert(blocked.failed && !topNames(hooked).includes(name), `${name} in an Also allowed folder with a hooks path of hooks: ${blocked.text}`);
			}
			const made = await bash(`mkdir ${quoted(path.join(husky, "hooks"))} && echo x > ${quoted(path.join(husky, "hooks", "use-auth.ts"))} && echo exit=$?`);
			assert(!made.failed && fs.existsSync(path.join(husky, "hooks", "use-auth.ts")), `hooks in an Also allowed folder with a husky hooks path: ${made.text}`);
		} finally {
			saveAlsoAllowedFolders(ROOM_ID, []);
			for (const place of [hooked, husky]) fs.rmSync(place, { recursive: true, force: true });
		}
	});

	await macRow("names: the editor, assistant and package-manager files other tools run from can't be written", async () => {
		await nextTurn();
		try {
			for (const name of [".devcontainer.json", "team.code-workspace", ".clinerules", ".pre-commit-config.yaml", ".npmrc", ".yarnrc.yml"]) {
				const blocked = await bash(`echo x > ${quoted(name)}`);
				assert(blocked.failed && !fs.existsSync(inRoom(name)), `${name}: ${blocked.text}`);
				const deeper = await bash(`mkdir -p nested && echo x > ${quoted(`nested/${name}`)}`);
				assert(deeper.failed && !fs.existsSync(inRoom("nested", name)), `nested/${name}: ${deeper.text}`);
			}
			for (const name of [".nova", ".fleet", ".vs", ".continue", ".roo", ".kiro", ".opencode", ".cline", ".husky"]) {
				const blocked = await bash(`mkdir ${quoted(name)} && echo x > ${quoted(`${name}/f`)}`);
				assert(blocked.failed && !fs.existsSync(inRoom(name, "f")), `${name}: ${blocked.text}`);
			}
			const beside = await bash("echo x > ordinary.json && echo exit=$?");
			assert(!beside.failed && fs.existsSync(inRoom("ordinary.json")), `an ordinary file: ${beside.text}`);
		} finally {
			for (const name of [".devcontainer.json", "team.code-workspace", ".clinerules", ".pre-commit-config.yaml", ".npmrc", ".yarnrc.yml", "nested", ".nova", ".fleet", ".vs", ".continue", ".roo", ".kiro", ".opencode", ".cline", ".husky", "ordinary.json"]) fs.rmSync(inRoom(name), { recursive: true, force: true });
		}
	});

	await macRow("launching and odd transports are refused: scheduling, privilege, a remote shell and UDP", async () => {
		await nextTurn();
		for (const [name, command] of [
			["crontab", "/usr/bin/crontab -l 2>&1; echo code=$?"],
			["at", "echo true | /usr/bin/at now 2>&1; echo code=$?"],
			["sudo", "/usr/bin/sudo -n true 2>&1; echo code=$?"],
			["ssh", "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=2 nobody@8.8.8.8 true 2>&1 | /usr/bin/head -1; echo code=$?"],
		] as const) {
			const refused = await bash(command);
			assert(/not permitted/i.test(refused.text), `${name}: ${refused.text}`);
		}
		const udp = await bash("/usr/bin/python3 -I -c 'import socket\ntry:\n    socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b\"x\", (\"8.8.8.8\", 53)); print(\"SENT\")\nexcept OSError as e:\n    print(\"BLOCKED\", e)' 2>/dev/null");
		assert(udp.text.includes("BLOCKED") && /not permitted/i.test(udp.text), `udp: ${udp.text}`);
	});

	await macRow("reads: the per-user caches folder and the 0 folder are closed, by the system's own names", async () => {
		await nextTurn();
		for (const name of ["DARWIN_USER_CACHE_DIR", "DARWIN_USER_DIR", "DARWIN_USER_TEMP_DIR"]) {
			const read = await bash(`d=$(/usr/bin/getconf ${name}); /bin/ls "$d" > /dev/null 2>&1; echo ${name}=$?`);
			assert(read.text.includes(`${name}=`) && !read.text.includes(`${name}=0`), `${name} was readable: ${read.text}`);
		}
	});

	await macRow("the way out and a boxed command each run their message's calls in order: nothing runs beside them in one batch", () => {
		const way = tools.tools.find((candidate) => candidate.name === "run_outside_box");
		assert(way?.executionMode === "sequential", `the way out's mode: ${way?.executionMode}`);
		const boxed = tools.tools.find((candidate) => candidate.name === "bash");
		assert(boxed?.executionMode === "sequential", `the boxed command's mode: ${boxed?.executionMode}`);
	});

	const repository = inRoom("repo");
	fs.mkdirSync(repository);
	git(repository, "init", "-q");
	fs.writeFileSync(path.join(repository, "a.txt"), "one\n");
	git(repository, "add", ".");
	git(repository, "commit", "-qm", "first");
	const inRepo = (command: string) => bash(`cd repo && ${command}`);
	const gitIn = "git -c user.name=s -c user.email=s@s";

	await macRow("git: the settings and hooks are closed", async () => {
		const before = fs.readFileSync(path.join(repository, ".git", "config"), "utf8");
		const config = await inRepo("echo '[core]' >> .git/config");
		assert(config.failed && fs.readFileSync(path.join(repository, ".git", "config"), "utf8") === before, "config changed");
		const hook = await inRepo("echo x > .git/hooks/pre-commit");
		assert(hook.failed && !fs.existsSync(path.join(repository, ".git", "hooks", "pre-commit")), "a hook landed");
		const set = await inRepo("git config core.fsmonitor /bin/echo");
		assert(set.failed && fs.readFileSync(path.join(repository, ".git", "config"), "utf8") === before, `git config: ${set.text}`);
	});

	await macRow("git: status and log work, and a commit is refused and leaves the repository as it was", async () => {
		const read = await inRepo("echo two >> a.txt && git status --porcelain && git log --oneline");
		assert(!read.failed && read.text.includes("M a.txt") && read.text.includes("first"), `git status and log: ${read.text}`);
		const head = fs.readFileSync(path.join(repository, ".git", "HEAD"), "utf8");
		const commit = await inRepo(`${gitIn} commit -qam second`);
		assert(commit.failed && fs.readFileSync(path.join(repository, ".git", "HEAD"), "utf8") === head && !git(repository, "log", "--oneline").stdout.includes("second"), `git commit: ${commit.text}`);
		git(repository, "checkout", "-q", "a.txt");
	});

	await macRow("git: a repository can't be made, and a .git can't be made, moved, replaced or changed inside", async () => {
		const init = await bash("mkdir -p fresh && cd fresh && git init -q");
		assert(init.failed && !fs.existsSync(inRoom("fresh", ".git", "config")), `git init: ${init.text}`);
		const entry = await bash("mkdir -p other && : > other/.git");
		assert(entry.failed && !fs.existsSync(inRoom("other", ".git")), "a .git file landed");
		const moved = await inRepo("mv .git moved-git");
		assert(moved.failed && fs.existsSync(path.join(repository, ".git", "HEAD")), "the .git moved");
		const inside = await inRepo("echo x > .git/description-note");
		assert(inside.failed && !fs.existsSync(path.join(repository, ".git", "description-note")), `inside .git: ${inside.text}`);
		const removed = await bash("rm -rf repo");
		assert(removed.failed && fs.existsSync(path.join(repository, ".git", "HEAD")), `rm -rf over a repository: ${removed.text}`);
		fs.writeFileSync(path.join(repository, "a.txt"), "one\n");
		fs.rmSync(inRoom("fresh"), { recursive: true, force: true });
		fs.rmSync(inRoom("other"), { recursive: true, force: true });
	});

	await macRow("git: no repository is made in the private temp or caches, so none moves into the room", async () => {
		for (const place of ["$TMPDIR", "$npm_config_cache"]) {
			const made = await bash(`/bin/mkdir -p "${place}/prep" && cd "${place}/prep" && git init -q`);
			assert(made.failed, `git init in ${place}: ${made.text}`);
			const planted = await bash(`/bin/mkdir -p "${place}/prep/.git/hooks"`);
			assert(planted.failed, `a .git in ${place}: ${planted.text}`);
		}
		const moved = await bash('/bin/mv repo "$TMPDIR/away" && echo "[core]" >> "$TMPDIR/away/.git/config"');
		assert(moved.failed, `a repository's settings changed in the temp: ${moved.text}`);
		await bash('[ -d "$TMPDIR/away" ] && /bin/mv "$TMPDIR/away" repo');
		assert(fs.existsSync(path.join(repository, ".git", "HEAD")) && !fs.readFileSync(path.join(repository, ".git", "config"), "utf8").endsWith("[core]\n"), "the repository came back changed");
	});

	await macRow("process information: another program's arguments can't be read", async () => {
		// portability-ok: a macRow, skipped by name on any other computer
		const started = spawnSync("/bin/bash", ["-c", "/bin/sleep 30 process-secret >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
		const pid = Number(started.stdout.trim());
		try {
			const { text } = await bash(`/usr/bin/perl -e 'my $n=pack("i3",1,49,${pid});my $b="\\0"x65536;my $l=pack("Q",65536);my $r=syscall(202,unpack("Q",pack("P",$n)),3,unpack("Q",pack("P",$b)),unpack("Q",pack("P",$l)),0,0);print "r=$r err=",$!+0,"\\n";print "found\\n" if index($b,"process-secret")>=0;'`);
			assert(text.includes("r=-1 err=1") && !text.includes("found"), `process read: ${text}`);
		} finally {
			try { process.kill(pid); } catch { /* Already gone. */ }
		}
	});

	await macRow("the private temp can't be swapped for a link", async () => {
		const { failed } = await bash(`t="$TMPDIR"; /usr/bin/find "$t" -mindepth 1 -delete; /bin/rmdir "$t" && /bin/ln -s ${quoted(elsewhere)} "$t"`);
		assert(failed, "the private temp was removed");
		const after = await bash('echo still > "$TMPDIR/still"; /bin/cat "$TMPDIR/still"');
		assert(!after.failed && after.text.includes("still"), `temp after: ${after.text}`);
		assert(!fs.existsSync(path.join(elsewhere, "still")), "the private temp led somewhere else");
	});

	await macRow("the room's caches can't be swapped for a link", async () => {
		const swap = await bash(`c="\${npm_config_cache%/npm}"; /usr/bin/find "$c" -mindepth 1 -delete; /bin/rmdir "$c" && /bin/ln -s ${quoted(elsewhere)} "$c"`);
		assert(swap.failed, "the caches folder was removed");
		await box.endTurn();
		const after = await bash('/bin/mkdir -p "$npm_config_cache" && echo still > "$npm_config_cache/still"');
		assert(!after.failed && !fs.existsSync(path.join(elsewhere, "npm", "still")), `the caches led somewhere else: ${after.text}`);
	});

	await macRow("git rules: a worktree's settings file can't be planted, nor any other file in the repository's .git", async () => {
		git(inRoom(), "init", "-q");
		const planted = await bash("/bin/mkdir -p .git/worktrees/x && echo '[broken' > .git/worktrees/x/config");
		assert(planted.failed && !fs.existsSync(inRoom(".git/worktrees/x/config")), `planted: ${planted.text}`);
		const exclude = await bash("echo ignored >> .git/info/exclude");
		assert(exclude.failed && !fs.readFileSync(inRoom(".git/info/exclude"), "utf8").includes("ignored"), `an ordinary file in the repository: ${exclude.text}`);
		const next = await bash("echo still-runs");
		assert(!next.failed && next.text.includes("still-runs"), `the next command: ${next.text}`);
		fs.rmSync(inRoom(".git"), { recursive: true, force: true });
	});

	await macRow("launching: the server's own steps take no program from PATH", async () => {
		const planted = outsideRoom("planted-bin");
		const marker = outsideRoom("planted-ran");
		fs.mkdirSync(planted, { recursive: true });
		// portability-ok: a macRow, skipped by name on any other computer
		for (const name of ["env", "git"]) fs.writeFileSync(path.join(planted, name), `#!/bin/sh\necho ${name} >> ${quoted(marker)}\nexec /usr/bin/${name} "$@"\n`, { mode: 0o755 });
		const saved = process.env.PATH;
		process.env.PATH = `${planted}:${saved}`;
		try {
			const { failed, text } = await bash("echo through");
			assert(!failed && text.includes("through"), `the command: ${text}`);
			assert(!fs.existsSync(marker), `ran outside the box: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`);
		} finally {
			process.env.PATH = saved;
		}
	});

	await macRow("launching: a fixed shell with no startup files, whatever the environment says", async () => {
		const marker = inRoom("startup-ran");
		for (const file of [".bashrc", ".bash_profile", ".zshenv", ".profile"]) fs.writeFileSync(path.join(home, file), `echo ran > ${quoted(marker)}\n`);
		const saved = { BASH_ENV: process.env.BASH_ENV, ENV: process.env.ENV, SHELL: process.env.SHELL };
		process.env.BASH_ENV = path.join(home, ".bashrc");
		process.env.ENV = path.join(home, ".bashrc");
		// portability-ok: a macRow, skipped by name on any other computer
		process.env.SHELL = "/bin/zsh";
		try {
			const { text, failed } = await bash('echo "env:${BASH_ENV:-none}"');
			assert(!failed && text.includes("env:none"), `shell: ${text}`);
			assert(!fs.existsSync(marker), "a startup file ran");
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	await macRow("environment: a short allow list, never inherited", async () => {
		process.env.EXXPERTS_AUTH_TOKEN = "smoke-token";
		process.env.ANTHROPIC_API_KEY = "smoke-key";
		process.env.SMOKE_OWN_VARIABLE = "own-value";
		try {
			const { text } = await bash("/usr/bin/env");
			for (const leaked of ["smoke-token", "smoke-key", "own-value"]) assert(!text.includes(leaked), `${leaked} reached the command`);
			assert(/^PATH=/m.test(text) && /^HOME=/m.test(text) && /^TMPDIR=/m.test(text), `kept: ${text}`);
		} finally {
			delete process.env.EXXPERTS_AUTH_TOKEN;
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.SMOKE_OWN_VARIABLE;
		}
	});

	await macRow("skills: an approved folder reads and runs, never writes outside the room; one inside the room keeps the room's writes; another stays closed; a withdrawn one drops", async () => {
		const skills = path.join(home, "skills");
		const approved = path.join(skills, "approved");
		const other = path.join(skills, "other");
		for (const skill of [approved, other]) fs.mkdirSync(skill, { recursive: true });
		// portability-ok: a macRow, skipped by name on any other computer
		fs.writeFileSync(path.join(approved, "run.sh"), "#!/bin/sh\necho skill-ran\n", { mode: 0o755 });
		fs.writeFileSync(path.join(other, "secret"), "other-skill");
		person.skillFolders = [approved];
		try {
			const ran = await bash(quoted(path.join(approved, "run.sh")));
			assert(!ran.failed && ran.text.includes("skill-ran"), `run: ${ran.text}`);
			const planted = await bash(`echo x > ${quoted(path.join(approved, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(approved, "planted")), "a skill folder took a write");
			const insideRoom = inRoom("skill-in-room");
			fs.mkdirSync(insideRoom);
			person.skillFolders = [approved, insideRoom];
			const plantedInRoom = await bash("echo x > skill-in-room/planted");
			assert(!plantedInRoom.failed && fs.existsSync(path.join(insideRoom, "planted")), `a skill folder inside the room took the room's write away: ${plantedInRoom.text}`);
			person.skillFolders = [approved];
			const closed = await bash(`/bin/cat ${quoted(path.join(other, "secret"))}`);
			assert(closed.failed, "another skill was read");
			person.skillFolders = [];
			const withdrawn = await bash(quoted(path.join(approved, "run.sh")));
			assert(withdrawn.failed, "a withdrawn skill ran");
		} finally {
			person.skillFolders = [];
		}
	});

	await macRow("skills: a skill on in the room's library, never approved, runs as it now is, never takes a write or a link, and reads no closed file through a link; one left off reads nothing", async () => {
		const store = agentSkillsDir();
		/** A skill as the Skills page leaves it in the library: SKILL.md, one script and its record. */
		const plantSkill = (name: string): { dir: string; identity: string } => {
			const dir = path.join(store, name);
			const manifest = `---\nname: ${name}\ndescription: a test skill\n---\n\nRun scripts/run.sh.\n`;
			fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
			fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
			// portability-ok: a macRow, skipped by name on any other computer
			fs.writeFileSync(path.join(dir, "scripts", "run.sh"), `#!/bin/sh\necho ${name}-ran\n`, { mode: 0o755 });
			const identity = crypto.randomUUID();
			writeSkillProvenance(dir, { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest), identity });
			return { dir, identity };
		};
		const on = plantSkill("on-tool");
		const old = plantSkill("old-tool");
		const off = plantSkill("off-tool");
		// One entry as this app writes it, one as an older app left it: a stale hash and a run approval.
		const settingsFile = persistentRoomSkillSettingsPath(ROOM_ID);
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		const stored = `${JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "old-tool", sha256: sha256("the text it had"), identity: old.identity, executeApproval: { filesSha256: sha256("the files it had"), approvedAt: "2026-11-01T10:00:00.000Z" } }, { name: "on-tool", identity: on.identity }], updatedAt: "2026-11-01T10:00:00.000Z" }, null, 2)}\n`;
		fs.writeFileSync(settingsFile, stored);
		assert(roomSkillFolders(ROOM_ID).map((skill) => skill.name).join() === "old-tool,on-tool", "the two skills that are on");
		const skillBox = new RoomBox({ roomId: ROOM_ID, conversationId: () => "conversation-skills", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: roomSkillFolders(ROOM_ID).map((skill) => skill.skillDir) }), warn: () => {} });
		const skillTools = createRoomCommandTools(folder, { box: skillBox, outside: { questions: questions as any, setOffered: () => {} } });
		const run = (command: string) => call(skillTools, "bash", { command });
		const script = path.join(on.dir, "scripts", "run.sh");
		const closedFile = path.join(home, "skills-closed-secret.txt");
		fs.writeFileSync(closedFile, "CLOSED-NEEDLE\n");
		try {
			for (const skill of [on, old]) {
				const ran = await run(quoted(path.join(skill.dir, "scripts", "run.sh")));
				assert(!ran.failed && ran.text.includes(`${path.basename(skill.dir)}-ran`), `run ${path.basename(skill.dir)}: ${ran.text}`);
			}
			const planted = await run(`echo x > ${quoted(path.join(on.dir, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(on.dir, "planted")), "a skill folder took a write");
			const offRead = await run(`/bin/cat ${quoted(path.join(off.dir, "SKILL.md"))}`);
			assert(offRead.failed && !offRead.text.includes("name: off-tool"), `a skill left off was read: ${offRead.text}`);
			// One byte of the script changes: the next command runs it as it now is.
			// portability-ok: a macRow, skipped by name on any other computer
			fs.writeFileSync(script, "#!/bin/sh\necho on-tool-changed\n", { mode: 0o755 });
			const changed = await run(quoted(script));
			assert(!changed.failed && changed.text.includes("on-tool-changed"), `the changed script: ${changed.text}`);

			// A link inside the skill's folder to a closed file: the file stays closed, its neighbour in the folder reads.
			fs.symlinkSync(closedFile, path.join(on.dir, "link-to-secret"));
			const throughLink = await run(`/bin/cat ${quoted(path.join(on.dir, "link-to-secret"))}`);
			assert(throughLink.failed && !throughLink.text.includes("CLOSED-NEEDLE"), `a closed file was read through a link in a skill's folder: ${throughLink.text}`);
			const direct = await run(`/bin/cat ${quoted(closedFile)}`);
			assert(direct.failed && !direct.text.includes("CLOSED-NEEDLE"), `the closed file itself was read: ${direct.text}`);
			const neighbour = await run(`/bin/cat ${quoted(path.join(on.dir, "SKILL.md"))}`);
			assert(!neighbour.failed && neighbour.text.includes("name: on-tool"), `the skill's SKILL.md: ${neighbour.text}`);

			// A hard link into the room, and an append through a symbolic link: both refused, the file as it was.
			const before = { text: fs.readFileSync(script, "utf8"), links: fs.statSync(script).nlink };
			const hard = await run(`ln ${quoted(script)} ./hard-linked-skill-script`);
			assert(hard.failed && !fs.existsSync(inRoom("hard-linked-skill-script")), `a hard link of a skill's file was made in the room: ${hard.text}`);
			const appended = await run(`ln -s ${quoted(script)} ./linked-skill-script && echo appended >> ./linked-skill-script`);
			assert(appended.failed, `an append through a link to a skill's file: ${appended.text}`);
			assert(fs.readFileSync(script, "utf8") === before.text && fs.statSync(script).nlink === before.links, "the skill's file changed");
			// The allowed neighbour: a hard link of the room's own file.
			fs.writeFileSync(inRoom("own-file.txt"), "own\n");
			const ownLink = await run("ln ./own-file.txt ./own-file-link.txt");
			assert(!ownLink.failed && fs.statSync(inRoom("own-file.txt")).nlink === 2, `a hard link of the room's own file: ${ownLink.text}`);
			assert(fs.readFileSync(settingsFile, "utf8") === stored, "a boxed command wrote the room's skill settings");
		} finally {
			await skillBox.endTurn();
			for (const made of ["linked-skill-script", "own-file.txt", "own-file-link.txt"]) fs.rmSync(inRoom(made), { force: true });
			fs.rmSync(closedFile, { force: true });
			fs.rmSync(settingsFile, { force: true });
			for (const skill of [on, old, off]) fs.rmSync(skill.dir, { recursive: true, force: true });
		}
	});

	await macRow("skills: a shared-folder skill linked to a real folder inside ~/.agents reads and runs there, never takes a write, and a link inside it to a folder outside reads nothing", async () => {
		const real = path.join(home, ".agents", "kept", "shared-run");
		const linkedAt = path.join(home, ".agents", "skills", "shared-run");
		const outsideFolder = path.join(home, "shared-run-outside");
		fs.mkdirSync(path.join(real, "scripts"), { recursive: true });
		fs.mkdirSync(path.dirname(linkedAt), { recursive: true });
		fs.mkdirSync(outsideFolder, { recursive: true });
		fs.writeFileSync(path.join(real, "SKILL.md"), "---\nname: shared-run\ndescription: a shared test skill\n---\n\nRun scripts/run.sh.\n");
		// portability-ok: a macRow, skipped by name on any other computer
		fs.writeFileSync(path.join(real, "scripts", "run.sh"), "#!/bin/sh\necho shared-ran\n", { mode: 0o755 });
		fs.writeFileSync(path.join(outsideFolder, "secret.txt"), "OUTSIDE-NEEDLE\n");
		fs.symlinkSync(real, linkedAt, "dir");
		fs.symlinkSync(outsideFolder, path.join(real, "outside-link"), "dir");
		const settingsFile = persistentRoomSkillSettingsPath(ROOM_ID);
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, `${JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "shared-run" }], updatedAt: "2026-11-21T10:00:00.000Z" }, null, 2)}\n`);
		const opened = roomSkillFolders(ROOM_ID);
		assert(opened.length === 1 && opened[0].skillDir === fs.realpathSync(real), `the room opens the shared skill at its real folder, got ${JSON.stringify(opened)}`);
		const sharedBox = new RoomBox({ roomId: ROOM_ID, conversationId: () => "conversation-shared-skill", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: roomSkillFolders(ROOM_ID).map((skill) => skill.skillDir) }), warn: () => {} });
		const sharedTools = createRoomCommandTools(folder, { box: sharedBox, outside: { questions: questions as any, setOffered: () => {} } });
		const run = (command: string) => call(sharedTools, "bash", { command });
		try {
			const ran = await run(quoted(path.join(opened[0].skillDir, "scripts", "run.sh")));
			assert(!ran.failed && ran.text.includes("shared-ran"), `run the shared skill's script: ${ran.text}`);
			const read = await run(`/bin/cat ${quoted(path.join(opened[0].skillDir, "SKILL.md"))}`);
			assert(!read.failed && read.text.includes("name: shared-run"), `read its SKILL.md: ${read.text}`);
			const planted = await run(`echo x > ${quoted(path.join(opened[0].skillDir, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(real, "planted")), "the shared skill's folder took a write");
			const throughLink = await run(`/bin/cat ${quoted(path.join(opened[0].skillDir, "outside-link", "secret.txt"))}`);
			assert(throughLink.failed && !throughLink.text.includes("OUTSIDE-NEEDLE"), `a folder outside was read through a link in the shared skill's folder: ${throughLink.text}`);
		} finally {
			await sharedBox.endTurn();
			fs.rmSync(settingsFile, { force: true });
			fs.rmSync(path.join(home, ".agents"), { recursive: true, force: true });
			fs.rmSync(outsideFolder, { recursive: true, force: true });
		}
	});

	await macRow("skills: a shared-folder skill linked to a real folder outside ~/.agents reads and runs there and never takes a write", async () => {
		const away = path.join(home, "team-skills", "away-run");
		await withSharedSkills(ROOM_ID, folder, [[away, "away-run"]], true, async (run, opened) => {
			assert(opened.get("away-run") === fs.realpathSync(away), `the room opens the skill at its real folder outside ~/.agents, got ${JSON.stringify([...opened])}`);
			const ran = await run(quoted(path.join(away, "scripts", "run.sh")));
			assert(!ran.failed && ran.text.includes("away-run-ran"), `run the skill's script outside ~/.agents: ${ran.text}`);
			const read = await run(`/bin/cat ${quoted(path.join(away, "SKILL.md"))}`);
			assert(!read.failed && read.text.includes("name: away-run"), `read its SKILL.md: ${read.text}`);
			const planted = await run(`echo x > ${quoted(path.join(away, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(away, "planted")), "the skill's folder outside ~/.agents took a write");
		});
	});

	await macRow("skills: a shared-folder skill whose real folder is in the room's own folder reads and runs there by the room's own rights, and the room's writes land there", async () => {
		const inRoom = path.join(folder, "team-skills", "room-run");
		await withSharedSkills(ROOM_ID, folder, [[inRoom, "room-run"]], true, async (run, opened) => {
			assert(!opened.has("room-run"), `the server opens nothing for a skill in the room's own folder, got ${JSON.stringify([...opened])}`);
			const ran = await run(quoted(path.join(inRoom, "scripts", "run.sh")));
			assert(!ran.failed && ran.text.includes("room-run-ran"), `run the skill's script in the room's folder: ${ran.text}`);
			const changed = await run(`echo kept > ${quoted(path.join(inRoom, "notes.txt"))}`);
			assert(!changed.failed && fs.readFileSync(path.join(inRoom, "notes.txt"), "utf8") === "kept\n", `the room lost its write in its own folder where a skill's folder is: ${changed.text}`);
		});
	});

	await macRow("skills: a shared-folder skill whose real folder is in the room's own folder, swapped by the room's command for a link to a folder outside, opens nothing in that room: a file there stays closed", async () => {
		const inRoom = path.join(folder, "team-skills", "swap-run");
		const swappedTo = path.join(home, "private-notes");
		fs.mkdirSync(swappedTo, { recursive: true });
		fs.writeFileSync(path.join(swappedTo, "SKILL.md"), "---\nname: swap-run\ndescription: a folder of notes\n---\n\nNotes.\n");
		fs.writeFileSync(path.join(swappedTo, "notes.txt"), "swapped-secret\n");
		const secret = quoted(path.join(swappedTo, "notes.txt"));
		try {
			await withSharedSkills(ROOM_ID, folder, [[inRoom, "swap-run"]], true, async (run, opened) => {
				assert(!opened.has("swap-run"), `the server opens nothing for a skill in the room's own folder, got ${JSON.stringify([...opened])}`);
				const ran = await run(quoted(path.join(inRoom, "scripts", "run.sh")));
				assert(!ran.failed && ran.text.includes("swap-run-ran"), `before the swap, run the skill's script: ${ran.text}`);
				const before = await run(`/bin/cat ${secret}`);
				assert(before.failed && !before.text.includes("swapped-secret"), `the folder outside read before any swap: ${before.text}`);
				const swapped = await run(`mv ${quoted(inRoom)} ${quoted(`${inRoom}-old`)} && ln -s ${quoted(swappedTo)} ${quoted(inRoom)}`);
				assert(!swapped.failed && fs.lstatSync(inRoom).isSymbolicLink(), `the room's command swaps the skill's folder for a link: ${swapped.text}`);
				const read = await run(`/bin/cat ${secret}`);
				assert(read.failed && !read.text.includes("swapped-secret"), `a command read the folder a link the room left leads to: ${read.text}`);
				assert(!roomSkillFolders(ROOM_ID).some((skill) => skill.name === "swap-run"), `the room opens the skill through the link it left, got ${JSON.stringify(roomSkillFolders(ROOM_ID))}`);
			});
		} finally {
			fs.rmSync(swappedTo, { recursive: true, force: true });
			fs.rmSync(`${inRoom}-old`, { recursive: true, force: true });
		}
	});

	await macRow("skills: a shared-folder skill whose real folder is in the room's own folder: a folder above it swapped by the room for a link to a folder outside, as a job could just as the next command starts, opens nothing outside", async () => {
		const above = path.join(folder, "team-above");
		const inRoom = path.join(above, "above-run");
		const outside = path.join(home, "above-outside");
		fs.mkdirSync(path.join(outside, "above-run"), { recursive: true });
		fs.writeFileSync(path.join(outside, "above-run", "SKILL.md"), "---\nname: above-run\ndescription: a folder of notes\n---\n\nNotes.\n");
		fs.writeFileSync(path.join(outside, "above-run", "notes.txt"), "above-secret\n");
		let swapNext = false;
		const swap = () => {
			if (!swapNext) return;
			swapNext = false;
			fs.renameSync(above, `${above}-old`);
			fs.symlinkSync(outside, above, "dir");
		};
		try {
			await withSharedSkills(ROOM_ID, folder, [[inRoom, "above-run"]], true, async (run) => {
				const ran = await run(quoted(path.join(inRoom, "scripts", "run.sh")));
				assert(!ran.failed && ran.text.includes("above-run-ran"), `before the swap, run the skill's script: ${ran.text}`);
				swapNext = true;
				const read = await run(`/bin/cat ${quoted(path.join(outside, "above-run", "notes.txt"))}`);
				assert(!swapNext && fs.lstatSync(above).isSymbolicLink(), "the folder above the skill's folder was never swapped");
				assert(read.failed && !read.text.includes("above-secret"), `a command read the folder outside a link above the skill's folder leads to: ${read.text}`);
			}, swap);
		} finally {
			fs.rmSync(above, { recursive: true, force: true });
			fs.rmSync(`${above}-old`, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	await macRow("skills: in a room that can't change files, a shared-folder skill linked to a real folder outside ~/.agents and outside the room reads and runs there and never takes a write", async () => {
		const away = path.join(home, "team-skills", "away-still");
		await withSharedSkills(ROOM_ID, folder, [[away, "away-still"]], false, async (run, opened) => {
			assert(opened.get("away-still") === fs.realpathSync(away), `the room opens the skill at its real folder, got ${JSON.stringify([...opened])}`);
			const ran = await run(quoted(path.join(away, "scripts", "run.sh")));
			assert(!ran.failed && ran.text.includes("away-still-ran"), `run the skill's script: ${ran.text}`);
			const planted = await run(`echo x > ${quoted(path.join(away, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(away, "planted")), "the skill's folder took a write");
		});
	});

	await macRow("skills: a shared-folder skill whose real folder holds the room's folder: the room writes in its own folder, and not in the skill's folder outside it", async () => {
		const holder = fs.realpathSync(fs.mkdtempSync(path.join(home, "skill-holder-")));
		const inner = path.join(holder, "room-inner");
		fs.mkdirSync(inner);
		const holdRoom = "box-smoke-holding-room";
		fs.mkdirSync(persistentAgentRootPath(holdRoom), { recursive: true });
		chooseFolder(holdRoom, inner);
		await withSharedSkills(holdRoom, inner, [[holder, "hold-run"]], true, async (run, opened) => {
			assert(opened.get("hold-run") === holder, `the room opens the skill at the folder holding its own, got ${JSON.stringify([...opened])}`);
			const ran = await run(quoted(path.join(holder, "scripts", "run.sh")));
			assert(!ran.failed && ran.text.includes("hold-run-ran"), `run the skill's script around the room's folder: ${ran.text}`);
			const changed = await run(`echo kept > ${quoted(path.join(inner, "notes.txt"))}`);
			assert(!changed.failed && fs.readFileSync(path.join(inner, "notes.txt"), "utf8") === "kept\n", `the room lost its write in its own folder inside a skill's folder: ${changed.text}`);
			const planted = await run(`echo x > ${quoted(path.join(holder, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(holder, "planted")), "the skill's folder outside the room's folder took a write");
		});
	});

	await macRow("skills: in a room that can't change files, a shared-folder skill in its folder reads and runs, and takes no write", async () => {
		const inRoom = path.join(folder, "team-skills", "still-run");
		await withSharedSkills(ROOM_ID, folder, [[inRoom, "still-run"]], false, async (run, opened) => {
			assert(!opened.has("still-run"), `the server opens nothing for a skill in the room's own folder, got ${JSON.stringify([...opened])}`);
			const ran = await run(quoted(path.join(inRoom, "scripts", "run.sh")));
			assert(!ran.failed && ran.text.includes("still-run-ran"), `run the skill's script: ${ran.text}`);
			const planted = await run(`echo x > ${quoted(path.join(inRoom, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(inRoom, "planted")), "a room that can't change files wrote in a skill's folder");
		});
	});

	await macRow("skills: a shared-folder skill at the room's .agents/skills takes no write there, by the room's closed names", async () => {
		const inAgents = path.join(folder, ".agents", "skills", "named-run");
		await withSharedSkills(ROOM_ID, folder, [[inAgents, "named-run"]], true, async (run) => {
			const planted = await run(`echo x > ${quoted(path.join(inAgents, "planted"))}`);
			assert(planted.failed && !fs.existsSync(path.join(inAgents, "planted")), "a skill's folder under the room's .agents took a write");
		});
		fs.rmSync(path.join(folder, ".agents"), { recursive: true, force: true });
	});

	await macRow("skills: a skill marked to start only when picked, on in the room, reads and runs from its folder; switched off, reads nothing", async () => {
		const dir = path.join(agentSkillsDir(), "picked-tool");
		const manifest = "---\nname: picked-tool\ndescription: a test skill\ndisable-model-invocation: true\n---\n\nRun scripts/run.sh.\n";
		fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
		// portability-ok: a macRow, skipped by name on any other computer
		fs.writeFileSync(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\necho picked-tool-ran\n", { mode: 0o755 });
		const identity = crypto.randomUUID();
		writeSkillProvenance(dir, { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest), identity });
		const settingsFile = persistentRoomSkillSettingsPath(ROOM_ID);
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		const switched = (on: boolean) => fs.writeFileSync(settingsFile, `${JSON.stringify({ schemaVersion: 1, enabledSkills: on ? [{ name: "picked-tool", identity }] : [], updatedAt: "2026-11-19T10:00:00.000Z" }, null, 2)}\n`);
		const pickedBox = new RoomBox({ roomId: ROOM_ID, conversationId: () => "conversation-picked", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: roomSkillFolders(ROOM_ID).map((skill) => skill.skillDir) }), warn: () => {} });
		const run = (command: string) => call(createRoomCommandTools(folder, { box: pickedBox, outside: { questions: questions as any, setOffered: () => {} } }), "bash", { command });
		try {
			switched(true);
			const read = await run(`/bin/cat ${quoted(path.join(dir, "SKILL.md"))}`);
			assert(!read.failed && read.text.includes("name: picked-tool"), `the on skill's SKILL.md: ${read.text}`);
			const ran = await run(quoted(path.join(dir, "scripts", "run.sh")));
			assert(!ran.failed && ran.text.includes("picked-tool-ran"), `the on skill's script: ${ran.text}`);
			switched(false);
			const offRead = await run(`/bin/cat ${quoted(path.join(dir, "SKILL.md"))}`);
			assert(offRead.failed && !offRead.text.includes("name: picked-tool"), `a skill switched off was read: ${offRead.text}`);
		} finally {
			await pickedBox.endTurn();
			fs.rmSync(settingsFile, { force: true });
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	await macRow("skills: a library skill folder that is a link into the room's own folder opens as no skill's folder, and the room's commands change it as the room's own", async () => {
		const target = inRoom("linked-skill-target");
		const manifest = "---\nname: linked-into-room\ndescription: a test skill\n---\n\nRun nothing.\n";
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, "SKILL.md"), manifest);
		const identity = crypto.randomUUID();
		writeSkillProvenance(target, { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest), identity });
		const link = path.join(agentSkillsDir(), "linked-into-room");
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(target, link);
		const settingsFile = persistentRoomSkillSettingsPath(ROOM_ID);
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "linked-into-room", identity }], updatedAt: "" }));
		const skillBox = new RoomBox({ roomId: ROOM_ID, conversationId: () => "conversation-linked-skill", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: roomSkillFolders(ROOM_ID).map((skill) => skill.skillDir) }), warn: () => {} });
		const skillTools = createRoomCommandTools(folder, { box: skillBox, outside: { questions: questions as any, setOffered: () => {} } });
		const run = (command: string) => call(skillTools, "bash", { command });
		try {
			assert(roomSkillFolders(ROOM_ID).length === 0, "a linked skill folder opened as a skill's folder");
			const edited = await run("echo edited-by-the-room >> linked-skill-target/SKILL.md");
			assert(!edited.failed && fs.readFileSync(path.join(target, "SKILL.md"), "utf8").includes("edited-by-the-room"), `the room's own folder: ${edited.text}`);
			const throughLibrary = await run(`/bin/cat ${quoted(path.join(link, "SKILL.md"))}`);
			console.log(`  note: reading its SKILL.md by the library's path ${throughLibrary.failed ? "fails" : "reads"} in the box`);
		} finally {
			await skillBox.endTurn();
			fs.rmSync(link, { force: true });
			fs.rmSync(settingsFile, { force: true });
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	await macRow("a boxed command can't become an outside one by what it says", async () => {
		assert(tools.tools.map((tool) => tool.name).sort().join() === "bash,run_outside_box", "the room's tools");
		const { failed } = await bash("run_outside_box echo reached-outside");
		assert(failed && person.outsideCards.length === 0, "a boxed command asked to go outside");
	});

	// Sites. Nothing here needs the internet: a name that resolves nowhere still reaches
	// the ask, and the proxy's answer tells a refusal (403) from a yes that found no server.
	const realLookup = dns.lookup;
	/** Every name the server has looked up, for the rows that hold when it may. */
	const lookups: string[] = [];
	const lookupAs = (address: string) => {
		(dns as any).lookup = async (name: string) => {
			lookups.push(name);
			return [{ address, family: address.includes(":") ? 6 : 4 }];
		};
	};
	const SITE = "box-smoke.invalid";
	const reach = (target: string) => bash(`/usr/bin/curl -s -o /dev/null -m 10 -w 'status=%{http_code}' ${quoted(target)}; true`);
	const reset = () => {
		person.watcher = "computer";
		person.answeredBy = "computer";
		person.siteAnswer = "decline";
	};
	if (onMac) lookupAs("93.184.216.34");

	await macRow("site: the card shows while the command waits, and Decline refuses", async () => {
		await nextTurn();
		let doneWhenAsked: boolean | null = null;
		person.onSiteCard = () => { doneWhenAsked = fs.existsSync(inRoom("site-done")); };
		try {
			const { text } = await bash(`/usr/bin/curl -s -o /dev/null -m 10 -w 'status=%{http_code}' http://${SITE}/; echo; echo done > site-done`);
			assert(person.siteCards.length === 1 && person.siteCards[0].host === SITE && person.siteCards[0].port === 80, `the card: ${JSON.stringify(person.siteCards)}`);
			assert(doneWhenAsked === false, "the card came after the command ended");
			assert(text.includes("status=403"), `Decline: ${text}`);
		} finally {
			person.onSiteCard = undefined;
			fs.rmSync(inRoom("site-done"), { force: true });
		}
	});

	await macRow("site: a no, by Not now or by a message sent while the card waits, refuses that site, its www name and its other web port in the same command with no new card; the next command asks again", async () => {
		const threeWays = `for target in http://${SITE}/ http://www.${SITE}/ https://${SITE}/; do /usr/bin/curl -s -o /dev/null -m 10 "$target"; done; true`;
		for (const message of [false, true]) {
			await nextTurn();
			person.siteMessage = message;
			try {
				const { text } = await bash(threeWays);
				assert(person.siteCards.length === 1 && text.split("the person declined this site").length === 2 && !text.includes("the person stopped this"), `${message ? "a message" : "Not now"}: ${JSON.stringify(person.siteCards)} ${text}`);
				const next = await reach(`http://www.${SITE}/`);
				assert(seen().siteCards === 2 && next.text.includes("the person declined this site"), `the next command didn't ask again: ${next.text}`);
			} finally {
				person.siteMessage = false;
			}
		}
	});

	await macRow("site: Allow this time lets this run through and saves nothing", async () => {
		await nextTurn();
		person.siteAnswer = "once";
		const first = await reach(`http://${SITE}/`);
		assert(!first.text.includes("status=403"), `Allow this time: ${first.text}`);
		await reach(`http://${SITE}/again`);
		assert(person.siteCards.length === 1, "this run asked twice");
		assert(readAlsoAllowed(ROOM_ID).sites.length === 0, "Allow this time was saved");
		await nextTurn();
		person.siteAnswer = "decline";
		const later = await reach(`http://${SITE}/`);
		assert(person.siteCards.length === 1 && later.text.includes("status=403"), `the next run: ${later.text}`);
	});

	await macRow("site: Allow for this room saves it with its port, and another port asks again", async () => {
		await nextTurn();
		person.siteAnswer = "room";
		await reach(`http://${SITE}/`);
		assert(readAlsoAllowed(ROOM_ID).sites.some((site) => site.host === SITE && site.port === 80), "not on the list");
		await nextTurn();
		person.siteAnswer = "decline";
		const again = await reach(`http://${SITE}/`);
		assert(person.siteCards.length === 0 && !again.text.includes("status=403"), `the saved site: ${again.text}`);
		const otherPort = await reach(`http://${SITE}:8080/`);
		assert(seen().siteCards === 1 && otherPort.text.includes("status=403"), `another port: ${otherPort.text}`);
	});

	await macRow("site: with nobody there it's refused, with no card, and nothing waits", async () => {
		await nextTurn();
		person.watcher = "none";
		try {
			const { text } = await reach(`http://${SITE}:81/`);
			assert(person.siteCards.length === 0 && text.includes("status=403") && text.includes("ask again from the computer"), `nobody there: ${text}`);
		} finally {
			reset();
		}
	});

	await macRow("site: on a phone Allow lasts for this run and saves nothing", async () => {
		await nextTurn();
		person.watcher = "phone";
		person.answeredBy = "phone";
		person.siteAnswer = "room";
		try {
			const { text } = await reach(`http://${SITE}:82/`);
			assert(person.siteCards.length === 1 && person.siteCards[0].lasting === false, `the card: ${JSON.stringify(person.siteCards)}`);
			assert(!text.includes("status=403"), `a phone's yes: ${text}`);
			assert(!readAlsoAllowed(ROOM_ID).sites.some((site) => site.port === 82), "a phone's yes was saved");
		} finally {
			reset();
		}
	});

	// The room's web reader in the same answer: what it decides for a page, before any fetch. Undefined lets the page open.
	const SAME = "same-site.invalid";
	const pageDecision = (url: string) => {
		const handlers: Record<string, (event: any, ctx: any) => any> = {};
		createRoomWebReaderExtension({ roomId: ROOM_ID, questions: questions as any, answer: () => answerSites })({ on: (event: string, handler: any) => { handlers[event] = handler; } } as any);
		return handlers.tool_call({ toolName: "fetch_url", input: { url } }, { sessionManager: { getBranch: () => [] } }) as Promise<{ block: boolean; reason: string } | undefined>;
	};
	const refusedHere = (text: string) => text.includes("The room's protection refused");

	await macRow("site: Allow this time on a command's site reaches the room's pages on that site for this answer, and its commands the www name and the other web port; another port or sub-name asks; the next answer asks again", async () => {
		await nextTurn();
		person.siteAnswer = "once";
		const first = await reach(`http://${SAME}/`);
		assert(seen().siteCards === 1 && !refusedHere(first.text), `Allow this time: ${first.text}`);
		for (const address of [`https://${SAME}/design`, `http://www.${SAME}/brand`]) assert((await pageDecision(address)) === undefined && seen().siteCards === 1, `${address} opens with no question`);
		for (const target of [`http://www.${SAME}/`, `https://${SAME}/`, `https://www.${SAME}/`]) {
			const reached = await reach(target);
			assert(seen().siteCards === 1 && !refusedHere(reached.text), `${target} goes through with no question: ${reached.text}`);
		}
		person.siteAnswer = "decline";
		for (const target of [`http://${SAME}:8080/`, `http://api.${SAME}/`]) {
			const asked = await reach(target);
			assert(asked.text.includes("the person declined this site"), `${target} still asks: ${asked.text}`);
		}
		assert(seen().siteCards === 3, `each of the two asked: ${seen().siteCards}`);
		await nextTurn();
		const later = await pageDecision(`https://${SAME}/design`);
		assert(later?.block === true && seen().siteCards === 1, `the next answer asks again: ${JSON.stringify(later)}`);
	});

	await macRow("site: a phone's Allow on a command's site reaches the room's pages on that site for this answer, after the move to the computer too, and stores nothing", async () => {
		await nextTurn();
		person.watcher = "phone";
		person.answeredBy = "phone";
		person.siteAnswer = "room";
		try {
			const first = await reach(`http://phone.${SAME}/`);
			assert(seen().siteCards === 1 && !refusedHere(first.text), `a phone's yes: ${first.text}`);
			reset();
			assert((await pageDecision(`https://www.phone.${SAME}/page`)) === undefined && seen().siteCards === 1, "the page opens at the computer with no question");
			assert(!readAlsoAllowed(ROOM_ID).sites.some((site) => site.host.endsWith(SAME)), "a phone's yes was stored");
		} finally {
			reset();
		}
	});

	await macRow("site: a page's Allow this time never lets a command through", async () => {
		await nextTurn();
		person.siteAnswer = "once";
		assert((await pageDecision(`https://page.${SAME}/a`)) === undefined && seen().siteCards === 1, "the page's yes opens it");
		person.siteAnswer = "decline";
		const command = await reach(`https://page.${SAME}/`);
		assert(seen().siteCards === 2 && command.text.includes("the person declined this site"), `a command to that site still asks: ${command.text}`);
	});

	await macRow("site: a site on the room's list lets commands reach its www name and the other web port; another port or sub-name asks", async () => {
		await nextTurn();
		addAlsoAllowedSite(ROOM_ID, `listed.${SAME}`, 443);
		person.siteAnswer = "decline";
		for (const target of [`http://listed.${SAME}/`, `http://www.listed.${SAME}/`, `https://www.listed.${SAME}/`]) {
			const reached = await reach(target);
			assert(seen().siteCards === 0 && !refusedHere(reached.text), `${target} goes through with no question: ${reached.text}`);
		}
		for (const target of [`http://listed.${SAME}:8080/`, `http://api.listed.${SAME}/`]) assert((await reach(target)).text.includes("the person declined this site"), `${target} still asks`);
		assert(seen().siteCards === 2, `each of the two asked: ${seen().siteCards}`);
	});

	await macRow("site: a turn's site cards are capped, and one more is refused with no card", async () => {
		await nextTurn();
		person.siteAnswer = "decline";
		person.siteCards.length = 0;
		try {
			for (let port = 9001; port <= 9008; port += 1) await reach(`http://${SITE}:${port}/`);
			assert(person.siteCards.length === 8, `eight cards: ${person.siteCards.length}`);
			const over = await reach(`http://${SITE}:9009/`);
			assert(person.siteCards.length === 8 && over.text.includes("status=403"), `a ninth distinct site: ${person.siteCards.length} ${over.text}`);
		} finally {
			reset();
		}
	});

	const listener = http.createServer((_request, response) => response.end("local-service"));
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const localPort = (listener.address() as AddressInfo).port;
	for (const target of ["127.0.0.1", "localhost", "0.0.0.0", "[::ffff:127.0.0.1]", "[::1]", "169.254.169.254", "10.0.0.1", "8.8.8.8", "app.localhost"]) {
		await macRow(`site: ${target} is refused with no card`, async () => {
			await nextTurn();
			person.siteAnswer = "room";
			try {
				// Past the library's NO_PROXY, as a program that ignores it would go.
				const { text } = await bash(`/usr/bin/curl -s -m 5 --noproxy '' http://${target}:${localPort}/; echo; echo end`);
				assert(person.siteCards.length === 0, `a card for ${target}`);
				assert(!text.includes("local-service"), `reached ${target}: ${text}`);
			} finally {
				reset();
			}
		});
	}

	await macRow("site: a local port is closed with the proxy skipped too", async () => {
		const { text } = await bash(`/usr/bin/curl -s -m 5 --noproxy '*' http://127.0.0.1:${localPort}/; echo; echo end`);
		assert(!text.includes("local-service"), `reached the local port: ${text}`);
	});

	await macRow("site: no name is looked up before a yes: not while the card waits, not on Decline, not with nobody there", async () => {
		await nextTurn();
		lookups.length = 0;
		let lookedUpWhileWaiting: number | null = null;
		person.onSiteCard = () => { lookedUpWhileWaiting = lookups.length; };
		try {
			const declined = await reach("http://secret-data.leak.invalid/");
			assert(person.siteCards.length === 1 && lookedUpWhileWaiting === 0 && declined.text.includes("status=403"), `the card: ${JSON.stringify(person.siteCards)}, ${lookedUpWhileWaiting}, ${declined.text}`);
		} finally {
			person.onSiteCard = undefined;
		}
		person.watcher = "none";
		const unwatched = await reach("http://more-data.leak.invalid/");
		assert(unwatched.text.includes("status=403"), `nobody there: ${unwatched.text}`);
		assert(lookups.length === 0, `looked up with no yes: ${lookups.join()}`);
		reset();
	});

	await macRow("site: a yes on the card and the room's list each look the name up, once a person has allowed it", async () => {
		await nextTurn();
		lookups.length = 0;
		person.siteAnswer = "room";
		await reach("http://allowed.invalid/");
		assert(lookups.join() === "allowed.invalid", `after a yes: ${lookups.join()}`);
		await nextTurn();
		await reach("http://allowed.invalid/");
		assert(person.siteCards.length === 0 && lookups.join() === "allowed.invalid,allowed.invalid", `from the list: ${lookups.join()}`);
		reset();
	});

	await macRow("site: a name that doesn't resolve gets its card, and after a yes the model is told so", async () => {
		await nextTurn();
		(dns as any).lookup = async () => { throw new Error("ENOTFOUND"); };
		try {
			const declined = await reach("http://nowhere.invalid/");
			assert(person.siteCards.length === 1 && !declined.text.includes("did not resolve"), `no yes: ${declined.text}`);
			person.siteCards.length = 0;
			person.siteAnswer = "once";
			const allowed = await reach("http://nowhere.invalid:81/");
			assert(person.siteCards.length === 1 && allowed.text.includes("status=403") && allowed.text.includes("nowhere.invalid did not resolve"), `after a yes: ${allowed.text}`);
		} finally {
			lookupAs("93.184.216.34");
			reset();
		}
	});

	await macRow("site: a name that resolves to a local address is refused after a yes, and a private one goes through", async () => {
		await nextTurn();
		person.siteAnswer = "once";
		lookupAs("127.0.0.1");
		const local = await bash(`/usr/bin/curl -s -m 5 -w 'status=%{http_code}' http://sneaky.invalid:${localPort}/; echo; echo end`);
		assert(person.siteCards.length === 1 && !local.text.includes("local-service") && local.text.includes("status=403") && local.text.includes("local addresses can't be reached"), `a name that means this computer: ${local.text}`);
		lookupAs("10.20.30.40");
		const wiki = await reach("http://wiki.invalid/");
		assert(seen().siteCards === 2 && !wiki.text.includes("status=403"), `a company wiki: ${wiki.text}`);
		lookupAs("93.184.216.34");
		reset();
	});

	await macRow("site: a local address is refused at the dial too, when the name changes after the check", async () => {
		// Every Mac's hosts file has this name at the broadcast address. The check above is told it's public, so only the library's guard, on the address it would connect to, can refuse: 403, where a failed dial is 502.
		assert(fs.readFileSync("/etc/hosts", "utf8").includes("broadcasthost"), "this Mac's hosts file has no broadcasthost");
		await nextTurn();
		person.siteAnswer = "once";
		const dialled = await reach("http://broadcasthost:9/");
		assert(dialled.text.includes("status=403"), `the library's guard: ${dialled.text}`);
		const neighbour = await reach("http://nothing-here.invalid:9/");
		assert(neighbour.text.includes("status=502"), `a dial that found nothing: ${neighbour.text}`);
		reset();
	});

	// Past curl, which folds these itself: a program can hand the proxy any spelling.
	const askProxy = (host: string) => bash(`/usr/bin/perl -MIO::Socket::INET -MMIME::Base64 -e '
		my ($login, $port) = $ENV{HTTP_PROXY} =~ m{//(.*)\\@[^:]+:(\\d+)};
		my $proxy = IO::Socket::INET->new("127.0.0.1:$port") or die "no proxy";
		print $proxy "CONNECT $ARGV[0]:80 HTTP/1.1\\r\\nHost: $ARGV[0]:80\\r\\nProxy-Authorization: Basic " . encode_base64($login, "") . "\\r\\n\\r\\n";
		print "answer=", scalar <$proxy>;
	' ${quoted(host)}`);
	await macRow("site: every spelling of a local address is refused from its text, with no card and no lookup", async () => {
		await nextTurn();
		lookups.length = 0;
		person.siteAnswer = "once";
		for (const spelling of ["127.1", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.0.0.1.", "localhost.", "localhost..", "127.0.0.1..", "LOCALHOST", "App.Localhost."]) {
			const { text } = await askProxy(spelling);
			assert(text.includes("answer=HTTP/1.1 403"), `the proxy's answer for ${spelling}: ${text}`);
			assert(person.siteCards.length === 0 && lookups.length === 0, `a card or a lookup for ${spelling}: ${JSON.stringify(person.siteCards)} ${lookups.join()}`);
		}
		reset();
	});

	await macRow("site: an ordinary name through the same door gets its card", async () => {
		await nextTurn();
		const { text } = await askProxy("Example.invalid");
		assert(text.includes("answer=HTTP/1.1 403") && person.siteCards.length === 1, `the neighbour: ${text} ${JSON.stringify(person.siteCards)}`);
	});

	// A job of its own group outlives the answer, the stated limit: the network it had still closes.
	await macRow("site: a job that leaves its command's group has no network after the answer and raises no card", async () => {
		await nextTurn();
		person.siteAnswer = "once";
		await bash(`set -m; (while [ ! -e go ]; do /bin/sleep 0.05; done; /usr/bin/curl -s -o /dev/null -m 5 -w '%{http_code}' http://late.invalid/ > left-behind.txt; echo finished > left-behind-done) >/dev/null 2>&1 &`);
		await nextTurn();
		fs.writeFileSync(inRoom("go"), "");
		await waitFor(() => fs.existsSync(inRoom("left-behind-done")), "the job left behind to finish");
		assert(person.siteCards.length === 0, "a job left behind raised a card");
		assert(fs.readFileSync(inRoom("left-behind.txt"), "utf8").trim() === "000", `the proxy still answered: ${fs.readFileSync(inRoom("left-behind.txt"), "utf8")}`);
		reset();
	});

	if (onMac) (dns as any).lookup = realLookup;
	listener.close();


	await macRow("grants: never home, the root, a closed place, ~/Library or a parent of anything closed", () => {
		const grantable = (place: string) => {
			fs.mkdirSync(place, { recursive: true });
			return folderGrantable(place, "read", [folder], folder);
		};
		assert(!grantable(home), "home");
		assert(!grantable("/"), "the root");
		assert(!folderGrantable(path.join(webServerRoot, "src"), "read", [], ""), "the app's own files");
		assert(!grantable(path.join(home, ".ssh", "keys")), "a closed place");
		assert(!grantable(path.join(home, "Library", "Caches", "x")), "~/Library");
		assert(!grantable(path.join(home, ".config")), "a parent of .config/gh");
		assert(grantable(path.join(home, "Projects")), "an ordinary folder");
	});

	await macRow("grants: the computer's shared temp and caches are never kept, and a folder in home still is", async () => {
		const userCaches = spawnSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8" }).stdout.trim();
		const places = [fs.mkdtempSync("/private/tmp/box-review-"), fs.mkdtempSync(path.join(sharedTemp, "box-shared-grant-")), fs.mkdtempSync(path.join(userCaches, "box-shared-grant-"))].map((place) => fs.realpathSync(place));
		const neighbour = outsideRoom("grant-beside-shared");
		fs.mkdirSync(neighbour, { recursive: true });
		try {
			for (const place of places) {
				for (const access of ["read", "write"] as const) assert(!folderGrantable(place, access, [], folder) && soundFolders([{ path: place, access }], folder).length === 0, `kept: ${place} (${access})`);
			}
			// A grant made before this rule: the next command drops it, and the write stays refused.
			await nextTurn();
			addAlsoAllowedFolder(ROOM_ID, places[0], "write");
			const write = await bash(`echo x > ${quoted(path.join(places[0], "probe.txt"))}`);
			assert(write.failed && !fs.existsSync(path.join(places[0], "probe.txt")) && !readAlsoAllowed(ROOM_ID).folders.some((entry) => entry.path === places[0]), `an old grant: ${write.text}`);
			assert(folderGrantable(neighbour, "write", [], folder), "a folder in home");
		} finally {
			saveAlsoAllowedFolders(ROOM_ID, []);
			for (const place of [...places, neighbour]) fs.rmSync(place, { recursive: true, force: true });
		}
	});

	await row("outside: its description keeps it off a place the room keeps closed on purpose", () => {
		const way = createRoomCommandTools(folder, { box: new RoomBox({ roomId: ROOM_ID, conversationId: () => "c", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {} }), outside: { questions: questions as any, setOffered: () => {} } }).tools.find((tool) => tool.name === RUN_OUTSIDE_BOX_TOOL_NAME);
		assert(way?.description.includes("closed on purpose") && way.description.includes("unless the person asks"), `the description: ${way?.description}`);
	});

	// The way out.
	const outside = (command: string, reason = "smoke") => call(tools, "run_outside_box", { command, reason });
	const outsideMarker = outsideRoom("outside-ran");

	await macRow("outside: Decline runs nothing and isn't recorded as run", async () => {
		await nextTurn();
		tools.personSpoke();
		person.outsideCards.length = 0;
		person.outsideAnswer = false;
		const { failed, text, id } = await outside(`echo x > ${quoted(outsideMarker)}`);
		assert(failed && text.includes("declined"), `Decline: ${text}`);
		assert(!fs.existsSync(outsideMarker) && !tools.started(id), "a declined command ran or was recorded");
		assert(person.outsideCards.length === 1 && person.outsideCards[0].command === `echo x > ${quoted(outsideMarker)}`, "the card's command");
	});

	// What the room's records say, read by the real extension from the real tool's call.
	const listedAsRun = async (from: RoomCommandTools, id: string) => {
		let onResult: ((event: unknown) => Promise<{ details: unknown } | undefined>) | undefined;
		await createPersistentRoomBashApprovalExtension({} as any, from.started)({ on: (event: string, handler: any) => { if (event === "tool_result") onResult = handler; } } as any);
		return commandRan((await onResult?.({ toolName: "run_outside_box", toolCallId: id, content: [], details: {} }))?.details);
	};

	await macRow("outside: only a command that started is listed as run, a failing one included", async () => {
		await nextTurn();
		tools.personSpoke();
		person.outsideAnswer = false;
		const declined = await outside("echo declined");
		assert(declined.failed && !(await listedAsRun(tools, declined.id)), "a declined command is listed as run");
		person.outsideAnswer = true;
		const failing = await outside("exit 3");
		assert(failing.failed && (await listedAsRun(tools, failing.id)), `a command that ran and failed: ${failing.text}`);
		const gone = createRoomCommandTools(outsideRoom("no-such-folder"), { box, outside: { questions: questions as any, setOffered: () => {} } });
		const nowhere = await call(gone, "run_outside_box", { command: "echo nowhere", reason: "smoke" });
		assert(nowhere.failed && !(await listedAsRun(gone, nowhere.id)), `a yes that couldn't start: ${nowhere.text}`);
	});

	await macRow("outside: a yes runs that text once, in the person's environment with the token and keys out", async () => {
		tools.personSpoke();
		person.outsideAnswer = true;
		process.env.EXXPERTS_AUTH_TOKEN = "smoke-token";
		process.env.ANTHROPIC_API_KEY = "smoke-key";
		process.env.SMOKE_OWN_VARIABLE = "own-value";
		try {
			const { text, failed, id } = await outside(`echo x > ${quoted(outsideMarker)}; /usr/bin/env`);
			assert(!failed && fs.existsSync(outsideMarker), `the outside run: ${text}`);
			assert(text.includes("own-value") && !text.includes("smoke-token") && !text.includes("smoke-key"), `its environment: ${text}`);
			assert(tools.started(id), "not recorded as run");
			const again = await outside("exit 3");
			assert(again.failed && tools.started(again.id), "a command that started and failed still ran");
		} finally {
			person.outsideAnswer = false;
			delete process.env.EXXPERTS_AUTH_TOKEN;
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.SMOKE_OWN_VARIABLE;
		}
	});

	await macRow("outside: the card gets the command and the model's reason, and nothing more, whatever the command runs", async () => {
		tools.personSpoke();
		person.outsideCards.length = 0;
		await outside("./build.sh", "It builds the app.");
		await outside("ls -la");
		assert(JSON.stringify(person.outsideCards) === JSON.stringify([{ command: "./build.sh", reason: "It builds the app." }, { command: "ls -la", reason: "smoke" }]), JSON.stringify(person.outsideCards));
	});

	await macRow("outside: refused on a phone and with nobody there, with no card", async () => {
		tools.personSpoke();
		person.outsideCards.length = 0;
		person.outsideAnswer = true;
		for (const watcher of ["phone", "none"] as const) {
			person.watcher = watcher;
			const { failed, id } = await outside(`echo x > ${quoted(outsideRoom(`outside-${watcher}`))}`);
			assert(failed && !fs.existsSync(outsideRoom(`outside-${watcher}`)) && !tools.started(id), `ran with ${watcher}`);
		}
		reset();
		person.outsideAnswer = false;
		assert(person.outsideCards.length === 0, "a card with nobody at the computer");
	});

	await macRow("outside: too long a command is refused before any card", async () => {
		tools.personSpoke();
		person.outsideCards.length = 0;
		const { failed, text } = await outside(`echo ${"x".repeat(OUTSIDE_COMMAND_MAX_CHARS)}`);
		assert(failed && text.includes("too long") && person.outsideCards.length === 0, text);
	});

	await macRow("outside: three Declines in a row stop the offer until the person writes", async () => {
		tools.personSpoke();
		person.outsideCards.length = 0;
		person.offered = true;
		for (let index = 0; index < 3; index += 1) await outside("ls");
		assert(seen().offered === false && person.outsideCards.length === 3, `after three: ${person.offered}, ${person.outsideCards.length}`);
		const refused = await outside("ls");
		assert(refused.failed && refused.text.includes("do not ask again") && person.outsideCards.length === 3, refused.text);
		tools.personSpoke();
		assert(person.offered === true, "the person's message didn't bring it back");
		await outside("ls");
		assert(seen().outsideCards === 4, "no card after the person wrote");
	});

	await macRow("outside: with the room's commands off it shows no card, and a Turn off while its card waits runs nothing", async () => {
		let off: string | null = "Commands are off in this room, so nothing ran.";
		const { box } = newBox();
		const gated = createRoomCommandTools(folder, { box, outside: { questions: questions as any, setOffered: () => {} } }, () => off);
		gated.personSpoke();
		person.outsideCards.length = 0;
		person.outsideAnswer = true;
		const marker = outsideRoom("outside-after-off");
		try {
			const before = await call(gated, "run_outside_box", { command: `echo x > ${quoted(marker)}`, reason: "smoke" });
			assert(before.failed && before.text === off && person.outsideCards.length === 0 && !gated.started(before.id), `off before the card: ${before.text}`);
			// The allowed neighbour: commands on, the yes runs it.
			off = null;
			const on = await call(gated, "run_outside_box", { command: `echo x > ${quoted(marker)}`, reason: "smoke" });
			assert(!on.failed && fs.existsSync(marker) && gated.started(on.id), `on: ${on.text}`);
			fs.rmSync(marker, { force: true });
			// Turn off pressed while the card waits: the yes that follows runs nothing.
			const asked = questions.askOutside;
			questions.askOutside = async (card) => {
				const answer = await asked(card);
				off = "Commands are off in this room, so nothing ran.";
				return answer;
			};
			try {
				const during = await call(gated, "run_outside_box", { command: `echo x > ${quoted(marker)}`, reason: "smoke" });
				assert(during.failed && during.text === off && !fs.existsSync(marker) && !gated.started(during.id), `off while the card waited: ${during.text}`);
			} finally {
				questions.askOutside = asked;
			}
		} finally {
			person.outsideAnswer = false;
			fs.rmSync(marker, { force: true });
		}
	});

	await macRow("outside: a box that failed takes the way out with it", async () => {
		const started = BoxProcess.start;
		BoxProcess.start = (async () => { throw new Error("no worker"); }) as typeof BoxProcess.start;
		const broken = newBox();
		person.outsideCards.length = 0;
		try {
			const { failed, text } = await call(broken.tools, "run_outside_box", { command: "ls", reason: "smoke" });
			assert(failed && text === BOX_FAULT_SENTENCE && person.outsideCards.length === 0, text);
		} finally {
			BoxProcess.start = started;
		}
	});

	await row("outside: hidden characters are written out, and line ends stay", () => {
		const hidden = "ls‮ -la​\n\trm x\u{e0041}";
		const shown = commandAsShown(hidden);
		for (const mark of ["U+202E", "U+200B", "U+E0041"]) assert(shown.includes(mark), `${mark}: ${shown}`);
		assert(shown.includes("\n\t"), "line ends and tabs kept");
		assert(commandAsShown("plain ls -la") === "plain ls -la", "plain text changed");
	});

	// Its box serves only its file tools: room-box-files-smoke.ts runs one.
	await row("a scheduled run has no commands", () => {
		const scheduled = getPersistentRoomToolPolicy(ROOM_ID, { workspaceToolsEnabled: true, workspaceAccessMode: "localFiles", bashEnabled: false, bashRuntimeAllowed: false });
		assert(!scheduled.allowedToolNames.includes("bash"), "commands in a scheduled run");
		const source = fs.readFileSync(path.join(webServerRoot, "src", "persistent-room-background-execution.ts"), "utf8");
		assert(source.includes("bashEnabled: false, bashRuntimeAllowed: false") && !source.includes("createRoomCommandTools"), "a scheduled run builds commands");
	});

	await row("outside: only a live turn at the computer with a box is offered the tool", () => {
		const input = { workspaceToolsEnabled: true, workspaceAccessMode: "localFiles", bashEnabled: true, bashRuntimeAllowed: true } as const;
		assert(getPersistentRoomToolPolicy(ROOM_ID, { ...input, outsideToolOffered: true }).allowedToolNames.includes("run_outside_box"), "a live turn at the computer");
		assert(!getPersistentRoomToolPolicy(ROOM_ID, input).allowedToolNames.includes("run_outside_box"), "a helper or a scheduled run");
		assert(!getPersistentRoomToolPolicy(ROOM_ID, { ...input, bashEnabled: false, outsideToolOffered: true }).allowedToolNames.includes("run_outside_box"), "a room with no commands");
	});

	// Long output.
	const spillPath = (text: string) => /\S*\/temp-[0-9a-f]+\/[0-9a-f]{32}\.log/.exec(text)?.[0];

	const alsoAllowedFile = path.join(persistentAgentRootPath(ROOM_ID), "runtime", "also-allowed.json");

	await macRow("site: why a site was refused reaches the command's result, and an allowed one adds nothing", async () => {
		await nextTurn();
		reset();
		lookupAs("93.184.216.34");
		const localName = await reach("http://localhost:1/");
		assert(localName.text.includes("local addresses can't be reached") && localName.text.includes(CLOSED_ON_PURPOSE), `a local name: ${localName.text}`);
		const localRaw = await reach("http://127.0.0.1:1/");
		assert(localRaw.text.includes("local addresses can't be reached") && localRaw.text.includes(CLOSED_ON_PURPOSE), `a local address: ${localRaw.text}`);
		const raw = await reach("http://8.8.8.8:1/");
		assert(raw.text.includes("raw address") && !raw.text.includes(CLOSED_ON_PURPOSE), `a raw address a name can reach: ${raw.text}`);
		person.siteAnswer = "decline";
		const declined = await reach("http://declined.invalid/");
		assert(declined.text.includes("the person declined this site") && !declined.text.includes(CLOSED_ON_PURPOSE), `a Decline: ${declined.text}`);
		person.watcher = "none";
		assert((await reach("http://nobody.invalid/")).text.includes("nobody is here"), "nobody there");
		reset();
		person.siteAnswer = "once";
		const allowed = await reach(`http://${SITE}/`);
		assert(!allowed.text.includes("refused") && !allowed.text.includes("declined"), `an allowed site: ${allowed.text}`);
		reset();
	});

	await macRow("site: a name resolving to this computer's own address in the mapped spelling is refused after a yes", async () => {
		const own = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
		if (!own) {
			console.log("  skip the mapped spelling (no network interface)");
			return;
		}
		await nextTurn();
		const [a, b, c, d] = own.split(".").map(Number);
		const hex = (high: number, low: number) => ((high << 8) | low).toString(16);
		person.siteAnswer = "once";
		for (const spelling of [`::ffff:${own}`, `::ffff:${hex(a, b)}:${hex(c, d)}`]) {
			lookupAs(spelling);
			const { text } = await reach("http://mapped.invalid/");
			assert(text.includes("local addresses can't be reached"), `${spelling}: ${text}`);
		}
		lookupAs("93.184.216.34");
		reset();
	});

	// A room on Auto. Its server looks no name up: the library resolves each one once, refuses what
	// it may not reach on that address and dials what it checked. A name for a private-network
	// address comes from this Mac's own multicast names (dns-sd), so nothing here needs the internet;
	// a name that resolves nowhere, refused nowhere, is dialled and finds nothing (502, not 403).
	/** A `.local` name this Mac answers with `address` while the registration lives. */
	async function localName(name: string, address: string): Promise<{ host: string; end: () => void }> {
		const host = `${name}-${process.pid}.local`;
		const registration = spawn("/usr/bin/dns-sd", ["-P", `${name}-${process.pid}`, "_exxsmoke._tcp", "local", "9", host, address], { stdio: "ignore" });
		const end = () => {
			registration.kill();
			resolvedNow.delete(host);
		};
		resolvedNow.set(host, "");
		try {
			await waitFor(() => resolvedNow.get(host) === address, `${host} to resolve to ${address}`);
		} catch (error) {
			end();
			throw error;
		}
		return { host, end };
	}
	/** The real resolver's answers, polled: what the library will get. */
	const resolvedNow = new Map<string, string>();
	const watchName = setInterval(() => {
		for (const host of resolvedNow.keys()) void realLookup(host).then((found: any) => resolvedNow.set(host, found.address), () => {});
	}, 100);
	const onFree = async (run: () => Promise<void>) => {
		boxFree = true;
		await nextTurn();
		lookups.length = 0;
		try {
			await run();
		} finally {
			boxFree = false;
			await nextTurn();
			reset();
		}
	};

	// A smoke reaches no real website: a name that resolves nowhere shows the request was let out, its 502 coming from the library's own lookup after it allowed the dial (Semi would raise a card, a refusal is a 403).
	await macRow("Auto: a site raises no card and the request leaves through the library's own lookup, with no lookup of the server's, also with nobody there", () => onFree(async () => {
		const reached = await reach("http://nothing-here.invalid/");
		assert(reached.text.includes("status=502") && person.siteCards.length === 0, `allowed and dialled: ${reached.text}`);
		person.watcher = "none";
		const unwatched = await reach("http://nothing-else.invalid:81/");
		assert(unwatched.text.includes("status=502") && !unwatched.text.includes("nobody is here") && person.siteCards.length === 0, `with nobody there: ${unwatched.text}`);
		assert(lookups.length === 0, `the server looked a name up: ${lookups.join()}`);
	}));

	await macRow("Auto: a raw address, localhost and a local address are refused from their text as before, with their lines", () => onFree(async () => {
		const localhost = await reach("http://localhost:1/");
		assert(localhost.text.includes("status=403") && localhost.text.includes("local addresses can't be reached"), `localhost: ${localhost.text}`);
		const localRaw = await reach("http://127.0.0.1:1/");
		assert(localRaw.text.includes("status=403") && localRaw.text.includes("local addresses can't be reached"), `a local address: ${localRaw.text}`);
		const raw = await reach("http://8.8.8.8:1/");
		assert(raw.text.includes("status=403") && raw.text.includes("raw address"), `a raw address: ${raw.text}`);
		assert(person.siteCards.length === 0 && lookups.length === 0, "a card or a lookup");
	}));

	await macRow("Auto: a name that leads to the broadcast address is refused at the dial with the local line", () => onFree(async () => {
		assert(fs.readFileSync("/etc/hosts", "utf8").includes("broadcasthost"), "this Mac's hosts file has no broadcasthost");
		const dialled = await reach("http://broadcasthost:9/");
		assert(dialled.text.includes("status=403") && dialled.text.includes("local addresses can't be reached") && !dialled.text.includes(FREE_PRIVATE_REFUSAL), `broadcasthost: ${dialled.text}`);
	}));

	await macRow("Auto: a name that leads to a private-network address is refused at the dial with nobody asked, also on the room's list and with the server's own lookup saying public; the model reads why; Semi asks for it and reaches it after a yes", async () => {
		const name = await localName("free-private", "192.168.77.7");
		try {
			await onFree(async () => {
				lookupAs("93.184.216.34");
				const refused = await reach(`http://${name.host}:9/`);
				assert(refused.text.includes("status=403") && refused.text.includes(FREE_PRIVATE_REFUSAL) && person.siteCards.length === 0, `a private name in Auto: ${refused.text}`);
				addAlsoAllowedSite(ROOM_ID, name.host, 9);
				const listed = await reach(`http://${name.host}:9/again`);
				assert(listed.text.includes("status=403") && listed.text.includes(FREE_PRIVATE_REFUSAL) && person.siteCards.length === 0, `on the room's list: ${listed.text}`);
				assert(lookups.length === 0, `the server looked a name up: ${lookups.join()}`);
			});
			// Semi, the same name: off the list, the person is asked; after a yes the dial goes out (502: nothing listens there).
			removeAlsoAllowedEntry(ROOM_ID, { host: name.host, port: 9 });
			await nextTurn();
			lookupAs("192.168.77.7");
			person.siteAnswer = "once";
			const auto = await reach(`http://${name.host}:9/`);
			assert(person.siteCards.length === 1 && !auto.text.includes("status=403") && !auto.text.includes(FREE_PRIVATE_REFUSAL), `Semi after a yes: ${auto.text}`);
		} finally {
			name.end();
			lookupAs("93.184.216.34");
			reset();
		}
	});

	await macRow("Auto holds for the box it started in: an answer that started on Auto stays on Auto until its turn ends, and the next turn reads the mode again", async () => {
		boxFree = true;
		await nextTurn();
		try {
			// The box starts with the turn's first command, and reads the mode then.
			const started = await reach("http://started-free.invalid/");
			assert(started.text.includes("status=502") && person.siteCards.length === 0, `the box started on Auto: ${started.text}`);
			boxFree = false;
			const still = await reach("http://still-free.invalid/");
			assert(still.text.includes("status=502") && person.siteCards.length === 0, `the same turn: ${still.text}`);
			await nextTurn();
			const asks = await reach("http://asks-again.invalid/");
			assert(seen().siteCards === 1 && asks.text.includes("status=403"), `the next turn: ${asks.text}`);
		} finally {
			boxFree = false;
			await nextTurn();
			reset();
		}
	});
	clearInterval(watchName);

	await macRow("site: a card left open when the turn ends closes, and a late answer saves nothing", async () => {
		await nextTurn();
		reset();
		let answerLate: (answer: { choice: "room"; answeredBy: BoxWatcher }) => void = () => {};
		person.heldSite = new Promise((resolve) => { answerLate = resolve; });
		const closedBefore = person.siteCardsClosed;
		const asking = bash("/usr/bin/curl -s -o /dev/null -m 2 http://late.invalid/; true");
		await waitFor(() => person.siteCards.length === 1, "the card");
		await asking;
		await box.endTurn();
		answerLate({ choice: "room", answeredBy: "computer" });
		person.heldSite = undefined;
		await waitFor(() => person.siteCardsClosed > closedBefore, "the turn's end closes the card");
		await new Promise((resolve) => setImmediate(resolve));
		assert(!readAlsoAllowed(ROOM_ID).sites.some((site) => site.host === "late.invalid"), "a late yes changed the room's list");
	});

	await row("site: closing a turn's site cards ends those and leaves other questions open", async () => {
		const frames: any[] = [];
		const context = createWebUiContext((frame: unknown) => frames.push(frame));
		const site = context.askSite({ host: "a.invalid", port: 443, lasting: true }, () => "once");
		const outsideCard = context.askOutside({ command: "ls", reason: "" });
		context.closeSiteCards("the turn ended");
		const failed = await site.then(() => null, (error: Error) => error.message);
		assert(failed === "the turn ended", `the card's end: ${failed}`);
		const closed = frames.filter((frame) => frame.type === "ui_request_closed");
		assert(closed.length === 1 && closed[0].reason === "unanswered", `frames: ${JSON.stringify(frames)}`);
		assert(context.hasOpenQuestions(), "the outside card closed too");
		context.declineOpenQuestionsOnce("done");
		await outsideCard.catch(() => {});
	});

	await macRow("outside: its refusals use the words the page reads as not run", async () => {
		await nextTurn();
		tools.personSpoke();
		person.outsideAnswer = false;
		const declined = await outside("echo declined");
		assert(commandDeclined(declined.text), `a Decline: ${declined.text}`);
		person.watcher = "none";
		const nobody = await outside("echo nobody");
		assert(nobodyToApprove(nobody.text), `nobody there: ${nobody.text}`);
		reset();
		for (let declines = 0; declines < 3; declines += 1) await outside("echo again");
		const offerOver = await outside("echo once-more");
		assert(commandDeclined(offerOver.text), `several Declines: ${offerOver.text}`);
		tools.personSpoke();
	});

	await macRow("a boxed command's timeout reads as a plain one's, and ends it", async () => {
		await nextTurn();
		const startedAt = Date.now();
		const late = await call(tools, "bash", { command: "echo before-the-wait; sleep 30", timeout: 1 });
		assert(late.failed && late.text.includes("before-the-wait") && late.text.includes("Command timed out after 1 seconds"), `the timeout: ${late.text}`);
		assert(Date.now() - startedAt < 25_000, "the timeout waited for the command");
	});

	await macRow("Stop ends a boxed command and what it started", async () => {
		await nextTurn();
		const tool = tools.tools.find((candidate) => candidate.name === "bash");
		assert(tool, "no bash tool");
		const pidFile = inRoom("stopped-pid");
		const stopper = new AbortController();
		const running = tool.execute("stop-call", { command: `/bin/sleep 60 & echo $! > ${quoted(pidFile)}; wait` } as any, stopper.signal, undefined as any, undefined as any).then(() => "finished", (error: Error) => error.message);
		await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", "the command to start");
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		stopper.abort();
		const ended = await running;
		assert(ended !== "finished" && ended.includes("aborted"), `Stop: ${ended}`);
		await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "what it started to end");
		fs.rmSync(pidFile);
	});

	await macRow("spill: a command that prints a spill's shape keeps its result", async () => {
		await nextTurn();
		const shaped = path.join(os.tmpdir(), "pi-bash-0000000000000000.log");
		const printed = await bash(`echo '[Full output: ${shaped}]'`);
		assert(!printed.failed && printed.text.includes(shaped), `a result: ${printed.text}`);
		const thrown = await bash(`echo '[Full output: ${shaped}]'; exit 3`);
		assert(thrown.failed && thrown.text.includes("[Full output: ") && thrown.text.includes("exit"), `thrown text: ${thrown.text}`);
	});

	await macRow("spill: with file tools that don't read in this box, the result says to read it with a command, and a boxed read works", async () => {
		await nextTurn();
		const { text } = await bash("/usr/bin/seq 1 5000");
		const spill = spillPath(text);
		assert(text.includes("[Showing lines 3002-5001 of 5001.") && spill, `the note: ${text.slice(-200)}`);
		assert(/with a command/.test(text) && text.includes("tail"), `what to do with it: ${text.slice(-200)}`);
		const read = await bash(`/usr/bin/wc -l < ${quoted(spill)}`);
		assert(!read.failed && read.text.trim() === "5000", `a boxed read: ${read.text}`);
	});

	await macRow("spill: long output lands in the private temp, and the text names it there", async () => {
		await nextTurn();
		const { text, failed } = await bash("/usr/bin/seq 1 40000");
		const spill = spillPath(text);
		assert(!failed && spill && fs.existsSync(spill) && fs.readFileSync(spill, "utf8").includes("39999"), `the spill: ${text.slice(-200)}`);
		assert(!text.includes(sharedTemp + path.sep + "pi-bash-"), `the shared temp's name stayed: ${text.slice(-200)}`);
		const read = await bash(`/usr/bin/tail -n 1 ${quoted(spill)}`);
		assert(read.text.includes("40000"), `the model reads it: ${read.text}`);
	});

	await macRow("spill: a failed command's long output is moved and named in the thrown text too", async () => {
		const { text, failed } = await bash("/usr/bin/seq 1 40000; exit 7");
		const spill = spillPath(text);
		assert(failed && spill && fs.existsSync(spill), `the thrown text: ${text.slice(-200)}`);
	});

	await row("spill: a link waiting at the name can't catch it", async () => {
		const place = fs.mkdtempSync(path.join(home, "spill-"));
		const victim = path.join(place, "victim");
		const source = path.join(place, "source");
		fs.writeFileSync(victim, "untouched");
		fs.writeFileSync(source, "secret output");
		fs.symlinkSync(victim, path.join(place, "target.log"));
		let refused = false;
		await moveSpill(source, path.join(place, "target.log")).catch(() => { refused = true; });
		assert(refused && fs.readFileSync(victim, "utf8") === "untouched", "the link caught the spill");
		await moveSpill(source, path.join(place, "free.log"));
		assert(fs.readFileSync(path.join(place, "free.log"), "utf8") === "secret output" && !fs.existsSync(source), "an ordinary move");
	});

	if (onMac) await box.endTurn();

	// Last: an entry fills the registry once, and nothing here can empty it again.
	// Spellings. A Mac's disk opens each of these as the one folder, and the box's allow for one opens the real one.
	const hideaway = path.join(home, ".ssh");
	const keyFile = path.join(hideaway, "secret");
	fs.mkdirSync(hideaway, { recursive: true });
	fs.writeFileSync(keyFile, "the-key");
	const setList = (folders: { path: string; access: "read" | "write" }[]) => writeRoomJson(alsoAllowedFile, { folders, sites: [] });
	const listedPaths = () => readAlsoAllowed(ROOM_ID).folders.map((entry) => entry.path);

	for (const [label, spelling] of [["case", ".SSH"], ["long s", ".ſsh"], ["sharp s", ".ßh"]]) {
		await macRow(`spelling: ${label} of a closed folder is closed on the list check, there or not yet`, () => {
			assert(!folderGrantable(path.join(home, spelling), "read", [], ""), "a yes could open it");
			assert(!fs.existsSync(path.join(home, ".azure")) && !folderGrantable(path.join(home, ".AZURE"), "read", [], ""), "a closed place not made yet");
		});
		await macRow(`spelling: ${label} of a closed folder on the list opens nothing in a real box`, async () => {
			setList([{ path: path.join(home, spelling), access: "read" }]);
			const read = await bash(`/bin/cat ${quoted(keyFile)}`);
			assert(read.failed && !read.text.includes("the-key"), `read: ${read.text}`);
			setList([]);
		});
	}

	await macRow("spelling: the other Unicode form of a closed folder is closed, on the check and in a real box", async () => {
		const composed = path.join(home, "Müller");
		const decomposed = path.join(home, "Müller");
		fs.mkdirSync(path.join(composed, ".ssh"), { recursive: true });
		fs.writeFileSync(path.join(composed, ".ssh", "secret"), "the-key");
		process.env.EXXPERTS_REAL_HOME = composed;
		try {
			assert(!folderGrantable(path.join(decomposed, ".ssh"), "read", [], ""), "a yes could open it");
			process.env.EXXPERTS_REAL_HOME = path.join(home, "Straße-gone");
			assert(!folderGrantable(path.join(home, "STRASSE-GONE", ".ssh"), "read", [], ""), "a home not there, in other letters");
			process.env.EXXPERTS_REAL_HOME = path.join(home, "Müller-gone");
			assert(!folderGrantable(path.join(home, "Müller-gone", ".ssh"), "read", [], ""), "a home not there, in the other Unicode form");
			process.env.EXXPERTS_REAL_HOME = composed;
			setList([{ path: path.join(decomposed, ".ssh"), access: "read" }]);
			const read = await bash(`/bin/cat ${quoted(path.join(composed, ".ssh", "secret"))}`);
			assert(read.failed && !read.text.includes("the-key"), `read: ${read.text}`);
		} finally {
			delete process.env.EXXPERTS_REAL_HOME;
			setList([]);
		}
	});

	await macRow("spelling: closed names written with a long s are refused in the room, and a long s elsewhere is written", async () => {
		await nextTurn();
		fs.mkdirSync(inRoom("spelled", ".git"), { recursive: true });
		for (const [name, command] of [[".gitmoduleſ", "echo x > .gitmoduleſ"], [".baſhrc", "echo x > .baſhrc"], [".vſcode", "mkdir .vſcode && echo x > .vſcode/tasks.json"], [".git/hookſ", "mkdir -p spelled/.git/hookſ && echo x > spelled/.git/hookſ/pre-commit"]]) {
			const { failed } = await bash(command);
			assert(failed, `${name} was written`);
		}
		const neighbour = await bash("echo x > noteſ.txt && mkdir -p ſheet && echo x > ſheet/a");
		assert(!neighbour.failed, `a neighbour: ${neighbour.text}`);
	});

	// A name other tools run from, anywhere in the path.
	const otherRepository = outsideRoom("other-repository");
	const plainWork = outsideRoom("plain-work");
	fs.mkdirSync(path.join(otherRepository, ".git", "hooks"), { recursive: true });

	await macRow("grants: a list entry for a repository's hooks is refused, for writing and for reading", async () => {
		await nextTurn();
		const hooks = path.join(otherRepository, ".git", "hooks");
		fs.writeFileSync(path.join(hooks, "note"), "hook-note");
		setList([{ path: hooks, access: "write" }]);
		const wrote = await bash(`echo x > ${quoted(path.join(hooks, "pre-commit"))}`);
		assert(wrote.failed && !fs.existsSync(path.join(hooks, "pre-commit")) && listedPaths().length === 0, `a list entry: ${wrote.text}`);
		setList([{ path: hooks, access: "read" }]);
		const read = await bash(`/bin/cat ${quoted(path.join(hooks, "note"))}`);
		assert(read.failed && listedPaths().length === 0, `reading the hooks is refused too: ${read.text}`);
		setList([]);
	});

	// A grant lives at a name: nothing a command can write may hold one, and one whose real path moved is off the list.
	await macRow("grants: nothing inside a place a command can write, and the folder beside it can", () => {
		const shared = outsideRoom("shared-write");
		for (const place of [inRoom("sub"), path.join(shared, "sub"), outsideRoom("beside")]) fs.mkdirSync(place, { recursive: true });
		assert(!folderGrantable(inRoom("sub"), "read", [folder, shared], folder), "inside the room");
		assert(!folderGrantable(path.join(shared, "sub"), "read", [folder, shared], folder), "inside a folder on the list for writing");
		assert(folderGrantable(outsideRoom("beside"), "read", [folder, shared], folder), "a folder beside it");
		assert(!folderGrantable(path.join(shared, "sub"), "write", [shared], "") && folderGrantable(shared, "write", [shared], ""), "a folder is judged by what holds it, not by itself");
	});

	const privateNote = path.join(home, "private-note.txt");
	fs.writeFileSync(privateNote, "private-words");

	await macRow("grants: a folder inside the room, swapped by a boxed command for a link to home, is off the list and home stays closed", async () => {
		await nextTurn();
		const granted = inRoom("granted");
		fs.mkdirSync(granted);
		setList([{ path: granted, access: "read" }]);
		const swap = await bash(`/bin/mv granted granted-old && /bin/ln -s ${quoted(home)} granted`);
		assert(!swap.failed && fs.lstatSync(granted).isSymbolicLink(), `the swap: ${swap.text}`);
		const direct = await bash(`/bin/cat ${quoted(privateNote)}`);
		const through = await bash(`/bin/cat ${quoted(path.join(granted, "private-note.txt"))}`);
		assert(direct.failed && through.failed, `home read: ${direct.text} ${through.text}`);
		assert(listedPaths().length === 0, `the list: ${listedPaths().join()}`);
		fs.unlinkSync(granted);
	});

	await macRow("grants: a folder swapped for a link by another program is off the list, and stays off when it comes back", async () => {
		await nextTurn();
		const granted = outsideRoom("swapped-elsewhere");
		fs.mkdirSync(granted);
		fs.writeFileSync(path.join(granted, "note.txt"), "granted-note");
		setList([{ path: granted, access: "write" }]);
		const before = await bash(`/bin/cat ${quoted(path.join(granted, "note.txt"))}`);
		assert(!before.failed, `before the swap: ${before.text}`);
		fs.renameSync(granted, `${granted}-old`);
		fs.symlinkSync(home, granted);
		const read = await bash(`/bin/cat ${quoted(privateNote)}`);
		const wrote = await bash(`echo x > ${quoted(path.join(home, "planted.txt"))}`);
		assert(read.failed && wrote.failed && !fs.existsSync(path.join(home, "planted.txt")), `home: ${read.text} ${wrote.text}`);
		assert(listedPaths().length === 0, `the list: ${listedPaths().join()}`);
		fs.unlinkSync(granted);
		fs.renameSync(`${granted}-old`, granted);
		const back = await bash(`/bin/cat ${quoted(path.join(granted, "note.txt"))}`);
		assert(back.failed && listedPaths().length === 0, `back: ${back.text}`);
	});

	await macRow("grants: a plain folder keeps its grant from command to command", async () => {
		await nextTurn();
		const kept = outsideRoom("kept-grant");
		const keptRead = outsideRoom("kept-read");
		for (const place of [kept, keptRead]) fs.mkdirSync(place);
		fs.writeFileSync(path.join(keptRead, "note.txt"), "kept-note");
		setList([{ path: kept, access: "write" }, { path: keptRead, access: "read" }]);
		for (let round = 0; round < 3; round += 1) {
			const wrote = await bash(`echo x > ${quoted(path.join(kept, `f${round}`))}`);
			const read = await bash(`/bin/cat ${quoted(path.join(keptRead, "note.txt"))}`);
			assert(!wrote.failed && !read.failed, `round ${round}: ${wrote.text} ${read.text}`);
		}
		assert(listedPaths().join() === [kept, keptRead].join(), `the list: ${listedPaths().join()}`);
		setList([]);
	});

	// The library writes an allow with the links on its way resolved and only its last name as written, so a link in a
	// grant's parent moves the grant while its text stays the same. A last name chosen to match the target opens the target.
	const plant = (file: string, words: string) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, words);
		return { file, words };
	};
	const taxes = plant(path.join(home, "Documents", "Taxes", "marker"), "taxes-words");
	const cookies = plant(path.join(home, "Library", "Cookies", "marker"), "cookie-words");
	const otherTaxes = plant(path.join(home, "Projects", "Taxes", "marker"), "other-taxes-words");
	const swapPlace = inRoom("swap-parent");
	/** A row that failed leaves its link: each one starts from nothing there, so its own check decides it. */
	const clearPlace = (place: string) => fs.rmSync(place, { recursive: true, force: true });
	const swapByCommand = async (parent: string, target: string) => {
		const swap = await bash(`/bin/rm -rf ${quoted(parent)}; /bin/ln -s ${quoted(target)} ${quoted(parent)}`);
		assert(!swap.failed && fs.lstatSync(parent).isSymbolicLink(), `the swap: ${swap.text}`);
	};
	const staysClosed = async (...secrets: { file: string; words: string }[]) => {
		for (const { file, words } of secrets) {
			const read = await bash(`/bin/cat ${quoted(file)}`);
			assert(read.failed && !read.text.includes(words), `${file} was read: ${read.text}`);
		}
	};
	/** A grant inside `holder`, a real folder when it goes on the list; a command then swaps `holder` for a link to `target`. */
	const parentSwap = async (holder: string, lastName: string, target: string, others: { path: string; access: "read" | "write" }[], ...secrets: { file: string; words: string }[]) => {
		await nextTurn();
		clearPlace(holder);
		const named = path.join(holder, lastName);
		fs.mkdirSync(named, { recursive: true });
		setList([...others, { path: named, access: "read" }]);
		await swapByCommand(holder, target);
		await staysClosed(...secrets);
		// Inside the room's folder, the swap command only skips the grant, as another conversation's folder may differ; moved, no conversation can use it, so the next command takes it off.
		const left = listedPaths();
		assert(left.join() === others.map((entry) => entry.path).join(), `on the list after the next command: ${left.join()}`);
		fs.unlinkSync(holder);
		setList([]);
	};

	await macRow("parent swap: a grant named as the home, its parent swapped for a link to the home's parent, opens no part of home", () => parentSwap(swapPlace, path.basename(home), path.dirname(home), [], taxes, cookies));

	await macRow("parent swap: a grant named Library, its parent swapped for a link to home, opens nothing in Library", () => parentSwap(swapPlace, "Library", home, [], cookies));

	await macRow("parent swap: a grant named Taxes, its parent swapped for a link to Documents, opens nothing there", () => parentSwap(swapPlace, "Taxes", path.dirname(path.dirname(taxes.file)), [], taxes));

	await macRow("parent swap: inside a folder on the list for writing, the same", async () => {
		const shared = outsideRoom("shared-swap");
		fs.mkdirSync(shared, { recursive: true });
		await parentSwap(path.join(shared, "parent"), "Taxes", path.dirname(path.dirname(taxes.file)), [{ path: shared, access: "write" }], taxes);
	});

	await macRow("parent swap: an entry through a link, re-pointed by a command, opens neither folder", async () => {
		await nextTurn();
		clearPlace(swapPlace);
		fs.symlinkSync(path.dirname(path.dirname(taxes.file)), swapPlace);
		setList([{ path: path.join(swapPlace, "Taxes"), access: "read" }]);
		await swapByCommand(swapPlace, path.dirname(path.dirname(otherTaxes.file)));
		const left = listedPaths();
		await staysClosed(otherTaxes, taxes);
		assert(left.length === 0, `on the list when the link moved: ${left.join()}`);
		fs.unlinkSync(swapPlace);
	});

	await macRow("parent swap: a yes through a link holds the real folder, and re-pointing the link moves nothing", async () => {
		await nextTurn();
		clearPlace(swapPlace);
		setList([]);
		const realTaxes = path.dirname(taxes.file);
		fs.symlinkSync(path.dirname(realTaxes), swapPlace);
		// A pick through the link goes on the list by its real path, as the folder window's pick does.
		assert(realPathOf(path.join(swapPlace, "Taxes")) === realTaxes, "the real folder");
		addAlsoAllowedFolder(ROOM_ID, realTaxes, "read");
		const read = await bash(`/bin/cat ${quoted(taxes.file)}`);
		assert(!read.failed && read.text.includes(taxes.words), `the folder the person said yes to: ${read.text}`);
		await swapByCommand(swapPlace, path.dirname(path.dirname(otherTaxes.file)));
		await staysClosed(otherTaxes, { file: path.join(swapPlace, "Taxes", "marker"), words: otherTaxes.words });
		assert(listedPaths().join() === realTaxes, `the list: ${listedPaths().join()}`);
		fs.unlinkSync(swapPlace);
		setList([]);
	});

	for (const access of ["read", "write"] as const) {
		await macRow(`parent swap: a ${access} grant outside the room works, then its parent swapped by another program is off the list and opens nothing`, async () => {
			await nextTurn();
			const holder = outsideRoom(`swap-${access}`);
			const named = path.join(holder, "Taxes");
			fs.mkdirSync(named, { recursive: true });
			fs.writeFileSync(path.join(named, "note.txt"), "granted-note");
			setList([{ path: named, access }]);
			const before = await bash(`/bin/cat ${quoted(path.join(named, "note.txt"))}`);
			assert(!before.failed && before.text.includes("granted-note") && listedPaths().length === 1, `before the swap: ${before.text}`);
			fs.renameSync(holder, `${holder}-old`);
			fs.symlinkSync(path.dirname(path.dirname(taxes.file)), holder);
			await staysClosed(taxes);
			const wrote = await bash(`echo x > ${quoted(path.join(path.dirname(taxes.file), "planted"))}`);
			assert(wrote.failed && !fs.existsSync(path.join(path.dirname(taxes.file), "planted")), `the write: ${wrote.text}`);
			assert(listedPaths().length === 0, `the list: ${listedPaths().join()}`);
			fs.unlinkSync(holder);
		});
	}

	await macRow("offer: a folder that holds the room, or whose files other programs run, is never offered, for reading or changing", () => {
		const container = outsideRoom("has-room");
		const nestedRoom = path.join(container, "the-room");
		fs.mkdirSync(nestedRoom, { recursive: true });
		const bare = outsideRoom("bare-repo");
		for (const name of ["objects", "refs", "hooks"]) fs.mkdirSync(path.join(bare, name), { recursive: true });
		fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
		const grantable = outsideRoom("plain-grantable");
		fs.mkdirSync(grantable, { recursive: true });
		try {
			for (const access of ["read", "write"] as const) {
				assert(!folderGrantable(container, access, [], nestedRoom), `a folder holding the room (${access})`);
				assert(!folderGrantable(bare, access, [], nestedRoom), `a bare repository's root (${access})`);
				assert(!folderGrantable(path.join(bare, "hooks"), access, [], nestedRoom), `a repository's hooks (${access})`);
				assert(!folderGrantable("/Applications", access, [], nestedRoom), `the applications folder (${access})`);
				assert(!folderGrantable("/usr/bin", access, [], nestedRoom), `a folder on the search path (${access})`);
				assert(!folderGrantable("/usr", access, [], nestedRoom), `a folder holding the search path (${access})`);
				assert(!folderGrantable(path.join(home, ".local"), access, [], nestedRoom), `a folder holding a per-user search path (${access})`);
				assert(folderGrantable(grantable, access, [], nestedRoom), `a plain folder still offers (${access})`);
			}
		} finally {
			for (const name of ["has-room", "bare-repo", "plain-grantable"]) fs.rmSync(outsideRoom(name), { recursive: true, force: true });
		}
	});

	// Line ends: a command keeps them, a path has no business holding them.
	await macRow("paths: a tab or a line break is hidden in a path, and a command keeps its own", () => {
		assert(pathHoldsHidden("/a/b\tc") && pathHoldsHidden("/a/b\nc") && pathHoldsHidden("/a/b‮c"), "a path");
		assert(!pathHoldsHidden("/a/b c/ü.txt"), "a plain path");
		assert(commandAsShown("for x in 1 2; do\n\techo $x\ndone") === "for x in 1 2; do\n\techo $x\ndone", "a command");
		for (const name of ["tab\there", "line\nbreak"]) fs.mkdirSync(path.join(plainWork, name), { recursive: true });
		assert(!folderGrantable(path.join(plainWork, "tab\there"), "write", [], folder) && !folderGrantable(path.join(plainWork, "line\nbreak"), "read", [], folder), "the check");
	});


	// A room's own folder and each folder it may write stay where the person chose them, whatever their names hold.
	const namedRooms = path.join(home, "named-rooms");
	const boxFor = (roomId: string, cwd: string) => {
		const roomBox = new RoomBox({ roomId, conversationId: () => "conversation-a", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {} });
		return { box: roomBox, tools: createRoomCommandTools(cwd, { box: roomBox, outside: { questions: questions as any, setOffered: () => {} } }) };
	};
	for (const [index, name] of ["Sales Review", "Q[1] Review", "What?", "Plan*", "Bücher Übersicht"].entries()) {
		await macRow(`entries: a command can't move, rename, remove or replace the folder of a room named ${name}, nor a folder it may write, and what is inside them moves`, async () => {
			const roomId = `box-smoke-named-${index}`;
			const own = path.join(namedRooms, name);
			const shared = path.join(namedRooms, `${name} shared`);
			for (const place of [own, shared]) fs.mkdirSync(place, { recursive: true });
			chooseFolder(roomId, own);
			saveAlsoAllowedFolders(roomId, [{ path: realPathOf(shared), access: "write" }]);
			const named = boxFor(roomId, own);
			const wentThrough: string[] = [];
			try {
				for (const [label, place] of [["the room's folder", own], ["a folder it may write", shared]]) {
					const entry = quoted(place);
					const scratch = (end: string) => `"$TMPDIR/${place === own ? "own" : "shared"}-${end}"`;
					const inside = await call(named.tools, "bash", { command: `mkdir ${quoted(path.join(place, "sub"))} && mv ${quoted(path.join(place, "sub"))} ${scratch("sub")} && mkdir ${quoted(path.join(place, "gone"))} && rmdir ${quoted(path.join(place, "gone"))}` });
					assert(!inside.failed, `${label}: moving and removing a folder inside it: ${inside.text}`);
					const attempts = {
						move: `mv ${entry} ${scratch("away")}`,
						rename: `mv ${entry} ${quoted(`${place} renamed`)}`,
						remove: `rmdir ${entry}`,
						replace: `mkdir ${scratch("new")} && /usr/bin/perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\\n"' ${scratch("new")} ${entry}`,
					};
					for (const [way, command] of Object.entries(attempts)) {
						// Each way on the folder as it was chosen: one that went through has moved or replaced it.
						fs.mkdirSync(place, { recursive: true });
						const identity = fs.lstatSync(place).ino;
						const attempt = await call(named.tools, "bash", { command });
						const kept = fs.lstatSync(place, { throwIfNoEntry: false });
						if (!attempt.failed || !kept?.isDirectory() || kept.ino !== identity) wentThrough.push(`${label}: ${way}`);
					}
				}
				assert(wentThrough.length === 0, `went through: ${wentThrough.join(", ")}`);
			} finally {
				await named.box.endTurn();
				fs.rmSync(namedRooms, { recursive: true, force: true });
			}
		});
	}

	await macRow("swap: a room's folder moved away with a link or another folder put at its name: the next command doesn't run, and what is there is neither read nor written", async () => {
		const roomId = "box-smoke-swapped";
		const own = path.join(namedRooms, "Swapped Room");
		const away = path.join(namedRooms, "Swapped Room away");
		const target = fs.realpathSync(fs.mkdtempSync(path.join(home, "swap-target-")));
		fs.writeFileSync(path.join(target, "inside.txt"), "swap-target-words");
		fs.mkdirSync(own, { recursive: true });
		chooseFolder(roomId, own);
		const swapped = boxFor(roomId, own);
		const command = "cat inside.txt; echo after > after.txt";
		const refused = async (tools: RoomCommandTools, label: string) => {
			const result = await call(tools, "bash", { command });
			assert(result.failed && result.text === COMMAND_FOLDER_MOVED && !tools.started(result.id), `${label}: ${result.text}`);
			assert(!fs.existsSync(path.join(target, "after.txt")) && !fs.existsSync(path.join(away, "after.txt")), `${label}: something was written`);
		};
		try {
			const before = await call(swapped.tools, "bash", { command: "echo before > before.txt" });
			assert(!before.failed && fs.existsSync(path.join(own, "before.txt")), `before the swap: ${before.text}`);
			// Another program swaps it between two commands.
			fs.renameSync(own, away);
			fs.symlinkSync(target, own);
			await refused(swapped.tools, "a link at its name");
			// A conversation that starts after the swap takes its folder from the link's target.
			const later = boxFor(roomId, target);
			await refused(later.tools, "a conversation started in the link's target").finally(() => later.box.endTurn());
			fs.unlinkSync(own);
			await refused(swapped.tools, "nothing at its name");
			const otherCase = path.join(namedRooms, "SWAPPED ROOM");
			fs.mkdirSync(otherCase);
			assert(fs.realpathSync.native(own) === otherCase, "this disk tells case apart, so no other folder answers to the room's name");
			await refused(swapped.tools, "another folder at its name");
			fs.rmdirSync(otherCase);
			fs.renameSync(away, own);
			const back = await call(swapped.tools, "bash", { command: "echo back > back.txt" });
			assert(!back.failed && fs.existsSync(path.join(own, "back.txt")), `moved back: ${back.text}`);
		} finally {
			await swapped.box.endTurn();
			fs.rmSync(namedRooms, { recursive: true, force: true });
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	// A developer setting can move the agent folder out of the app's data: the sign-in file and the library go with it.
	const movedCode = path.join(home, "code");
	const movedAgent = path.join(movedCode, "agent");
	const movedSkill = path.join(movedAgent, "skills", "report");
	const fileTools = (roomId: string, roomBox: RoomBox, asksNothing = false) => {
		const { policy } = resolvePersistentRoomCapabilityPolicy(roomId, "conversation-a");
		assert(policy, `no policy for ${roomId}`);
		return new Map(createPersistentRoomWorkspaceTools(policy, { box: roomBox, asksNothing: () => asksNothing }).map((tool) => [String(tool.name), tool]));
	};
	const fileCall = async (named: Map<string, any>, name: string, input: Record<string, unknown>) => {
		try {
			const result = await named.get(name).execute("call", input, undefined, undefined, undefined);
			return { text: (result.content ?? []).map((part: any) => part.text ?? "").join(""), failed: false };
		} catch (error) {
			return { text: (error as Error).message, failed: true };
		}
	};

	await row("the ordinary set-up: an agent folder inside the app's data adds no place, and none is listed twice", () => {
		delete process.env.EXXPERTS_CODING_AGENT_DIR;
		const ordinary = appDataPlaces();
		process.env.EXXPERTS_CODING_AGENT_DIR = path.join(home, ".exxperts", "agent");
		try {
			const inside = appDataPlaces();
			assert(JSON.stringify(inside) === JSON.stringify(ordinary) && new Set(inside).size === inside.length && !inside.includes(realPathOf(path.join(home, ".exxperts", "agent"))), `with the agent folder inside: ${JSON.stringify(inside)}, without: ${JSON.stringify(ordinary)}`);
		} finally {
			delete process.env.EXXPERTS_CODING_AGENT_DIR;
		}
	});

	await macRow("an agent folder a setting moved out of the app's data: a room beside it reads and writes nothing in it, by command or file tool, also asking nothing; the box keeps it closed to writes; a yes can't open it, and a folder beside it can be", async () => {
		fs.mkdirSync(movedSkill, { recursive: true });
		fs.mkdirSync(path.join(movedCode, "project"), { recursive: true });
		// Planted empty, by the sign-in file's name: never a real one.
		fs.writeFileSync(path.join(movedAgent, "auth.json"), "");
		fs.writeFileSync(path.join(movedSkill, "SKILL.md"), "library-skill-words");
		process.env.EXXPERTS_CODING_AGENT_DIR = movedAgent;
		await nextTurn();
		try {
			for (const command of [`/bin/cat ${quoted(path.join(movedAgent, "auth.json"))} && echo read-it`, `/bin/cat ${quoted(path.join(movedSkill, "SKILL.md"))}`]) {
				const read = await bash(command);
				assert(read.failed && !read.text.includes("read-it") && !read.text.includes("library-skill-words"), `${command}: ${read.text}`);
			}
			const wrote = await bash(`echo changed > ${quoted(path.join(movedSkill, "SKILL.md"))}; echo planted > ${quoted(path.join(movedAgent, "planted.txt"))}`);
			assert(wrote.failed && fs.readFileSync(path.join(movedSkill, "SKILL.md"), "utf8") === "library-skill-words" && !fs.existsSync(path.join(movedAgent, "planted.txt")), `a write: ${wrote.text}`);
			for (const asksNothing of [false, true]) {
				const named = fileTools(ROOM_ID, box, asksNothing);
				const read = await fileCall(named, "read", { path: path.join(movedSkill, "SKILL.md") });
				assert(read.failed && !read.text.includes("library-skill-words"), `file tool read${asksNothing ? ", asking nothing" : ""}: ${read.text}`);
				const write = await fileCall(named, "write", { path: path.join(movedAgent, "planted.txt"), content: "planted" });
				assert(write.failed && !fs.existsSync(path.join(movedAgent, "planted.txt")), `file tool write${asksNothing ? ", asking nothing" : ""}: ${write.text}`);
			}
			const temp = path.join(persistentAgentRootPath(ROOM_ID), "runtime", "box", "temp-row");
			const rules = boxRules({ folder, canChangeFiles: true, alsoAllowed: [], skillFolders: [], places: { temp, caches: path.join(path.dirname(temp), "caches"), shim: path.join(path.dirname(temp), "bin"), gitTemplate: path.join(path.dirname(temp), "git-template") } });
			const denyWrite = (rules.filesystem.denyWrite as { path: string }[]).map((entry) => entry.path);
			assert(denyWrite.includes(realPathOf(movedAgent)), `not closed to writes: ${JSON.stringify(denyWrite)}`);
			assert(neverOpened().includes(realPathOf(movedAgent)), "a yes could open it");
			for (const access of ["read", "write"] as const) {
				for (const place of [movedAgent, movedSkill, movedCode]) assert(!folderGrantable(place, access, [folder], folder), `${access}: ${place} can be granted`);
				assert(folderGrantable(path.join(movedCode, "project"), access, [folder], folder), `${access}: the folder beside it can't be granted`);
			}
		} finally {
			delete process.env.EXXPERTS_CODING_AGENT_DIR;
			fs.rmSync(movedCode, { recursive: true, force: true });
		}
	});

	await macRow("an agent folder a setting moved out of the app's data: a room that asks nothing still reads and writes beyond its folders as before, and reads a skill on in the moved library, but nothing else there", async () => {
		fs.mkdirSync(movedAgent, { recursive: true });
		fs.writeFileSync(path.join(movedAgent, "auth.json"), "");
		process.env.EXXPERTS_CODING_AGENT_DIR = movedAgent;
		const settingsFile = persistentRoomSkillSettingsPath(ROOM_ID);
		const settingsBefore = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : null;
		const beyond = outsideRoom("beyond-asking-nothing");
		fs.mkdirSync(beyond, { recursive: true });
		fs.writeFileSync(path.join(beyond, "note.txt"), "beyond-words");
		try {
			// A skill as the Skills page leaves it in the library, which now sits in the moved folder, on in this room; another left off.
			const plant = (name: string) => {
				const dir = path.join(agentSkillsDir(), name);
				const manifest = `---\nname: ${name}\ndescription: a test skill\n---\n\n${name}-words\n`;
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
				const identity = crypto.randomUUID();
				writeSkillProvenance(dir, { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest), identity });
				return { dir, identity };
			};
			const on = plant("moved-on");
			const off = plant("moved-off");
			fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
			fs.writeFileSync(settingsFile, `${JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "moved-on", identity: on.identity }], updatedAt: new Date().toISOString() })}\n`);
			assert(path.relative(movedAgent, on.dir) === path.join("skills", "moved-on"), `the library is not in the moved folder: ${on.dir}`);
			await nextTurn();
			const named = fileTools(ROOM_ID, box, true);
			const read = await fileCall(named, "read", { path: path.join(beyond, "note.txt") });
			assert(!read.failed && read.text.includes("beyond-words"), `a read beyond the room's folders: ${read.text}`);
			const write = await fileCall(named, "write", { path: path.join(beyond, "new.txt"), content: "written" });
			assert(!write.failed && fs.readFileSync(path.join(beyond, "new.txt"), "utf8") === "written", `a write beyond the room's folders: ${write.text}`);
			const skill = await fileCall(named, "read", { path: path.join(on.dir, "SKILL.md") });
			assert(!skill.failed && skill.text.includes("moved-on-words"), `the skill on in the room: ${skill.text}`);
			for (const closed of [path.join(off.dir, "SKILL.md"), path.join(movedAgent, "auth.json")]) {
				const refused = await fileCall(named, "read", { path: closed });
				assert(refused.failed && !refused.text.includes("moved-off-words"), `${closed}: ${refused.text}`);
			}
		} finally {
			if (settingsBefore === null) fs.rmSync(settingsFile, { force: true });
			else fs.writeFileSync(settingsFile, settingsBefore);
			delete process.env.EXXPERTS_CODING_AGENT_DIR;
			fs.rmSync(movedCode, { recursive: true, force: true });
			fs.rmSync(beyond, { recursive: true, force: true });
		}
	});

	await macRow("an agent folder a setting moved out of the app's data: a room whose folder, or Also allowed folder, held it before runs no command in it and opens no file from its next call", async () => {
		fs.mkdirSync(movedSkill, { recursive: true });
		fs.writeFileSync(path.join(movedAgent, "auth.json"), "");
		fs.writeFileSync(path.join(movedSkill, "SKILL.md"), "library-skill-words");
		// Chosen while the agent folder was still in the app's data.
		const heldId = "box-smoke-held-agent";
		chooseFolder(heldId, movedCode);
		saveAlsoAllowedFolders(ROOM_ID, [{ path: realPathOf(movedCode), access: "write" }]);
		process.env.EXXPERTS_CODING_AGENT_DIR = movedAgent;
		await nextTurn();
		const held = boxFor(heldId, movedCode);
		try {
			const run = await call(held.tools, "bash", { command: "/bin/cat agent/skills/report/SKILL.md; echo planted > agent/planted.txt" });
			assert(run.failed && run.text === ROOM_FOLDER_REFUSED && !held.tools.started(run.id) && !fs.existsSync(path.join(movedAgent, "planted.txt")), `the room's folder: ${run.text}`);
			const opened = await fileCall(fileTools(heldId, held.box), "read", { path: path.join(movedSkill, "SKILL.md") });
			assert(opened.failed && opened.text === ROOM_FOLDER_REFUSED, `the room's file tool: ${opened.text}`);
			const listed = await bash(`/bin/cat ${quoted(path.join(movedSkill, "SKILL.md"))}; echo planted > ${quoted(path.join(movedAgent, "planted.txt"))}`);
			assert(listed.failed && !listed.text.includes("library-skill-words") && !fs.existsSync(path.join(movedAgent, "planted.txt")), `an Also allowed folder: ${listed.text}`);
			assert(!readAlsoAllowed(ROOM_ID).folders.some((entry) => entry.path === realPathOf(movedCode)), "the Also allowed folder is still on the list");
		} finally {
			await held.box.endTurn();
			saveAlsoAllowedFolders(ROOM_ID, []);
			delete process.env.EXXPERTS_CODING_AGENT_DIR;
			fs.rmSync(movedCode, { recursive: true, force: true });
		}
	});

	await macRow("the start-up probe tells the first command nothing: it blocks on purpose", async () => {
		await box.endTurn();
		const secondServer = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			import fs from "node:fs";
			import { RoomBox } from "./src/room-box/box-session.ts";
			const room = "box-smoke-probe-room";
			const questions = { watcher: () => "computer", closeSiteCards() {}, askSite: async () => ({ choice: "decline", answeredBy: "computer" }) };
			const box = new RoomBox({ roomId: room, conversationId: () => "a", questions, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: (detail, message) => console.log(message, detail) });
			let text = "";
			const run = await box.operations().exec("echo probed", process.argv[1], { onData: (chunk) => { text += chunk; }, env: process.env });
			await box.endTurn();
			console.log(JSON.stringify({ code: run.exitCode, text }));
		`, folder], { cwd: webServerRoot, encoding: "utf8", env: process.env });
		const report = (secondServer.stdout ?? "").trim().split("\n").at(-1) ?? "";
		assert(report === '{"code":0,"text":"probed\\n"}', `a fresh server's first turn: ${secondServer.stdout}${secondServer.stderr}`);
	});

	if (onWindows) console.log("SKIPPED: not yet on a real Windows PC: a shared server's plain commands (the row acts as a Mac, so its plain run looks for /bin/bash)");
	else await row("a shared server: no box on any platform, plain commands, and the proxy's code is never reached", async () => {
		registerServerHooks({});
		const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
		const started = BoxProcess.start;
		BoxProcess.start = (async () => { throw new Error("the proxy's code was reached"); }) as typeof BoxProcess.start;
		try {
			assert(!roomBoxAvailable(), "a box on a shared server");
			// The box reads no log, and the worker starts only from BoxProcess.start, which is refused above.
			// Every file in the folder and below it, so no subfolder holds another way in.
			const boxRoot = path.join(webServerRoot, "src", "room-box");
			const boxFiles = fs.readdirSync(boxRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
			const holding = (words: string) => boxFiles.filter((file) => fs.readFileSync(file, "utf8").includes(words));
			assert(holding("/usr/bin/log").length === 0 && holding('"box-worker.mjs"').join() === path.join(boxRoot, "box-process.ts"), "a way to the log, or another way to the worker");
			const shared = createRoomCommandTools(folder);
			assert(shared.tools.length === 1 && shared.tools[0].name === "bash", "only bash");
			const { text, failed } = await call(shared, "bash", { command: "echo plain-run" });
			assert(!failed && text.includes("plain-run"), `plain run: ${text}`);
		} finally {
			BoxProcess.start = started;
			Object.defineProperty(process, "platform", platform);
		}
	});
}

main().catch((error) => {
	failures.push(`crashed: ${(error as Error).stack}`);
}).finally(() => {
	fs.rmSync(folder, { recursive: true, force: true });
	fs.rmSync(elsewhere, { recursive: true, force: true });
	console.log(`room box smoke: ${passed} passed, ${failures.length} failed`);
	for (const failure of failures) console.log(`  failed: ${failure}`);
	process.exit(failures.length ? 1 : 0);
});
