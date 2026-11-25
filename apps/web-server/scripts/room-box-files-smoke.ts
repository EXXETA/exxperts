// A room's file tools in the box, on a Mac. Every row runs the room's own tools,
// with the turn's real box, and reads what the model would get. A job left
// behind is played by swapping a path between the server's check and the
// program's open, which is the one moment the box exists for.
//
// It writes into the home it runs under, so it refuses to start anywhere but the
// throwaway home `npm run smokes` makes. On any other computer each row says it
// was skipped, by name.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import * as XLSX from "xlsx";

import { roomBoxAvailable } from "../src/room-box/box-available.js";
import { addAlsoAllowedFolder, saveAlsoAllowedFolders } from "../src/room-box/also-allowed.js";
import { isInside, realPathOf } from "../src/room-box/box-closed.js";
import { BoxFiles, boxedCommandSinceStart, FILES_STOPPED_LINE, type FileProgramCall, fileProgram, notEnoughSpace } from "../src/room-box/box-files.js";
import { BoxFault, BoxProcess, FILE_WORKER } from "../src/room-box/box-process.js";
import { CLOSED_TO_WRITES_ASKING_NOTHING, fileRules, NEVER_WRITABLE_FILES, NEVER_WRITABLE_FOLDERS } from "../src/room-box/box-rules.js";
import { RoomBox, type RoomBoxOptions } from "../src/room-box/box-session.js";
import { BOX_FAULT_SENTENCE } from "../src/room-box/card-text.js";
import { unprotectedRoomOnAutoIn } from "../src/persistent-room-bash-settings.js";
import { PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES } from "../src/persistent-room-tool-policy.js";
import { createPersistentRoomCapabilityPolicy, createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, writePersistentRoomDefaultCapabilityPolicy } from "../src/persistent-room-workspace-policy.js";
import { createPersistentRoomWorkspaceTools, openedWithoutAsking } from "../src/persistent-room-workspace-tools.js";
import { createRoomCommandTools } from "../src/room-command-tool.js";
import { registerServerHooks } from "../src/server-hooks.js";
import { closedRefusal, type FencedPath, fencePath, type FenceRoot, neverChanged, ownTempRefusal, readOnlyFolder, type RoomFence, roomFence, RoomFilesError } from "../src/room-files.js";
import { fileProgramPidsIn } from "./smoke-file-programs.js";
import { freePort, SMOKE_SERVER_AUTH_ENV, smokeHomeEnv, waitForServer } from "./smoke-server-process.js";

const home = fs.realpathSync(os.homedir());
const sharedTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(home) !== sharedTemp || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`room box files smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- room-box-files`);
	process.exit(1);
}

// --- Node's listing of the libraries it loads runs once per server process, so
// each stand-in listing and each server start runs in a child of its own.
const LISTING_JOB = "ROOM_BOX_FILES_LISTING_JOB";
type ListingJob = { answer: string } | { fails: true } | { start: "darwin" | "linux" };
type ListingCall = { args: readonly string[]; env: unknown };

/** Records each child this Node starts of itself by `execFileSync`, as the listing does, and answers for it when given a stand-in. */
function watchListings(standIn?: () => string): ListingCall[] {
	const childProcess = createRequire(import.meta.url)("node:child_process");
	const real = childProcess.execFileSync;
	const calls: ListingCall[] = [];
	childProcess.execFileSync = (file: string, args: readonly string[], options?: { env?: unknown }) => {
		if (file !== process.execPath) return real(file, args, options);
		calls.push({ args, env: options?.env });
		return standIn ? standIn() : real(file, args, options);
	};
	syncBuiltinESMExports();
	return calls;
}

/** The file program's whole environment, and the listing Node's: OpenSSL's settings file is /dev/null, which its rules open already. */
const PROGRAM_ENV = { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" };

/** The rules a file call builds for these program files, on one fixed root. */
const rulesFor = (program: readonly string[]) => fileRules({ roots: [{ path: home, access: "write" }], writes: true, closedBelow: [".env"], asksNothing: false, program });
/** What main builds today: the Node and the program, nothing else. */
const mainProgram = () => [realPathOf(process.execPath), realPathOf(FILE_WORKER)];

const listingJob = process.env[LISTING_JOB];
if (listingJob) {
	const asked = JSON.parse(listingJob) as ListingJob;
	let answer: unknown;
	if ("start" in asked) {
		const calls = watchListings();
		await import("../src/index.js");
		await waitForServer({ exitCode: null }, `http://127.0.0.1:${process.env.PORT}`, 60_000);
		answer = { box: roomBoxAvailable(), calls: calls.length };
	} else {
		const calls = watchListings(() => {
			if ("fails" in asked) throw new Error("the listing failed");
			return asked.answer;
		});
		const first = fileProgram();
		const again = fileProgram();
		answer = { files: first.files, again: again.files, command: first.command, rules: rulesFor(first.files), calls: calls.length };
	}
	// A pipe's write can still be under way when this returns (Node 20 on a Mac),
	// and exiting then cuts the line: the job ends only once it is written.
	process.stdout.write(`${JSON.stringify(answer)}\n`, () => process.exit(0));
	await new Promise(() => {});
}

/** Runs one listing job in a child of this smoke, and gives back the last line it printed. */
function runListingJob(asked: ListingJob, env: Record<string, string | undefined> = process.env): any {
	const ran = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...env, [LISTING_JOB]: JSON.stringify(asked) }, encoding: "utf8", timeout: 120_000 });
	try {
		return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "");
	} catch {
		throw new Error(`the listing job gave no answer: ${ran.stdout}${ran.stderr}`);
	}
}

const onMac = process.platform === "darwin";
let passed = 0;
const failures: string[] = [];

async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	if (!onMac) {
		console.log(`  skip ${name} (needs a Mac)`);
		return;
	}
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const ROOM_ID = "box-files-smoke-room";
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
fs.mkdirSync(persistentAgentRootPath(ROOM_ID), { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(home, "room-folder-")));
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(home, "elsewhere-")));
const inRoom = (...names: string[]) => path.join(folder, ...names);
const policy = createPersistentRoomCapabilityPolicy({ agentId: ROOM_ID, conversationId: "conversation-a", repoRoot, root: folder, workspaceAccessMode: "localFiles", source: "manual" });
// Chosen as a person chooses a room's folder: a command runs only in the folder the room has stored.
writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: ROOM_ID, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));

const quietQuestions = { watcher: () => "computer" as const, askSite: async () => ({ choice: "decline" as const, answeredBy: "computer" as const }), closeSiteCards: () => {} };
function newBox(warn: RoomBoxOptions["warn"] = () => {}): RoomBox {
	return new RoomBox({ roomId: ROOM_ID, conversationId: () => "conversation-a", questions: quietQuestions, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn });
}
let box: RoomBox;
let tools: Map<string, any>;
function bind(warn?: RoomBoxOptions["warn"]): void {
	box = newBox(warn);
	tools = new Map(createPersistentRoomWorkspaceTools(policy, { box }).map((tool) => [String(tool.name), tool]));
}
const nextTurn = async () => {
	await box.endTurn();
	bind();
};

async function call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; failed: boolean; result?: any }> {
	const tool = tools.get(name);
	assert(tool, `no ${name} tool`);
	try {
		const result = await tool.execute("call", input, signal, undefined, undefined);
		return { text: (result.content ?? []).map((part: any) => part.text ?? "").join(""), failed: false, result };
	} catch (error) {
		return { text: (error as Error).message, failed: true };
	}
}

/** The room's tools with a reader of whether it asks nothing, as room-socket.ts passes one. */
const stateTools = (asksNothing?: () => boolean) => new Map(createPersistentRoomWorkspaceTools(policy, { box, asksNothing }).map((tool) => [String(tool.name), tool]));

/** A file written, then edited, by the room's tools; one not `made` is there before and is overwritten. */
async function writtenAndEdited(target: string, made = false): Promise<void> {
	const file = path.isAbsolute(target) ? target : inRoom(target);
	const wrote = await call("write", { path: target, content: "changed\n", ...(made ? {} : { overwrite: true }) });
	assert(!wrote.failed && fs.readFileSync(file, "utf8") === "changed\n", `write ${target}: ${wrote.text}`);
	const edited = await call("edit", { path: target, edits: [{ oldText: "changed", newText: "edited" }] });
	assert(!edited.failed && fs.readFileSync(file, "utf8") === "edited\n", `edit ${target}: ${edited.text}`);
}

/** What the box's program answers a write the fence never judged, in `root`: null when it wrote, else the refusal's code. */
function programWrite(fence: RoomFence, real: string, root: FenceRoot): Promise<string | null> {
	const target: FencedPath = { real, root, shown: real, exists: fs.existsSync(real), needsDeck: false };
	return new BoxFiles(box, fence).write(target, real, "past the fence\n", true).then(
		() => null,
		(error: unknown) => (error instanceof RoomFilesError ? error.code : String(error)),
	);
}

/** Runs `swap` after the server's check and before the program opens anything: a job left behind, at its moment. */
async function withSwapBeforeOpen<T>(swap: () => void, body: () => Promise<T>): Promise<T> {
	const original = RoomBox.prototype.runFileProgram;
	let swapped = false;
	RoomBox.prototype.runFileProgram = function (this: RoomBox, ...args) {
		if (!swapped) {
			swapped = true;
			swap();
		}
		return original.apply(this, args);
	};
	try {
		return await body();
	} finally {
		RoomBox.prototype.runFileProgram = original;
	}
}

const shellWord = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * Runs each file call with a stand-in for the program, in the same box under the
 * same rules: this Node, which writes `marker`, its own process number as the
 * loader does, and more than the log keeps to its error output, with a bell and a
 * line break in it, and exits 3 without an answer; or, when it `hangs`, waits
 * past the call's limit, cut to two seconds.
 */
