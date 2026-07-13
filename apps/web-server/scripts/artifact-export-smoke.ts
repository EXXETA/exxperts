import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
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
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

// Point the policy module (imported below to seed the room default) at the temp
// agents root, exactly as the spawned server will read it.
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

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

async function exportArtifact(taskId: string, relativePath: string, roomId: string, conversationId?: string): Promise<{ status: number; body: any }> {
	const response = await fetch(`${baseUrl}/api/artifacts/${taskId}/export`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ relativePath, roomId, ...(conversationId ? { conversationId } : {}) }),
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
		mode: "write",
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
	const mode = fs.statSync(savedTo).mode & 0o777;
	assert(mode === 0o600, `happy export: destination should be 0o600, got 0o${mode.toString(8)}`);

	// 2. Second export of the same name → 409, and the existing file is untouched.
	const conflict = await exportArtifact("tsk-export1", "tasks/tsk-export1/page.html", ROOM_WITH_WORKSPACE);
	assert(conflict.status === 409, `duplicate export: expected 409, got ${conflict.status}: ${JSON.stringify(conflict.body)}`);
	assert(String(conflict.body?.error ?? "").includes("already exists"), `duplicate export: message should mention already exists, got ${JSON.stringify(conflict.body)}`);
	assert(fs.readFileSync(savedTo, "utf-8") === HTML_BODY, "duplicate export: existing file must be left intact");

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
		mode: "write",
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

	console.log("artifact export smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
