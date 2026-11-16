// Settle this room: every reader of a room's content finishes what a crash
// left half done before it reads, for itself, and never inside a save.
//
//   1. the step is the only caller of the crash finish and the Forget sweep,
//      and costs one file call on a settled room;
//   2. a real kill (SIGKILL in a child process) at every write of a Remember
//      and a Forget: the next settle clears the intent, no page is written
//      twice, the words go, and a second settle changes no file;
//   3. every reader, through its route where it has one: a pending Remember is
//      settled before the answer is built, and a half-done Forget's words never
//      come back and are erased;
//   4. a save in flight is neither finished nor dropped by a read during it.
//
// Offline: fake proposal text, a local model that answers 400, no port.
// ONLY=kills,readers runs those groups alone (step, kills, readers, inflight).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

const job = process.env.ROOM_SETTLE_KILL_JOB;
const tempHome = job ? String(process.env.HOME) : fs.mkdtempSync(path.join(os.tmpdir(), "room-settle-home-"));
const appDir = path.join(tempHome, ".exxperts", "app");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const root = path.join(appDir, "personalized-agents");
const tempCwd = path.join(tempHome, "cwd");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;
// The app's state follows these before HOME: left set, the smoke would write into the profile they name.
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);

const MODEL = { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5" };
const APPROVED_PAGE = "### RC-DRAFT | CLOSED | 2026-10-08 | The logo\n\n**Session arc:** We picked a logo.\n\n**Body:**\n- The blue logo was chosen.\n\n**Parked:**\nNone\n";
const WORD = "QUILLARANTH";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// --- A kill: the child runs one save and dies at its Nth file change -----------

/** Every file change a save makes goes through one of these. */
const FILE_CHANGES = ["writeFileSync", "appendFileSync", "renameSync", "rmSync", "unlinkSync", "mkdirSync", "copyFileSync", "utimesSync", "openSync"] as const;

/** Runs before each file change from the save's intent on; the patch reaches named imports too. */
function watchFileChanges(onChange: (name: string, target: string) => void): () => void {
	const real = new Map<string, any>(FILE_CHANGES.map((name) => [name, (fs as any)[name]]));
	for (const name of FILE_CHANGES) {
		(fs as any)[name] = (...args: any[]) => {
			// A read opens a file too; only an open for writing changes one.
			if (name !== "openSync" || (args[1] !== undefined && args[1] !== "r")) onChange(name, String(args[name === "renameSync" ? 1 : 0]));
			return real.get(name)(...args);
		};
	}
	syncBuiltinESMExports();
	return () => {
		for (const name of FILE_CHANGES) (fs as any)[name] = real.get(name);
		syncBuiltinESMExports();
	};
}

if (job) {
	const { kind, agentId, threadId, approval, killAt, countFile } = JSON.parse(job) as { kind: "remember" | "forget"; agentId: string; threadId: string; approval?: unknown; killAt: number; countFile: string };
	const agents = await import("../src/persistent-agents.js");
	const realWrite = fs.writeFileSync;
	let steps = 0;
	let saving = false;
	const stop = watchFileChanges((_name, target) => {
		saving ||= /[\\/]runtime[\\/]commit[\\/]/.test(target);
		if (!saving) return;
		steps += 1;
		if (steps !== killAt) return;
		// On Windows a killed process ends with code 1 and no signal, so the mark, not the signal, says the kill landed.
		realWrite(`${countFile}.killed-${killAt}`, "");
		process.kill(process.pid, "SIGKILL");
	});
	if (kind === "remember") {
		const parsed = agents.parseCheckpointApprovalRequest(approval, agentId);
		agents.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd });
	} else {
		agents.writePersistentAgentMementoBoundary(agentId, threadId, new Date(), { runtimeCwd: tempCwd });
	}
	stop();
	realWrite(countFile, String(steps));
	process.exit(0);
}

// --- The room's world -----------------------------------------------------------

fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempCwd, { recursive: true });
// A provider that answers every call with a 400: the memory chat reads its rooms, then its call fails.
const backend = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Not in this smoke." } }));
	});
});
await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}` } } }));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-smoke" } }), { mode: 0o600 });

const agents = await import("../src/persistent-agents.js");
const { settleRoom } = await import("../src/room-settle.js");
const { resetForgetSweepForTests } = await import("../src/forget-erase.js");
const { commitIntentPath, withRoomSaveLock } = await import("../src/memory-commit.js");
const { loadRoomCorpus } = await import("../src/memory-search-sources.js");
const { preparePersistentRoomBackgroundExecution } = await import("../src/persistent-room-background-execution.js");
const { assessTaskStoreGc } = await import("../src/specialist-task-store-gc.js");
await Promise.all(["memory-routes", "room-routes", "room-schedule-routes", "room-runtime-routes", "room-thread-routes", "room-settings-routes", "room-fold-routes", "room-remember-routes", "model-routes", "skill-routes", "remote-routes", "room-files-routes"].map((name) => import(`../src/${name}.js`)));
const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
app.log.level = "silent";

async function get(url: string, method: "GET" | "POST" = "GET", payload?: object): Promise<{ status: number; body: string; json: any }> {
	const answer = await app.inject({ method, url, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN }, ...(payload ? { payload } : {}) });
	let json: any = null;
	try {
		json = JSON.parse(answer.body);
	} catch {
		// a file route answers with the file itself
	}
	return { status: answer.statusCode, body: answer.body, json };
}

let rooms = 0;

/** A room with one conversation that carries the word, on disk as a person leaves it. */
function roomWithConversation(label: string): { agentId: string; instance: ReturnType<typeof agents.createPersistentAgentInstance>; threadId: string; word: string } {
	rooms += 1;
	const word = `${WORD}Z${rooms}Z`;
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: `Settle ${label} ${rooms}`, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const threadId = `c_settle_${rooms}`;
	const write = agents.writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "home",
		model: MODEL,
		items: [{ kind: "user", id: "u1", text: `The code word is ${word}.` }],
	}, { createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }) });
	const session = agents.openPersistentAgentPiSessionManager(agentId, write.thread.runtime as any, tempCwd);
	session.appendMessage({ role: "user", content: `The code word is ${word}.`, timestamp: Date.now() } as any);
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: `Noted: ${word}.` }], api: "responses", provider: MODEL.provider, model: MODEL.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as any);
	return { agentId, instance: agents.createPersistentAgentInstance(agentId), threadId, word };
}

/** The word in every store a conversation's words reach, beyond its own two files. */
function plantStores(room: { agentId: string; instance: { rootDir: string }; threadId: string; word: string }): void {
	const plant = (file: string, text: string) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};
	const runtime = path.join(room.instance.rootDir, "runtime");
	const taskId = `t_settle_${rooms}`;
	const runDir = path.join(appDir, "background-runs", "runs", `bg_${String(rooms).padStart(32, "0")}`);
	plant(path.join(runtime, "task-ledger", `${taskId}.json`), JSON.stringify({ schemaVersion: 1, taskId, roomId: room.agentId, conversationId: room.threadId, templateId: "deck", templateVersion: 1, title: `Write up ${room.word}`, outcome: "ok", startedAt: new Date().toISOString() }));
	plant(path.join(appDir, "artifacts", "tasks", taskId, "brief.md"), `Brief: ${room.word}`);
	plant(path.join(runtime, "remember", room.threadId, "parts.json"), `{"notes":["${room.word}"]}`);
	plant(path.join(runtime, "held-messages", `${room.threadId}.json`), JSON.stringify({ schemaVersion: 1, messages: [{ id: "h1", text: `Ask about ${room.word} later.` }] }));
	plant(path.join(runDir, "run.json"), JSON.stringify({ status: "succeeded", target: { threadId: room.threadId }, scope: { roomId: room.agentId } }));
	plant(path.join(runDir, "input.md"), `Ask about ${room.word}`);
	plant(path.join(runDir, "output.md"), `The answer names ${room.word}`);
	plant(path.join(appDir, "stream-traces", room.agentId, `${room.threadId}.jsonl`), `{"text":"${room.word}"}\n`);
}

/** The body a Save sends for the room's open conversation. */
async function approvalBody(agentId: string, threadId: string): Promise<object> {
	const proposal = await agents.buildCheckpointProposal({
		agentId,
		conversationId: threadId,
		model: MODEL,
		density: "standard",
		items: [{ kind: "user", text: `The code word is ${WORD}.` }],
		runtimeCwd: tempCwd,
	}, async () => ({ text: "TITLE:\nThe logo\n\nSESSION_ARC:\nWe picked a logo.\n\nBODY:\n- The blue logo was chosen.\n\nPARKED:\nNone\n", usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } }));
	return { conversationId: threadId, model: MODEL, density: proposal.density, proposal, approvedRecentContext: APPROVED_PAGE };
}

function approve(agentId: string, body: object) {
	const parsed = agents.parseCheckpointApprovalRequest(body, agentId);
	return agents.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd });
}

function forget(agentId: string, threadId: string) {
	return agents.writePersistentAgentMementoBoundary(agentId, threadId, new Date(), { runtimeCwd: tempCwd });
}

function memoryOf(instance: { l1bCurrentPath(meta: any): string; readAgentJson(): any }): string {
	return fs.readFileSync(instance.l1bCurrentPath(instance.readAgentJson()), "utf-8");
}

function pages(instance: Parameters<typeof memoryOf>[0]): number {
	return (memoryOf(instance).match(/^### RC-\d{4}\b/gm) ?? []).length;
}

function intentOf(roomDir: string, kind: "remember" | "forget" | "memory"): any {
	const file = commitIntentPath(roomDir, kind);
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
}

/** Every file in the room with its bytes: what a second settle must leave as it was. */
function roomFiles(roomDir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else files[path.relative(roomDir, file)] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		}
	};
	walk(roomDir);
	return files;
}

/** Every file in the app folder that holds the word. A killed sibling's room can change under the walk: a file gone by the time it is read holds nothing. */
function filesHoldingWord(word: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			try {
				if (entry.isDirectory()) walk(file);
				else if (fs.readFileSync(file, "utf-8").includes(word)) found.push(path.relative(tempHome, file).split(path.sep).join("/"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	};
	walk(appDir);
	return found;
}

// A skill for the skills routes to answer about.
const skillDir = path.join(agentDir, "skills", "settle-skill");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: settle-skill\ndescription: A skill in this smoke.\n---\n\nDo the thing.\n");

const failures: string[] = [];
async function row(label: string, run: () => Promise<void> | void): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const only = process.env.ONLY?.split(",");
const runs = (group: string) => !only || only.includes(group);

// --- 1. The step -----------------------------------------------------------------

if (runs("step")) {
	await row("the step is the only caller of the crash finish and the Forget sweep", () => {
		const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
		const callers = fs.readdirSync(src).filter((name) => name.endsWith(".ts") && !["memory-commit.ts", "forget-erase.ts"].includes(name)).filter((name) => /\b(settleCommits|sweepForgotten)\(/.test(fs.readFileSync(path.join(src, name), "utf-8").replace(/^\s*(\/\/|\*).*$/gm, "")));
		assert(JSON.stringify(callers) === JSON.stringify(["room-settle.ts"]), `callers: ${JSON.stringify(callers)}`);
	});

	/** How many file calls the step makes, of every kind, reads included. */
	const fileCallsOf = (agentId: string): number => {
		const names = ["existsSync", "statSync", "lstatSync", "readdirSync", "readFileSync", "accessSync", "opendirSync", ...FILE_CHANGES] as const;
		const real = new Map<string, any>(names.map((name) => [name, (fs as any)[name]]));
		let calls = 0;
		for (const name of names) (fs as any)[name] = (...args: any[]) => { calls += 1; return real.get(name)(...args); };
		try {
			settleRoom(agentId);
		} finally {
			for (const name of names) (fs as any)[name] = real.get(name);
		}
		return calls;
	};

	const fresh = roomWithConversation("Fresh");
	settleRoom(fresh.agentId);
	await row("a settled room that never saved costs one file call", () => {
		const calls = fileCallsOf(fresh.agentId);
		assert(calls === 1, `${calls} file calls`);
	});

	const saved = roomWithConversation("Saved");
	forget(saved.agentId, saved.threadId);
	settleRoom(saved.agentId);
	await row("a settled room that has saved costs one file call: the commit folder outlives its intents", () => {
		assert(fs.existsSync(path.dirname(commitIntentPath(saved.instance.rootDir, "forget"))), "the commit folder stays after a save");
		const calls = fileCallsOf(saved.agentId);
		assert(calls === 1, `${calls} file calls`);
	});

	const pending = roomWithConversation("Pending");
	await crashed(() => forget(pending.agentId, pending.threadId));
	await row("a room with a save pending costs more, and is settled", () => {
		assert(intentOf(pending.instance.rootDir, "forget"), "the intent is pending");
		const calls = fileCallsOf(pending.agentId);
		assert(calls > 1, `${calls} file calls`);
		assert(!intentOf(pending.instance.rootDir, "forget"), "the intent is gone");
	});
}

/** A save cut off after its commit point, before its fresh conversation's first file: every later write of this process fails too, as a dead process writes nothing. */
async function crashed(save: () => unknown): Promise<void> {
	let dead = false;
	const stop = watchFileChanges((_name, target) => {
		dead ||= /[\\/](postcp|postmem)_[^\\/]*\.boot-prompt\.txt$/.test(target);
		if (dead) throw new Error("killed");
	});
	try {
		await save();
		throw new Error("the save was not cut off");
	} catch (error) {
		if ((error as Error).message === "the save was not cut off") throw error;
	} finally {
		stop();
	}
}

// --- 2. Real kills ---------------------------------------------------------------

const smokeFile = fileURLToPath(import.meta.url);
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

function runChild(request: object): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--import", tsxLoader, smokeFile], { env: { ...process.env, ROOM_SETTLE_KILL_JOB: JSON.stringify(request) }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (data) => { output += data; });
		child.stderr.on("data", (data) => { output += data; });
		child.on("close", (code) => resolve({ code, output }));
	});
}

/** Runs each step with at most `width` children alive. */
async function inBatches<T>(items: T[], width: number, run: (item: T) => Promise<void>): Promise<void> {
	for (let start = 0; start < items.length; start += width) await Promise.all(items.slice(start, start + width).map(run));
}

interface KillCase {
	kind: "remember" | "forget";
	prepare(): Promise<{ agentId: string; threadId: string; word: string; approval?: object }>;
	/** What the room must hold after the settle, the kill at `step`; `retry` is a person doing it again. */
	check(room: { agentId: string; threadId: string; word: string; approval?: object }, step: number): void;
}

const rememberKills: KillCase = {
	kind: "remember",
	prepare: async () => {
		const room = roomWithConversation("Kill Remember");
		return { ...room, approval: await approvalBody(room.agentId, room.threadId) };
	},
	check: ({ agentId, threadId, approval }, step) => {
		const instance = agents.createPersistentAgentInstance(agentId);
		const landed = pages(instance) === 1;
		assert(pages(instance) <= 1, `step ${step}: ${pages(instance)} pages`);
		const thread = agents.getPersistentAgentThread(agentId, threadId);
		if (landed) {
			assert(thread?.state === "closed" && thread.closedReason === "checkpoint", `step ${step}: the page is in memory and the conversation is ${thread?.state}`);
			const runtime = agents.getPersistentAgentRuntimeState(agentId);
			assert(runtime.activeThreadId?.startsWith("postcp_"), `step ${step}: the room points at ${runtime.activeThreadId}`);
			assert(fs.readdirSync(path.join(instance.rootDir, "events", "checkpoint")).filter((name) => name.endsWith(".json")).length === 1, `step ${step}: one event record`);
		} else {
			assert(thread?.state !== "closed", `step ${step}: nothing was saved and the conversation is ${thread?.state}`);
		}
		const answer = approve(agentId, approval!);
		assert(landed ? answer.alreadySaved === true : !answer.alreadySaved, `step ${step}: Save again after ${landed ? "the page landed" : "nothing landed"} answered alreadySaved=${answer.alreadySaved}`);
		assert(pages(instance) === 1, `step ${step}: Save again leaves ${pages(instance)} pages`);
	},
};

const forgetKills: KillCase = {
	kind: "forget",
	prepare: async () => {
		const room = roomWithConversation("Kill Forget");
		plantStores(room);
		return room;
	},
	check: ({ agentId, threadId, word }, step) => {
		const thread = agents.getPersistentAgentThread(agentId, threadId);
		if (thread?.state === "closed") {
			const left = filesHoldingWord(word);
			assert(left.length === 0, `step ${step}: the words stay in ${JSON.stringify(left)}`);
			const runtime = agents.getPersistentAgentRuntimeState(agentId);
			assert(runtime.activeThreadId?.startsWith("postmem_"), `step ${step}: the room points at ${runtime.activeThreadId}`);
		} else {
			forget(agentId, threadId);
			assert(agents.getPersistentAgentThread(agentId, threadId)?.state === "closed", `step ${step}: Forget again closes the conversation`);
		}
	},
};

async function killAtEveryStep(label: string, kills: KillCase): Promise<void> {
	const countFile = path.join(tempHome, `${kills.kind}-steps`);
	let steps = 0;
	await row(`${label}: a whole save runs in a child`, async () => {
		const whole = await runChild({ ...await kills.prepare(), kind: kills.kind, killAt: 0, countFile });
		assert(whole.code === 0, `the whole save ran: ${whole.output}`);
		steps = Number(fs.readFileSync(countFile, "utf-8"));
		assert(steps > 5, `${steps} file changes from the intent on`);
	});
	const numbers = Array.from({ length: steps }, (_, index) => index + 1);
	await inBatches(numbers, 6, async (step) => {
		const room = await kills.prepare();
		const child = await runChild({ ...room, kind: kills.kind, killAt: step, countFile });
		await row(`${label}: killed at step ${step} of ${steps}, the settle finishes it`, async () => {
			assert(child.code !== 0 && fs.existsSync(`${countFile}.killed-${step}`), `the child was not killed: ${child.output}`);
			const roomDir = agents.createPersistentAgentInstance(room.agentId).rootDir;
			resetForgetSweepForTests();
			settleRoom(room.agentId);
			const stuck = intentOf(roomDir, kills.kind) !== null;
			const settled = roomFiles(roomDir);
			settleRoom(room.agentId);
			const moved = JSON.stringify(roomFiles(roomDir)) !== JSON.stringify(settled);
			kills.check(room, step);
			assert(!stuck, `step ${step}: the intent is stuck`);
			assert(!moved, `step ${step}: a second settle changed the room`);
		});
	});
}

if (runs("kills")) {
	await killAtEveryStep("Remember", rememberKills);
	await killAtEveryStep("Forget", forgetKills);
}

// --- 3. Every reader -------------------------------------------------------------

/** A room with a save a crash left pending, as a reader finds it. */
interface Fixture {
	agentId: string;
	threadId: string;
	instance: ReturnType<typeof agents.createPersistentAgentInstance>;
	word: string;
	/** The id the pending save stamped: a Remember's checkpoint. */
	checkpointId?: string;
}

async function pendingRemember(): Promise<Fixture> {
	const room = roomWithConversation("Reader Remember");
	const shelf = await get(`/api/persistent-agents/${room.agentId}/files`, "POST", { filename: "note.txt", contentBase64: Buffer.from("A note on the shelf.").toString("base64") });
	assert(shelf.status < 300, `the shelf took a file: ${shelf.body}`);
	const body = await approvalBody(room.agentId, room.threadId);
	await crashed(() => approve(room.agentId, body));
	const checkpointId = intentOf(room.instance.rootDir, "remember")?.checkpointId;
	assert(checkpointId && pages(room.instance) === 1, "the page is in memory and the save is pending");
	assert(agents.getPersistentAgentThread(room.agentId, room.threadId)?.state !== "closed", "the conversation is still open");
	return { ...room, checkpointId };
}

async function halfForget(): Promise<Fixture> {
	const room = roomWithConversation("Reader Forget");
	const shelf = await get(`/api/persistent-agents/${room.agentId}/files`, "POST", { filename: "note.txt", contentBase64: Buffer.from("A note on the shelf.").toString("base64") });
	assert(shelf.status < 300, `the shelf took a file: ${shelf.body}`);
	plantStores(room);
	await crashed(() => forget(room.agentId, room.threadId));
	assert(agents.getPersistentAgentThread(room.agentId, room.threadId)?.state === "closed", "the conversation is closed");
	assert(intentOf(room.instance.rootDir, "forget"), "the erase is pending");
	assert(filesHoldingWord(room.word).length >= 8, "its words are still on disk");
	return room;
}

/** A reader as a person or a room reaches it; what it returns is the answer's text, a refusal included. */
type Reader = { name: string; read(room: Fixture): Promise<string> | string; sees?(answer: string, room: Fixture): boolean; archived?: boolean };

const api = (room: Fixture) => `/api/persistent-agents/${room.agentId}`;
const memoryApi = (room: Fixture) => `/api/memory/rooms/${room.agentId}`;
const route = (url: (room: Fixture) => string) => async (room: Fixture) => (await get(url(room))).body;
const mentionsCheckpoint = (answer: string, room: Fixture) => answer.includes(room.checkpointId!);

const readers: Reader[] = [
	// The list routes.
	{ name: "room list", read: route(() => "/api/persistent-agents"), sees: mentionsCheckpoint },
	{ name: "archived rooms", read: route(() => "/api/persistent-agents/archived"), archived: true },
	{ name: "memory overview", read: route(() => "/api/memory/overview"), sees: (answer, room) => JSON.parse(answer).rooms.find((row: { id: string }) => row.id === room.agentId)?.checkpoints === 1 },
	{ name: "room-memory (Home's memory)", read: route(() => "/api/memory/room-memory") },
	{ name: "digest", read: route(() => "/api/memory/digest?since=1"), sees: (answer) => JSON.parse(answer).totals.newCheckpoints >= 1 },
	{ name: "memory search", read: route(() => "/api/memory/search?q=blue") },
	{ name: "memory ask", read: async () => (await get("/api/memory/ask", "POST", { question: "What was chosen?" })).body },
	{ name: "skills list", read: route(() => "/api/skills") },
	{ name: "one skill", read: route(() => "/api/skills/settle-skill") },
	{ name: "AI defaults", read: route(() => "/api/ai/defaults") },
	{ name: "remote rooms", read: route(() => "/api/remote/rooms") },
	// Every route that names the room.
	{ name: "status", read: route((room) => `${api(room)}/status`) },
	{ name: "lifecycle counts", read: route((room) => `${api(room)}/lifecycle-counts`) },
	{ name: "conversation", read: async (room) => (await get(`${api(room)}/threads/${room.threadId}`)).body },
	{ name: "model options", read: route((room) => `${api(room)}/threads/${room.threadId}/model-options`) },
	{ name: "tasks", read: route((room) => `${api(room)}/tasks`) },
	{ name: "memory entries", read: route((room) => `${api(room)}/memory/entries`) },
	{ name: "memory archive", read: route((room) => `${api(room)}/memory/archive`) },
	{ name: "memory history", read: route((room) => `${api(room)}/memory/history`), sees: mentionsCheckpoint },
	{ name: "Memorize status", read: route((room) => `${api(room)}/absorb/status`) },
	{ name: "Review status", read: route((room) => `${api(room)}/review/status`) },
	{ name: "a Memorize run", read: route((room) => `${api(room)}/absorb/runs/no-such-run`) },
	{ name: "room memory", read: route(memoryApi) },
	{ name: "memory area", read: route((room) => `${memoryApi(room)}/area?name=Recent%20Context`) },
	{ name: "remembered conversation", read: route((room) => `${memoryApi(room)}/conversation?checkpoint=${room.checkpointId ?? "cp_none"}`), sees: (answer) => answer.includes(WORD) },
	{ name: "remembered conversations", read: route((room) => `${memoryApi(room)}/conversations`), sees: mentionsCheckpoint },
	{ name: "event diff", read: route((room) => `${memoryApi(room)}/event-diff?kind=checkpoint&event=${room.checkpointId ?? "cp_none"}`) },
	{ name: "snapshot", read: route((room) => `${memoryApi(room)}/snapshot?view=notes`) },
	{ name: "schedules", read: route((room) => `${api(room)}/schedules`) },
	{ name: "background runs", read: route((room) => `${api(room)}/background-runs`) },
	{ name: "shelf list", read: route((room) => `${api(room)}/files`) },
	{ name: "shelf file", read: route((room) => `${api(room)}/files/note.txt?download=1`) },
	// What no route reaches.
	{ name: "search sources", read: (room) => JSON.stringify(loadRoomCorpus(room.agentId, { runtimeCwd: tempCwd }).docs), sees: (answer) => answer.includes("\"conversation\"") },
	{
		name: "Remember's read of the transcript",
		read: (room) => {
			try {
				return JSON.stringify(agents.buildPersistentAgentCheckpointTranscriptSource({ agentId: room.agentId, conversationId: room.threadId, l1b: memoryOf(room.instance), runtimeCwd: tempCwd }));
			} catch (error) {
				return (error as Error).message;
			}
		},
	},
	{
		name: "a consult of the room",
		read: async (room) => {
			let prompt = "";
			await agents.buildConsultAnswer({ targetAgentId: room.agentId, question: "What was chosen?" }, MODEL, async (text: string) => {
				prompt = text;
				return { text: "An answer.", usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
			});
			return prompt;
		},
	},
	{
		name: "a scheduled run's start",
		read: (room) => {
			try {
				return JSON.stringify(preparePersistentRoomBackgroundExecution({ roomId: room.agentId, executionId: "bg_settle", prompt: "Go on.", target: { kind: "resume-thread", threadId: room.threadId, model: MODEL }, cwd: tempCwd } as any, MODEL).thread);
			} catch (error) {
				return (error as Error).message;
			}
		},
	},
	{ name: "the task store's clean-up", read: () => JSON.stringify(assessTaskStoreGc({ thresholdBytes: 0 })) },
	{
		name: "turn start",
		read: (room) => {
			try {
				const turn = agents.beginPersistentAgentTurn(room.agentId, room.threadId);
				agents.finishPersistentAgentTurn(room.agentId, room.threadId, { turnId: turn.turnId } as any);
				return "the turn began";
			} catch (error) {
				return (error as Error).message;
			}
		},
	},
];

if (runs("readers")) {
	for (const reader of readers) {
		await row(`${reader.name}: a pending Remember is settled before the answer is built`, async () => {
			const room = await pendingRemember();
			if (reader.archived) fs.writeFileSync(room.instance.agentJsonPath(), JSON.stringify({ ...room.instance.readAgentJson(), archivedAt: Date.now() }));
			const answer = await reader.read(room);
			assert(!intentOf(room.instance.rootDir, "remember"), "the save is still pending after the read");
			assert(agents.getPersistentAgentThread(room.agentId, room.threadId)?.state === "closed", "the conversation is still open");
			assert(!reader.sees || reader.sees(answer, room), `the answer was built before the settle: ${answer.slice(0, 200)}`);
			if (reader.archived) fs.writeFileSync(room.instance.agentJsonPath(), JSON.stringify({ ...room.instance.readAgentJson(), archivedAt: undefined }));
		});
		await row(`${reader.name}: a half-done Forget's words never come back, and go`, async () => {
			const room = await halfForget();
			if (reader.archived) fs.writeFileSync(room.instance.agentJsonPath(), JSON.stringify({ ...room.instance.readAgentJson(), archivedAt: Date.now() }));
			const answer = await reader.read(room);
			assert(!answer.includes(room.word), `the answer holds the word: ${answer.slice(0, 200)}`);
			const left = filesHoldingWord(room.word);
			assert(left.length === 0, `the words stay in ${JSON.stringify(left)}`);
			assert(!intentOf(room.instance.rootDir, "forget"), "the erase is still pending");
			if (reader.archived) fs.writeFileSync(room.instance.agentJsonPath(), JSON.stringify({ ...room.instance.readAgentJson(), archivedAt: undefined }));
		});
	}
}