async function withSilentProgram<T>(marker: string, body: () => Promise<T>, { hangs = false } = {}): Promise<T> {
	const original = RoomBox.prototype.runFileProgram;
	const written = `process.stderr.write(${JSON.stringify(marker)} + "[" + process.pid + "]" + ${JSON.stringify("\u0007\nsecond line\t")} + "x".repeat(3000));`;
	const script = `${written} ${hangs ? "setInterval(() => {}, 1000);" : "process.exitCode = 3;"}`;
	RoomBox.prototype.runFileProgram = function (this: RoomBox, call) {
		return original.call(this, { ...call, command: `${shellWord(realPathOf(process.execPath))} -e ${shellWord(script)}`, ...(hangs ? { limitMs: 2_000 } : {}) });
	};
	try {
		return await body();
	} finally {
		RoomBox.prototype.runFileProgram = original;
	}
}

/** The stand-in's marker in each line logged, in order. */
const markersIn = (logged: readonly string[]) => logged.map((line) => /SILENT-[A-Z]+/.exec(line)?.[0] ?? line);

/** Runs a boxed command, so the record says one ran since the computer started. */
async function runACommand(): Promise<void> {
	const commands = createRoomCommandTools(folder, { box, outside: { questions: { ...quietQuestions, askOutside: async () => false } as any, setOffered: () => {} } });
	await commands.tools.find((tool) => tool.name === "bash")!.execute("cmd", { command: "true" } as any, undefined as any, undefined as any, undefined as any);
	assert(boxedCommandSinceStart(), "the command left no record");
}

/** This smoke's file programs still alive. */
const programsAlive = (): number => fileProgramPidsIn(folder).length;

// `nobody`'s fixed id: `ls -len` prints access lists by id, so no name lookup can fail under load.
const NOBODY_DENIED_READ = "FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE deny read";
const accessList = (file: string) => execFileSync("/bin/ls", ["-len", file], { encoding: "utf8" });

const copiesLeft = () => fs.readdirSync(sharedTemp).filter((name) => name.startsWith("exxperts-file-copy-")).length;

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function minimalPdf(): Buffer {
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
		"4 0 obj\n<< /Length 84 >>\nstream\nBT /F1 12 Tf 72 720 Td (Quarterly payment terms are 60 days) Tj ET\nendstream\nendobj\n",
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += object;
	}
	const xrefOffset = Buffer.byteLength(body, "latin1");
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

