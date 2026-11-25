// Paths that name a network or device place reach no disk or network call, in
// the file tools, the folder checks, the folder offer and the saved requests, and
// the AI gets its one line. Every disk call and program start is
// recorded, so a row proves the place was never touched. Both computers' shapes
// are checked here, Windows' by acting as Windows. The rows that need a Mac say
// elsewhere that they were skipped, by name.
//
// It writes into the home it runs under, so it refuses to start anywhere but the
// throwaway home `npm run smokes` makes.
import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { PlaceRefused, placeRefused, realPlace, refusedShape, walkPlace } from "../src/path-shapes.js";
import { linkRefused } from "../src/room-files.js";
import { createPersistentRoomCapabilityPolicy, createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, writePersistentRoomDefaultCapabilityPolicy } from "../src/persistent-room-workspace-policy.js";
import { createPersistentRoomWorkspaceTools } from "../src/persistent-room-workspace-tools.js";
import { saveAlsoAllowedFolders } from "../src/room-box/also-allowed.js";
import { closedForReading, neverOpened } from "../src/room-box/box-closed.js";
import { folderGrantable, soundFolders } from "../src/room-box/folder-offer.js";

const home = fs.realpathSync(os.homedir());
const sharedTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(home) !== sharedTemp || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`path shapes smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- path-shapes`);
	process.exit(1);
}

const onMac = process.platform === "darwin";
const onWindows = process.platform === "win32";
let passed = 0;
const failures: string[] = [];

async function row(name: string, body: () => Promise<void> | void, needs: "any" | "posix" | "mac" = "any"): Promise<void> {
	if ((needs === "mac" && !onMac) || (needs === "posix" && onWindows)) {
		console.log(`  skip ${name} (needs ${needs === "mac" ? "a Mac" : "a Mac or Linux"})`);
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

// ---- every disk call and program start, recorded by the names it was given ----
type Call = { fn: string; name: string };
const calls: Call[] = [];
let recording = false;
const named = (value: unknown): string[] => (typeof value === "string" ? [value] : value instanceof URL ? [value.pathname] : Buffer.isBuffer(value) ? [value.toString("utf8")] : Array.isArray(value) ? value.flatMap(named) : []);
function recordCalls(owner: Record<string, any>, name: string, fn = name): void {
	const original = owner[name];
	if (typeof original !== "function") return;
	const recorded = function (this: unknown, ...args: unknown[]) {
		if (recording) calls.push(...args.slice(0, 2).flatMap(named).map((place) => ({ fn, name: place })));
		return original.apply(this, args);
	};
	for (const key of Object.keys(original)) (recorded as any)[key] = original[key];
	owner[name] = recorded;
}
const FS_CALLS = ["access", "exists", "lstat", "open", "opendir", "readdir", "readFile", "readlink", "realpath", "stat", "statfs", "watch", "mkdir", "writeFile", "rename", "unlink", "rm", "symlink", "copyFile", "cp"];
for (const name of FS_CALLS) {
	recordCalls(fs, name);
	recordCalls(fs, `${name}Sync`);
	recordCalls(fsPromises, name, `promises.${name}`);
}
recordCalls(fs.realpathSync, "native", "realpathSync.native");
recordCalls(fs.realpath, "native", "realpath.native");
for (const name of ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync", "fork"]) recordCalls(childProcess, name);
// The modules that import these by name see the recorded ones too.
syncBuiltinESMExports();

async function recorded<T>(body: () => Promise<T> | T): Promise<{ value: T; calls: Call[] }> {
	calls.length = 0;
	recording = true;
	try {
		return { value: await body(), calls: [...calls] };
	} finally {
		recording = false;
	}
}

/** The calls whose names reach one of these places, by any spelling of case or slash. */
const reaching = (seen: readonly Call[], places: readonly string[]): Call[] => {
	const spelled = (text: string) => text.replace(/\\/g, "/").toLowerCase();
	return seen.filter((call) => places.some((place) => spelled(call.name).includes(spelled(place))));
};
const noCallOn = (seen: readonly Call[], places: readonly string[], label: string) => {
	const reached = reaching(seen, places);
	assert(reached.length === 0, `${label}: calls on the place: ${JSON.stringify(reached.slice(0, 5))}`);
};
// Only these look at a link itself; every other call by its name, or by a name past it, reaches its target.
const ON_THE_LINK = new Set(["lstat", "lstatSync", "promises.lstat", "readlink", "readlinkSync", "promises.readlink"]);
const noCallThrough = (seen: readonly Call[], link: string, label: string) => {
	const through = seen.filter((call) => (call.name === link && !ON_THE_LINK.has(call.fn)) || call.name.startsWith(`${link}${path.sep}`));
	assert(through.length === 0, `${label}: calls through the link: ${JSON.stringify(through.slice(0, 5))}`);
};

/** Runs `body` as the code would on Windows: only what reads `process.platform` at the call changes. */
async function actingAsWindows<T>(body: () => Promise<T> | T): Promise<T> {
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	try {
		return await body();
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
}

// The design's shapes. A call on one would carry its whole text.
const WINDOWS_SHAPES = ["\\\\h\\s\\x", "//h/s", "\\\\?\\UNC\\h\\s", "\\\\.\\pipe\\x", "\\??\\C:\\x", "C:x", "NUL.txt", "a.txt:s"];
// The automounts again under the data volume's name, and /.vol, which opens a file by its disk and file numbers.
const MAC_SHAPES = ["/net/h/x", "/Network/Servers/h", "/System/Volumes/Data/net/h/x", "/System/Volumes/Data/Network/Servers/h", "/.vol/16777220/2"];
const MAC_PLACES = ["/net/h", "/net/team", "/network/servers", "/system/volumes/data/net", "/system/volumes/data/network", "/.vol"];

// ---- a room with a folder ----
const ROOM_ID = "path-shapes-smoke-room";
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
fs.mkdirSync(persistentAgentRootPath(ROOM_ID), { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(home, "room-folder-")));
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(home, "elsewhere-")));
const inRoom = (...names: string[]) => path.join(folder, ...names);
const policy = createPersistentRoomCapabilityPolicy({ agentId: ROOM_ID, conversationId: "conversation-a", repoRoot, root: folder, workspaceAccessMode: "localFiles", source: "manual" });
writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: ROOM_ID, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));
const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
write(inRoom("notes.md"), "room notes\n");
write(path.join(elsewhere, "shared", "brief.md"), "shared brief\n");

