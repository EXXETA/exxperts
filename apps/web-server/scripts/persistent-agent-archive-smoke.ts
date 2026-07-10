import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-archive-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-archive-root-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function readJson(file: string): any {
	return JSON.parse(readText(file));
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function assertNoPathLeak(value: unknown, label: string, blockedPaths: string[]): void {
	const serialized = JSON.stringify(value);
	for (const blockedPath of blockedPaths) {
		assert(!serialized.includes(blockedPath), `${label}: response must not leak absolute path ${blockedPath}`);
	}
	assert(!serialized.includes('"root"'), `${label}: response must not expose root field`);
	assert(!serialized.includes('"path"'), `${label}: response must not expose path field`);
}

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

async function requestJson(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
	const response = await fetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function listAgentIds(): Promise<string[]> {
	const listed = await requestJson("/api/persistent-agents");
	assert(listed.status === 200, `list should succeed, got ${listed.status}: ${JSON.stringify(listed.body)}`);
	assert(Array.isArray(listed.body), "list should return an array");
	return listed.body.map((status: any) => String(status.id));
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			EXXETA_HOME: repoRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	let listedIds = await listAgentIds();
	assert(listedIds.length === 0, "fresh empty agents root should list no rooms");
	assert(!fs.existsSync(path.join(tempAgentsRoot, "borja-coordinator")), "fresh listing must not create borja-coordinator");

	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({
			displayName: "Archive Smoke Room",
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		}),
	});
	assert(created.status === 201, `create non-default room should succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
	const agentId = String(created.body?.agent?.agentId ?? "");
	assert(agentId === "archive-smoke-room", `expected archive-smoke-room id, got ${agentId}`);
	const encodedAgentId = encodeURIComponent(agentId);
	const agentRoot = path.join(tempAgentsRoot, agentId);
	const agentJsonPath = path.join(agentRoot, "agent.json");
	const runtimePath = path.join(agentRoot, "runtime", "state.json");
	const threadId = "archive_smoke_thread";
	const threadPath = path.join(agentRoot, "runtime", "threads", `${threadId}.json`);

	writeJson(threadPath, {
		schemaVersion: 1,
		threadId,
		agentId,
		state: "standby",
		origin: "home",
		model: { provider: "synthetic", model: "archive-smoke", label: "Archive Smoke" },
		items: [{ kind: "user", id: "u1", text: "synthetic archived thread" }],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
	writeJson(runtimePath, {
		schemaVersion: 1,
		agentId,
		state: "standby",
		activeThreadId: threadId,
		model: { provider: "synthetic", model: "archive-smoke", label: "Archive Smoke" },
		updatedAt: Date.now(),
	});

	const wrongArchive = await requestJson(`/api/persistent-agents/${encodedAgentId}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE wrong-room` }),
	});
	assert(wrongArchive.status === 400, `wrong confirmation should reject, got ${wrongArchive.status}: ${JSON.stringify(wrongArchive.body)}`);
	assert(readJson(agentJsonPath).archivedAt == null, "wrong confirmation must not write archive metadata");

	const archive = await requestJson(`/api/persistent-agents/${encodedAgentId}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${agentId}` }),
	});
	assert(archive.status === 200, `archive should succeed, got ${archive.status}: ${JSON.stringify(archive.body)}`);
	assert(archive.body?.agentId === agentId, "archive response should return agentId");
	assert(archive.body?.status === "archived", "archive response should mark archived status");
	assert(typeof archive.body?.archivedAt === "number" && archive.body.archivedAt > 0, "archive response should include archivedAt");
	assertNoPathLeak(archive.body, "non-default archive", [tempHome, tempAgentsRoot, repoRoot, agentRoot]);

	const archivedMeta = readJson(agentJsonPath);
	assert(archivedMeta.status === "archived", "agent.json should carry human-readable archived status");
	assert(archivedMeta.archivedAt === archive.body.archivedAt, "agent.json should persist archivedAt from response");
	assert(archivedMeta.archivedBy === "local-user", "agent.json should persist archivedBy local-user");
	const runtimeAfterArchive = readJson(runtimePath);
	assert(runtimeAfterArchive.state === "idle", "archive should set runtime idle");
	assert(runtimeAfterArchive.activeThreadId === null, "archive should clear runtime activeThreadId");
	assert(fs.existsSync(threadPath), "archive should preserve runtime thread file");

	listedIds = await listAgentIds();
	assert(!listedIds.includes(agentId), "archived room should be hidden from active list");

	const statusAfterArchive = await requestJson(`/api/persistent-agents/${encodedAgentId}/status`);
	assert(statusAfterArchive.status === 410, `archived status call should return 410, got ${statusAfterArchive.status}: ${JSON.stringify(statusAfterArchive.body)}`);
	assert(statusAfterArchive.body?.status === "archived", "archived status error should include archived marker");
	assertNoPathLeak(statusAfterArchive.body, "archived status", [tempHome, tempAgentsRoot, repoRoot, agentRoot]);

	const threadAfterArchive = await requestJson(`/api/persistent-agents/${encodedAgentId}/threads/${encodeURIComponent(threadId)}`);
	assert(threadAfterArchive.status === 410, `archived thread load should reject safely, got ${threadAfterArchive.status}: ${JSON.stringify(threadAfterArchive.body)}`);
	assertNoPathLeak(threadAfterArchive.body, "archived thread rejection", [tempHome, tempAgentsRoot, repoRoot, agentRoot]);

	const archiveAgain = await requestJson(`/api/persistent-agents/${encodedAgentId}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${agentId}` }),
	});
	assert(archiveAgain.status === 409, `already archived room should return 409, got ${archiveAgain.status}: ${JSON.stringify(archiveAgain.body)}`);

	const missingScaffold = await requestJson(`/api/persistent-agents/borja-coordinator/scaffold`, { method: "POST" });
	assert(missingScaffold.status === 404, `retired default scaffold route should 404, got ${missingScaffold.status}: ${JSON.stringify(missingScaffold.body)}`);
	assert(!fs.existsSync(path.join(tempAgentsRoot, "borja-coordinator")), "retired scaffold route must not create borja-coordinator");

	const recreated = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({
			displayName: "Archive Smoke Room",
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		}),
	});
	assert(recreated.status === 201, `same-name recreation should succeed, got ${recreated.status}: ${JSON.stringify(recreated.body)}`);
	const recreatedId = String(recreated.body?.agent?.agentId ?? "");
	assert(recreatedId === "archive-smoke-room-2", `same-name recreation should allocate archive-smoke-room-2, got ${recreatedId}`);
	listedIds = await listAgentIds();
	assert(listedIds.includes(recreatedId), "recreated suffixed room should appear in active list");
	assert(!listedIds.includes(agentId), "archived original id must remain hidden after recreation");
	assert(fs.existsSync(path.join(tempAgentsRoot, agentId, "agent.json")), "archived original folder should remain on disk");
	assert(fs.existsSync(path.join(tempAgentsRoot, recreatedId, "agent.json")), "recreated suffixed room folder should exist separately");
	assert(!fs.existsSync(path.join(tempAgentsRoot, "borja-coordinator")), "archive smoke must not create borja-coordinator");

	// Rename: displayName + anchored constitution rewrite + word-boundary memory
	// mention replacement (previewable, archived); the id never changes.
	const renameRoot = path.join(tempAgentsRoot, recreatedId);
	const renameAgentJsonPath = path.join(renameRoot, "agent.json");
	const renameL1aPath = path.join(renameRoot, "L1a.md");
	const renameL1bPath = path.join(renameRoot, "L1b", "current.md");
	const renameArchiveDir = path.join(renameRoot, "L1b", "archive");
	// The scaffolded L1b mentions the display name twice (Chronos + Deep Memory).
	// Add one more whole-phrase mention plus two inside-longer-word decoys that
	// the boundary matcher must ignore.
	const boundaryLine = "Boundary check: Archive Smoke Rooms and xArchive Smoke Room stay as-is; (Archive Smoke Room) counts.";
	fs.writeFileSync(renameL1bPath, readText(renameL1bPath).trimEnd() + "\n\n" + boundaryLine + "\n", { mode: 0o600 });
	const l1bBeforeRename = readText(renameL1bPath);
	const l1aBeforeRename = readText(renameL1aPath);
	const agentJsonBeforeRename = readText(renameAgentJsonPath);

	const renameEmpty = await requestJson(`/api/persistent-agents/${encodeURIComponent(recreatedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "   " }),
	});
	assert(renameEmpty.status === 400, `empty rename should reject, got ${renameEmpty.status}: ${JSON.stringify(renameEmpty.body)}`);

	const renameUnchanged = await requestJson(`/api/persistent-agents/${encodeURIComponent(recreatedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Archive Smoke Room" }),
	});
	assert(renameUnchanged.status === 400, `unchanged rename should reject, got ${renameUnchanged.status}: ${JSON.stringify(renameUnchanged.body)}`);

	const renameArchived = await requestJson(`/api/persistent-agents/${encodedAgentId}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Should Not Apply" }),
	});
	assert(renameArchived.status === 409, `archived room rename should return 409, got ${renameArchived.status}: ${JSON.stringify(renameArchived.body)}`);

	// Preview (dryRun): reports the mention lines and writes nothing.
	const renamePreview = await requestJson(`/api/persistent-agents/${encodeURIComponent(recreatedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Renamed Smoke Room", dryRun: true }),
	});
	assert(renamePreview.status === 200, `rename preview should succeed, got ${renamePreview.status}: ${JSON.stringify(renamePreview.body)}`);
	assert(renamePreview.body?.dryRun === true, "preview should report dryRun");
	assert(renamePreview.body?.memoryMentions?.count === 3, `preview should find 3 whole-word mentions, got ${JSON.stringify(renamePreview.body?.memoryMentions)}`);
	assert(Array.isArray(renamePreview.body?.memoryMentions?.lines) && renamePreview.body.memoryMentions.lines.length === 3, "preview should list one line per mention");
	assert(renamePreview.body.memoryMentions.lines.every((entry: any) => String(entry.text).includes("Archive Smoke Room")), "preview lines should contain the old name");
	assert(renamePreview.body?.memoryUpdated === false, "preview must not report a memory write");
	assertNoPathLeak(renamePreview.body, "rename preview", [tempHome, tempAgentsRoot, repoRoot, renameRoot]);
	assert(readText(renameL1bPath) === l1bBeforeRename, "preview must not touch L1b");
	assert(readText(renameL1aPath) === l1aBeforeRename, "preview must not touch L1a");
	assert(readText(renameAgentJsonPath) === agentJsonBeforeRename, "preview must not touch agent.json");
	assert(!fs.existsSync(renameArchiveDir) || fs.readdirSync(renameArchiveDir).length === 0, "preview must not create archive entries");

	const renamed = await requestJson(`/api/persistent-agents/${encodeURIComponent(recreatedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "  Renamed   Smoke Room  " }),
	});
	assert(renamed.status === 200, `rename should succeed, got ${renamed.status}: ${JSON.stringify(renamed.body)}`);
	assert(renamed.body?.agentId === recreatedId, "rename response should keep the agent id");
	assert(renamed.body?.displayName === "Renamed Smoke Room", "rename should collapse whitespace like creation");
	assert(renamed.body?.previousDisplayName === "Archive Smoke Room", "rename response should carry the previous name");
	assert(renamed.body?.constitutionUpdated === true, "pristine constitution anchors should both update");
	assert(renamed.body?.memoryMentions?.count === 3, "apply should report the same 3 mentions");
	assert(renamed.body?.memoryUpdated === true, "apply should rewrite the learned memory");
	assert(/^L1b\/archive\/\d{8}T\d{6}Z-before-rename_/.test(String(renamed.body?.archivedL1b ?? "").replace(/\\/g, "/")), `apply should report the archive rel path, got ${renamed.body?.archivedL1b}`);
	assertNoPathLeak(renamed.body, "rename", [tempHome, tempAgentsRoot, repoRoot, renameRoot]);
	const renamedMeta = readJson(renameAgentJsonPath);
	assert(renamedMeta.id === recreatedId, "rename must never change the id");
	assert(renamedMeta.displayName === "Renamed Smoke Room", "agent.json should persist the new displayName");
	assert(renamedMeta.updatedAt === renamed.body.updatedAt, "agent.json should persist updatedAt from response");
	const l1aAfterRename = readText(renameL1aPath);
	assert(l1aAfterRename.startsWith("# Renamed Smoke Room Constitution\n"), "L1a heading anchor should carry the new name");
	assert(l1aAfterRename.includes("You are **Renamed Smoke Room**"), "L1a identity anchor should carry the new name");
	assert(!l1aAfterRename.includes("Archive Smoke Room"), "L1a should no longer mention the old name at the anchors");
	const l1bAfterRename = readText(renameL1bPath);
	assert(l1bAfterRename.includes("Agent display name: Renamed Smoke Room"), "L1b Chronos mention should carry the new name");
	assert(l1bAfterRename.includes("(Renamed Smoke Room)"), "L1b parenthesized whole-phrase mention should carry the new name");
	assert(l1bAfterRename.includes("Archive Smoke Rooms and xArchive Smoke Room stay as-is"), "inside-longer-word decoys must stay untouched");
	assert(readText(path.join(renameRoot, String(renamed.body.archivedL1b))) === l1bBeforeRename, "the archived L1b must be the exact pre-rename content");
	assert(fs.readdirSync(renameArchiveDir).length === 1, "apply should create exactly one archive entry");

	// Customized constitution: a broken heading anchor is left untouched and reported.
	fs.writeFileSync(renameL1aPath, l1aAfterRename.replace("# Renamed Smoke Room Constitution", "# My Custom Charter"), { mode: 0o600 });
	const renamedPartial = await requestJson(`/api/persistent-agents/${encodeURIComponent(recreatedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Partial Anchor Room" }),
	});
	assert(renamedPartial.status === 200, `partial-anchor rename should still succeed, got ${renamedPartial.status}: ${JSON.stringify(renamedPartial.body)}`);
	assert(renamedPartial.body?.constitutionUpdated === false, "customized heading should report constitutionUpdated false");
	assert(renamedPartial.body?.constitutionAnchors?.heading === false, "broken heading anchor should report heading false");
	assert(renamedPartial.body?.constitutionAnchors?.identity === true, "intact identity anchor should still update");
	const l1aAfterPartial = readText(renameL1aPath);
	assert(l1aAfterPartial.startsWith("# My Custom Charter\n"), "customized heading must be left untouched");
	assert(l1aAfterPartial.includes("You are **Partial Anchor Room**"), "identity anchor should carry the newest name");
	assert(readJson(renameAgentJsonPath).displayName === "Partial Anchor Room", "agent.json should carry the newest name after partial rename");
	assert(renamedPartial.body?.memoryUpdated === true, "partial rename should still rewrite memory mentions");
	assert(fs.readdirSync(renameArchiveDir).length === 2, "each memory rewrite should add one archive entry");

	// Unicode boundary: a diacritic name must match whole phrases only.
	const accented = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({ displayName: "Café Räume", userName: "Synthetic User" }),
	});
	assert(accented.status === 201, `diacritic room creation should succeed, got ${accented.status}: ${JSON.stringify(accented.body)}`);
	const accentedId = String(accented.body?.agent?.agentId ?? "");
	assert(accentedId === "cafe-raume", `diacritic slug should strip accents, got ${accentedId}`);
	const accentedL1bPath = path.join(tempAgentsRoot, accentedId, "L1b", "current.md");
	fs.writeFileSync(accentedL1bPath, readText(accentedL1bPath).trimEnd() + "\n\nDecoy: Café Räumen must stay; Café Räume! counts.\n", { mode: 0o600 });
	const accentedPreview = await requestJson(`/api/persistent-agents/${encodeURIComponent(accentedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Salon Ost", dryRun: true }),
	});
	assert(accentedPreview.status === 200, `diacritic preview should succeed, got ${accentedPreview.status}: ${JSON.stringify(accentedPreview.body)}`);
	assert(accentedPreview.body?.memoryMentions?.count === 3, `diacritic preview should find 3 mentions (2 scaffold + 1 punctuation-bounded), got ${JSON.stringify(accentedPreview.body?.memoryMentions)}`);
	const accentedRename = await requestJson(`/api/persistent-agents/${encodeURIComponent(accentedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Salon Ost" }),
	});
	assert(accentedRename.status === 200, `diacritic rename should succeed, got ${accentedRename.status}: ${JSON.stringify(accentedRename.body)}`);
	const accentedL1bAfter = readText(accentedL1bPath);
	assert(accentedL1bAfter.includes("Café Räumen must stay"), "diacritic inside-longer-word decoy must stay untouched");
	assert(accentedL1bAfter.includes("Salon Ost! counts."), "punctuation-bounded diacritic mention should be replaced");
	assert(!accentedL1bAfter.includes("Café Räume!"), "no boundary-exact old-name mention should survive in L1b");

	// Busy surfaces: another process (scheduler run, CLI session) may be mid-write in this room;
	// rename must refuse instead of interleaving with it.
	const lockDirPath = path.join(tempHome, ".exxperts", "app", ".room-locks");
	fs.mkdirSync(lockDirPath, { recursive: true });
	const accentedLockPath = path.join(lockDirPath, `${accentedId}.json`);
	for (const surface of ["scheduler", "cli"]) {
		fs.writeFileSync(accentedLockPath, JSON.stringify({ surface, pid: process.pid, connectionId: "synthetic-lock", host: os.hostname(), label: "smoke", acquiredAt: Date.now(), lastSeen: Date.now() }), { mode: 0o600 });
		const busy = await requestJson(`/api/persistent-agents/${encodeURIComponent(accentedId)}/rename`, {
			method: "POST",
			body: JSON.stringify({ displayName: "Locked Name" }),
		});
		assert(busy.status === 409, `${surface}-locked rename should return 409, got ${busy.status}: ${JSON.stringify(busy.body)}`);
	}
	fs.rmSync(accentedLockPath, { force: true });
	assert(readJson(path.join(tempAgentsRoot, accentedId, "agent.json")).displayName === "Salon Ost", "locked renames must not change the stored name");

	// A memory write landing between the preview scan and the apply must be renamed too, never
	// clobbered by stale content — and the archive must capture it.
	const stalePreview = await requestJson(`/api/persistent-agents/${encodeURIComponent(accentedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Studio West", dryRun: true }),
	});
	assert(stalePreview.status === 200, `race preview should succeed, got ${stalePreview.status}: ${JSON.stringify(stalePreview.body)}`);
	const previewCount = Number(stalePreview.body?.memoryMentions?.count ?? 0);
	fs.writeFileSync(accentedL1bPath, readText(accentedL1bPath).trimEnd() + "\n\nFreshly learned fact about Salon Ost.\n", { mode: 0o600 });
	const raceRename = await requestJson(`/api/persistent-agents/${encodeURIComponent(accentedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Studio West" }),
	});
	assert(raceRename.status === 200, `race rename should succeed, got ${raceRename.status}: ${JSON.stringify(raceRename.body)}`);
	assert(raceRename.body?.memoryMentions?.count === previewCount + 1, `apply should re-scan and pick up the just-learned mention, got ${JSON.stringify(raceRename.body?.memoryMentions)}`);
	const raceL1b = readText(accentedL1bPath);
	assert(raceL1b.includes("Freshly learned fact about Studio West."), "just-learned memory must be renamed, not clobbered");
	assert(readText(path.join(tempAgentsRoot, accentedId, String(raceRename.body.archivedL1b))).includes("Freshly learned fact about Salon Ost."), "the rename archive must capture the just-learned memory");

	// A partially-applied rename (crash before the agent.json write) must report truthfully on
	// retry: the anchors already carry the new name, so constitutionUpdated stays true.
	const accentedAgentJsonPath = path.join(tempAgentsRoot, accentedId, "agent.json");
	const accentedMeta = readJson(accentedAgentJsonPath);
	fs.writeFileSync(accentedAgentJsonPath, JSON.stringify({ ...accentedMeta, displayName: "Salon Ost" }, null, 2) + "\n", { mode: 0o600 });
	const retryRename = await requestJson(`/api/persistent-agents/${encodeURIComponent(accentedId)}/rename`, {
		method: "POST",
		body: JSON.stringify({ displayName: "Studio West" }),
	});
	assert(retryRename.status === 200, `retry rename should succeed, got ${retryRename.status}: ${JSON.stringify(retryRename.body)}`);
	assert(retryRename.body?.constitutionUpdated === true, "retry after partial apply should report the constitution as current, not 'not updated'");
	assert(retryRename.body?.memoryMentions?.count === 0 && retryRename.body?.memoryUpdated === false, "retry should truthfully report no remaining memory mentions");
	assert(readJson(accentedAgentJsonPath).displayName === "Studio West", "retry should complete the partially-applied rename");

	console.log("persistent-agent archive smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	}
}