async function minimalDocx(): Promise<Buffer> {
	const { default: JSZip } = await import("jszip");
	const zip = new JSZip();
	zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
	zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Contract clause: renewal is automatic.</w:t></w:r></w:p></w:body></w:document>`);
	return zip.generateAsync({ type: "nodebuffer" });
}

function workbook(): Buffer {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Region", "Sales"], ["North", 42]]), "Sales");
	return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

async function main(): Promise<void> {
	console.log("room box files smoke");

	bind();
	fs.writeFileSync(inRoom("notes.txt"), "line one\nline two\nneedle here\n");
	fs.mkdirSync(inRoom("docs"));
	fs.writeFileSync(inRoom("docs", "plan.md"), "plan needle\n");
	fs.writeFileSync(inRoom(".env"), "TOKEN=secret\n");
	fs.writeFileSync(inRoom(".env.example"), "TOKEN=\n");

	await row("Node's listing of its libraries runs once, at the first file call, in the program's own environment with no options", async () => {
		// The server's own NODE_OPTIONS until the first listing: a preload that would leave a mark and load a library of its own, the Mac's file watcher.
		const listings = watchListings();
		const preloadRan = path.join(home, "preload-ran");
		const preload = path.join(home, "preload.cjs");
		const watcher = createRequire(import.meta.url).resolve("fsevents");
		const watcherLibrary = realPathOf(path.join(path.dirname(watcher), "fsevents.node"));
		fs.writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloadRan)}, "ran"); require(${JSON.stringify(watcher)});`);
		process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
		try {
			const before = listings.length;
			assert(before === 0, "a listing ran before any file call");
			for (const input of [{ path: "notes.txt" }, { path: "docs/plan.md" }]) {
				const read = await call("read", input);
				assert(!read.failed, `read: ${read.text}`);
			}
			await nextTurn();
			assert(!(await call("ls", {})).failed, "ls in a new box");
			const otherRoom = "box-files-smoke-other-room";
			fs.mkdirSync(persistentAgentRootPath(otherRoom), { recursive: true });
			writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: otherRoom, repoRoot, root: elsewhere, workspaceAccessMode: "localFiles", displayLabel: "Elsewhere", source: "manual" }));
			const otherBox = new RoomBox({ roomId: otherRoom, conversationId: () => "conversation-b", questions: quietQuestions, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {} });
			const otherPolicy = createPersistentRoomCapabilityPolicy({ agentId: otherRoom, conversationId: "conversation-b", repoRoot, root: elsewhere, workspaceAccessMode: "localFiles", source: "manual" });
			const otherLs = createPersistentRoomWorkspaceTools(otherPolicy, { box: otherBox }).find((tool) => tool.name === "ls")!;
			await otherLs.execute("call", {} as any, undefined, undefined as any, undefined as any);
			await otherBox.endTurn();
			assert(listings.length === 1, `listings: ${listings.length}`);
			const [listing] = listings;
			assert(listing.args.length === 2 && listing.args[0] === "-e", `the listing's arguments: ${listing.args.join(" ")}`);
			assert(isDeepStrictEqual(listing.env, PROGRAM_ENV), `the listing's environment: ${JSON.stringify(listing.env)}`);
			assert(!fs.existsSync(preloadRan), "the server's NODE_OPTIONS preload ran in the listing");
			// This Node's own libraries may be there: none from nodejs.org, libnode and its kin from Homebrew.
			const { files } = fileProgram();
			assert(isDeepStrictEqual(files.slice(0, 2), mainProgram()) && !files.includes(watcherLibrary), `the program's files: ${files.join(" ")}`);
		} finally {
			delete process.env.NODE_OPTIONS;
		}
	});

	await row("a library outside the system's opens by its real path alone, a linked one by its target; system libraries and the Node add nothing", () => {
		const libs = fs.realpathSync(fs.mkdtempSync(path.join(home, "stand-in-libs-")));
		const libnode = path.join(libs, "lib", "libnode.141.dylib");
		const llhttp = path.join(libs, "Cellar", "llhttp", "9.3.0", "lib", "libllhttp.9.3.dylib");
		for (const library of [libnode, llhttp]) {
			fs.mkdirSync(path.dirname(library), { recursive: true });
			fs.writeFileSync(library, "stand-in");
		}
		// Homebrew's way: opt/ holds a link to the library's folder in the Cellar.
		fs.mkdirSync(path.join(libs, "opt"));
		fs.symlinkSync(path.join(libs, "Cellar", "llhttp", "9.3.0"), path.join(libs, "opt", "llhttp"));
		const linked = path.join(libs, "opt", "llhttp", "lib", "libllhttp.9.3.dylib");
		try {
			const listing = [process.execPath, "/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation", libnode, linked, libnode];
			const got = runListingJob({ answer: JSON.stringify(listing) });
			assert(isDeepStrictEqual(got.files, [...mainProgram(), libnode, llhttp]), `files: ${got.files.join(" ")}`);
			assert(got.calls === 1 && isDeepStrictEqual(got.again, got.files), `a second file call: ${got.calls} listings, ${got.again.join(" ")}`);
			assert(got.command === fileProgram().command, `the command: ${got.command}`);
			const main = rulesFor(mainProgram());
			const worker = `(literal ${JSON.stringify(mainProgram()[1])})`;
			const opened = [libnode, llhttp].map((library) => ({ path: library, literal: true }));
			const expected = {
				filesystem: { ...main.filesystem, allowRead: [...(main.filesystem.allowRead as unknown[]), ...opened] },
				profileRules: main.profileRules.replace(worker, `${worker} ${[libnode, llhttp].map((library) => `(literal ${JSON.stringify(library)})`).join(" ")}`),
			};
			assert(main.profileRules.split(worker).length === 2 && isDeepStrictEqual(got.rules, expected), `rules: ${JSON.stringify(got.rules)}`);
		} finally {
			fs.rmSync(libs, { recursive: true, force: true });
		}
	});

	await row("a listing like nodejs.org's Node, one that fails and an empty one leave the rules byte for byte as before", () => {
		const main = JSON.stringify(rulesFor(mainProgram()));
		const nodejsOrg = [process.execPath, "/usr/lib/libSystem.B.dylib", "/usr/lib/libc++.1.dylib", "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation"];
		for (const [what, asked] of [["nodejs.org's", { answer: JSON.stringify(nodejsOrg) }], ["failing", { fails: true }], ["empty", { answer: "" }]] as const) {
			const got = runListingJob(asked);
			assert(JSON.stringify(got.rules) === main && isDeepStrictEqual(got.files, mainProgram()) && got.calls === 1, `${what}: ${got.calls} listings, files ${got.files.join(" ")}, rules ${JSON.stringify(got.rules) === main ? "as before" : "changed"}`);
		}
	});

	await row("a server's start runs no listing, on a Mac and acting as another platform", async () => {
		for (const platform of ["darwin", "linux"] as const) {
			const startHome = fs.mkdtempSync(path.join(sharedTemp, "exxperts-smoke-home-listing-"));
			try {
				const acted = platform === "linux" ? { EXXPERTS_TEST_SHELL_PLATFORM: "linux" } : {};
				const env = smokeHomeEnv(startHome, { ...SMOKE_SERVER_AUTH_ENV, ...acted, PORT: String(await freePort()), EXXETA_HOME: repoRoot, EXXPERTS_TEST_INTROSPECTION: "1", LOG_LEVEL: "warn" });
				const got = runListingJob({ start: platform }, env);
				assert(got.box === (platform === "darwin") && got.calls === 0, `${platform}: ${JSON.stringify(got)}`);
			} finally {
				fs.rmSync(startHome, { recursive: true, force: true });
			}
		}
	});

	await row("the file program starts where the box refuses OpenSSL's settings file, in the listing's environment", async () => {
		// The file this Node's OpenSSL reads at start, refused by one line added here alone, as the box refuses Homebrew's under its own folder.
		const settings = "/System/Library/OpenSSL/openssl.cnf";
		const refusesSettings = `(deny file-read-data (literal ${JSON.stringify(settings)}))`;
		const wrapped: string[] = [];
		const request = BoxProcess.prototype.request;
		BoxProcess.prototype.request = async function (this: BoxProcess, kind: string, body: any) {
			if (kind !== "wrap" || body.command !== fileProgram().command) return request.call(this, kind, body);
			const answer = (await request.call(this, kind, { ...body, profileRules: `${body.profileRules}\n${refusesSettings}` })) as { wrapped: string };
			wrapped.push(answer.wrapped);
			return answer;
		} as typeof BoxProcess.prototype.request;
		const childProcess = createRequire(import.meta.url)("node:child_process");
		const spawn = childProcess.spawn;
		const started: { command: string; env: unknown }[] = [];
		childProcess.spawn = (file: string, args: readonly string[], options?: { env?: unknown }) => {
			// portability-ok: the row runs only on a Mac
			if (file === "/bin/bash") started.push({ command: args[1], env: options?.env });
			return spawn(file, args, options);
		};
		syncBuiltinESMExports();
		const logged: string[] = [];
		await box.endTurn();
		bind((_detail, message) => logged.push(message));
		try {
			const fence = roomFence(policy, () => []);
			// A program that gave no answer: its error output is in the operator's log.
			const entries = await new BoxFiles(box, fence).list(fencePath(fence, ".", "read", { decksInBox: true }), ".").catch((error: Error) => {
				throw new Error(`${error.message} ${logged.join(" | ")}`);
			});
			assert(entries.some((entry) => entry.name === "notes.txt") && logged.length === 0, `the program's listing: ${entries.map((entry) => entry.name).join(" ")}; logged: ${logged.join(" | ")}`);
		} finally {
			BoxProcess.prototype.request = request;
			childProcess.spawn = spawn;
			syncBuiltinESMExports();
			await nextTurn();
		}
		assert(wrapped.length === 1 && wrapped[0].includes(refusesSettings), `wrapped programs: ${wrapped.length}`);
		const program = started.filter((start) => start.command === wrapped[0]);
		assert(program.length === 1 && isDeepStrictEqual(program[0].env, PROGRAM_ENV), `the program's start: ${JSON.stringify(program.map((start) => start.env))}`);
		// The same start without the setting dies on that file: the added line refuses it, and the setting is what lets the program start.
		// portability-ok: the row runs only on a Mac
		const bare = spawnSync("/bin/bash", ["-c", wrapped[0]], { cwd: folder, input: JSON.stringify({ op: "list", path: folder, decks: [] }), env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 30_000 });
		assert(bare.status !== 0 && bare.stderr.includes("OpenSSL configuration error") && /BIO_new_file:Operation not permitted/.test(bare.stderr), `without the setting: ${bare.status}: ${bare.stderr}`);
	});

	await row("the file program opens no OpenSSL settings file by name, under this Node and beside Homebrew's OpenSSL libraries: its rules read /dev/null already", () => {
		const libs = fs.realpathSync(fs.mkdtempSync(path.join(home, "stand-in-libs-")));
		const libcrypto = path.join(libs, "Cellar", "openssl@4", "4.0.0", "lib", "libcrypto.4.dylib");
		fs.mkdirSync(path.dirname(libcrypto), { recursive: true });
		fs.writeFileSync(libcrypto, "stand-in");
		try {
			const homebrew = runListingJob({ answer: JSON.stringify([process.execPath, libcrypto]) });
			assert(isDeepStrictEqual(homebrew.files, [...mainProgram(), libcrypto]), `Homebrew's files: ${homebrew.files.join(" ")}`);
			for (const [what, files, rules] of [["this Node's", fileProgram().files, rulesFor(fileProgram().files)], ["Homebrew's", homebrew.files, homebrew.rules]] as const) {
				// A settings file is `openssl.cnf`, or a file it pulls in: none is named, though a library's folder may say openssl.
				assert(!files.some((file: string) => /\.cnf$/i.test(file)) && !/\.cnf\b/i.test(JSON.stringify(rules)), `${what} files: ${files.join(" ")}`);
				assert(/^\(deny file-read-data \(require-not \(require-any [^\n]*\(literal "\/dev\/null"\)/m.test(rules.profileRules), `${what} reads: ${rules.profileRules.split("\n")[0]}`);
			}
		} finally {
			fs.rmSync(libs, { recursive: true, force: true });
		}
	});

	await row("a boxed command gets no OpenSSL setting, though the server has one", async () => {
		const record = path.join(home, ".exxperts.box-commands");
		process.env.OPENSSL_CONF = "/dev/null";
		try {
			const commands = createRoomCommandTools(folder, { box, outside: { questions: { ...quietQuestions, askOutside: async () => false } as any, setOffered: () => {} } });
			const ran = await commands.tools.find((tool) => tool.name === "bash")!.execute("cmd", { command: "/usr/bin/env" } as any, undefined as any, undefined as any, undefined as any);
			const printed = (ran.content ?? []).map((part: any) => part.text ?? "").join("");
			assert(/^SHELL=\/bin\/bash$/m.test(printed) && !/OPENSSL/.test(printed), `the command's environment: ${printed}`);
		} finally {
			delete process.env.OPENSSL_CONF;
			fs.rmSync(record, { force: true });
			await nextTurn();
		}
	});

	await row("each of the six tools works in the box, and a closed name stays out", async () => {
		const read = await call("read", { path: "notes.txt" });
		assert(!read.failed && read.text.includes("needle here"), `read: ${read.text}`);
		const listed = await call("ls", {});
		assert(!listed.failed && listed.text.includes("docs/") && listed.text.includes("notes.txt") && !/^\.env$/m.test(listed.text) && listed.text.includes(".env.example") && listed.text.includes("1 entry left out"), `ls: ${listed.text}`);
		const found = await call("find", { pattern: "*.md" });
		assert(!found.failed && found.text.includes("docs/plan.md"), `find: ${found.text}`);
		const searched = await call("grep", { pattern: "needle", context: 1 });
		assert(!searched.failed && searched.text.includes("notes.txt:3: needle here") && searched.text.includes("notes.txt-2- line two") && searched.text.includes("docs/plan.md:1: plan needle") && !searched.text.includes("TOKEN"), `grep: ${searched.text}`);
		const wrote = await call("write", { path: "made/new.txt", content: "written in the box" });
		assert(!wrote.failed && fs.readFileSync(inRoom("made", "new.txt"), "utf8") === "written in the box", `write: ${wrote.text}`);
		const again = await call("write", { path: "made/new.txt", content: "twice" });
		assert(again.failed && again.text.startsWith("File already exists"), `write without overwrite: ${again.text}`);
		const edited = await call("edit", { path: "made/new.txt", edits: [{ oldText: "in the box", newText: "and edited" }] });
		assert(!edited.failed && fs.readFileSync(inRoom("made", "new.txt"), "utf8") === "written and edited", `edit: ${edited.text}`);
		const secret = await call("read", { path: ".env" });
		assert(secret.failed && !secret.text.includes("TOKEN=secret"), `a closed name: ${secret.text}`);
	});

	await row("in a room that asks nothing the person's keys in the room's folder open in the box for all six tools, a key's name with no deck in it included; the room's own tools still refuse them", async () => {
		fs.mkdirSync(inRoom(".ssh"));
		fs.writeFileSync(inRoom(".ssh", "config"), "Host synthetic\n");
		fs.writeFileSync(inRoom("server.key"), "KEY synthetic\n");
		const kept = tools;
		try {
			for (const closed of [".env", ".ssh/config", "server.key"]) {
				const refused = await call("read", { path: closed });
				assert(refused.failed && refused.text === closedRefusal(closed), `the room's own tools, ${closed}: ${refused.text}`);
			}
			tools = new Map(createPersistentRoomWorkspaceTools(policy, { box, asksNothing: () => true }).map((tool) => [String(tool.name), tool]));
			for (const [file, text] of [[".env", "TOKEN=secret"], [".ssh/config", "Host synthetic"], ["server.key", "KEY synthetic"]] as const) {
				const read = await call("read", { path: file });
				assert(!read.failed && read.text.includes(text), `read ${file}: ${read.text}`);
			}
			const listed = await call("ls", {});
			assert(!listed.failed && [".env", ".ssh/", "server.key"].every((entry) => listed.text.split("\n").includes(entry)) && !listed.text.includes("left out"), `ls: ${listed.text}`);
			const found = await call("find", { pattern: "**/config" });
			assert(!found.failed && found.text.split("\n").includes(".ssh/config"), `find: ${found.text}`);
			const searched = await call("grep", { pattern: "TOKEN=secret|synthetic" });
			assert(!searched.failed && [".env:1: TOKEN=secret", ".ssh/config:1: Host synthetic", "server.key:1: KEY synthetic"].every((line) => searched.text.includes(line)), `grep: ${searched.text}`);
			const wrote = await call("write", { path: ".env", content: "TOKEN=written\n", overwrite: true });
			const edited = await call("edit", { path: ".env", edits: [{ oldText: "written", newText: "edited" }] });
			assert(!wrote.failed && !edited.failed && fs.readFileSync(inRoom(".env"), "utf8") === "TOKEN=edited\n", `write and edit .env: ${wrote.text} / ${edited.text}`);
		} finally {
			tools = kept;
			fs.rmSync(inRoom(".ssh"), { recursive: true, force: true });
			fs.rmSync(inRoom("server.key"), { force: true });
			fs.writeFileSync(inRoom(".env"), "TOKEN=secret\n");
		}
	});

	await row("in a room that asks nothing the names other programs run from in the room's folder are written and edited in the box, its program writes them past the fence too, and ask_for_folder opens their folder", async () => {
		const names = [".vscode/tasks.json", ".claude/settings.json", ".husky/pre-commit", "repo/.git/hooks/pre-commit", "repo/.git/config"];
		const made = "fresh/.git/HEAD";
		const plant = () => {
			for (const name of names) {
				fs.mkdirSync(path.dirname(inRoom(name)), { recursive: true });
				fs.writeFileSync(inRoom(name), "kept\n");
			}
			fs.rmSync(inRoom("fresh"), { recursive: true, force: true });
		};
		plant();
		const kept = tools;
		try {
			tools = stateTools(() => true);
			for (const name of [...names, made]) await writtenAndEdited(name, name === made);
			// The fence the tools use in this state, and the box's program past it: each write lands.
			plant();
			const fence = roomFence(policy, () => [], undefined, true);
			const files = new BoxFiles(box, fence);
			for (const name of [...names, made]) {
				await files.write(fencePath(fence, name, "write"), name, "past the fence\n", true);
				assert(fs.readFileSync(inRoom(name), "utf8") === "past the fence\n", `the box's program, ${name}`);
			}
			// ask_for_folder says the same as the write: the folder can be changed, as an ordinary one beside it can.
			const asked = (folder: string) => {
				try {
					return openedWithoutAsking(policy, folder, "write").real;
				} catch (error) {
					return (error as Error).message;
				}
			};
			assert(asked(inRoom(".vscode")) === inRoom(".vscode"), `ask_for_folder for .vscode: ${asked(inRoom(".vscode"))}`);
			fs.mkdirSync(inRoom("plain-folder"), { recursive: true });
			assert(asked(inRoom("plain-folder")) === inRoom("plain-folder"), `ask_for_folder for an ordinary folder: ${asked(inRoom("plain-folder"))}`);
		} finally {
			tools = kept;
			for (const place of [".vscode", ".claude", ".husky", "repo", "fresh", "plain-folder"]) fs.rmSync(inRoom(place), { recursive: true, force: true });
		}
	});

	// --- A room that asks nothing (Auto with protection off): in the box its file tools change what its commands can, but the one list.
	await row("in a room that asks nothing the file tools write and edit, in the room's folder and in an Also allowed folder, what its commands can change: .vscode, .claude, .husky, a git hook, .git/config, a new .git/HEAD with its folders, .zshrc, .npmrc, a .code-workspace file and a top-level HEAD", async () => {
		const also = fs.realpathSync(fs.mkdtempSync(path.join(home, "also-")));
		addAlsoAllowedFolder(ROOM_ID, also, "write");
		const there = [".vscode/tasks.json", ".claude/settings.json", ".husky/pre-commit", "repo/.git/hooks/pre-commit", "repo/.git/config", ".zshrc", ".npmrc", "team.code-workspace", "HEAD"];
		const kept = tools;
		try {
			tools = stateTools(() => true);
			for (const base of [folder, also]) {
				for (const name of there) {
					fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
					fs.writeFileSync(path.join(base, name), "kept\n");
				}
				for (const name of there) await writtenAndEdited(path.join(base, name));
				await writtenAndEdited(path.join(base, "fresh", ".git", "HEAD"), true);
			}
		} finally {
			tools = kept;
			saveAlsoAllowedFolders(ROOM_ID, []);
			fs.rmSync(also, { recursive: true, force: true });
			for (const place of [".vscode", ".claude", ".husky", "repo", "fresh", ".zshrc", ".npmrc", "team.code-workspace", "HEAD"]) fs.rmSync(inRoom(place), { recursive: true, force: true });
		}
	});

	await row("in a room that asks nothing .mcp.json, sub/.MCP.JSON and sub/.exxperts/x stay closed to writes, from the fence and from the box's program past it; a file beside each is written both ways", async () => {
		const closed = [[".mcp.json", neverChanged(".mcp.json")], ["sub/.MCP.JSON", neverChanged("sub/.MCP.JSON")], ["sub/.exxperts/x", closedRefusal("sub/.exxperts/x")]] as const;
		const beside = ["settings.json", "sub/settings.json", "sub/notes/x"];
		for (const name of [...closed.map(([name]) => name), ...beside]) {
			fs.mkdirSync(path.dirname(inRoom(name)), { recursive: true });
			fs.writeFileSync(inRoom(name), "kept\n");
		}
		const kept = tools;
		try {
			tools = stateTools(() => true);
			const fence = roomFence(policy, () => [], undefined, true);
			for (const [name, line] of closed) {
				const wrote = await call("write", { path: name, content: "changed\n", overwrite: true });
				assert(wrote.failed && wrote.text === line, `the fence, ${name}: ${wrote.text}`);
				const program = await programWrite(fence, inRoom(name), fence.room!);
				assert(program === "box_refused", `the box's program, ${name}: ${program ?? "written"}`);
				assert(fs.readFileSync(inRoom(name), "utf8") === "kept\n", `${name} is as it was`);
			}
			// Protection is off in this room, so the box's refusal names none.
			const said = await new BoxFiles(box, fence).write({ real: inRoom(".mcp.json"), root: fence.room!, shown: ".mcp.json", exists: true, needsDeck: false }, inRoom(".mcp.json"), "past the fence\n", true).then(() => "written", (error: Error) => error.message);
			assert(said === ".mcp.json can't be opened: this room's rules for files refused it, or another program has it locked. Tell the person.", `the box's refusal: ${said}`);
			for (const name of beside) {
				await writtenAndEdited(name);
				const program = await programWrite(fence, inRoom(name), fence.room!);
				assert(program === null && fs.readFileSync(inRoom(name), "utf8") === "past the fence\n", `the box's program, ${name}: ${program}`);
			}
		} finally {
			tools = kept;
			for (const place of [".mcp.json", "settings.json", "sub"]) fs.rmSync(inRoom(place), { recursive: true, force: true });
		}
	});

	await row("in a room that asks nothing a folder set to Can read takes no write, from the fence or from the box's program past it; the room's folder beside it does", async () => {
		const readOnly = fs.realpathSync(fs.mkdtempSync(path.join(home, "can-read-")));
		const inReadOnly = path.join(readOnly, ".vscode", "tasks.json");
		for (const file of [inReadOnly, inRoom(".vscode", "tasks.json")]) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "kept\n");
		}
		addAlsoAllowedFolder(ROOM_ID, readOnly, "read");
		const kept = tools;
		try {
			tools = stateTools(() => true);
			const wrote = await call("write", { path: inReadOnly, content: "changed\n", overwrite: true });
			assert(wrote.failed && wrote.text.startsWith(readOnlyFolder(inReadOnly)), `the fence: ${wrote.text}`);
			const fence = roomFence(policy, () => [], undefined, true);
			const root = fence.roots().find((each) => each.path === readOnly);
			assert(root?.access === "read", `the folder's place: ${JSON.stringify(root)}`);
			const program = await programWrite(fence, inReadOnly, root);
			assert(program === "box_refused" && fs.readFileSync(inReadOnly, "utf8") === "kept\n", `the box's program: ${program ?? "written"}`);
			await writtenAndEdited(".vscode/tasks.json");
			const beside = await programWrite(fence, inRoom(".vscode", "tasks.json"), fence.room!);
			assert(beside === null, `the box's program in the room's folder: ${beside}`);
		} finally {
			tools = kept;
			saveAlsoAllowedFolders(ROOM_ID, []);
			fs.rmSync(readOnly, { recursive: true, force: true });
			fs.rmSync(inRoom(".vscode"), { recursive: true, force: true });
		}
	});

	await row("in a room that asks nothing with Can change files off the room has no write or edit tool, and the box's program past the fence writes nothing; with it on the same write lands", async () => {
		const readOnlyPolicy = createPersistentRoomCapabilityPolicy({ agentId: ROOM_ID, conversationId: "conversation-a", repoRoot, root: folder, workspaceAccessMode: "localFiles", source: "manual", toolSelection: { kind: "custom", allowedToolNames: [...PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES] } });
		const file = inRoom(".vscode", "tasks.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "kept\n");
		try {
			const names = createPersistentRoomWorkspaceTools(readOnlyPolicy, { box, asksNothing: () => true }).map((tool) => String(tool.name));
			assert(names.includes("read") && !names.includes("write") && !names.includes("edit"), `the tools: ${names.join(", ")}`);
			const fence = roomFence(readOnlyPolicy, () => [], undefined, true);
			assert(fence.asksNothing && fence.room?.access === "read", `the fence: ${fence.asksNothing} ${fence.room?.access}`);
			const program = await programWrite(fence, file, fence.room);
			assert(program === "box_refused" && fs.readFileSync(file, "utf8") === "kept\n", `the box's program: ${program ?? "written"}`);
			const changing = roomFence(policy, () => [], undefined, true);
			const lands = await programWrite(changing, file, changing.room!);
			assert(lands === null && fs.readFileSync(file, "utf8") === "past the fence\n", `with Can change files on: ${lands}`);
		} finally {
			fs.rmSync(inRoom(".vscode"), { recursive: true, force: true });
		}
	});

	await row("in a room that asks nothing a write swapped between check and open lands nowhere: through a link to a folder outside the room's folders, or into .exxperts; with no swap it lands", async () => {
		fs.mkdirSync(inRoom(".exxperts"), { recursive: true });
		const kept = tools;
		try {
			tools = stateTools(() => true);
			for (const [label, target] of [["outside the room's folders", elsewhere], [".exxperts", inRoom(".exxperts")]] as const) {
				fs.rmSync(inRoom("sub"), { recursive: true, force: true });
				fs.mkdirSync(inRoom("sub"));
				const write = await withSwapBeforeOpen(() => {
					fs.rmSync(inRoom("sub"), { recursive: true });
					fs.symlinkSync(target, inRoom("sub"));
				}, () => call("write", { path: "sub/planted.txt", content: "planted" }));
				assert(write.failed && !fs.existsSync(path.join(target, "planted.txt")), `${label}: ${write.text}`);
			}
			fs.rmSync(inRoom("sub"), { recursive: true, force: true });
			fs.mkdirSync(inRoom("sub"));
			const plain = await call("write", { path: "sub/planted.txt", content: "planted" });
			assert(!plain.failed && fs.readFileSync(inRoom("sub", "planted.txt"), "utf8") === "planted", `with no swap: ${plain.text}`);
		} finally {
			tools = kept;
			for (const place of ["sub", ".exxperts"]) fs.rmSync(inRoom(place), { recursive: true, force: true });
			fs.rmSync(path.join(elsewhere, "planted.txt"), { force: true });
		}
	});

	await row("one set of tools in a room that switches: after Auto to Ask the next write of .vscode/tasks.json is refused as before, and after Ask to Auto the next goes through", async () => {
		let asksNothing = true;
		fs.mkdirSync(inRoom(".vscode"), { recursive: true });
		fs.writeFileSync(inRoom(".vscode", "tasks.json"), "kept\n");
		const kept = tools;
		try {
			tools = stateTools(() => asksNothing);
			await writtenAndEdited(".vscode/tasks.json");
			asksNothing = false;
			const refused = await call("write", { path: ".vscode/tasks.json", content: "changed\n", overwrite: true });
			assert(refused.failed && refused.text === neverChanged(".vscode/tasks.json") && fs.readFileSync(inRoom(".vscode", "tasks.json"), "utf8") === "edited\n", `on Ask: ${refused.text}`);
			asksNothing = true;
			await writtenAndEdited(".vscode/tasks.json");
		} finally {
			tools = kept;
			fs.rmSync(inRoom(".vscode"), { recursive: true, force: true });
		}
	});

	await row("what stays closed to writes in a room that asks nothing is one list: the box's rules close exactly its names, and the fence refuses a write of each of them and of no other name commands run from", async () => {
		const rules = fileRules({ roots: [{ path: folder, access: "write" }], writes: true, closedBelow: [], asksNothing: true, program: [] });
		const named = new Set((rules.filesystem.denyWrite as unknown[]).filter((entry): entry is string => typeof entry === "string").map((pattern) => pattern.replace(`${folder}/`, "").replace(/^\*\*\//, "")));
		assert(isDeepStrictEqual([...named].sort(), [...CLOSED_TO_WRITES_ASKING_NOTHING].sort()), `the box's rules close: ${[...named].join(", ")}`);
		const fence = roomFence(policy, () => [], undefined, true);
		const refused = (name: string): boolean => {
			try {
				fencePath(fence, name, "write");
				return false;
			} catch (error) {
				if (error instanceof RoomFilesError) return true;
				throw error;
			}
		};
		for (const name of [...NEVER_WRITABLE_FILES, ...NEVER_WRITABLE_FOLDERS.map((each) => `${each}/x`)]) {
			const listed = CLOSED_TO_WRITES_ASKING_NOTHING.some((each) => name === each || name.startsWith(`${each}/`));
			assert(refused(name) === listed, `the fence ${listed ? "lets through" : "refuses"} ${name}`);
		}
	});

	await row("the sandbox library's own write denies sit under the box worker's working folder, which no room's folder is in: those names in the room's folder are written in the box; a box whose worker started in the room's folder refuses them", async () => {
		const names = [".vscode/tasks.json", ".idea/workspace.xml", ".claude/commands/deploy.md", ".claude/agents/helper.md", "repo/.git/hooks/pre-commit", "repo/.git/config", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".gitmodules", ".ripgreprc"];
		for (const name of names) {
			fs.mkdirSync(path.dirname(inRoom(name)), { recursive: true });
			fs.writeFileSync(inRoom(name), "kept\n");
		}
		const started = process.cwd();
		assert(!isInside(folder, started), `the room's folder is in the box worker's working folder ${started}`);
		try {
			tools = stateTools(() => true);
			for (const name of names) await writtenAndEdited(name);
			// The control: the library's denies are anchored where the worker started.
			await box.endTurn();
			process.chdir(folder);
			bind();
			tools = stateTools(() => true);
			const refused = await call("write", { path: ".vscode/tasks.json", content: "changed\n", overwrite: true });
			assert(refused.failed && refused.text.includes("this room's rules for files refused it") && fs.readFileSync(inRoom(".vscode", "tasks.json"), "utf8") === "edited\n", `a worker started in the room's folder: ${refused.text}`);
		} finally {
			process.chdir(started);
			await nextTurn();
			for (const place of [".vscode", ".idea", ".claude", "repo", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".gitmodules", ".ripgreprc"]) fs.rmSync(inRoom(place), { recursive: true, force: true });
		}
	});

	await row("on a boxed Mac the tools open and write nothing by name in the room; the parsers' copies aside", async () => {
		const opened: string[] = [];
		const spied = ["open", "readFile", "writeFile", "mkdir", "readdir", "opendir", "rm", "rename", "copyFile", "appendFile"] as const;
		const spiedSync = ["openSync", "readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "opendirSync", "rmSync", "renameSync", "copyFileSync", "appendFileSync"] as const;
		const originals = new Map<string, any>();
		const note = (target: unknown) => {
			if (typeof target === "string" && target.startsWith(folder)) opened.push(target);
		};
		for (const name of spied) {
			originals.set(`p.${name}`, (fs.promises as any)[name]);
			(fs.promises as any)[name] = (target: unknown, ...rest: unknown[]) => (note(target), originals.get(`p.${name}`).call(fs.promises, target, ...rest));
		}
		for (const name of spiedSync) {
			originals.set(name, (fs as any)[name]);
			(fs as any)[name] = (target: unknown, ...rest: unknown[]) => (note(target), originals.get(name).call(fs, target, ...rest));
		}
		try {
			for (const [name, input] of [["read", { path: "notes.txt" }], ["ls", {}], ["find", { pattern: "*" }], ["grep", { pattern: "needle" }], ["write", { path: "spy.txt", content: "x", overwrite: true }], ["edit", { path: "spy.txt", edits: [{ oldText: "x", newText: "y" }] }]] as const) {
				const result = await call(name, input);
				assert(!result.failed, `${name}: ${result.text}`);
			}
		} finally {
			for (const name of spied) (fs.promises as any)[name] = originals.get(`p.${name}`);
			for (const name of spiedSync) (fs as any)[name] = originals.get(name);
		}
		assert(opened.length === 0, `opened by name: ${opened.join(", ")}`);
	});

	await row("a job swaps a folder in the room for a link: a system file and a closed name through it are refused by the Mac", async () => {
		fs.mkdirSync(inRoom("sub"));
		fs.writeFileSync(inRoom("sub", "hosts"), "the room's own hosts note");
		const system = await withSwapBeforeOpen(() => {
			fs.rmSync(inRoom("sub"), { recursive: true });
			fs.symlinkSync("/etc", inRoom("sub"));
		}, () => call("read", { path: "sub/hosts" }));
		assert(system.failed && system.text.includes("this room's rules for files refused it") && !system.text.includes("localhost"), `a system file through the link: ${system.text}`);
		fs.rmSync(inRoom("sub"));
		fs.mkdirSync(inRoom(".pi"));
		fs.writeFileSync(inRoom(".pi", "settings.json"), "{\"key\":\"app data\"}");
		fs.mkdirSync(inRoom("sub"));
		fs.writeFileSync(inRoom("sub", "settings.json"), "{}");
		const closed = await withSwapBeforeOpen(() => {
			fs.rmSync(inRoom("sub"), { recursive: true });
			fs.symlinkSync(inRoom(".pi"), inRoom("sub"));
		}, () => call("read", { path: "sub/settings.json" }));
		assert(closed.failed && closed.text.includes("this room's rules for files refused it") && !closed.text.includes("app data"), `a closed name through the link: ${closed.text}`);
		fs.rmSync(inRoom("sub"));
		// The allowed neighbour: the same read with no swap.
		fs.mkdirSync(inRoom("sub"));
		fs.writeFileSync(inRoom("sub", "hosts"), "the room's own hosts note");
		const plain = await call("read", { path: "sub/hosts" });
		assert(!plain.failed && plain.text.includes("own hosts note"), `the read with no swap: ${plain.text}`);
	});

	await row("a swap between check and open: the read gets nothing, and the write lands nowhere", async () => {
		fs.writeFileSync(path.join(elsewhere, "private.txt"), "outside the fence");
		fs.rmSync(inRoom("sub"), { recursive: true });
		fs.mkdirSync(inRoom("sub"));
		fs.writeFileSync(inRoom("sub", "private.txt"), "inside");
		const swap = () => {
			fs.rmSync(inRoom("sub"), { recursive: true });
			fs.symlinkSync(elsewhere, inRoom("sub"));
		};
		const read = await withSwapBeforeOpen(swap, () => call("read", { path: "sub/private.txt" }));
		assert(read.failed && !read.text.includes("outside the fence"), `the read: ${read.text}`);
		fs.rmSync(inRoom("sub"));
		fs.mkdirSync(inRoom("sub"));
		const write = await withSwapBeforeOpen(swap, () => call("write", { path: "sub/planted.txt", content: "planted" }));
		assert(write.failed && !fs.existsSync(path.join(elsewhere, "planted.txt")), `the write: ${write.text}`);
		fs.rmSync(inRoom("sub"));
		fs.mkdirSync(inRoom("sub"));
		const list = await withSwapBeforeOpen(swap, () => call("ls", { path: "sub" }));
		assert(list.failed && !list.text.includes("private.txt"), `the listing: ${list.text}`);
		fs.rmSync(inRoom("sub"), { recursive: true, force: true });
	});

	await row("a file swapped for a named pipe between check and open answers at once", async () => {
		fs.writeFileSync(inRoom("pipe.txt"), "a file now");
		const started = Date.now();
		const read = await withSwapBeforeOpen(() => {
			fs.rmSync(inRoom("pipe.txt"));
			execFileSync("/usr/bin/mkfifo", [inRoom("pipe.txt")]);
		}, () => call("read", { path: "pipe.txt" }));
		assert(read.failed && read.text.includes("is not a file") && Date.now() - started < 5_000, `the read: ${read.text}`);
		const write = await withSwapBeforeOpen(() => {}, () => call("write", { path: "pipe.txt", content: "x", overwrite: true }));
		assert(write.failed && Date.now() - started < 10_000, `the write: ${write.text}`);
		fs.rmSync(inRoom("pipe.txt"));
	});

	await row("a file swapped for a link to a key in the room between check and open: the read gets nothing", async () => {
		fs.writeFileSync(inRoom("signing.key"), "PRIVATE KEY BYTES");
		fs.writeFileSync(inRoom("plain.txt"), "plain text");
		const read = await withSwapBeforeOpen(() => {
			fs.rmSync(inRoom("plain.txt"));
			fs.symlinkSync(inRoom("signing.key"), inRoom("plain.txt"));
		}, () => call("read", { path: "plain.txt" }));
		assert(read.failed && !read.text.includes("PRIVATE KEY"), `the read: ${read.text}`);
		fs.rmSync(inRoom("plain.txt"));
		fs.writeFileSync(inRoom("plain.txt"), "plain text");
		const plain = await call("read", { path: "plain.txt" });
		assert(!plain.failed && plain.text.includes("plain text"), `the read with no swap: ${plain.text}`);
		fs.rmSync(inRoom("plain.txt"));
		fs.rmSync(inRoom("signing.key"));
	});

	await row("Stop while the program is being wrapped: nothing of it runs", async () => {
		const stop = new AbortController();
		const request = BoxProcess.prototype.request;
		BoxProcess.prototype.request = async function (this: BoxProcess, kind: string, body: any) {
			const answer = await request.call(this, kind, body);
			if (kind === "wrap" && body.command === fileProgram().command) stop.abort();
			return answer;
		} as typeof BoxProcess.prototype.request;
		try {
			const wrote = await call("write", { path: "stopped-in-wrap.txt", content: "x" }, stop.signal);
			assert(wrote.failed && !fs.existsSync(inRoom("stopped-in-wrap.txt")), `the write: ${wrote.text}`);
		} finally {
			BoxProcess.prototype.request = request;
		}
	});

	await row("a file is changed in place: it keeps its access list and tags, and Stop waits for a write already running", async () => {
		const target = inRoom("replace-me.txt");
		fs.writeFileSync(target, "ORIGINAL");
		fs.chmodSync(target, 0o640);
		execFileSync("/usr/bin/xattr", ["-w", "com.example.tag", "kept", target]);
		execFileSync("/bin/chmod", ["+a", "user:nobody deny read", target]);
		const edited = await call("edit", { path: "replace-me.txt", edits: [{ oldText: "ORIGINAL", newText: "EDITED" }] });
		assert(!edited.failed && fs.readFileSync(target, "utf8") === "EDITED", `the edit: ${edited.text}`);
		const listed = accessList(target);
		// portability-ok: the row runs only on a Mac
		assert(listed.includes(NOBODY_DENIED_READ) && (fs.statSync(target).mode & 0o777) === 0o640, `the access list after the edit: ${listed}`);
		assert(execFileSync("/usr/bin/xattr", ["-p", "com.example.tag", target], { encoding: "utf8" }).trim() === "kept", "the tag after the edit");
		// Stop while a write runs: the program is held mid-way, Stop comes, and it still runs to its end.
		const signalGroup = (pid: number, signal: NodeJS.Signals) => {
			try {
				process.kill(-pid, signal);
			} catch {
				// Not a group's leader.
			}
		};
		const programPids = () => fileProgramPidsIn(folder);
		const content = "N".repeat(64 * 1024 * 1024);
		let held = false;
		for (let tries = 0; tries < 5 && !held; tries += 1) {
			const stop = new AbortController();
			const writing = call("write", { path: "replace-me.txt", content, overwrite: true }, stop.signal);
			let settled = false;
			void writing.then(() => { settled = true; });
			let pids: number[] = [];
			while (!settled && pids.length === 0) {
				await new Promise((resolve) => setImmediate(resolve));
				pids = programPids();
			}
			if (!settled) {
				for (const pid of pids) signalGroup(pid, "SIGSTOP");
				held = true;
				stop.abort();
				await new Promise((resolve) => setTimeout(resolve, 300));
				const alive = programPids().length > 0;
				for (const pid of pids) signalGroup(pid, "SIGCONT");
				assert(alive, "Stop ended a write already running");
			}
			const ended = await writing;
			if (held) assert(!ended.failed && fs.statSync(target).size === content.length, `the write after Stop: ${ended.text}, the file holds ${fs.statSync(target).size} bytes`);
		}
		assert(held, "no write was ever seen running");
		fs.rmSync(target);
	});

	await row("a replace larger than the disk's free space is refused and leaves the file as it was; one that fits goes through", async () => {
		// A real full disk: a 24 MB disk image holds about 23 MB, so 32 MB never fits.
		const image = path.join(home, "full-disk.dmg");
		const disk = path.join(home, "full-disk");
		fs.mkdirSync(disk);
		execFileSync("/usr/bin/hdiutil", ["create", "-size", "24m", "-fs", "APFS", "-volname", "fulldisk", "-o", image, "-quiet"]);
		execFileSync("/usr/bin/hdiutil", ["attach", image, "-mountpoint", disk, "-nobrowse", "-quiet"]);
		const roomTools = tools;
		const diskBox = newBox();
		try {
			const onDisk = createPersistentRoomCapabilityPolicy({ agentId: ROOM_ID, conversationId: "conversation-a", repoRoot, root: disk, workspaceAccessMode: "localFiles", source: "manual" });
			tools = new Map(createPersistentRoomWorkspaceTools(onDisk, { box: diskBox }).map((tool) => [String(tool.name), tool]));
			const target = path.join(disk, "kept.txt");
			fs.writeFileSync(target, "KEPT");
			execFileSync("/bin/chmod", ["+a", "user:nobody deny read", target]);
			const tooBig = await call("write", { path: "kept.txt", content: "B".repeat(32 * 1024 * 1024), overwrite: true });
			assert(fs.readFileSync(target, "utf8") === "KEPT", `the file after the write too big for the disk holds ${fs.statSync(target).size} bytes (${tooBig.text.slice(0, 200)})`);
			assert(accessList(target).includes(NOBODY_DENIED_READ), "the access list after the refusal");
			assert(tooBig.failed && tooBig.text === notEnoughSpace("kept.txt"), `the write too big for the disk: ${tooBig.text.slice(0, 200)}`);
			const fits = await call("write", { path: "kept.txt", content: "FITS", overwrite: true });
			assert(!fits.failed && fs.readFileSync(target, "utf8") === "FITS", `the write that fits: ${fits.text}`);
		} finally {
			tools = roomTools;
			await diskBox.endTurn();
			execFileSync("/usr/bin/hdiutil", ["detach", disk, "-force", "-quiet"]);
			fs.rmSync(disk, { recursive: true, force: true });
			fs.rmSync(image, { force: true });
		}
	});

	await row("office files read in the box, and the copy is gone after", async () => {
		fs.writeFileSync(inRoom("terms.pdf"), minimalPdf());
		fs.writeFileSync(inRoom("contract.docx"), await minimalDocx());
		fs.writeFileSync(inRoom("sales.xlsx"), workbook());
		fs.writeFileSync(inRoom("pixel.png"), ONE_PIXEL_PNG);
		const before = copiesLeft();
		const pdf = await call("read", { path: "terms.pdf" });
		assert(!pdf.failed && pdf.text.includes("Quarterly payment terms"), `pdf: ${pdf.text}`);
		const docx = await call("read", { path: "contract.docx" });
		assert(!docx.failed && docx.text.includes("renewal is automatic"), `docx: ${docx.text}`);
		const xlsx = await call("read", { path: "sales.xlsx" });
		assert(!xlsx.failed && xlsx.text.includes("North") && xlsx.text.includes("sales.xlsx"), `xlsx: ${xlsx.text}`);
		const png = await call("read", { path: "pixel.png" });
		assert(!png.failed && png.result.content.some((part: any) => part.type === "image"), `png: ${png.text}`);
		assert(copiesLeft() === before, "a copy was left in the temp");
	});

	await row("one call's cost: p50 per call", async () => {
		const times: number[] = [];
		for (let index = 0; index < 20; index += 1) {
			const started = performance.now();
			const read = await call("read", { path: "notes.txt" });
			times.push(performance.now() - started);
			assert(!read.failed, read.text);
		}
		times.sort((a, b) => a - b);
		console.log(`       p50 ${times[10].toFixed(0)} ms, p95 ${times[18].toFixed(0)} ms per read call (n=20)`);
	});

	await row("Stop ends the program at once, and a slow search ends at its deadline", async () => {
		fs.writeFileSync(inRoom("slow.txt"), `${"a".repeat(40)}!\n`.repeat(50));
		const stop = new AbortController();
		const started = Date.now();
		setTimeout(() => stop.abort(), 500);
		const stopped = await call("grep", { pattern: "(a+)+$" }, stop.signal);
		assert(stopped.failed && Date.now() - started < 5_000, `stopped: ${stopped.text} after ${Date.now() - started} ms`);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert(programsAlive() === 0, "a program outlived its Stop");
		const timed = await call("grep", { pattern: "(a+)+$" });
		assert(!timed.failed && timed.text.includes("Search stopped after"), `the deadline: ${timed.text}`);
		assert(programsAlive() === 0, "a program outlived its deadline");
		fs.rmSync(inRoom("slow.txt"));
	});

	await row("the turn's end stops a program still running", async () => {
		fs.writeFileSync(inRoom("slow.txt"), `${"a".repeat(40)}!\n`.repeat(50));
		const running = call("grep", { pattern: "(a+)+$" });
		const deadline = Date.now() + 5_000;
		while (programsAlive() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		assert(programsAlive() > 0, "the program never started");
		await nextTurn();
		const ended = await running;
		assert(ended.failed && ended.text.includes("turn ended"), `the call: ${ended.text}`);
		assert(programsAlive() === 0, "a program outlived its turn");
		fs.rmSync(inRoom("slow.txt"));
	});

	await row("a long output reads by its exact path; another file in the private temp doesn't", async () => {
		const commands = createRoomCommandTools(folder, { box, outside: { questions: { ...quietQuestions, askOutside: async () => false } as any, setOffered: () => {} } });
		const bash = commands.tools.find((tool) => tool.name === "bash");
		assert(bash, "no bash tool");
		const result: any = await bash.execute("cmd", { command: "/usr/bin/seq 1 5000" } as any, undefined as any, undefined as any, undefined as any);
		const text = (result.content ?? []).map((part: any) => part.text ?? "").join("");
		const spill = /\S*\/temp-[0-9a-f]+\/[0-9a-f]{32}\.log/.exec(text)?.[0];
		assert(spill && !/with a command/.test(text), `the note: ${text.slice(-200)}`);
		const read = await call("read", { path: spill, offset: 4999 });
		assert(!read.failed && read.text.includes("5000"), `the spill: ${read.text}`);
		const other = path.join(path.dirname(spill), "other.log");
		fs.writeFileSync(other, "another file");
		const refused = await call("read", { path: other });
		assert(refused.failed && !refused.text.includes("another file"), `another file: ${refused.text}`);
	});

	await row("a file a command made under $TMPDIR is refused to the file tools as this answer's temp, with no step for the person", async () => {
		const commands = createRoomCommandTools(folder, { box, outside: { questions: { ...quietQuestions, askOutside: async () => false } as any, setOffered: () => {} } });
		const bash = commands.tools.find((tool) => tool.name === "bash");
		assert(bash, "no bash tool");
		const made: any = await bash.execute("cmd", { command: 'echo poster > "$TMPDIR/poster.txt"; echo "at:$TMPDIR/poster.txt"' } as any, undefined as any, undefined as any, undefined as any);
		const poster = /at:(\S+)/.exec((made.content ?? []).map((part: any) => part.text ?? "").join(""))?.[1] ?? "";
		assert(poster && fs.readFileSync(poster, "utf8") === "poster\n", `the command's file: ${poster}`);
		const read = await call("read", { path: poster });
		assert(read.failed && read.text === ownTempRefusal(poster), `the read: ${read.text}`);
		const beside = path.join(path.dirname(poster), "beside.txt");
		const wrote = await call("write", { path: beside, content: "x\n" });
		assert(wrote.failed && wrote.text === ownTempRefusal(beside) && !fs.existsSync(beside), `the write: ${wrote.text}`);
		// The room's folder beside it takes the same file.
		const intoRoom = await call("write", { path: "poster.txt", content: "poster\n" });
		assert(!intoRoom.failed && fs.readFileSync(inRoom("poster.txt"), "utf8") === "poster\n", `the write into the room: ${intoRoom.text}`);
		fs.rmSync(inRoom("poster.txt"));
	});

	await row("a file program's read of a folder swapped for a link just before the open is refused", async () => {
		await nextTurn();
		// In this turn the Mac blocks a file program's read of a folder outside the room.
		fs.mkdirSync(inRoom("sub"));
		fs.writeFileSync(inRoom("sub", "private.txt"), "inside");
		const read = await withSwapBeforeOpen(() => {
			fs.rmSync(inRoom("sub"), { recursive: true });
			fs.symlinkSync(elsewhere, inRoom("sub"));
		}, () => call("read", { path: "sub/private.txt" }));
		assert(read.failed && read.text.includes("this room's rules for files refused it"), `the read: ${read.text}`);
		fs.rmSync(inRoom("sub"));
	});


	await row("a scheduled run's file tools run in the box, and its programs and box are gone at the run's end", async () => {
		// A real scheduled run, with a scripted model that reads one file and then answers.
		const agentDir = path.join(home, ".exxperts", "agent");
		const appRoot = path.join(home, ".exxperts", "app");
		fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(appRoot, { recursive: true, mode: 0o700 });
		const answered = "SCHEDULED-ANSWER";
		let toolResult: string | null = null;
		const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
		const gateway = http.createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				const messages: any[] = JSON.parse(body).messages ?? [];
				const fromTool = messages.find((message) => message.role === "tool");
				const base = { id: "cmpl_scheduled", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
				res.writeHead(200, { "content-type": "text/event-stream" });
				if (fromTool) {
					toolResult = typeof fromTool.content === "string" ? fromTool.content : JSON.stringify(fromTool.content);
					res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: answered }, finish_reason: null }] }));
					res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
				} else {
					res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "notes.txt" }) } }] }, finish_reason: null }] }));
					res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
				}
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
		const started: BoxProcess[] = [];
		const start = BoxProcess.start;
		BoxProcess.start = (async (...args: Parameters<typeof BoxProcess.start>) => {
			const process = await start(...args);
			started.push(process);
			return process;
		}) as typeof BoxProcess.start;
		const wrapped: string[] = [];
		const request = BoxProcess.prototype.request;
		BoxProcess.prototype.request = async function (this: BoxProcess, kind: string, body: any) {
			if (kind === "wrap") wrapped.push(body.command);
			return request.call(this, kind, body);
		} as typeof BoxProcess.prototype.request;
		try {
			const port = (gateway.address() as AddressInfo).port;
			fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }), { mode: 0o600 });
			fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-scheduled" } }), { mode: 0o600 });
			fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }), { mode: 0o600 });
			fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }), { mode: 0o600 });
			const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
			const { createPersistentRoomDefaultCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
			const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
			const { executePersistentRoomBackgroundPrompt } = await import("../src/persistent-room-background-execution.js");
			const room = createPersistentAgentFromScaffoldInput({ displayName: "Scheduled Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.id;
			writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: room, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));
			const result = await executePersistentRoomBackgroundPrompt({
				roomId: room,
				target: { kind: "fresh-thread", model: { provider: "openai-compatible", model: "room-model" } },
				prompt: "Read the notes.",
				executionId: "box-files-scheduled",
				cwd: folder,
				agentDir,
				modelRegistry: ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json")),
			} as any);
			assert(result.assistantText.includes(answered), `the run's answer: ${result.assistantText}`);
			assert(toolResult !== null && (toolResult as string).includes("needle here"), `the read: ${toolResult}`);
			assert(wrapped.includes(fileProgram().command), "the read didn't run in the box");
			assert(started.length > 0 && started.every((process) => !process.alive), "a box outlived the run");
			assert(programsAlive() === 0, "a file program outlived the run");
		} finally {
			BoxProcess.start = start;
			BoxProcess.prototype.request = request;
			gateway.close();
		}
	});

	await row("a box that fails with no command since the computer started: file tools go on behind the server's fence", async () => {
		const record = path.join(home, ".exxperts.box-commands");
		fs.rmSync(record, { force: true });
		const started = BoxProcess.start;
		BoxProcess.start = (async () => { throw new Error("no worker"); }) as typeof BoxProcess.start;
		await nextTurn();
		try {
			const read = await call("read", { path: "notes.txt" });
			assert(!read.failed && read.text.includes("needle here"), `the read: ${read.text}`);
			assert(!fs.existsSync(record) && !boxedCommandSinceStart(), "a box that failed counted as a command");
		} finally {
			BoxProcess.start = started;
		}
	});

	await row("after a command has run, a box that fails stops file tools with the plain line", async () => {
		await nextTurn();
		const commands = createRoomCommandTools(folder, { box, outside: { questions: { ...quietQuestions, askOutside: async () => false } as any, setOffered: () => {} } });
		await commands.tools.find((tool) => tool.name === "bash")!.execute("cmd", { command: "true" } as any, undefined as any, undefined as any, undefined as any);
		assert(boxedCommandSinceStart(), "the command left no record");
		const started = BoxProcess.start;
		BoxProcess.start = (async () => { throw new Error("no worker"); }) as typeof BoxProcess.start;
		await nextTurn();
		try {
			for (const [name, input] of [["read", { path: "notes.txt" }], ["write", { path: "after.txt", content: "x" }], ["ls", {}]] as const) {
				const result = await call(name, input);
				assert(result.failed && result.text === FILES_STOPPED_LINE, `${name}: ${result.text}`);
			}
			assert(!fs.existsSync(inRoom("after.txt")), "a write went on");
		} finally {
			BoxProcess.start = started;
			fs.rmSync(path.join(home, ".exxperts.box-commands"), { force: true });
		}
	});

	await row("a record that can't be read counts as a command that ran, and a command whose record can't be written doesn't run", async () => {
		const record = path.join(home, ".exxperts.box-commands");
		fs.rmSync(record, { recursive: true, force: true });
		assert(!boxedCommandSinceStart(), "no record counted as a command");
		fs.writeFileSync(record, "not a record");
		assert(boxedCommandSinceStart(), "a record that doesn't parse counted as no command");
		fs.rmSync(record);
		fs.mkdirSync(record);
		try {
			assert(boxedCommandSinceStart(), "a record that can't be read counted as no command");
			await nextTurn();
			const commands = createRoomCommandTools(folder, { box, outside: { questions: { ...quietQuestions, askOutside: async () => false } as any, setOffered: () => {} } });
			const ran = await commands.tools.find((tool) => tool.name === "bash")!.execute("cmd", { command: `echo ran > ${JSON.stringify(inRoom("unrecorded-run"))}` } as any, undefined as any, undefined as any, undefined as any).then(() => "ran", (error: Error) => error.message);
			assert(ran !== "ran" && !fs.existsSync(inRoom("unrecorded-run")), `the command: ${ran}`);
		} finally {
			fs.rmSync(record, { recursive: true, force: true });
			fs.rmSync(inRoom("unrecorded-run"), { force: true });
			await nextTurn();
		}
	});

	await row("a file program that gives no answer leaves one line in the log: how it ended and the start of its error output, on one line; one that answers leaves none", async () => {
		const logged: string[] = [];
		await box.endTurn();
		bind((_detail, message) => logged.push(message));
		const answered = await call("ls", {});
		assert(!answered.failed && answered.text.includes("notes.txt") && isDeepStrictEqual(logged, []), `a program that answered: ${answered.text}; logged: ${logged.join(" | ")}`);
		await withSilentProgram("SILENT-ONE", () => call("ls", {}));
		const prefix = "the file program gave no answer (exit code 3); its error output: ";
		assert(isDeepStrictEqual(markersIn(logged), ["SILENT-ONE"]) && logged[0].startsWith(prefix) && /^SILENT-ONE\[\d+\]  second line x/.test(logged[0].slice(prefix.length)), `logged: ${logged.join(" | ")}`);
		assert(!/[\u0000-\u001f\u007f-\u009f]/.test(logged[0]) && Buffer.byteLength(logged[0].slice(prefix.length)) === 2_000, `the line: ${JSON.stringify(logged[0])}`);
		await nextTurn();
	});

	await row("a program that gives no answer at every call writes its line once per server process, though each call's process number differs; other words write their own", async () => {
		const logged: string[] = [];
		const warn = (_detail: Record<string, unknown>, message: string) => logged.push(message);
		await box.endTurn();
		bind(warn);
		await withSilentProgram("SILENT-TWO", async () => {
			for (const input of [{}, { path: "docs" }, {}]) await call("ls", input);
			await box.endTurn();
			bind(warn);
			await call("ls", {});
		});
		assert(isDeepStrictEqual(markersIn(logged), ["SILENT-TWO"]), `logged: ${logged.join(" | ")}`);
		await withSilentProgram("SILENT-THREE", () => call("ls", {}));
		assert(isDeepStrictEqual(markersIn(logged), ["SILENT-TWO", "SILENT-THREE"]), `logged: ${logged.join(" | ")}`);
		await nextTurn();
	});

	await row("a program that hangs to its time limit leaves its line too, with what it had written; the model reads the limit's line as before", async () => {
		const logged: string[] = [];
		await box.endTurn();
		bind((_detail, message) => logged.push(message));
		const read = await withSilentProgram("SILENT-HANG", () => call("read", { path: "notes.txt" }), { hangs: true });
		assert(read.failed && /^\S+ took too long to open\. Try again, or ask for a smaller part\.$/.test(read.text), `the read: ${read.text}`);
		assert(isDeepStrictEqual(markersIn(logged), ["SILENT-HANG"]) && /^the file program gave no answer \(stopped at its time limit, [^)]+\); its error output: SILENT-HANG\[\d+\]  second line x/.test(logged[0]), `logged: ${logged.join(" | ")}`);
		assert(programsAlive() === 0, "the program outlived its limit");
		await nextTurn();
	});

	await row("what a program that gives no answer wrote reaches the log alone: the fault, the model and the person read what they did before", async () => {
		const logged: string[] = [];
		const record = path.join(home, ".exxperts.box-commands");
		await box.endTurn();
		bind((_detail, message) => logged.push(message));
		try {
			await withSilentProgram("SILENT-FOUR", async () => {
				fs.rmSync(record, { force: true });
				const behindFence = await call("read", { path: "notes.txt" });
				assert(!behindFence.failed && behindFence.text.includes("needle here") && !behindFence.text.includes("SILENT"), `with no command since the start: ${behindFence.text}`);
				await runACommand();
				for (const [name, input] of [["read", { path: "notes.txt" }], ["ls", {}]] as const) {
					const result = await call(name, input);
					assert(result.failed && result.text === FILES_STOPPED_LINE, `${name}: ${result.text}`);
				}
				const fence = roomFence(policy, () => []);
				const fault = await new BoxFiles(box, fence).list(fencePath(fence, ".", "read", { decksInBox: true }), ".").then(() => null, (error: unknown) => error);
				assert(fault instanceof BoxFault && fault.message === BOX_FAULT_SENTENCE && fault.detail === "the file program gave no answer", `the fault: ${String(fault)}`);
			});
			assert(isDeepStrictEqual(markersIn(logged), ["SILENT-FOUR"]), `logged: ${logged.join(" | ")}`);
		} finally {
			fs.rmSync(record, { force: true });
			await nextTurn();
		}
	});

	await row("the by-hand check of the file program answers under this Node, and leaves nothing behind", () => {
		const checks = () => fs.readdirSync(sharedTemp).filter((name) => name.startsWith("exxperts-worker-check-")).length;
		const before = checks();
		const ran = spawnSync(process.execPath, [...process.execArgv, path.join(import.meta.dirname, "room-box-worker-check.ts")], { cwd: repoRoot, encoding: "utf8", timeout: 180_000 });
		const said = `${ran.status}: ${ran.stdout}${ran.stderr}`;
		assert(ran.status === 0 && ran.stdout.includes(`Node: ${process.execPath} (${process.version})\nOpenSSL's settings file: /dev/null\n`), `the check: ${said}`);
		assert(/^It answered: hello\.txt$/m.test(ran.stdout) && /^It ended with: exit code 0$/m.test(ran.stdout) && /^Its error output: none$/m.test(ran.stdout), `the check: ${said}`);
		assert(fileProgram().files.every((file) => ran.stdout.includes(`\n  ${file}\n`)), `the files it names: ${said}`);
		assert(/^macOS's sandbox (log couldn't be read: .+|logged no refusal around this run\.|logged around this run .+:)$/m.test(ran.stdout), `the sandbox's log: ${said}`);
		assert(checks() === before, "the check left its folder behind");
	});

	await row("a box file call names its program's own paths only: nothing from the model reaches the shell", async () => {
		const seen: string[] = [];
		const request = BoxProcess.prototype.request;
		BoxProcess.prototype.request = async function (this: BoxProcess, kind: string, body: any) {
			if (kind === "wrap") seen.push(body.command);
			return request.call(this, kind, body);
		} as typeof BoxProcess.prototype.request;
		try {
			fs.writeFileSync(inRoom("odd $(name) 'q'.txt"), "odd");
			const read = await call("read", { path: "odd $(name) 'q'.txt" });
			assert(!read.failed && read.text.includes("odd"), read.text);
		} finally {
			BoxProcess.prototype.request = request;
		}
		assert(seen.includes(fileProgram().command) && seen.every((command) => !command.includes("odd")), `commands: ${seen.join(" | ")}`);
	});

	// Last: the shared-server switch can't be turned off again in this process.
	await row("outside a room that asks nothing the file program's rules are byte for byte as before: on Ask, in a protected room on Auto, with no reader, with a reader that throws and with the shared-server switch on; in the state only the write denies differ from what it had before", async () => {
		const recorded: FileProgramCall["rules"][] = [];
		const original = RoomBox.prototype.runFileProgram;
		RoomBox.prototype.runFileProgram = function (this: RoomBox, programCall) {
			recorded.push(programCall.rules);
			return original.call(this, programCall);
		};
		const rulesOf = async (asksNothing?: () => boolean): Promise<string> => {
			tools = stateTools(asksNothing);
			recorded.length = 0;
			const wrote = await call("write", { path: "rules.txt", content: "rules\n", overwrite: true });
			assert(!wrote.failed && recorded.length === 1, `the write: ${wrote.text}`);
			return JSON.stringify(recorded[0]);
		};
		const kept = tools;
		try {
			// What a call built before the state's own write denies: outside the state, and in it, where the person's keys already opened.
			const rulesBefore = (asksNothing: boolean) => {
				const fence = roomFence(policy, () => box.spills().map((spill) => ({ path: spill })), undefined, asksNothing);
				return JSON.stringify(fileRules({ roots: [...fence.roots(), ...fence.dataReads()], writes: true, closedBelow: fence.closedBelow(), asksNothing: false, program: fileProgram().files }));
			};
			const asBefore = rulesBefore(false);
			const stateBefore = JSON.parse(rulesBefore(true));
			const inState = JSON.parse(await rulesOf(() => true));
			const readers: Array<[string, (() => boolean) | undefined]> = [
				["on Ask", () => false],
				["a protected room on Auto", () => unprotectedRoomOnAutoIn(ROOM_ID, "conversation-a", { state: "on" })],
				["no reader (a scheduled run)", undefined],
				["a reader that throws", () => {
					throw new Error("unreadable");
				}],
			];
			for (const [label, reader] of readers) assert((await rulesOf(reader)) === asBefore, `${label}: the rules differ`);
			registerServerHooks({});
			assert((await rulesOf(() => true)) === asBefore, "the shared-server switch on: the rules differ");
			const sameBut = JSON.stringify({ ...inState, filesystem: { ...inState.filesystem, denyWrite: stateBefore.filesystem.denyWrite } });
			assert(sameBut === JSON.stringify(stateBefore) && !isDeepStrictEqual(inState.filesystem.denyWrite, stateBefore.filesystem.denyWrite), "in the state more than the write denies differ from before, or nothing does");
		} finally {
			RoomBox.prototype.runFileProgram = original;
			tools = kept;
			fs.rmSync(inRoom("rules.txt"), { force: true });
		}
	});

	await box.endTurn();
	console.log(`room box files smoke: ${passed} passed, ${failures.length} failed`);
	if (failures.length > 0) process.exit(1);
}

await main();
