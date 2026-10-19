import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-artifact-export-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });

// Seed the artifact store the way a specialist session would leave it. Store root
// mirrors productAppStatePath("artifacts") == <HOME>/.exxperts/app/artifacts, and
// HOME is pointed at tempHome for the spawned server below.
const store = path.join(tempHome, ".exxperts", "app", "artifacts");
const taskDir = path.join(store, "tasks", "tsk-export1");
fs.mkdirSync(path.join(taskDir, "sub"), { recursive: true });
fs.mkdirSync(path.join(taskDir, ".thumbs"), { recursive: true });

const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const HTML_BODY = "<!doctype html><title>page</title><p>hello</p>";
const MD_BODY = "# notes\n\nsome markdown\n";
const INNER_BODY = "<!doctype html><title>inner</title><p>nested</p>";
const SECRET = "TOP-SECRET-ARTIFACT-CONTENTS-DO-NOT-LEAK";

fs.writeFileSync(path.join(taskDir, "diagram.svg"), SVG_BODY);
fs.writeFileSync(path.join(taskDir, "page.html"), HTML_BODY);
fs.writeFileSync(path.join(taskDir, "notes.md"), MD_BODY);
fs.writeFileSync(path.join(taskDir, "sub", "inner.html"), INNER_BODY);
fs.writeFileSync(path.join(taskDir, ".thumbs", "preview.png"), "not-really-a-png");
// A servable-extension file OUTSIDE the tasks tree that traversal must never copy.
fs.mkdirSync(path.join(store, "private"), { recursive: true });
fs.writeFileSync(path.join(store, "private", "secret.md"), SECRET);

// The room's workspace folder (the export destination) and a second room with no
// workspace configured at all.
const ROOM_WITH_WORKSPACE = "room-export-smoke";
const ROOM_WITHOUT_WORKSPACE = "room-no-workspace";
const workspaceRoot = path.join(tempHome, "room-workspace");
fs.mkdirSync(workspaceRoot, { recursive: true });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

// Point the policy module (imported below to seed the room default) at the temp
// agents root, exactly as the spawned server will read it.
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

