import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, type AuthedFetchInit, waitForServer } from "./smoke-server-process.js";
import { listSkillFiles, sha256, writeSkillProvenance } from "../src/skills-store.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";

// Pins the REAL execution-exposure chain end to end, through a live room
// session — the seam every other skill smoke stubs. A synthetic gateway
// plays the model and calls read_skill; the server executes the actual tool
// with the actual skill files resolver room-socket.ts builds; the tool
// result then travels back to the gateway inside the follow-up completion
// request, where this smoke reads it. Asserted:
//
// - with localFiles + bash and the skill switched on, never approved, the
//   served body carries the on-disk skill dir and the bundled file name (the
//   gate OPENS on a real turn: the regression this smoke exists for, the
//   original gate read an env var that only existed during extension
//   install, so it could never open outside a test), in words that say
//   nothing of an approval;
// - a changed SKILL.md is served as it now is on the next read, in the same
//   conversation and in a new one, and an old entry with a stale hash and an
//   approval is on, its file kept byte for byte by everything that reads it;
// - the old approve and revoke actions are refused, and the settings answers
//   carry the skill's name, status and mark only;
// - with commands off the room gets the folder to read and the line that its
//   scripts can't run; with no folder, or one that can't be found, the count
//   of files and never a path; a skill with SKILL.md alone gets nothing more,
//   commands on included; commands set to run without asking on a computer
//   whose protection can't run read as off; and the settings answer's
//   skillFiles says the same as each room's text;
// - a shared-folder skill kept to its instructions (its link leads into the
//   app's data) gets the instructions-only line with its count, and past 2,000
//   files "more than 2,000", its files counted no further; one linked outside
//   ~/.agents elsewhere hands over its real folder.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-exposure-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const workspaceRoot = path.join(tempHome, "workspace");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

// The skill under test: a user-store skill with one bundled script, planted
// exactly as accept would leave it (SKILL.md + files + provenance sidecar).
const skillName = "convert-docs";
const skillDir = path.join(agentDir, "skills", skillName);
fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true, mode: 0o700 });
const skillManifest = `---\nname: ${skillName}\ndescription: Converts documents with a bundled script\n---\n\nRun the bundled script to convert documents.\n`;
fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillManifest, { mode: 0o600 });
fs.writeFileSync(path.join(skillDir, "scripts", "convert.py"), "print('converted')\n", { mode: 0o600 });
writeSkillProvenance(skillDir, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(skillManifest) });
assert(listSkillFiles(skillDir)?.includes("scripts/convert.py"), "the planted skill must list its bundled script");
// A skill with SKILL.md alone.
const plainName = "plain-note";
const plainManifest = `---\nname: ${plainName}\ndescription: A note with no files\n---\n\nWrite the note plainly.\n`;
fs.mkdirSync(path.join(agentDir, "skills", plainName), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(agentDir, "skills", plainName, "SKILL.md"), plainManifest, { mode: 0o600 });
writeSkillProvenance(path.join(agentDir, "skills", plainName), { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(plainManifest) });