if (runs("readers")) {
	await row("a shelf address no room can have answers like a room that is not there, on the room's own folder too", async () => {
		const room = roomWithConversation("Shelf Address");
		// Only a file system that ignores case finds the folder; either way this is no room's id.
		const upper = await get(`/api/persistent-agents/${room.agentId.toUpperCase()}/files`);
		assert(upper.status === 404, `${upper.status}: ${upper.body.slice(0, 120)}`);
		const own = await get(`/api/persistent-agents/${room.agentId}/files`);
		assert(own.status === 200, `its own address: ${own.status}`);
	});
}

// --- 4. A save in flight ---------------------------------------------------------

/**
 * Runs a save and watches the span from its intent to its clear: at every file
 * change in it the room is read the way the save's own code reads it, and the
 * step must not run. A settle in the span would look at the commit folder.
 */
function watchSpan(roomDir: string, kind: "remember" | "forget" | "memory", save: () => unknown): { changes: number; settles: number } {
	const intent = commitIntentPath(roomDir, kind);
	const commitDir = path.dirname(intent);
	let inSpan = false;
	let changes = 0;
	let settles = 0;
	const realReaddir = fs.readdirSync;
	const realExists = fs.existsSync;
	(fs as any).readdirSync = (...args: any[]) => {
		if (inSpan && String(args[0]) === commitDir) settles += 1;
		return (realReaddir as any)(...args);
	};
	(fs as any).existsSync = (...args: any[]) => {
		if (inSpan && String(args[0]).startsWith(commitDir)) settles += 1;
		return (realExists as any)(...args);
	};
	const agentId = path.basename(roomDir);
	const stop = watchFileChanges((name, target) => {
		if (name === "renameSync" && target === intent) inSpan = true;
		else if (name === "rmSync" && target === intent) inSpan = false;
		else if (inSpan) {
			changes += 1;
			const instance = agents.createPersistentAgentInstance(agentId);
			instance.readAgentJson();
			agents.getPersistentAgentRuntimeState(agentId);
			const runtime = agents.getPersistentAgentRuntimeState(agentId);
			if (runtime.activeThreadId) agents.getPersistentAgentThread(agentId, runtime.activeThreadId);
			agents.buildPersistentAgentBootContext({ agentId, conversationId: "status-preview", sessionId: null, model: { provider: "status-preview", model: "prompt-budget" } });
		}
	});
	try {
		save();
	} finally {
		stop();
		(fs as any).readdirSync = realReaddir;
		(fs as any).existsSync = realExists;
	}
	return { changes, settles };
}