// The boot-time shelf migration (files core slice) would otherwise move or
// sweep the seeded store files. This smoke pins the STORE export path, so the
// fixture pins the one state that keeps store files in place: an
// already-migrated room (marker present) whose row still references tasks/
// paths — such folders are protected from the sweep.
const exportRoomRuntime = path.join(tempAgentsRoot, ROOM_WITH_WORKSPACE, "runtime");
fs.mkdirSync(path.join(exportRoomRuntime, "task-ledger"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(exportRoomRuntime, "task-ledger", "tsk-export1.json"), `${JSON.stringify({
	schemaVersion: 1, taskId: "tsk-export1", roomId: ROOM_WITH_WORKSPACE, conversationId: "conv-export", templateId: "deck", templateVersion: 1,
	title: "export fixture", startedAt: "2026-07-20T10:00:00.000Z", endedAt: "2026-07-20T10:05:00.000Z", outcome: "ok",
	artifacts: [
		{ relativePath: "tasks/tsk-export1/diagram.svg", bytes: SVG_BODY.length, extension: ".svg" },
		{ relativePath: "tasks/tsk-export1/page.html", bytes: HTML_BODY.length, extension: ".html" },
		{ relativePath: "tasks/tsk-export1/notes.md", bytes: MD_BODY.length, extension: ".md" },
		{ relativePath: "tasks/tsk-export1/sub/inner.html", bytes: INNER_BODY.length, extension: ".html" },
	],
}, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(exportRoomRuntime, "shelf-migration.json"), `${JSON.stringify({ schemaVersion: 1, migratedAt: "2026-07-20T10:00:00.000Z", filesMoved: 0 }, null, 2)}\n`, { mode: 0o600 });

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function exportArtifact(taskId: string, relativePath: string, roomId: string, conversationId?: string, resolution?: { overwrite?: boolean; rename?: boolean }): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}/api/artifacts/${taskId}/export`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ relativePath, roomId, ...(conversationId ? { conversationId } : {}), ...(resolution ?? {}) }),
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	// Seed the room-default workspace policy on disk (validated construction, same
	// as the workspace API would write). The export route reads this file to learn
	// the room's approved workspace root.
	const { createPersistentRoomDefaultCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
	const policy = createPersistentRoomDefaultCapabilityPolicy({
		agentId: ROOM_WITH_WORKSPACE,
		root: workspaceRoot,
		repoRoot,
		persistentAgentsRoot: tempAgentsRoot,
		exxetaStateRoot: path.join(tempHome, ".exxperts", "app"),
		workspaceAccessMode: "localFiles",
		displayLabel: "Export Smoke Workspace",
	});
	writePersistentRoomDefaultCapabilityPolicy(policy, { persistentAgentsRoot: tempAgentsRoot });
	const workspaceRealRoot = fs.realpathSync.native(workspaceRoot);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// 1. Happy path: HTML export lands bytes-identical inside the workspace root.
	const happy = await exportArtifact("tsk-export1", "tasks/tsk-export1/page.html", ROOM_WITH_WORKSPACE);
	assert(happy.status === 200, `happy export: expected 200, got ${happy.status}: ${JSON.stringify(happy.body)}`);
	const savedTo = String(happy.body?.savedTo ?? "");
	assert(savedTo.endsWith(`${path.sep}page.html`), `happy export: savedTo should end with page.html, got "${savedTo}"`);
	assert(savedTo === path.join(workspaceRealRoot, "page.html"), `happy export: savedTo should be inside the workspace root, got "${savedTo}"`);
	assert(fs.existsSync(savedTo), "happy export: destination file should exist");
	assert(fs.readFileSync(savedTo, "utf-8") === HTML_BODY, "happy export: destination bytes must match source");
	// POSIX permission bits do not exist on Windows; stat reports 0o666 there
	// no matter what mode the write requested.
	if (process.platform !== "win32") {
		const mode = fs.statSync(savedTo).mode & 0o777;
		assert(mode === 0o600, `happy export: destination should be 0o600, got 0o${mode.toString(8)}`);
	}

	// 2. Second export of the same name → 409 with the machine key, file untouched.
	const conflict = await exportArtifact("tsk-export1", "tasks/tsk-export1/page.html", ROOM_WITH_WORKSPACE);
	assert(conflict.status === 409, `duplicate export: expected 409, got ${conflict.status}: ${JSON.stringify(conflict.body)}`);
	assert(String(conflict.body?.error ?? "").includes("already exists"), `duplicate export: message should mention already exists, got ${JSON.stringify(conflict.body)}`);
	assert(conflict.body?.code === "exists", `duplicate export: 409 must carry code "exists", got ${JSON.stringify(conflict.body)}`);
	assert(fs.readFileSync(savedTo, "utf-8") === HTML_BODY, "duplicate export: existing file must be left intact");

	// 2b. Collision resolutions (assets contract §5). Keep both → first free
	// suffix, returned in savedTo; a second Keep both takes the next suffix.
	const keepBoth = await exportArtifact("tsk-export1", "tasks/tsk-export1/page.html", ROOM_WITH_WORKSPACE, undefined, { rename: true });
	assert(keepBoth.status === 200, `keep-both export: expected 200, got ${keepBoth.status}: ${JSON.stringify(keepBoth.body)}`);
	assert(String(keepBoth.body?.savedTo ?? "") === path.join(workspaceRealRoot, "page-2.html"), `keep-both export: savedTo should be page-2.html, got "${keepBoth.body?.savedTo}"`);
	assert(fs.readFileSync(path.join(workspaceRealRoot, "page-2.html"), "utf-8") === HTML_BODY, "keep-both export: suffixed copy must match source");
	assert(fs.readFileSync(savedTo, "utf-8") === HTML_BODY, "keep-both export: original must be untouched");
	const keepBothAgain = await exportArtifact("tsk-export1", "tasks/tsk-export1/page.html", ROOM_WITH_WORKSPACE, undefined, { rename: true });
	assert(String(keepBothAgain.body?.savedTo ?? "") === path.join(workspaceRealRoot, "page-3.html"), `second keep-both should take the next suffix, got "${keepBothAgain.body?.savedTo}"`);
	// Replace → drops wx→w only with the explicit flag; content is replaced.
	fs.writeFileSync(savedTo, "stale contents", "utf-8");
	const replace = await exportArtifact("tsk-export1", "tasks/tsk-export1/page.html", ROOM_WITH_WORKSPACE, undefined, { overwrite: true });
	assert(replace.status === 200, `replace export: expected 200, got ${replace.status}: ${JSON.stringify(replace.body)}`);
	assert(String(replace.body?.savedTo ?? "") === savedTo, `replace export: savedTo should stay the original name, got "${replace.body?.savedTo}"`);
	assert(fs.readFileSync(savedTo, "utf-8") === HTML_BODY, "replace export: destination must carry the fresh bytes");
	// Both flags at once is a client bug → 400, nothing written.
	const bothFlags = await exportArtifact("tsk-export1", "tasks/tsk-export1/page.html", ROOM_WITH_WORKSPACE, undefined, { overwrite: true, rename: true });
	assert(bothFlags.status === 400, `both-flags export: expected 400, got ${bothFlags.status}: ${JSON.stringify(bothFlags.body)}`);
	assert(!fs.existsSync(path.join(workspaceRealRoot, "page-4.html")), "both-flags export: nothing new should be written");

	// 2c. Ledger mapping (assets contract §3): a successful export appends
	// {relativePath, savedTo} to the task's ledger row; a task without a row
	// (pre-ledger) exports fine and stays recordless.
	{
		const { createTaskLedgerRecord, listTaskLedgerRecords } = await import("../src/persistent-room-task-ledger.js");
		const ledgerTaskDir = path.join(store, "tasks", "tsk-export9");
		fs.mkdirSync(ledgerTaskDir, { recursive: true });
		fs.writeFileSync(path.join(ledgerTaskDir, "report.html"), HTML_BODY);
		createTaskLedgerRecord({ taskId: "tsk-export9", roomId: ROOM_WITH_WORKSPACE, conversationId: "conv-x", templateId: "deck", templateVersion: 1, title: "Ledger export" });
		const ledgered = await exportArtifact("tsk-export9", "tasks/tsk-export9/report.html", ROOM_WITH_WORKSPACE);
		assert(ledgered.status === 200, `ledger export: expected 200, got ${ledgered.status}: ${JSON.stringify(ledgered.body)}`);
		const ledgerRow = listTaskLedgerRecords(ROOM_WITH_WORKSPACE).find((r) => r.taskId === "tsk-export9");
		assert(ledgerRow?.exports?.length === 1, "ledger export: exports[] must gain one entry");
		assert(ledgerRow?.exports?.[0]?.relativePath === "tasks/tsk-export9/report.html" && ledgerRow?.exports?.[0]?.savedTo === String(ledgered.body?.savedTo), "ledger export: entry must map artifact to real savedTo");
		assert(typeof ledgerRow?.exports?.[0]?.at === "string" && ledgerRow.exports[0].at.length > 0, "ledger export: entry must be timestamped");
		// The recordless "pre-ledger" scenario is extinct since the shelf
		// migration (files core slice): a recordless store task is swept at boot,
		// so every exportable task has a row. tsk-export1's fixture row must have
		// collected the successful exports above — appended, never a second row.
		const fixtureRows = listTaskLedgerRecords(ROOM_WITH_WORKSPACE).filter((r) => r.taskId === "tsk-export1");
		assert(fixtureRows.length === 1, "exports must append to the existing row, never invent another");
		assert((fixtureRows[0]?.exports?.length ?? 0) >= 4, `fixture row must have collected the successful exports (got ${fixtureRows[0]?.exports?.length})`);
	}

	// 3. Room without a configured workspace → 400 with the guidance message.
	const noWorkspace = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITHOUT_WORKSPACE);
	assert(noWorkspace.status === 400, `no-workspace export: expected 400, got ${noWorkspace.status}: ${JSON.stringify(noWorkspace.body)}`);
	assert(String(noWorkspace.body?.error ?? "").includes("no workspace folder configured"), `no-workspace export: message should explain the missing workspace, got ${JSON.stringify(noWorkspace.body)}`);
	assert(!fs.existsSync(path.join(workspaceRealRoot, "notes.md")), "no-workspace export: nothing should be copied");

	// 4. Traversal relativePath → refused, and the secret is never copied.
	const traversals = [
		"tasks/tsk-export1/../private/secret.md",
		"tasks/tsk-export1/..%2fprivate%2fsecret.md",
		"tasks/tsk-export1/sub/../../private/secret.md",
	];
	for (const rel of traversals) {
		const res = await exportArtifact("tsk-export1", rel, ROOM_WITH_WORKSPACE);
		assert(res.status === 404 || res.status === 400, `traversal ${rel}: expected 404/400, got ${res.status}: ${JSON.stringify(res.body)}`);
		assert(!JSON.stringify(res.body ?? "").includes(SECRET), `traversal ${rel}: response leaked secret`);
	}
	assert(!fs.existsSync(path.join(workspaceRealRoot, "secret.md")), "traversal: secret.md must never land in the workspace");
	// A relativePath not owned by the URL taskId → 400, never a cross-task copy.
	const crossTask = await exportArtifact("tsk-export1", "tasks/tsk-other/page.html", ROOM_WITH_WORKSPACE);
	assert(crossTask.status === 400, `cross-task export: expected 400, got ${crossTask.status}: ${JSON.stringify(crossTask.body)}`);

	// 5. Foreign / unknown taskId → 404 (source does not exist), nothing copied.
	const foreign = await exportArtifact("tsk-nonexistent", "tasks/tsk-nonexistent/page.html", ROOM_WITH_WORKSPACE);
	assert(foreign.status === 404, `foreign taskId export: expected 404, got ${foreign.status}: ${JSON.stringify(foreign.body)}`);
	// A malformed taskId is rejected before any filesystem work.
	const badTaskId = await exportArtifact(".hidden", "tasks/.hidden/page.html", ROOM_WITH_WORKSPACE);
	assert(badTaskId.status === 404, `malformed taskId export: expected 404, got ${badTaskId.status}: ${JSON.stringify(badTaskId.body)}`);

	// 6. Destination confinement: a nested source flattens to its basename directly
	//    inside the workspace root — no subfolder path components leak into the dest,
	//    so a resolved destination can never escape the approved workspace folder.
	const nested = await exportArtifact("tsk-export1", "tasks/tsk-export1/sub/inner.html", ROOM_WITH_WORKSPACE);
	assert(nested.status === 200, `nested export: expected 200, got ${nested.status}: ${JSON.stringify(nested.body)}`);
	assert(String(nested.body?.savedTo ?? "") === path.join(workspaceRealRoot, "inner.html"), `nested export: should flatten to workspace/inner.html, got "${nested.body?.savedTo}"`);
	assert(!fs.existsSync(path.join(workspaceRealRoot, "sub")), "nested export: must not recreate source subfolders in the workspace");

	// 6b. A link in the workspace that carries the destination's name: the export
	//     never writes through it. The default answers "exists", Keep both takes
	//     the next free name, and Replace is refused in plain words, whether the
	//     link points outside the workspace or at a file inside it.
	const outsideTarget = path.join(tempRoot, "outside-target.md");
	const insideTarget = path.join(workspaceRealRoot, "inside-target.md");
	const linkPath = path.join(workspaceRealRoot, "notes.md");
	let linksWork = true;
	for (const [label, target] of [["outside", outsideTarget], ["inside", insideTarget]] as const) {
		fs.writeFileSync(target, "LINK-TARGET-ORIGINAL");
		try {
			fs.symlinkSync(target, linkPath);
		} catch (error) {
			console.log(`artifact-export-smoke: link case skipped (${(error as NodeJS.ErrnoException).code ?? "no symlink"})`);
			linksWork = false;
			fs.rmSync(target, { force: true });
			break;
		}
		const asIs = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE);
		assert(asIs.status === 409 && asIs.body?.code === "exists", `${label} link, default: expected 409 exists, got ${asIs.status}: ${JSON.stringify(asIs.body)}`);
		const replaced = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { overwrite: true });
		assert(replaced.status === 400, `${label} link, Replace: expected 400, got ${replaced.status}: ${JSON.stringify(replaced.body)}`);
		assert(replaced.body?.error === "The file with this name in the room's folder is a shortcut to somewhere else, so it was not replaced. Use Keep both instead.", `${label} link, Replace: the refusal must be the plain sentence, got ${JSON.stringify(replaced.body)}`);
		const keptBoth = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { rename: true });
		assert(keptBoth.status === 200 && String(keptBoth.body?.savedTo ?? "") === path.join(workspaceRealRoot, "notes-2.md"), `${label} link, Keep both: expected notes-2.md, got ${keptBoth.status}: ${JSON.stringify(keptBoth.body)}`);
		assert(!fs.lstatSync(String(keptBoth.body.savedTo)).isSymbolicLink() && fs.readFileSync(String(keptBoth.body.savedTo), "utf-8") === MD_BODY, `${label} link, Keep both: notes-2.md must be a real copy`);
		assert(fs.readFileSync(target, "utf-8") === "LINK-TARGET-ORIGINAL", `${label} link: the link's target was written`);
		assert(fs.lstatSync(linkPath).isSymbolicLink(), `${label} link: the link itself must be left in place`);
		fs.unlinkSync(linkPath);
		fs.unlinkSync(path.join(workspaceRealRoot, "notes-2.md"));
		fs.rmSync(target, { force: true });
	}
	if (linksWork) {
		// A link that leads nowhere, at the name and at the next free name: both
		// count as taken, and nothing is created through either.
		const danglingTarget = path.join(tempRoot, "dangling-target.md");
		const nextLinkPath = path.join(workspaceRealRoot, "notes-2.md");
		fs.symlinkSync(danglingTarget, linkPath);
		fs.symlinkSync(danglingTarget, nextLinkPath);
		for (const resolution of [undefined, { overwrite: true }]) {
			const res = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, resolution);
			assert(res.status === 409 || res.status === 400, `dangling link ${JSON.stringify(resolution ?? {})}: expected a refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
			assert(!fs.existsSync(danglingTarget), `dangling link ${JSON.stringify(resolution ?? {})}: a file was created through the link`);
		}
		const keptBoth = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { rename: true });
		assert(keptBoth.status === 200 && String(keptBoth.body?.savedTo ?? "") === path.join(workspaceRealRoot, "notes-3.md"), `dangling links, Keep both: expected notes-3.md, got ${keptBoth.status}: ${JSON.stringify(keptBoth.body)}`);
		assert(!fs.existsSync(danglingTarget), "dangling links, Keep both: a file was created through a link");
		for (const name of [linkPath, nextLinkPath, String(keptBoth.body.savedTo)]) fs.unlinkSync(name);
	} else {
		console.log("artifact-export-smoke: dangling link case skipped");
	}

	// 6c. Another name of an outside file (a hard link) and a FIFO at the
	//     destination's name: Replace puts a new file at the name and writes
	//     into neither, and the server keeps answering.
	const answerWithin = <T,>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: the server did not answer within 10 s`)), 10_000).unref()),
	]);
	const hardTarget = path.join(tempRoot, "hard-target.md");
	fs.writeFileSync(hardTarget, "HARD-TARGET-ORIGINAL");
	fs.linkSync(hardTarget, linkPath);
	const hardDefault = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE);
	assert(hardDefault.status === 409 && hardDefault.body?.code === "exists", `hard link, default: expected 409 exists, got ${hardDefault.status}: ${JSON.stringify(hardDefault.body)}`);
	const hardReplace = await answerWithin(exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { overwrite: true }), "hard link, Replace");
	assert(hardReplace.status === 200, `hard link, Replace: expected 200, got ${hardReplace.status}: ${JSON.stringify(hardReplace.body)}`);
	assert(fs.readFileSync(hardTarget, "utf-8") === "HARD-TARGET-ORIGINAL", "hard link, Replace: the other name's file was written");
	assert(fs.readFileSync(linkPath, "utf-8") === MD_BODY && fs.statSync(linkPath).nlink === 1, "hard link, Replace: the name must now hold a new file of its own");
	fs.unlinkSync(linkPath);
	if (process.platform !== "win32" && spawnSync("mkfifo", [linkPath]).status === 0) {
		const fifoReplace = await answerWithin(exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { overwrite: true }), "FIFO, Replace");
		assert(fifoReplace.status === 200 && fs.lstatSync(linkPath).isFile() && fs.readFileSync(linkPath, "utf-8") === MD_BODY, `FIFO, Replace: expected a new file at the name, got ${fifoReplace.status}: ${JSON.stringify(fifoReplace.body)}`);
		assert((await answerWithin(fetch(`${baseUrl}/healthz`), "health after the FIFO")).ok, "the server must keep answering after a FIFO at the name");
		fs.unlinkSync(linkPath);
	} else {
		console.log("artifact-export-smoke: FIFO case skipped");
	}
	assert(fs.readdirSync(workspaceRealRoot).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");

	// 6d. Replace gives the new file the old file's permission bits and, when
	//     the account belongs to it, its group; a Replace with nothing at the
	//     name gives what a new export gives.
	if (process.platform !== "win32") {
		const replaceNotes = () => exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { overwrite: true });
		for (const mode of [0o600, 0o664]) {
			fs.writeFileSync(linkPath, "KEPT-ORIGINAL");
			fs.chmodSync(linkPath, mode);
			const replacedKept = await replaceNotes();
			const modeAfter = fs.statSync(linkPath).mode & 0o777;
			assert(replacedKept.status === 200 && fs.readFileSync(linkPath, "utf-8") === MD_BODY, `a 0${mode.toString(8)} file, Replace: expected the new bytes, got ${replacedKept.status}: ${JSON.stringify(replacedKept.body)}`);
			assert(modeAfter === mode, `a 0${mode.toString(8)} file, Replace: the file came back 0${modeAfter.toString(8)}`);
			fs.unlinkSync(linkPath);
		}
		const exportedNew = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE);
		const newMode = fs.statSync(linkPath).mode & 0o777;
		fs.unlinkSync(linkPath);
		const replacedNothing = await replaceNotes();
		const replacedNothingMode = fs.statSync(linkPath).mode & 0o777;
		assert(exportedNew.status === 200 && replacedNothing.status === 200 && replacedNothingMode === newMode, `Replace with nothing at the name: expected 0${newMode.toString(8)}, as a new export gets, got 0${replacedNothingMode.toString(8)}`);
		const otherGroup = process.getgroups?.().find((gid) => gid !== fs.statSync(linkPath).gid);
		let grouped = false;
		if (otherGroup !== undefined) {
			try {
				fs.chownSync(linkPath, -1, otherGroup);
				grouped = true;
			} catch {}
		}
		if (grouped) {
			const replacedGrouped = await replaceNotes();
			const groupAfter = fs.statSync(linkPath).gid;
			assert(replacedGrouped.status === 200 && groupAfter === otherGroup, `a file in group ${otherGroup}, Replace: the file came back in group ${groupAfter}`);
		} else {
			console.log("artifact-export-smoke: group case skipped (no second group to give the file)");
		}
		fs.unlinkSync(linkPath);
		assert(fs.readdirSync(workspaceRealRoot).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");
	} else {
		console.log("artifact-export-smoke: permission case skipped (Windows has no permission bits)");
	}

	// 6f. On macOS, Replace keeps what the old file carried beside its bytes:
	//     its Finder tag and comment (extended attributes) and its creation date.
	if (process.platform === "darwin") {
		const detailsPath = linkPath;
		const tags = "com.apple.metadata:_kMDItemUserTags";
		const comment = "com.apple.metadata:kMDItemFinderComment";
		fs.writeFileSync(detailsPath, "KEPT-ORIGINAL");
		assert(spawnSync("xattr", ["-w", tags, "(\"Red\\n6\")", detailsPath]).status === 0 && spawnSync("xattr", ["-w", comment, "a comment", detailsPath]).status === 0, "the Finder tag and comment could not be set");
		// A modification time before the creation date moves the creation date back on macOS.
		const created = new Date("2020-01-02T10:00:00Z");
		fs.utimesSync(detailsPath, created, created);
		const createdMs = fs.statSync(detailsPath).birthtimeMs;
		const replacedDetails = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { overwrite: true });
		const read = (attribute: string) => spawnSync("xattr", ["-p", attribute, detailsPath], { encoding: "utf-8" }).stdout.trim();
		assert(replacedDetails.status === 200 && fs.readFileSync(detailsPath, "utf-8") === MD_BODY, `a tagged file, Replace: expected the new bytes`);
		assert(read(tags) === "(\"Red\\n6\")", `a tagged file, Replace: the Finder tag is gone, got "${read(tags)}"`);
		assert(read(comment) === "a comment", `a tagged file, Replace: the Finder comment is gone, got "${read(comment)}"`);
		assert(fs.statSync(detailsPath).birthtimeMs === createdMs, `a tagged file, Replace: the creation date moved from ${new Date(createdMs).toISOString()} to ${fs.statSync(detailsPath).birthtime.toISOString()}`);
		fs.unlinkSync(detailsPath);
		assert(fs.readdirSync(path.dirname(detailsPath)).every((name) => !name.endsWith(".tmp")), "Replace must leave no temporary file behind");
	} else {
		console.log("SKIPPED: artifact-export-smoke: Finder details case (macOS only)");
	}

	// 6e. A file the account may not write is not replaced, as before: the
	//     answer is the one a failed export gives, and the file stays as it was.
	if (process.platform === "win32" || process.getuid?.() !== 0) {
		fs.writeFileSync(linkPath, "READ-ONLY-ORIGINAL");
		fs.chmodSync(linkPath, 0o444);
		try {
			const refused = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { overwrite: true });
			assert(refused.status === 500 && refused.body?.error === "Failed to export the artifact to the room workspace.", `read-only file, Replace: expected 500 with the export failure, got ${refused.status}: ${JSON.stringify(refused.body)}`);
			assert(fs.readFileSync(linkPath, "utf-8") === "READ-ONLY-ORIGINAL", "read-only file, Replace: the file was replaced");
		} finally {
			fs.chmodSync(linkPath, 0o644);
			fs.unlinkSync(linkPath);
		}
	} else {
		console.log("artifact-export-smoke: read-only file case skipped (root may write any file)");
	}

	// 6f. A workspace folder where the file can be changed but no new file can
	//     be made: Replace writes into the file itself when it is a plain file
	//     with no other name, and refuses a second name of an outside file.
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		const secondNamePath = path.join(workspaceRealRoot, "diagram.svg");
		const lockedOutside = path.join(tempRoot, "locked-outside.svg");
		fs.writeFileSync(linkPath, "LOCKED-ORIGINAL");
		fs.writeFileSync(lockedOutside, "LOCKED-OUTSIDE-ORIGINAL");
		fs.linkSync(lockedOutside, secondNamePath);
		const inodeBefore = fs.statSync(linkPath).ino;
		const workspaceMode = fs.statSync(workspaceRealRoot).mode & 0o7777;
		fs.chmodSync(workspaceRealRoot, 0o555);
		try {
			const inPlace = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, undefined, { overwrite: true });
			assert(inPlace.status === 200 && fs.readFileSync(linkPath, "utf-8") === MD_BODY && fs.statSync(linkPath).ino === inodeBefore, `folder without new files, Replace: expected the file itself rewritten, got ${inPlace.status}: ${JSON.stringify(inPlace.body)}`);
			const secondName = await exportArtifact("tsk-export1", "tasks/tsk-export1/diagram.svg", ROOM_WITH_WORKSPACE, undefined, { overwrite: true });
			assert(secondName.status === 500 && secondName.body?.error === "Failed to export the artifact to the room workspace.", `folder without new files, a second name of an outside file: expected the export failure, got ${secondName.status}: ${JSON.stringify(secondName.body)}`);
			assert(fs.readFileSync(lockedOutside, "utf-8") === "LOCKED-OUTSIDE-ORIGINAL", "folder without new files: the outside file was written through its second name");
		} finally {
			fs.chmodSync(workspaceRealRoot, workspaceMode);
		}
		fs.unlinkSync(linkPath);
		fs.unlinkSync(secondNamePath);
	} else {
		console.log("artifact-export-smoke: folder without new files case skipped (a read-only folder does not stop new files on Windows or for root)");
	}

	// 7. Missing roomId → 400 (no room to resolve a workspace for).
	const noRoom = await exportArtifact("tsk-export1", "tasks/tsk-export1/diagram.svg", "");
	assert(noRoom.status === 400, `missing roomId export: expected 400, got ${noRoom.status}: ${JSON.stringify(noRoom.body)}`);

	// 8. Thread-effective policy (hardening pass): a conversation with a thread
	//    workspace override exports into ITS workspace; without a conversationId
	//    (or with one that has no override) the room default still applies.
	const THREAD_ID = "pi_export_0001";
	const threadWorkspaceRoot = path.join(tempHome, "thread-workspace");
	fs.mkdirSync(threadWorkspaceRoot, { recursive: true });
	const { createPersistentRoomCapabilityPolicy, writePersistentRoomCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
	const threadPolicy = createPersistentRoomCapabilityPolicy({
		agentId: ROOM_WITH_WORKSPACE,
		conversationId: THREAD_ID,
		root: threadWorkspaceRoot,
		repoRoot,
		persistentAgentsRoot: tempAgentsRoot,
		exxetaStateRoot: path.join(tempHome, ".exxperts", "app"),
		workspaceAccessMode: "localFiles",
		displayLabel: "Thread Export Workspace",
	});
	writePersistentRoomCapabilityPolicy(threadPolicy, { persistentAgentsRoot: tempAgentsRoot });
	const threadWorkspaceReal = fs.realpathSync.native(threadWorkspaceRoot);
	const threadScoped = await exportArtifact("tsk-export1", "tasks/tsk-export1/notes.md", ROOM_WITH_WORKSPACE, THREAD_ID);
	assert(threadScoped.status === 200, `thread-scoped export: expected 200, got ${threadScoped.status}: ${JSON.stringify(threadScoped.body)}`);
	assert(String(threadScoped.body?.savedTo ?? "") === path.join(threadWorkspaceReal, "notes.md"), `thread-scoped export must land in the THREAD workspace, got "${threadScoped.body?.savedTo}"`);
	assert(!fs.existsSync(path.join(workspaceRealRoot, "notes.md")), "thread-scoped export must not land in the room-default workspace");
	const defaultScoped = await exportArtifact("tsk-export1", "tasks/tsk-export1/diagram.svg", ROOM_WITH_WORKSPACE);
	assert(defaultScoped.status === 200 && String(defaultScoped.body?.savedTo ?? "") === path.join(workspaceRealRoot, "diagram.svg"), `no-conversation export must use the room default, got ${JSON.stringify(defaultScoped.body)}`);
	fs.writeFileSync(path.join(taskDir, "extra.md"), "extra");
	const fallbackScoped = await exportArtifact("tsk-export1", "tasks/tsk-export1/extra.md", ROOM_WITH_WORKSPACE, "pi_no_override_0001");
	assert(fallbackScoped.status === 200 && String(fallbackScoped.body?.savedTo ?? "") === path.join(workspaceRealRoot, "extra.md"), `no-override conversation must fall back to the room default, got ${JSON.stringify(fallbackScoped.body)}`);

	// 6) The workspace fence restricts the model's tools, not the user's clicks:
	//    a room whose selection has no writer tools still exports artifacts when
	//    the user asks for it.
	writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({
		agentId: ROOM_WITH_WORKSPACE,
		root: workspaceRoot,
		repoRoot,
		persistentAgentsRoot: tempAgentsRoot,
		exxetaStateRoot: path.join(tempHome, ".exxperts", "app"),
		workspaceAccessMode: "localFiles",
		toolSelection: { kind: "custom", allowedToolNames: ["read", "ls", "find", "grep"] },
		displayLabel: "Export Smoke Workspace",
	}), { persistentAgentsRoot: tempAgentsRoot });
	fs.writeFileSync(path.join(taskDir, "readonly-room.md"), "readonly room export");
	const readOnlyRoomScoped = await exportArtifact("tsk-export1", "tasks/tsk-export1/readonly-room.md", ROOM_WITH_WORKSPACE);
	assert(readOnlyRoomScoped.status === 200, `read-only-selection room export must stay allowed, got ${readOnlyRoomScoped.status}: ${JSON.stringify(readOnlyRoomScoped.body)}`);
	assert(String(readOnlyRoomScoped.body?.savedTo ?? "") === path.join(workspaceRealRoot, "readonly-room.md"), `read-only-selection room export must land in the room workspace, got "${readOnlyRoomScoped.body?.savedTo}"`);

	console.log("artifact export smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