// ---------------------------------------------------------------------------
// Synthetic gateway: first request of each turn answers with a read_skill
// tool call; the follow-up request (recognizable by the tool result riding
// in its messages) is captured and answered with plain text.
// ---------------------------------------------------------------------------
const capturedToolResults: string[] = [];
// The skill the next turn's read_skill asks for.
let readName = skillName;

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		// This turn's tool results: those after its prompt, the conversation's earlier turns left out.
		const lastPrompt = messages.map((m) => m?.role).lastIndexOf("user");
		const toolMessages = messages.slice(lastPrompt + 1).filter((m) => m?.role === "tool");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${capturedToolResults.length + 1}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (toolMessages.length === 0) {
			// First leg of the turn: the model "decides" to read the skill.
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_read_skill", type: "function", function: { name: "read_skill", arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ name: readName }) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			// Second leg: the tool already ran server-side; capture what it said.
			capturedToolResults.push(toolMessages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 5, total_tokens: 155 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const WebSocketImpl: any = (await import("ws")).default;

// Run one prompt turn over the room WS and wait for the assistant's "done",
// which only arrives after the tool round-trip completed, then for the turn
// to settle on the server.
async function runTurn(agentId: string, conversationId: string, options: { continues?: boolean } = {}): Promise<void> {
	// Prompting requires the room's current active thread; seed an empty one
	// under this conversation id first, like the client does on room open. A
	// turn that continues the conversation sends into the thread as it is.
	if (!options.continues) {
		const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
			method: "PUT",
			body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
		});
		assert(seeded.status === 200, `thread seed: expected 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
	}
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch {}
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	socket.send(JSON.stringify({ type: "prompt", text: "Please read the convert-docs skill." }));
	const deadline = Date.now() + 30_000;
	const before = capturedToolResults.length;
	while (Date.now() < deadline) {
		// Leave only once the turn has ended on the server side: closing the
		// socket on the first tool result races the turn's own finish, whose
		// final write moves the room's active thread back under the next
		// conversation's feet and its prompt is refused as not current.
		// A landing after the switch now leaves the pointer alone
		// (keepRuntimeIfMoved, pinned by conversation-switch-race-smoke), so
		// this agent_end check is only harmless; the settle wait below is the
		// one the next conversation needs.
		if (capturedToolResults.length > before && frames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end")) {
			await waitForTurnSettled(requestJson, agentId, `${conversationId}: the turn has settled before the next seed`);
			try { socket.close(); } catch {}
			return;
		}
		const errors = frames.filter((frame) => String(frame?.type ?? "").includes("error"));
		if (errors.length > 0) throw new Error(`turn errored before the tool round-trip: ${JSON.stringify(errors[0]).slice(0, 400)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`turn did not complete a tool round-trip and end; frame types: ${frames.map((f) => f?.type).join(", ")}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
				api: "openai-completions",
				models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-exposure-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

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
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 20_000);

	// A bash room: localFiles workspace with the bash switch on.
	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Exposure Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation: expected 201, got ${room.status}: ${JSON.stringify(room.body)}`);
	const agentId = String(room.body?.agent?.id ?? room.body?.agent?.agentId ?? "");
	assert(agentId, `room creation must return an id, got ${JSON.stringify(room.body).slice(0, 300)}`);
	const workspace = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "Exposure Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }),
	});
	assert(workspace.status === 200, `workspace default PUT: expected 200, got ${workspace.status}: ${JSON.stringify(workspace.body)}`);
	assert(workspace.body?.policy?.bashEnabled === true, "the room default must carry bashEnabled");

	const settingsUrl = `/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`;
	const enable = await requestJson(settingsUrl, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) });
	assert(enable.status === 200, `skill enable: expected 200, got ${enable.status}: ${JSON.stringify(enable.body)}`);
	assert(JSON.stringify(enable.body?.skills) === JSON.stringify([{ name: skillName, status: "ok" }]), `the enable answer carries the skill's name and status only, got ${JSON.stringify(enable.body?.skills)}`);
	for (const action of ["approve-execution", "revoke-execution"]) {
		const refused = await requestJson(settingsUrl, { method: "PUT", body: JSON.stringify({ action, name: skillName }) });
		assert(refused.status === 400 && refused.body?.error === "action must be 'enable' or 'disable'", `${action} must be refused, got ${refused.status}: ${JSON.stringify(refused.body)}`);
	}
	const listed = await requestJson(settingsUrl);
	assert(JSON.stringify(listed.body?.skills) === JSON.stringify([{ name: skillName, status: "ok", manualOnly: false }]), `the settings answer carries the skill's name, status and mark only, got ${JSON.stringify(listed.body?.skills)}`);

	// The room's file as an older app left it: a hash of text the skill no longer
	// has, and a run approval of files it no longer has.
	const settingsFile = path.join(agentsRoot, agentId, "runtime", "skill-settings.json");
	assert(fs.existsSync(settingsFile), `the room's skill settings live at ${settingsFile}`);
	const oldShape = `${JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: skillName, sha256: sha256("the text it had"), executeApproval: { filesSha256: sha256("the files it had"), approvedAt: "2026-11-01T10:00:00.000Z" } }], updatedAt: "2026-11-01T10:00:00.000Z" }, null, 2)}\n`;
	fs.writeFileSync(settingsFile, oldShape, { mode: 0o600 });
	const oldListed = await requestJson(settingsUrl);
	assert(oldListed.body?.skills?.[0]?.status === "ok", `an old entry with a stale hash and an approval reads on, got ${JSON.stringify(oldListed.body?.skills)}`);

	// 1. On, never approved, bash + localFiles: the REAL closure exposes the path.
	const UNTRUE = /approv|review|exactly this version|pinned|voids/i;
	await runTurn(agentId, "conv-exposed");
	const exposed = capturedToolResults[0];
	assert(exposed.includes("Run the bundled script to convert documents."), `the tool result must carry the skill body, got: ${exposed.slice(0, 400)}`);
	assert(exposed.includes(skillDir), `the tool result must carry the on-disk skill dir (the gate must OPEN on a real turn), got: ${exposed.slice(0, 600)}`);
	assert(exposed.includes("when you tell the user where an output landed, name the folder's path.") && !exposed.includes("Attachments panel") && !exposed.includes("Files panel"), `the outputs line names the folder and no panel, which the room's own lines name once, got: ${exposed.slice(-700)}`);
	assert(exposed.includes(JSON.stringify("scripts/convert.py")), `the tool result must list the bundled script, got: ${exposed.slice(0, 600)}`);
	assert(!UNTRUE.test(exposed.replaceAll(skillDir, "")), `the tool result says nothing of an approval, a review or a pinned version, got: ${exposed}`);

	// 2. SKILL.md's body changes, its name and description as they were: the next
	// read serves the new body, in the same conversation and in a new one.
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillManifest.replace("Run the bundled script to convert documents.", "Run the bundled script twice to convert documents."), { mode: 0o600 });
	await runTurn(agentId, "conv-exposed", { continues: true });
	await runTurn(agentId, "conv-changed");
	for (const [at, where] of [[1, "the same conversation"], [2, "a new conversation"]] as const) {
		const changed = capturedToolResults[at];
		assert(changed.includes("Run the bundled script twice to convert documents.") && changed.includes(skillDir), `${where}: the changed body is served, with its folder, got: ${changed.slice(0, 600)}`);
	}
	// Nothing that read the room's skills wrote its file.
	assert(fs.readFileSync(settingsFile, "utf-8") === oldShape, "the settings reads and the turns leave the room's file byte for byte as it was");

	// 3. A room without bash never sees the path.
	const room2 = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "No Bash Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId2 = String(room2.body?.agent?.id ?? room2.body?.agent?.agentId ?? "");
	assert(agentId2, "second room must create");
	const enable2 = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId2)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) });
	assert(enable2.status === 200, `skill enable (room 2): expected 200, got ${enable2.status}`);
	await runTurn(agentId2, "conv-no-bash");
	const noBash = capturedToolResults[3];
	assert(noBash.includes("Run the bundled script twice to convert documents.") && !noBash.includes(skillDir), `a room without bash gets the body and never the path, got: ${noBash.slice(0, 600)}`);
	// The rows on what each room is told: every one runs, so one run names each answer that is wrong.
	const rowsFailed: string[] = [];
	const check = (condition: unknown, message: string): void => {
		if (!condition) rowsFailed.push(message);
	};
	const NONE_LINE = "This skill has 1 more file beside these instructions, and this room can't open them. Work from the instructions alone; if the task needs one of those files, say so. The person can let this room read them by choosing a folder for it, and run its scripts by also switching Commands on.";
	check(noBash.endsWith(NONE_LINE), `a room without a folder is told the count of the skill's files and how the person can open them, got: ${noBash.slice(-500)}`);
	const skillFilesOf = async (id: string) => (await requestJson(`/api/persistent-agents/${encodeURIComponent(id)}/skill-settings`)).body?.skillFiles;
	check(await skillFilesOf(agentId) === "run" && await skillFilesOf(agentId2) === "none", `the settings answer says run with a folder and commands on, none without a folder, got ${await skillFilesOf(agentId)}, ${await skillFilesOf(agentId2)}`);

	// 4. A skill with SKILL.md alone, commands on: nothing about files.
	assert((await requestJson(settingsUrl, { method: "PUT", body: JSON.stringify({ action: "enable", name: plainName }) })).status === 200, "the plain skill switches on");
	readName = plainName;
	await runTurn(agentId, "conv-plain");
	const plain = capturedToolResults.at(-1)!;
	check(plain.trimEnd().endsWith("Write the note plainly.") && !plain.includes("Files:") && !plain.includes("bundled files"), `a skill with SKILL.md alone gets nothing more with commands on, got: ${plain.slice(-400)}`);
	readName = skillName;

	// 5. A folder with commands off: the folder to read, and that its scripts can't run.
	const room3 = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Read Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId3 = String(room3.body?.agent?.id ?? room3.body?.agent?.agentId ?? "");
	assert(agentId3, "the read room must create");
	const readOnly = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId3)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, displayLabel: "Read Workspace", workspaceAccessMode: "localFiles", bashEnabled: false }) });
	assert(readOnly.status === 200 && readOnly.body?.policy?.bashEnabled === false, `the read room's folder with commands off, got ${readOnly.status}`);
	assert((await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId3)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) })).status === 200, "skill enable (read room)");
	await runTurn(agentId3, "conv-read");
	const readText = capturedToolResults.at(-1)!;
	check(readText.includes(`This skill's bundled files live at:\n${skillDir}`) && readText.includes(JSON.stringify("scripts/convert.py")) && readText.includes("Commands are off in this room, so its scripts can't run here") && !readText.includes("bash tool"), `with commands off the room gets the folder to read, got: ${readText.slice(-900)}`);
	check(await skillFilesOf(agentId3) === "read", `the read room's answer says read, got ${await skillFilesOf(agentId3)}`);

	// 6. A folder that can't be found: as no folder.
	const goneRoot = path.join(tempHome, "gone-workspace");
	fs.mkdirSync(goneRoot, { recursive: true, mode: 0o700 });
	const room4 = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Gone Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId4 = String(room4.body?.agent?.id ?? room4.body?.agent?.agentId ?? "");
	assert(agentId4, "the gone room must create");
	assert((await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId4)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: goneRoot, displayLabel: "Gone Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) })).status === 200, "the gone room's folder");
	assert((await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId4)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) })).status === 200, "skill enable (gone room)");
	fs.renameSync(goneRoot, `${goneRoot}-moved`);
	await runTurn(agentId4, "conv-gone");
	const goneText = capturedToolResults.at(-1)!;
	check(goneText.endsWith(NONE_LINE) && !goneText.includes(skillDir), `a folder that can't be found reads as none, got: ${goneText.slice(-500)}`);
	check(await skillFilesOf(agentId4) === "none", `the gone room's answer says none, got ${await skillFilesOf(agentId4)}`);

	// 6b. A folder moved and replaced by a link to it: the fence won't open it, so as no folder.
	const linkedRoot = path.join(tempHome, "linked-workspace");
	fs.mkdirSync(linkedRoot, { recursive: true, mode: 0o700 });
	const room5 = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Linked Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId5 = String(room5.body?.agent?.id ?? room5.body?.agent?.agentId ?? "");
	assert(agentId5, "the linked room must create");
	assert((await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId5)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: linkedRoot, displayLabel: "Linked Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) })).status === 200, "the linked room's folder");
	assert((await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId5)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) })).status === 200, "skill enable (linked room)");
	await runTurn(agentId5, "conv-linked-before");
	check(capturedToolResults.at(-1)!.includes(`This skill's bundled files live at:\n${skillDir}`) && await skillFilesOf(agentId5) === "run", "before the move the linked room's folder opens and its answer says run");
	fs.renameSync(linkedRoot, `${linkedRoot}-moved`);
	fs.symlinkSync(`${linkedRoot}-moved`, linkedRoot, process.platform === "win32" ? "junction" : "dir");
	await runTurn(agentId5, "conv-linked");
	const linkedText = capturedToolResults.at(-1)!;
	check(linkedText.endsWith(NONE_LINE) && !linkedText.includes(skillDir), `a folder moved and replaced by a link reads as none, got: ${linkedText.slice(-500)}`);
	check(await skillFilesOf(agentId5) === "none", `the linked room's answer says none, got ${await skillFilesOf(agentId5)}`);

	// 6c. A skill of many files: the rest are listed with the ls tool, which every room that reads has, one saved with Read alone included (its tools fold back to the four that read).
	const bigName = "many-files";
	const bigDir = path.join(agentDir, "skills", bigName);
	fs.mkdirSync(path.join(bigDir, "docs"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(bigDir, "SKILL.md"), `---\nname: ${bigName}\ndescription: A skill with many files.\n---\n\nUse the docs.\n`, { mode: 0o600 });
	for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(bigDir, "docs", `d${i}.md`), "x\n", { mode: 0o600 });
	const LS_LINE = "List this folder, or any folder in it, with the ls tool.";
	readName = bigName;
	assert((await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId3)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: bigName }) })).status === 200, "many-files enable (read room)");
	await runTurn(agentId3, "conv-read-many");
	const withLs = capturedToolResults.at(-1)!;
	check(withLs.includes("Not every file is listed here.") && withLs.includes(LS_LINE), `a room with ls is told to list the rest with it, got: ${withLs.slice(-700)}`);
	const room6 = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Read Only Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId6 = String(room6.body?.agent?.id ?? room6.body?.agent?.agentId ?? "");
	assert(agentId6, "the read-only room must create");
	const readAlone = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId6)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, displayLabel: "Read Only Workspace", workspaceAccessMode: "localFiles", bashEnabled: false, toolSelection: { kind: "custom", allowedToolNames: ["read"] } }) });
	assert(readAlone.status === 200, `the read-only room's folder with read alone, got ${readAlone.status}`);
	assert((await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId6)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: bigName }) })).status === 200, "many-files enable (read-only room)");
	await runTurn(agentId6, "conv-read-alone");
	const readAloneText = capturedToolResults.at(-1)!;
	check(readAloneText.includes(`This skill's bundled files live at:\n${bigDir}`) && readAloneText.includes(LS_LINE), `a room saved with Read alone has ls back and is told to list the rest with it, got: ${readAloneText.slice(-700)}`);
	check(await skillFilesOf(agentId6) === "read", `the read-only room's answer says read, got ${await skillFilesOf(agentId6)}`);
	readName = skillName;

	// 6d. Shared-folder skills linked into the app's data: kept to their instructions, the model told how many files they
	// have. One linked outside ~/.agents elsewhere: the model gets its real folder.
	const sharedLinked = (name: string, files: number, at = path.join(tempHome, ".exxperts", "kept")): string => {
		const target = path.join(at, name);
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(target, "SKILL.md"), `---\nname: ${name}\ndescription: A shared skill kept elsewhere.\n---\n\nUse the notes.\n`, { mode: 0o600 });
		for (let i = 0; i < files; i++) fs.writeFileSync(path.join(target, `n${i}.md`), "x\n", { mode: 0o600 });
		fs.mkdirSync(path.join(tempHome, ".agents", "skills"), { recursive: true });
		fs.symlinkSync(target, path.join(tempHome, ".agents", "skills", name), process.platform === "win32" ? "junction" : "dir");
		return target;
	};
	const ONLY_LINE = (count: string) => `This skill has ${count} beside these instructions, and rooms can't open them. Work from the instructions alone.`;
	sharedLinked("shared-few", 2);
	const manyTarget = sharedLinked("shared-many", 2_001);
	// A folder past the 2,001st file that can't be listed: a count that walked on would fail there.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		fs.mkdirSync(path.join(manyTarget, "zz-locked"));
		fs.chmodSync(path.join(manyTarget, "zz-locked"), 0o000);
	} else console.log("SKIPPED: the locked folder past the count (taking rights away refuses no read on Windows or as root)");
	try {
		for (const [name, count] of [["shared-few", "2 more files"], ["shared-many", "more than 2,000 files"]] as const) {
			assert((await requestJson(settingsUrl, { method: "PUT", body: JSON.stringify({ action: "enable", name }) })).status === 200, `${name} enable`);
			readName = name;
			await runTurn(agentId, `conv-${name}`);
			const text = capturedToolResults.at(-1)!;
			check(text.trimEnd().endsWith(ONLY_LINE(count)) && !text.includes(path.join(tempHome, ".exxperts", "kept")), `a shared-folder skill kept to its instructions is told it has ${count}, and never its path, got: ${text.slice(-400)}`);
		}
	} finally {
		if (canForceFsRefusal) fs.chmodSync(path.join(manyTarget, "zz-locked"), 0o755);
	}
	const awayTarget = sharedLinked("shared-away", 2, path.join(tempHome, "elsewhere"));
	assert((await requestJson(settingsUrl, { method: "PUT", body: JSON.stringify({ action: "enable", name: "shared-away" }) })).status === 200, "shared-away enable");
	readName = "shared-away";
	await runTurn(agentId, "conv-shared-away");
	const awayText = capturedToolResults.at(-1)!;
	check(awayText.includes(`This skill's bundled files live at:\n${fs.realpathSync.native(awayTarget)}`), `a shared-folder skill linked outside ~/.agents hands over its real folder, got: ${awayText.slice(-600)}`);
	readName = skillName;

	// 7. Commands set to run without asking, on a computer whose protection can't run (as room-protection-smoke.ts acts as Linux): read, not run.
	process.env.HOME = tempHome;
	// Windows reads the home from USERPROFILE, and the fence judges the room's folder by it.
	process.env.USERPROFILE = tempHome;
	process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
	process.env.EXXPERTS_TEST_INTROSPECTION = "1";
	process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
	const { resolvePersistentRoomEffectiveWorkspacePolicy } = await import("../src/persistent-room-workspace-policy.js");
	const { skillFilesReach } = await import("../src/persistent-room-skill-tool.js");
	const reachIn = (id: string) => (typeof skillFilesReach === "function" ? skillFilesReach(resolvePersistentRoomEffectiveWorkspacePolicy(id, "conv-linux"), false) : "missing");
	check(reachIn(agentId) === "run", `commands on run where protection can't, got ${reachIn(agentId)}`);
	// The room saved with Read alone (6c): its tools fold back to the four that read, so the ls line is true there.
	check(resolvePersistentRoomEffectiveWorkspacePolicy(agentId6, "conv-linux").allowedToolNames.includes("ls"), "the room saved with Read alone has ls");
	const policyFile = path.join(agentsRoot, agentId, "runtime", "workspace-default.json");
	const stored = JSON.parse(fs.readFileSync(policyFile, "utf-8"));
	fs.writeFileSync(policyFile, JSON.stringify({ ...stored, commands: "automatic" }, null, 2), { mode: 0o600 });
	check(reachIn(agentId) === "read", `commands set to run without asking, where protection can't run, read as off, got ${reachIn(agentId)}`);
	assert(rowsFailed.length === 0, rowsFailed.join("\n"));

	console.log("skills-execution-exposure-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