if (runs("inflight")) {
	await row("a Remember in flight: no settle runs inside it, and it lands once", async () => {
		const room = roomWithConversation("Flight Remember");
		const body = await approvalBody(room.agentId, room.threadId);
		const { changes, settles } = watchSpan(room.instance.rootDir, "remember", () => approve(room.agentId, body));
		assert(changes > 5, `the span was watched: ${changes} file changes`);
		assert(settles === 0, `a settle ran ${settles} times inside the save`);
		assert(pages(room.instance) === 1 && !intentOf(room.instance.rootDir, "remember"), "the save landed once");
		assert(agents.getPersistentAgentThread(room.agentId, room.threadId)?.state === "closed", "the conversation closed");
	});

	await row("a Forget in flight: no settle runs inside it, and it lands once", () => {
		const room = roomWithConversation("Flight Forget");
		const { changes, settles } = watchSpan(room.instance.rootDir, "forget", () => forget(room.agentId, room.threadId));
		assert(changes > 5, `the span was watched: ${changes} file changes`);
		assert(settles === 0, `a settle ran ${settles} times inside the save`);
		assert(!intentOf(room.instance.rootDir, "forget"), "the save landed");
		assert(filesHoldingWord(room.word).length === 0, "the words are gone");
	});

	await row("reads while a save holds the room's lock neither finish nor drop it", async () => {
		const room = roomWithConversation("Flight Lock");
		const body = await approvalBody(room.agentId, room.threadId);
		let release = () => undefined as void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const save = withRoomSaveLock(room.agentId, async () => {
			await held;
			return approve(room.agentId, body);
		});
		for (const reader of [`/api/persistent-agents/${room.agentId}/threads/${room.threadId}`, `/api/memory/rooms/${room.agentId}`, "/api/persistent-agents"]) {
			const answer = await get(reader);
			assert(answer.status === 200, `${reader}: ${answer.status}`);
		}
		assert(pages(room.instance) === 0, "nothing was saved while the save waited");
		release();
		const reading = get("/api/persistent-agents");
		const answer = await save;
		await reading;
		assert(answer.checkpointId && !answer.alreadySaved, "the save landed itself");
		assert(pages(room.instance) === 1 && !intentOf(room.instance.rootDir, "remember"), "one page, nothing pending");
	});
}

await new Promise<void>((resolve) => backend.close(() => resolve()));
await app.close().catch(() => undefined);
fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
if (failures.length > 0) {
	console.error(`room-settle-smoke: ${failures.length} rows failed`);
	process.exit(1);
}
console.log("room-settle-smoke: ok");
process.exit(0);
