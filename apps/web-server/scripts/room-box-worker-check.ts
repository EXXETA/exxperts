// By hand, on a Mac: does a room's file program answer under this Node? It
// starts the program in a room's box as the server does for a file tool, on a
// temporary folder, asks it to list that folder, and prints what tells why it
// gave no answer: the Node, OpenSSL's settings file it starts with, the files its
// rules open by name, how it ended, its error output, and what macOS's sandbox
// logged for the run.
//
// From the repository's root, after `npm ci` and `npm run build`, with the Node in question:
//   /opt/homebrew/bin/node --import tsx apps/web-server/scripts/room-box-worker-check.ts
// It exits 0 when the program answered and 1 when not. It writes only in a
// temporary folder of its own and removes it. Reading macOS's log may need an
// administrator's account; without one it says so and goes on.
//
// Not a smoke, so `npm run smokes` never runs it by its name; a row of
// room-box-files-smoke.ts runs it on a Mac.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileProgramCall, ProgramRun } from "../src/room-box/box-files.js";

if (process.platform !== "darwin") {
	console.log("This check runs on a Mac only.");
	process.exit(1);
}

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-worker-check-")));
// The app's data goes in the scratch folder, never the person's own: the room's box keeps its places there. It counts as a home too, so a
// folder in it may be a room's, as one in the shared temp may not.
process.env.EXXPERTS_STATE_HOME = scratch;
delete process.env.EXXETA_PERSISTENT_AGENTS_ROOT;
const listed = path.join(scratch, "listed");
fs.mkdirSync(listed);
fs.writeFileSync(path.join(listed, "hello.txt"), "hello\n");

// Imported after the data's place is set: the server's modules read it as they load.
const { BoxFiles, FILE_PROGRAM_ENV, fileProgram, ProgramEnded } = await import("../src/room-box/box-files.js");
const { RoomBox } = await import("../src/room-box/box-session.js");
const { createPersistentRoomCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
const { fencePath, roomFence } = await import("../src/room-files.js");

/** The server's own box, which also keeps the file program's run for this check to print. */
class WatchedBox extends RoomBox {
	last: ProgramRun | null = null;

	override async runFileProgram(call: FileProgramCall): Promise<ProgramRun> {
		try {
			const ran = await super.runFileProgram(call);
			this.last = ran;
			return ran;
		} catch (error) {
			// Stopped at its time or size limit: what it did by then is on the error.
			if (error instanceof ProgramEnded) this.last = error.run;
			throw error;
		}
	}
}

const ROOM_ID = "worker-check";
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const box = new WatchedBox({
	roomId: ROOM_ID,
	conversationId: () => "check",
	questions: { watcher: () => "none", askSite: () => Promise.reject(new Error("nobody is there")), closeSiteCards: () => {} },
	rights: () => ({ canChangeFiles: false, skillFolders: [] }),
	warn: (detail, message) => console.log(`The server would log: ${message} ${JSON.stringify(detail)}`),
});

/** macOS's sandbox refusals since `start` for the processes a file program runs as: the Node, and the shells that start it. */
function sandboxLines(start: Date): string[] | string {
	const names = new Set([path.basename(fs.realpathSync(process.execPath)), "bash", "env", "sandbox-exec"]);
	const since = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " ");
	let shown: string;
	try {
		shown = execFileSync("/usr/bin/log", ["show", "--style", "compact", "--start", since, "--predicate", 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny"'], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const said = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0];
		return said || (error as Error).message;
	}
	return shown.split("\n").filter((line) => [...names].some((name) => line.includes(`${name}(`)));
}

let answered = false;
try {
	console.log(`Node: ${process.execPath} (${process.version})`);
	console.log(`OpenSSL's settings file: ${FILE_PROGRAM_ENV.OPENSSL_CONF}`);
	console.log("The file program's rules open these files by name:");
	for (const file of fileProgram().files) console.log(`  ${file}`);

	const policy = createPersistentRoomCapabilityPolicy({ agentId: ROOM_ID, conversationId: "check", repoRoot, root: listed, workspaceAccessMode: "localFiles", source: "manual" });
	const fence = roomFence(policy, () => []);
	let start = new Date();
	try {
		// The box starts and proves itself first, with commands it refuses on purpose; the log is read from a second later, when the program's own run begins.
		await box.privateTemp();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		start = new Date();
		const entries = await new BoxFiles(box, fence).list(fencePath(fence, ".", "read", { decksInBox: true }), ".");
		answered = true;
		console.log(`It answered: ${entries.map((entry) => entry.name).join(", ")}`);
	} catch (error) {
		console.log(`It gave no answer: ${(error as { detail?: string }).detail ?? (error as Error).message}`);
	}
	const run = box.last;
	// No run to read: the box didn't start, and the line above says why.
	console.log(`It ended with: ${run?.ended ?? "no run to read"}`);
	const errors = run?.errorOutput.toString("utf8").trim();
	console.log(errors ? `Its error output:\n${errors}` : "Its error output: none");
	const lines = sandboxLines(start);
	if (typeof lines === "string") console.log(`macOS's sandbox log couldn't be read: ${lines}`);
	else if (lines.length === 0) console.log("macOS's sandbox logged no refusal around this run.");
	else console.log(`macOS's sandbox logged around this run (any program of these names, so another's may be among them):\n${lines.map((line) => `  ${line}`).join("\n")}`);
} finally {
	await box.endTurn().catch(() => {});
	fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(answered ? 0 : 1);