async function call(tools: Map<string, any>, name: string, input: Record<string, unknown>): Promise<{ text: string; failed: boolean }> {
	const tool = tools.get(name);
	assert(tool, `no ${name} tool`);
	try {
		const result = await tool.execute("call", input, undefined, undefined, undefined);
		return { text: (result.content ?? []).map((part: any) => part.text ?? "").join(""), failed: false };
	} catch (error) {
		return { text: (error as Error).message, failed: true };
	}
}
const plainTools = () => new Map(createPersistentRoomWorkspaceTools(policy).map((tool) => [String(tool.name), tool]));

async function main(): Promise<void> {
	console.log("path shapes smoke");

	await row("each shape is refused by its own computer's path rules, and only there", () => {
		for (const shape of WINDOWS_SHAPES) assert(refusedShape(shape, [], path.win32), `Windows lets through ${shape}`);
		for (const shape of ["\\/h/s", "/\\h\\s", "\\\\?\\C:\\x", "\\\\.\\C:", "C:", "c:x\\y", "C:\\Users\\x\\nul", "C:\\Users\\x\\CON.tar.gz", "C:\\x\\lpt9.log", "C:\\x\\COM¹", "C:\\x\\aux ", "C:\\x\\a.txt:stream:$DATA"]) assert(refusedShape(shape, [], path.win32), `Windows lets through ${shape}`);
		for (const shape of [...MAC_SHAPES, "/net", "/NET/h", "/Network", "//net/h", "/./net/h", "/x/../net/h", "/system/volumes/DATA/NET/h", "/System/Volumes/Data/./Network", "/.VOL", "/x/../.vol/1/2"]) assert(refusedShape(shape, [], path.posix), `a Mac lets through ${shape}`);
		// The ordinary places beside them pass.
		for (const shape of ["C:\\Users\\x\\Documents\\a.txt", "D:/data/x.txt", "\\Users\\x\\a.txt", "notes\\a.txt", "C:\\x\\console.txt", "C:\\x\\nullable", "C:\\x\\COM10", "C:\\x\\CONFIG.sys", "/net/h/x"]) assert(!refusedShape(shape, [], path.win32), `Windows refuses ${shape}`);
		for (const shape of ["/Users/x/net/h", "net/h/x", "/Networking/x", "/network-drive/x", "/tmp/a.txt:s", "/Users/x/NUL.txt", "\\\\h\\s\\x", "C:x", "/System/Volumes/Data/Users/x", "/System/Volumes/Data/x/net/h", "/System/Volumes/Preboot/net", "/.volumes/x", "/Users/x/.vol/1/2"]) assert(!refusedShape(shape, [], path.posix), `a Mac refuses ${shape}`);
	});

	await row("a room's own folder on a share, and the folders above it, pass; below it only the names past it are judged", () => {
		const room = ["\\\\srv\\share\\room"];
		for (const shape of ["\\\\srv\\share\\room", "\\\\srv\\share\\room\\notes.md", "\\\\SRV\\Share\\Room\\sub\\a.txt", "//srv/share/room/sub/a.txt", "\\\\srv\\share"]) assert(!refusedShape(shape, room, path.win32), `refused in the room on a share: ${shape}`);
		for (const shape of ["\\\\srv\\share\\room\\NUL.txt", "\\\\srv\\share\\room\\sub\\a.txt:s", "\\\\srv\\share\\other\\a.txt", "\\\\srv\\share\\room\\..\\other", "\\\\?\\UNC\\srv\\share\\room\\a.txt", "\\\\h\\s\\x", "C:x"]) assert(refusedShape(shape, room, path.win32), `let through beside the room on a share: ${shape}`);
		// The same on a Mac, for a room the person chose under /Network.
		assert(!refusedShape("/Network/Servers/h/room/net/x", ["/Network/Servers/h/room"], path.posix) && refusedShape("/Network/Servers/h/other", ["/Network/Servers/h/room"], path.posix), "a Mac room under /Network");
	});

	await row("the closed places: the system's names for its shared folders are asked once, so later judgements start no program", async () => {
		closedForReading();
		const { calls: later } = await recorded(() => {
			closedForReading();
			neverOpened();
		});
		const started = later.filter((call) => call.name === "/usr/bin/getconf");
		assert(started.length === 0, `getconf started ${started.length} times`);
	});

	// ---- the file tools ----
	await row("file tools: each Mac shape, a relative path and a ~ path up to it reach no call, and the AI gets the line", async () => {
		const tools = plainTools();
		const up = "../".repeat(folder.split(path.sep).length - 1);
		const homeUp = `~/${"../".repeat(home.split(path.sep).length - 1)}`;
		for (const shape of [...MAC_SHAPES, `${up}net/h/x`, `${homeUp}net/h/x`]) {
			for (const [tool, input] of [["read", { path: shape }], ["write", { path: shape, content: "x" }], ["ls", { path: shape }]] as const) {
				const { value, calls: seen } = await recorded(() => call(tools, tool, input));
				assert(value.failed && value.text === placeRefused(shape), `${tool} ${shape}: got ${JSON.stringify(value)}`);
				noCallOn(seen, MAC_PLACES, `${tool} ${shape}`);
			}
		}
		assert(!(await call(tools, "read", { path: "notes.md" })).failed, "an ordinary file in the room opens");
	}, "posix");

	await row("file tools acting as Windows: each Windows shape reaches no call, and the AI gets the line", async () => {
		const tools = plainTools();
		for (const shape of WINDOWS_SHAPES) {
			for (const [tool, input] of [["read", { path: shape }], ["write", { path: shape, content: "x" }]] as const) {
				const { value, calls: seen } = await recorded(() => actingAsWindows(() => call(tools, tool, input)));
				assert(value.failed && value.text === placeRefused(shape), `${tool} ${shape}: got ${JSON.stringify(value)}`);
				noCallOn(seen, [shape], `${tool} ${shape}`);
			}
		}
	});

	await row("file tools: a link in the room, or outside it, to a network place is refused with no call on its target; a path through /var still opens", async () => {
		fs.symlinkSync("/net/h", inRoom("net-link"));
		fs.symlinkSync("/net/h", path.join(elsewhere, "alias"));
		try {
			const tools = plainTools();
			for (const shape of ["net-link/x", inRoom("net-link", "x"), path.join(elsewhere, "alias", "file")]) {
				const { value, calls: seen } = await recorded(() => call(tools, "read", { path: shape }));
				assert(value.failed && value.text === placeRefused(shape), `read ${shape}: got ${JSON.stringify(value)}`);
				noCallOn(seen, MAC_PLACES, `read ${shape}`);
				for (const link of [inRoom("net-link"), path.join(elsewhere, "alias")]) noCallThrough(seen, link, `read ${shape}`);
			}
			// macOS's /var is a link above the folders, to /private/var.
			if (folder.startsWith("/private/var/")) {
				const throughVar = path.join("/var", path.relative("/private/var", inRoom("notes.md")));
				const opened = await call(tools, "read", { path: throughVar });
				assert(!opened.failed && opened.text.includes("room notes"), `a path through /var: ${JSON.stringify(opened)}`);
			}
		} finally {
			fs.rmSync(inRoom("net-link"));
			fs.rmSync(path.join(elsewhere, "alias"));
		}
	}, "posix");

	await row("file tools: a link to a missing folder and back up, or a chain of more links than are followed, reaches no call past a link", async () => {
		const tools = plainTools();
		fs.symlinkSync("/net/h", inRoom("hop"));
		// By hand: path.join would take the missing folder and its `..` out.
		fs.symlinkSync(`${folder}/missing/../hop/file`, path.join(elsewhere, "back-up"));
		const chain = Array.from({ length: 42 }, (_, at) => path.join(elsewhere, `chain-${at}`));
		chain.forEach((link, at) => fs.symlinkSync(chain[at + 1] ?? "/net/h/x", link));
		try {
			const back = await recorded(() => call(tools, "read", { path: path.join(elsewhere, "back-up") }));
			assert(back.value.failed && back.value.text === placeRefused(path.join(elsewhere, "back-up")), `back up: ${JSON.stringify(back.value)}`);
			noCallThrough(back.calls, inRoom("hop"), "back up");
			const long = await recorded(() => call(tools, "read", { path: chain[0] }));
			assert(long.value.failed && long.value.text === linkRefused(chain[0]), `a long chain: ${JSON.stringify(long.value)}`);
			noCallOn(long.calls, MAC_PLACES, "a long chain");
			for (const link of chain) noCallThrough(long.calls, link, "a long chain");
		} finally {
			for (const link of [inRoom("hop"), path.join(elsewhere, "back-up"), ...chain]) fs.rmSync(link, { force: true });
		}
	}, "posix");

	await row("with links refused, a link on the way throws before its text is read; with no option the walk makes the same calls as before", async () => {
		fs.mkdirSync(path.join(elsewhere, "target"), { recursive: true });
		fs.symlinkSync(path.join(elsewhere, "target"), inRoom("to-target"));
		try {
			const through = inRoom("to-target", "x");
			const refused = await recorded(() => {
				try {
					walkPlace(through, [], { links: "refuse" });
					return "walked";
				} catch (error) {
					return error instanceof PlaceRefused ? error.why : "other";
				}
			});
			assert(refused.value === "links", `the walk: ${refused.value}`);
			assert(refused.calls.every((call) => !call.fn.includes("readlink")), `the link's text was read: ${JSON.stringify(refused.calls.filter((call) => call.fn.includes("readlink")))}`);
			noCallOn(refused.calls, [path.join(elsewhere, "target")], "refused walk");
			assert(realPlace(through, { links: "refuse" }) === null, "realPlace with links refused");
			// The neighbour with no link walks, and the default follows the link as before.
			assert(realPlace(inRoom("notes.md"), { links: "refuse" }) === inRoom("notes.md"), "a path with no link");
			const plain = await recorded(() => walkPlace(through));
			const empty = await recorded(() => walkPlace(through, [], {}));
			assert(plain.value.real === path.join(elsewhere, "target", "x") && JSON.stringify(plain.calls) === JSON.stringify(empty.calls), `no option and an empty one differ: ${JSON.stringify([plain.calls.length, empty.calls.length])}`);
		} finally {
			fs.rmSync(inRoom("to-target"));
		}
	}, "posix");

	await row("with stop folders, the walk ends where the way enters one, told by the folder itself and not its name: a link outside is followed into it, and no link inside it is looked at", async () => {
		fs.mkdirSync(inRoom("stop-sub"), { recursive: true });
		fs.mkdirSync(path.join(elsewhere, "beyond"), { recursive: true });
		fs.symlinkSync(path.join(elsewhere, "beyond"), inRoom("stop-sub", "inside-link"));
		fs.symlinkSync(inRoom("stop-sub", "inside-link", "skill"), path.join(elsewhere, "into-room"));
		// The room's folder named by another way to it: the walk still knows it.
		const otherName = path.join(elsewhere, "room-by-link");
		fs.symlinkSync(folder, otherName);
		try {
			const entering = await recorded(() => walkPlace(path.join(elsewhere, "into-room"), [], { stopAt: [otherName] }));
			assert(entering.value.stoppedAt === inRoom("stop-sub", "inside-link", "skill") && entering.value.real === entering.value.stoppedAt, `where the way enters the room's folder: ${JSON.stringify(entering.value)}`);
			noCallThrough(entering.calls, inRoom("stop-sub"), "a stopped walk");
			noCallOn(entering.calls, [path.join(elsewhere, "beyond")], "a stopped walk");
			// The same way with no stop folders follows the link inside, and one that never enters a stop folder walks as before.
			assert(walkPlace(path.join(elsewhere, "into-room")).real === path.join(elsewhere, "beyond", "skill"), "with no stop folder, the link inside is followed");
			const away = walkPlace(path.join(elsewhere, "beyond"), [], { stopAt: [folder] });
			assert(away.stoppedAt === undefined && away.real === path.join(elsewhere, "beyond"), `a way that never enters a stop folder: ${JSON.stringify(away)}`);
			const gone = walkPlace(path.join(elsewhere, "beyond"), [], { stopAt: [path.join(elsewhere, "not-there")] });
			assert(gone.stoppedAt === undefined, `a stop folder that isn't there stops nothing: ${JSON.stringify(gone)}`);
			// A `..` left past the stop leads where only a look inside could tell: the walk still stops, and names no place.
			fs.symlinkSync(`${inRoom("stop-sub")}/x/../../../out`, path.join(elsewhere, "back-out"));
			const back = walkPlace(path.join(elsewhere, "back-out"), [], { stopAt: [folder] });
			fs.rmSync(path.join(elsewhere, "back-out"));
			assert(back.stoppedAt === null && back.real === folder, `a way that leaves the stop folder by \`..\`: ${JSON.stringify(back)}`);
		} finally {
			fs.rmSync(path.join(elsewhere, "into-room"));
			fs.rmSync(otherName);
			fs.rmSync(inRoom("stop-sub"), { recursive: true, force: true });
			fs.rmSync(path.join(elsewhere, "beyond"), { recursive: true, force: true });
		}
	}, "posix");

	await row("on a Mac, a stop folder named under /System/Volumes/Data is the same folder as its plain name", () => {
		const dataName = path.join("/System/Volumes/Data", folder);
		assert(fs.existsSync(dataName), `no ${dataName} on this Mac`);
		const walked = walkPlace(inRoom("notes.md"), [], { stopAt: [dataName] });
		assert(walked.stoppedAt === inRoom("notes.md"), `the room's folder by its data volume name: ${JSON.stringify(walked)}`);
	}, "mac");

	// ---- the folder checks and the saved Also allowed list ----
	await row("a saved Also allowed entry naming a network place is dropped when read back, with no call on it; an ordinary one stays", async () => {
		const ordinary = { path: path.join(elsewhere, "shared"), access: "read" as const };
		const kept = await recorded(() => soundFolders([{ path: "/net/h/x", access: "read" }, { path: "/Network/Servers/h", access: "write" }, ordinary], folder));
		assert(JSON.stringify(kept.value) === JSON.stringify([ordinary]), `kept: ${JSON.stringify(kept.value)}`);
		noCallOn(kept.calls, MAC_PLACES, "the list's read-back");
		saveAlsoAllowedFolders(ROOM_ID, [{ path: "/net/h/x", access: "read" }, ordinary]);
		try {
			const { value, calls: seen } = await recorded(() => call(plainTools(), "read", { path: path.join(ordinary.path, "brief.md") }));
			assert(!value.failed && value.text.includes("shared brief"), `the ordinary folder opens: ${JSON.stringify(value)}`);
			noCallOn(seen, MAC_PLACES, "a file call with the entry on the list");
		} finally {
			saveAlsoAllowedFolders(ROOM_ID, []);
		}
	}, "posix");

	await row("acting as Windows, a saved Also allowed entry \\\\h\\s is dropped with no call on it", async () => {
		const { value, calls: seen } = await recorded(() => actingAsWindows(() => [folderGrantable("\\\\h\\s", "read", [folder], folder), soundFolders([{ path: "\\\\h\\s", access: "read" }], folder).length]));
		assert(value[0] === false && value[1] === 0, `kept: ${JSON.stringify(value)}`);
		noCallOn(seen, ["\\\\h\\s"], "the list's read-back");
	});

	console.log(`${passed} passed, ${failures.length} failed`);
	fs.rmSync(folder, { recursive: true, force: true });
	fs.rmSync(elsewhere, { recursive: true, force: true });
	if (failures.length > 0) process.exit(1);
}

await main();
