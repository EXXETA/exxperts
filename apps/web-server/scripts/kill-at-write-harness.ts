// A kill at any write of a save leaves a room that opens, with nothing the
// person was told is saved lost, nothing doubled, and a retry that works.
//
// Each save first runs once with every write in the data folder traced. Then,
// for each traced step and each way a step can die, a child server runs the
// save on a fresh copy of one prepared data folder and is killed there by
// kill-at-write-preload.mjs; a second server starts on the same disk, the room
// is checked, the same request is sent again, and the room is checked again. A
// save the client heard back about is not sent again: it must simply be there.
//
// A process kill leaves what the system already holds, so it cannot prove an
// fsync: the trace does, each landing rename after its file's flush and before
// its folder's. That is order, not a power cut.
//
// The steps are split over several smokes, since the runner stops any smoke at
// its time limit. KILL_ONLY=forget:38:before runs one step of a smoke's saves.
// KILL_LANES sets how many kills run side by side.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, keptPort, killSmokeServer, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const require = createRequire(import.meta.url);
const WebSocketImpl: any = (await import("ws")).default;
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;
export const preload = pathToFileURL(path.join(scriptDir, "kill-at-write-preload.mjs")).href;
const sharedServerEntry = pathToFileURL(path.join(scriptDir, "kill-at-write-shared-server.ts")).href;
export { tsxLoader, webServerDir };

export const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-kill-at-write-"));
const templateHome = path.join(tempRoot, "template");
export const agentsRootOf = (home: string) => path.join(home, ".exxperts", "app", "personalized-agents");
export const agentDirOf = (home: string) => path.join(home, ".exxperts", "agent");

// The conversation's own words: after a Forget they exist nowhere on the disk.
const SECRET = "zebra-quartz-forgotten-words";
const SEED_NOTE = "The seed note was saved long before the kill.";
const ADDED_NOTE = "The added note lands exactly once.";
const UPLOAD_NAME = "kill-upload.txt";
const UPLOAD_BYTES = Buffer.from(`${"attachment body ".repeat(4096)}end\n`);
const ROOM_NAME = "Kill Created Room";
export const AGENT = "kill-room";
export const THREAD = "pi_kill_room";
const REQUEST_ID = "kill-add-request";
const MODEL = { provider: "fake-gpt", model: "gpt-fake" };

function sse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** The answers the fake model is holding open, by the word that asked for it, each with how to finish it. */
const heldAnswers = new Map<string, () => void>();
export const answerIsHeld = (hold: string) => heldAnswers.has(hold);
export const releaseAnswer = (hold: string) => heldAnswers.get(hold)?.();

/** The last message of every request the fake model got. */
export const lastMessagesHeard: string[] = [];

/** Every request the fake model got, in order: the model it named, the tools it offered and its messages. */
export const requestsHeard: { model: string; tools: string[]; messages: string }[] = [];

/** A last message with a word like this gets the first words of its answer and then silence, so a turn stays in flight. */
const HOLD_WORD = /hold-answer-[a-z0-9-]+/;
/** What a held answer whose word ends in "-tail" says after its first words, once released. */
export const HELD_TAIL = " And it ends here.";
/** A held answer whose word ends in "-site" calls fetch_url once released, for an address on its own made-up site, so the room asks whether to open it. The call and its address leave the word out, so the call's result is not held again. */
export const askedSiteOf = (hold: string) => `https://${hold.replace("hold-answer-", "asked-")}.example.com/page`;
/** A last message with a word like this is refused, as a provider refuses a bad request. */
const REFUSE_WORD = /refuse-answer-[a-z0-9-]+/;
/** A last message with a word like this is refused the first time and held after, so a Try again stays in flight. */
const REFUSE_ONCE_WORD = /refuse-once-answer-[a-z0-9-]+/;
/** A last message with a word like this is answered up to the model's output limit, so the answer ends cut off. */
const LENGTH_WORD = /length-answer-[a-z0-9-]+/;
/** A last message with a word like this is answered as if it had read nearly the whole window, so the room shortens its conversation after that turn. */
const FULL_WORD = /full-answer-[a-z0-9-]+/;
const FULL_READING = 120_000;
const refusedOnce = new Set<string>();

function lastMessageOf(body: string): string {
	try {
		return JSON.stringify(JSON.parse(body).messages?.at(-1) ?? "");
	} catch {
		return "";
	}
}

export const provider = http.createServer((req, res) => {
	const body: Buffer[] = [];
	req.on("data", (chunk) => body.push(chunk));
	req.on("end", () => {
		const raw = Buffer.concat(body).toString();
		const last = lastMessageOf(raw);
		lastMessagesHeard.push(last);
		try {
			const request = JSON.parse(raw);
			requestsHeard.push({ model: String(request.model ?? ""), tools: (request.tools ?? []).map((tool: any) => String(tool?.function?.name ?? tool?.name ?? "")), messages: JSON.stringify(request.messages ?? []) });
		} catch {}
		const once = REFUSE_ONCE_WORD.exec(last)?.[0];
		const refuseNow = once !== undefined && !refusedOnce.has(once);
		if (once) refusedOnce.add(once);
		if (REFUSE_WORD.test(last) || refuseNow) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "This request was refused.", type: "invalid_request_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_kill", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "gpt-fake" };
		const finish = () => {
			sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
			res.write("data: [DONE]\n\n");
			res.end();
		};
		const hold = HOLD_WORD.exec(last)?.[0] ?? once;
		if (hold) {
			// One whose word ends in "-spent" says what it spent with its first words, so an answer stopped while held has used something.
			sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "A held answer begins." }, finish_reason: null }], ...(hold.endsWith("-spent") ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) });
			// One whose word ends in "-tail" says more once released, so an answer cut while held reads differently from a whole one.
			if (hold.endsWith("-site")) {
				heldAnswers.set(hold, () => {
					sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_asked_site", type: "function", function: { name: "fetch_url", arguments: JSON.stringify({ url: askedSiteOf(hold) }) } }] }, finish_reason: null }] });
					sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
					res.write("data: [DONE]\n\n");
					res.end();
				});
				return;
			}
			heldAnswers.set(hold, hold.endsWith("-tail") ? () => { sse(res, { ...base, choices: [{ index: 0, delta: { content: HELD_TAIL }, finish_reason: null }] }); finish(); } : finish);
			return;
		}
		sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "A fresh answer." }, finish_reason: null }] });
		if (FULL_WORD.test(last)) {
			sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: FULL_READING, completion_tokens: 5, total_tokens: FULL_READING + 5 } });
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		if (LENGTH_WORD.test(last)) {
			sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		finish();
	});
});

let shelfDirName = "";

export async function prepareTemplate(): Promise<{ approveBody: unknown; seedEntryId: string }> {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	const appDir = path.join(templateHome, ".exxperts", "app");
	const agentDir = agentDirOf(templateHome);
	for (const dir of [agentsRootOf(templateHome), agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	process.env.HOME = templateHome;
	process.env.USERPROFILE = templateHome;
	process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRootOf(templateHome);
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" }] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const memory = await import("../src/memory-entries-store.js");
	const entries = await import("../src/memory-entries.js");
	const shelf = await import("../src/persistent-room-shelf.js");
	agents.createPersistentAgentFromScaffoldInput({ displayName: "Kill Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	roomModels.writeRoomModels(AGENT, { conversation: MODEL });
	const written = agents.writePersistentAgentThread(AGENT, THREAD, {
		state: "active",
		origin: "home",
		model: MODEL,
		items: [{ kind: "user", id: "u1", text: `Please keep ${SECRET} in mind.` }, { kind: "assistant", id: "a1", text: `I will keep ${SECRET} in mind.` }],
	}, { createRuntime: ({ model }: { model: any }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: AGENT, threadId: THREAD, model, cwd: repoRoot }) });
	const session = agents.openPersistentAgentPiSessionManager(AGENT, written.thread.runtime as any, repoRoot);
	session.appendMessage({ role: "user", content: `Please keep ${SECRET} in mind.`, timestamp: Date.now() });
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: `I will keep ${SECRET} in mind.` }], api: "openai-completions", provider: "fake-gpt", model: "gpt-fake", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as any);

	const load = memory.loadMemoryDocument(AGENT);
	const seedEntryId = entries.formatEntryId(load.doc.nextEntryNumber);
	const next = entries.applyUserEdit(load.doc, { op: "add", topic: "Kill topic", kind: "fact", text: SEED_NOTE, saved: "2026-01-01" }).doc;
	memory.writeMemoryDocument(AGENT, next, { why: "user_edit", snapshotLabel: "edit", operation: "add", entryId: seedEntryId });
	const shelfDir = shelf.persistentRoomShelfDirPath(AGENT);
	shelfDirName = path.basename(shelfDir);
	fs.mkdirSync(shelfDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(shelfDir, "seed.txt"), "the seed attachment\n", { mode: 0o600 });

	const proposal = await agents.buildCheckpointProposal({
		agentId: AGENT,
		conversationId: THREAD,
		model: MODEL,
		density: "standard",
		items: [{ kind: "user", text: "Please keep the logo in mind." }],
		runtimeCwd: repoRoot,
	}, async () => ({ text: "TITLE:\nThe logo\n\nSESSION_ARC:\nWe picked a logo.\n\nBODY:\n- The blue logo was chosen.\n\nPARKED:\nNone\n", usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } }));
	return {
		seedEntryId,
		approveBody: {
			conversationId: THREAD,
			model: MODEL,
			density: proposal.density,
			proposal,
			approvedRecentContext: "### RC-DRAFT | CLOSED | 2026-10-08 | The logo\n\n**Session arc:** We picked a logo.\n\n**Body:**\n- The blue logo was chosen.\n\n**Parked:**\nNone\n",
		},
	};
}

export interface Run { home: string; base: string }
export interface Answer { status: number }
export interface Save {
	name: string;
	/** Which traced steps this save is killed at; every step that changes the disk when left out. */
	kills?(step: TraceStep): boolean;
	/** Sent again even when the first one was answered: the next turn after any kill is the point. */
	alwaysAgain?: boolean;
	/** Runs on a server that counts as shared. */
	sharedServer?: boolean;
	/** Sets up the copied data folder before its server starts. */
	prepare?(home: string): void;
	/** More modules for its server to load first. */
	imports?: string[];
	/** More settings for its server. */
	env?: Record<string, string>;
	/** The file this save removes once its answer has gone out. The answer arrives first, so its trace is whole only with that removal in it. */
	answerMark?: RegExp;
	send(run: Run): Promise<Answer>;
	/** Problems on the disk the kill left, before anything starts on it. */
	afterKill?(home: string): string[];
	/** Problems with the room right after the restart, whatever the kill left. */
	afterRestart(run: Run): Promise<string[]>;
	/** Problems once the same request was sent again. */
	afterRetry(run: Run, answer: Answer): Promise<string[]>;
}

const waitUntil = waitEvery(20);
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const roomUrl = (run: Run, rest = "") => `${run.base}/api/persistent-agents/${AGENT}${rest}`;
const shelfDirOf = (run: Run) => path.join(agentsRootOf(run.home), AGENT, shelfDirName);
const coreOf = (run: Run) => fs.readFileSync(path.join(agentsRootOf(run.home), AGENT, "L1b", "current.md"), "utf-8");
const count = (text: string, part: string) => text.split(part).length - 1;

export async function readJsonAnswer(url: string): Promise<{ status: number; body: any }> {
	const response = await authedFetch(url);
	const text = await response.text();
	try {
		return { status: response.status, body: JSON.parse(text) };
	} catch {
		return { status: response.status, body: text };
	}
}

/** What every save must leave, whatever it was: the room opens and what was saved before is still there. */
export async function roomProblems(run: Run): Promise<string[]> {
	const problems: string[] = [];
	const status = await readJsonAnswer(roomUrl(run, "/status"));
	if (status.status !== 200 || status.body?.status === "error") problems.push(`room status ${status.status} ${status.body?.status}: ${(status.body?.errors ?? []).join("; ")}`);
	const notes = await readJsonAnswer(roomUrl(run, "/memory/entries"));
	if (notes.status !== 200) problems.push(`memory refused: ${notes.status}`);
	if (count(coreOf(run), SEED_NOTE) + (await archiveRows(run)).filter((row) => row.text === SEED_NOTE).length !== 1) problems.push("the seed note is not there exactly once");
	const files = await readJsonAnswer(roomUrl(run, "/files"));
	for (const file of files.body?.files ?? []) if (!file.bytes) problems.push(`an empty attachment is listed: ${file.name}`);
	if (!(files.body?.files ?? []).some((file: any) => file.name === "seed.txt")) problems.push("the seed attachment is gone");
	return problems;
}

/** Files that must read whole the moment after the kill, before anything repairs them. */
function tornFiles(home: string): string[] {
	const room = path.join(agentsRootOf(home), AGENT);
	const threads = path.join(room, "runtime", "threads");
	const stored = [path.join(room, "runtime", "state.json"), path.join(room, "agent.json"), ...fs.readdirSync(threads).filter((name) => name.endsWith(".json")).map((name) => path.join(threads, name))];
	return stored.filter((file) => {
		try {
			JSON.parse(fs.readFileSync(file, "utf-8"));
			return false;
		} catch {
			return true;
		}
	}).map((file) => path.relative(room, file));
}

async function archiveRows(run: Run): Promise<Array<{ id: string; text: string; why: string }>> {
	const archive = await readJsonAnswer(roomUrl(run, "/memory/archive"));
	return archive.body?.entries ?? [];
}

function wordsOnDisk(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) wordsOnDisk(file, found);
		else if (entry.isFile() && fs.readFileSync(file).includes(SECRET)) found.push(file);
	}
	return found;
}

function answered(answer: Answer, what: string): string[] {
	return answer.status < 300 ? [] : [`the retry of ${what} was refused: ${answer.status}`];
}

const isSessionFile = (target: string) => target.includes("pi-sessions") && target.endsWith(".jsonl");

/** A turn over the live connection: answered when the model's words came back and nothing failed. A connection that drops rejects. */
export function sendTurn(run: Run, text: string, conversationId = THREAD): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocketImpl(`${run.base.replace("http", "ws")}/ws?persistentAgentId=${AGENT}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
		let heard = "";
		let settled = false;
		const end = (finish: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.close();
			finish();
		};
		const timer = setTimeout(() => end(() => reject(new Error(`the turn did not end; it said: ${heard.slice(-300)}`))), 30_000);
		socket.on("error", (error: Error) => end(() => reject(error)));
		socket.on("close", () => end(() => reject(new Error("the connection closed before the turn ended"))));
		socket.on("message", (data: unknown) => {
			const raw = String(data);
			heard += raw;
			const frame = JSON.parse(raw);
			if (frame.type === "ready") socket.send(JSON.stringify({ type: "prompt", text }));
			if (frame.type === "error") end(() => resolve({ status: 500 }));
			if (frame.event?.type === "agent_end") end(() => resolve({ status: heard.includes("A fresh answer.") ? 200 : 500 }));
		});
	});
}

function createRoom(run: Run): Promise<Answer> {
	return authedFetch(`${run.base}/api/persistent-agents`, json({ displayName: ROOM_NAME, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }));
}

async function listedRooms(run: Run): Promise<any[]> {
	const list = await readJsonAnswer(`${run.base}/api/persistent-agents`);
	return list.body?.agents ?? list.body?.rooms ?? list.body;
}

async function roomsMade(run: Run): Promise<any[]> {
	return (await listedRooms(run)).filter((room) => room.id !== AGENT);
}

export function saves(approveBody: unknown, seedEntryId: string): Save[] {
	return [
		{
			name: "turn",
			kills: (step) => isSessionFile(step.target),
			alwaysAgain: true,
			send: (run) => sendTurn(run, "One more question."),
			afterRestart: roomProblems,
			afterRetry: async (run, answer) => [...answered(answer, "the next turn"), ...await roomProblems(run)],
		},
		{
			name: "forget",
			send: (run) => authedFetch(roomUrl(run, "/memento"), json({ conversationId: THREAD })),
			afterRestart: async (run) => {
				const problems = await roomProblems(run);
				const status = await readJsonAnswer(roomUrl(run, "/status"));
				const active = status.body?.runtime?.activeThreadId;
				if (active === THREAD) return problems;
				const left = wordsOnDisk(run.home);
				if (left.length) problems.push(`forgotten words stayed in ${left.map((file) => path.relative(run.home, file)).join(", ")}`);
				return problems;
			},
			afterRetry: async (run, answer) => {
				const problems = [...answered(answer, "Forget"), ...await roomProblems(run)];
				const left = wordsOnDisk(run.home);
				if (left.length) problems.push(`forgotten words stayed in ${left.map((file) => path.relative(run.home, file)).join(", ")}`);
				const events = path.join(agentsRootOf(run.home), AGENT, "events", "memento");
				const records = fs.existsSync(events) ? fs.readdirSync(events).filter((name) => name.endsWith(".json")) : [];
				const named = records.filter((name) => {
					try {
						return JSON.parse(fs.readFileSync(path.join(events, name), "utf-8")).conversationId === THREAD;
					} catch {
						problems.push(`an unreadable memento record: ${name}`);
						return false;
					}
				});
				if (named.length !== 1) problems.push(`${named.length} memento records for the forgotten conversation`);
				if (records.length !== 1) problems.push(`${records.length} memento records for one Forget`);
				return problems;
			},
		},
		{
			name: "remember",
			send: (run) => authedFetch(roomUrl(run, "/checkpoint/approve"), json(approveBody)),
			afterRestart: async (run) => {
				const problems = await roomProblems(run);
				const pages = (coreOf(run).match(/^### RC-\d{4}\b/gm) ?? []).length;
				if (pages > 1) problems.push(`${pages} pages after one Remember`);
				return problems;
			},
			afterRetry: async (run, answer) => {
				const problems = [...answered(answer, "Remember"), ...await roomProblems(run)];
				const pages = (coreOf(run).match(/^### RC-\d{4}\b/gm) ?? []).length;
				if (pages !== 1) problems.push(`${pages} pages after a retried Remember`);
				return problems;
			},
		},
		{
			name: "add",
			send: (run) => authedFetch(roomUrl(run, "/memory/entries"), json({ kind: "fact", topic: "Kill topic", newTopic: false, text: ADDED_NOTE, requestId: REQUEST_ID })),
			afterRestart: async (run) => {
				const problems = await roomProblems(run);
				if (count(coreOf(run), ADDED_NOTE) > 1) problems.push("the note is doubled");
				return problems;
			},
			afterRetry: async (run, answer) => {
				const problems = [...answered(answer, "the add"), ...await roomProblems(run)];
				if (count(coreOf(run), ADDED_NOTE) !== 1) problems.push(`the note is in the core ${count(coreOf(run), ADDED_NOTE)} times after a retry`);
				return problems;
			},
		},
		{
			name: "delete",
			send: (run) => authedFetch(roomUrl(run, `/memory/entries/${seedEntryId}`), { method: "DELETE" }),
			afterRestart: async (run) => roomProblems(run),
			afterRetry: async (run, answer) => {
				const problems = [...answered(answer, "the delete"), ...await roomProblems(run)];
				if (count(coreOf(run), SEED_NOTE) !== 0) problems.push("the deleted note is still in the core");
				return problems;
			},
		},
		{
			name: "upload",
			answerMark: /\.upload-[^\\/]*\.json$/,
			send: (run) => authedFetch(roomUrl(run, "/files"), json({ filename: UPLOAD_NAME, contentBase64: UPLOAD_BYTES.toString("base64") })),
			afterRestart: async (run) => uploadProblems(run, false),
			afterRetry: async (run, answer) => [...answered(answer, "the upload"), ...await uploadProblems(run, true)],
		},
		{
			name: "create",
			answerMark: /create-unanswered\.json$/,
			send: createRoom,
			afterRestart: async (run) => createdRoomProblems(run, false),
			afterRetry: async (run, answer) => [...answered(answer, "the create"), ...await createdRoomProblems(run, true)],
		},
		{
			// A shared server's mark would name no person, so a room that landed is never handed to whoever sends the same details.
			name: "create on a shared server",
			sharedServer: true,
			kills: (step) => step.op === "renameSync" && path.basename(step.from ?? "").startsWith(".being-built-"),
			send: createRoom,
			afterRestart: async (run) => {
				if (!(await roomsMade(run)).length) return [];
				const again = await createRoom(run);
				return again.status === 409 ? [] : [`the same details sent after the kill got ${again.status}, not the name taken`];
			},
			afterRetry: async (run) => {
				const made = await roomsMade(run);
				return made.length === 1 ? [] : [`${made.length} rooms from one create`];
			},
		},
	];
}

export async function uploadProblems(run: Run, mustBeThere: boolean): Promise<string[]> {
	const problems = await roomProblems(run);
	const files = ((await readJsonAnswer(roomUrl(run, "/files"))).body?.files ?? []).filter((file: any) => file.name !== "seed.txt");
	if (files.length > 1) problems.push(`${files.length} attachments from one upload: ${files.map((file: any) => file.name).join(", ")}`);
	if (mustBeThere && files.length === 0) problems.push("the upload is not listed after a retry");
	for (const file of files) {
		const bytes = fs.readFileSync(path.join(shelfDirOf(run), file.name));
		if (!bytes.equals(UPLOAD_BYTES)) problems.push(`a partial attachment is listed: ${file.name}, ${bytes.length} of ${UPLOAD_BYTES.length} bytes`);
	}
	return problems;
}

async function createdRoomProblems(run: Run, mustBeThere: boolean): Promise<string[]> {
	const problems = await roomProblems(run);
	const rooms = await listedRooms(run);
	const bad = rooms.filter((room) => room.status === "error");
	if (bad.length) problems.push(`rooms with status error: ${bad.map((room) => room.id).join(", ")}`);
	const made = rooms.filter((room) => room.id !== AGENT);
	if (made.length > 1) problems.push(`${made.length} rooms from one create: ${made.map((room) => room.id).join(", ")}`);
	if (mustBeThere && made.length === 0) problems.push("the room is not listed after a retry");
	for (const room of made) {
		const notes = await readJsonAnswer(`${run.base}/api/persistent-agents/${room.id}/memory/entries`);
		if (notes.status !== 200) problems.push(`the new room's memory refused: ${notes.status}`);
	}
	const onDisk = fs.readdirSync(agentsRootOf(run.home)).filter((name) => !name.startsWith(".") && name !== AGENT);
	const hidden = onDisk.filter((name) => !made.some((room) => room.id === name));
	if (hidden.length) problems.push(`a room folder nothing lists: ${hidden.join(", ")}`);
	return problems;
}

// --- The servers ---------------------------------------------------------------

export interface Child { process: ChildProcessWithoutNullStreams; output: string[] }

export function startServer(save: Pick<Save, "sharedServer" | "imports" | "env">, home: string, port: number, kill?: { step: number; how: string; arm: string; trace?: string }): Child {
	const args = ["--import", tsxLoader, ...(save.sharedServer ? ["--import", sharedServerEntry] : []), ...(save.imports ?? []).flatMap((entry) => ["--import", entry]), ...(kill ? ["--import", preload] : []), "src/index.ts"];
	const child = spawn(process.execPath, args, {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(home, {
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDirOf(home),
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRootOf(home),
			...save.env,
			...(kill ? { KILL_ROOT: home, KILL_ARM: kill.arm, KILL_STEP: String(kill.step), KILL_HOW: kill.how, ...(kill.trace ? { KILL_TRACE: kill.trace } : {}) } : {}),
		}) as NodeJS.ProcessEnv,
	}) as ChildProcessWithoutNullStreams;
	const output: string[] = [];
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	return { process: child, output };
}

export function exited(child: Child): Promise<void> {
	return new Promise((resolve) => {
		if (child.process.exitCode != null || child.process.signalCode != null) resolve();
		else child.process.once("exit", () => resolve());
	});
}

/** Ends a child that is still running. One a signal ended has no exit code, and killSmokeServer would wait out its timeout for an exit that already came. */
export async function endChild(child: Child): Promise<void> {
	if (child.process.exitCode == null && child.process.signalCode == null) await killSmokeServer(child.process);
}

/** A fresh copy of the prepared data folder, in a folder of its own. */
export function templateCopy(name: string): string {
	const folder = fs.mkdtempSync(path.join(tempRoot, `${name}-`));
	fs.cpSync(templateHome, path.join(folder, "home"), { recursive: true });
	return folder;
}

export const waitReady = (child: Child, run: Run) => waitForServer(child.process, run.base, 60_000);

interface StepResult { landed: boolean; problems: string[] }

export async function runStep(save: Save, step: number, how: string, lane: number): Promise<StepResult> {
	const folder = fs.mkdtempSync(path.join(tempRoot, `lane-${lane}-`));
	const home = path.join(folder, "home");
	fs.cpSync(templateHome, home, { recursive: true });
	save.prepare?.(home);
	const arm = path.join(folder, "armed");
	const port = await keptPort();
	const run: Run = { home, base: `http://127.0.0.1:${port}` };
	const killed = startServer(save, home, port, { step, how, arm });
	let second: Child | undefined;
	try {
		await waitForServer(killed.process, run.base, 60_000);
		fs.writeFileSync(arm, "");
		const first = await save.send(run).catch(() => null);
		// The kill comes soon after the answer or the cut connection, later on a busy machine; only a kill that never comes waits this out.
		await Promise.race([exited(killed), new Promise((resolve) => setTimeout(resolve, 30_000))]);
		// Windows ends a process with exit code 1 and names no signal.
		const landed = killed.process.signalCode === "SIGKILL" || (process.platform === "win32" && killed.process.exitCode === 1);
		await endChild(killed);
		const problems = [...tornFiles(home).map((file) => `torn right after the kill: ${file}`), ...(save.afterKill?.(home) ?? [])];
		second = startServer(save, home, port);
		await waitForServer(second.process, run.base, 60_000);
		problems.push(...(await save.afterRestart(run)).map((problem) => `after the restart: ${problem}`));
		const heardBack = first !== null && first.status < 300 && !save.alwaysAgain;
		const answer = heardBack ? first : await save.send(run).catch((error: Error) => { problems.push(`the retry failed: ${error.message}`); return { status: 500 }; });
		problems.push(...(await save.afterRetry(run, answer)).map((problem) => `after the retry: ${problem}`));
		return { landed, problems };
	} finally {
		await endChild(killed);
		if (second) await endChild(second);
		fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
	}
}

export interface TraceStep { step: number; op: string; target: string; bytes: boolean; from?: string }

export async function traceSave(save: Save): Promise<TraceStep[]> {
	const folder = fs.mkdtempSync(path.join(tempRoot, "trace-"));
	const home = path.join(folder, "home");
	fs.cpSync(templateHome, home, { recursive: true });
	save.prepare?.(home);
	const arm = path.join(folder, "armed");
	const trace = path.join(folder, "trace.jsonl");
	const port = await keptPort();
	const child = startServer(save, home, port, { step: 0, how: "before", arm, trace });
	try {
		await waitForServer(child.process, `http://127.0.0.1:${port}`, 60_000);
		fs.writeFileSync(arm, "");
		const answer = await save.send({ home, base: `http://127.0.0.1:${port}` });
		if (answer.status >= 300) throw new Error(`${save.name} failed before any kill: ${answer.status}`);
		const steps = () => fs.readFileSync(trace, "utf-8").trim().split("\n").map((line) => {
			const step = JSON.parse(line) as TraceStep;
			return { ...step, target: path.relative(home, step.target), ...(step.from ? { from: path.relative(home, step.from) } : {}) };
		});
		const mark = save.answerMark;
		if (mark) await waitUntil(() => steps().some((step) => step.op === "rmSync" && mark.test(step.target)), `${save.name} removed its answer mark`);
		return steps();
	} finally {
		await endChild(child);
		fs.rmSync(folder, { recursive: true, force: true });
	}
}

/** How many kills run side by side. */
export const lanes = Number(process.env.KILL_LANES ?? 4);

export async function pool<T>(jobs: T[], lanes: number, work: (job: T, lane: number) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: lanes }, async (_, lane) => {
		while (next < jobs.length) await work(jobs[next++], lane);
	}));
}

/**
 * Writers a save's trace meets that are not this smoke's to hold to the flush
 * rule, each named so nothing else slips by: the MCP adapter's cache and the
 * room's last-used stamp, which sit outside a save's path, and Forget's erase,
 * whose emptied record goes through its own rename in forget-erase.ts. That one
 * matters after a power cut, and moves to the safe write with that file's task.
 * The locks on auth.json and settings.json and a room's lock hold no one's words:
 * after a power cut a lost lock is simply free.
 */
const NOT_HELD_TO_THE_FLUSH_RULE = [/[\\/]mcp-cache\.json$/, /[\\/]runtime[\\/]last-used\.json$/, /[\\/]runtime[\\/]threads[\\/]pi_kill_room\.json$/, /[\\/](auth|settings)\.json\.lock(\.lock)*$/, /[\\/]\.room-locks[\\/]/];

/**
 * Each landing rename comes after its file's flush and before its folder's, and
 * each append to a conversation is flushed. Windows cannot flush a folder, so
 * that half is not asked there.
 */
export function flushOrderProblems(saveName: string, trace: TraceStep[]): string[] {
	const problems: string[] = [];
	const excused = (step: TraceStep) => NOT_HELD_TO_THE_FLUSH_RULE.some((pattern) => pattern.test(step.target)) && (saveName === "forget" || !step.target.includes("threads"));
	trace.forEach((step, at) => {
		if ((step.op === "renameSync" || step.op === "linkSync") && step.from && !excused(step)) {
			const flushed = trace.slice(0, at).some((earlier) => earlier.op === "fsyncSync" && earlier.target === step.from) || path.basename(step.from).startsWith(".being-built-");
			if (!flushed) problems.push(`${step.target} landed before its bytes were flushed`);
			if (process.platform !== "win32" && !trace.slice(at).some((later) => later.op === "fsyncSync" && later.target === path.dirname(step.target))) problems.push(`the folder of ${step.target} was not flushed after the rename`);
		}
		if (isSessionFile(step.target) && step.bytes && !trace.slice(at).some((later) => later.op === "fsyncSync" && later.target === step.target)) problems.push(`an append to ${path.basename(step.target)} was not flushed`);
	});
	return [...new Set(problems)];
}

/** Runs every step of the named saves, and any rows of the smoke's own; a problem from either fails it. */
export async function runKillMatrix(names: string[], ownRows: () => Promise<string[]> = async () => []): Promise<void> {
	const only = process.env.KILL_ONLY?.split(":");
	let exitCode = 0;
	try {
		const { approveBody, seedEntryId } = await prepareTemplate();
		const all = saves(approveBody, seedEntryId).filter((save) => names.includes(save.name) && (!only || only[0] === save.name));
		const totals = { kills: 0, landed: 0 };
		const found: string[] = await ownRows();
		for (const problem of found) console.log(`  PROBLEM ${problem}`);
		for (const save of all) {
			const trace = await traceSave(save);
			if (process.env.KILL_SHOW_TRACE) for (const step of trace) console.log(`${save.name} ${step.step} ${step.op} ${step.target}`);
			for (const problem of flushOrderProblems(save.name, trace)) {
				found.push(`${save.name} flush order: ${problem}`);
				console.log(`  PROBLEM ${save.name} flush order: ${problem}`);
			}
			const jobs: Array<{ step: number; how: string }> = [];
			for (const step of trace) {
				if (step.op === "fsyncSync" || (save.kills && !save.kills(step))) continue;
				for (const how of step.bytes ? ["before", "torn-empty", "torn-half"] : ["before"]) jobs.push({ step: step.step, how });
				// Landed and unanswered: nothing but a flush may follow a rename before the answer goes out.
				if (step.op === "renameSync" || step.op === "linkSync") jobs.push({ step: step.step, how: "after" });
			}
			if (!save.kills) jobs.push({ step: trace.length, how: "after" });
			const mine = only ? jobs.filter((job) => job.step === Number(only[1]) && job.how === only[2]) : jobs;
			const started = Date.now();
			await pool(mine, lanes, async (job, lane) => {
				// A step that breaks the check itself is a finding too, never the end of the run.
				const result = await runStep(save, job.step, job.how, lane).catch((error: Error) => ({ landed: false, problems: [`the step could not be checked: ${error.message}`] }));
				totals.kills += 1;
				if (result.landed) totals.landed += 1;
				const target = trace.find((step) => step.step === job.step);
				const place = `${save.name} k=${job.step} ${job.how} [${target?.op} ${target?.target}]`;
				if (!result.landed) console.log(`  NOT LANDED ${place}`);
				for (const problem of result.problems) {
					found.push(`${place} ${problem}`);
					console.log(`  PROBLEM ${place} ${problem}`);
				}
			});
			console.log(`${save.name}: ${trace.length} write steps, ${mine.length} kills in ${Math.round((Date.now() - started) / 1000)}s`);
		}
		console.log(`kill at write: ${totals.kills} kills, ${totals.landed} landed, ${found.length} problems`);
		if (found.length > 0 || totals.landed !== totals.kills) exitCode = 1;
	} catch (error) {
		console.error(error);
		exitCode = 1;
	} finally {
		provider.close();
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
	}
	process.exit(exitCode);
}

// --- What the restart smokes share ---------------------------------------------------

/** The fake model answers in milliseconds, and a lock left behind costs ten seconds and more, so this tells "at once" from a wait on a loaded machine. */
export const AT_ONCE_MS = 5_000;
export const EDITIONS = [{ name: "desktop", sharedServer: false }, { name: "shared server", sharedServer: true }];

const only = process.env.RESTART_ONLY;
export const wanted = (name: string) => !only || name.includes(only);

/** The first turn after an end: one try, a real answer, at once. */
export async function firstTurnProblems(run: Run, send: () => Promise<Answer>): Promise<string[]> {
	const started = Date.now();
	const answer = await send().catch((error: Error) => { console.log(`  the first turn failed: ${error.message}`); return { status: 599 }; });
	const took = Date.now() - started;
	return [...(answer.status < 300 ? [] : [`the first turn failed: ${answer.status}`]), ...(took < AT_ONCE_MS ? [] : [`the first turn took ${took} ms`])];
}

export type RestartPart = (name: string, work: () => Promise<string[]> | string[], runs?: boolean) => Promise<void>;

// The name persistent-room-last-used.ts gives its temporary files: a start that checks the data folder knows a kill's leftover by it.
const LOCK_NOTE = /\.tmp-\d+-\d+-[a-z0-9]{0,6}$/;
const lockBase = (target: string) => path.basename(target).replace(LOCK_NOTE, "");
const reasoningModel = (home: string) => {
	const file = path.join(agentDirOf(home), "models.json");
	fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace('"input"', '"reasoning": true, "input"'));
};
const levelRead = async (run: Run) => (await readJsonAnswer(roomUrl(run, `/threads/${THREAD}/model-options`))).body?.models?.[0]?.effort?.level;

/**
 * The locks on auth.json and settings.json a kill can leave, on one edition: a
 * kill at every step of one taking and giving back of each lock, and the first
 * turn after it. One turn takes both locks, so it is traced once for both.
 */
export async function lockParts(part: RestartPart, all: Save[], edition: (typeof EDITIONS)[number]): Promise<void> {
	const turn = all.find((save) => save.name === "turn")!;
	const row: Save = {
		...turn,
		kills: undefined,
		sharedServer: edition.sharedServer,
		prepare: (home) => {
			fs.writeFileSync(path.join(agentDirOf(home), "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }), { mode: 0o600 });
			reasoningModel(home);
		},
	};
	let trace: Promise<TraceStep[]> | undefined;
	for (const lock of ["auth.json.lock", "settings.json.lock"]) await part(`lock ${edition.name} ${lock}`, async () => lockRows(turn, row, await (trace ??= traceSave(row)), edition, lock));
}

async function lockRows(turn: Save, row: Save, trace: TraceStep[], edition: (typeof EDITIONS)[number], lock: string): Promise<string[]> {
	const first = trace.findIndex((step) => lockBase(step.target) === lock);
	const end = trace.findIndex((step, at) => at > first && step.op === "rmSync" && path.basename(step.target) === lock);
	if (first < 0 || end < 0) return [`${edition.name}: ${lock} was never taken and given back, so nothing below proves anything`];
	const steps = trace.slice(first, end + 1).filter((step) => step.op !== "fsyncSync" && lockBase(step.target) === lock);
	const landing = steps.find((step) => step.op === "linkSync" && path.basename(step.target) === lock);
	if (!landing) return [`${edition.name}: ${lock} did not land by a link`];
	const jobs = steps.flatMap((step) => (step.bytes ? ["before", "after", "torn-empty", "torn-half"] : ["before", "after"]).map((how) => ({ step, how })));
	const problems: string[] = [];
	let locksLeft = 0;
	await pool(jobs, lanes, async ({ step, how }, lane) => {
		const place = `${edition.name} ${lock} k=${step.step} ${how} [${step.op} ${path.basename(step.target)}]`;
		let tookMs = 0;
		const killed: Save = {
			...row,
			send: async (run) => {
				const started = Date.now();
				const answer = await turn.send(run);
				tookMs = Date.now() - started;
				return answer;
			},
			afterKill: (home) => {
				const left = fs.existsSync(path.join(agentDirOf(home), lock));
				if (left) locksLeft += 1;
				const strangers = fs.readdirSync(agentDirOf(home)).filter((name) => name.startsWith(`${lock}.`) && lockBase(name) !== lock);
				return [
					...(step === landing && how === "after" && !left ? ["the kill left no lock, so this row proves nothing"] : []),
					...strangers.map((name) => `the kill left ${name}, which no start knows as a leftover`),
				];
			},
			afterRestart: async (run) => {
				const level = await levelRead(run);
				return [...(level === "high" ? [] : [`settings.json's level reads ${level}`]), ...await roomProblems(run)];
			},
			afterRetry: async (run, answer) => [...(answer.status < 300 ? [] : [`the first turn failed: ${answer.status}`]), ...(tookMs < AT_ONCE_MS ? [] : [`the first turn took ${tookMs} ms`]), ...await roomProblems(run)],
		};
		const result = await runStep(killed, step.step, how, lane);
		if (!result.landed) problems.push(`${place}: the kill never came`);
		problems.push(...result.problems.map((problem) => `${place}: ${problem}`));
	});
	if (locksLeft === 0) problems.push(`${edition.name} ${lock}: no kill left a lock, so nothing here proves anything`);
	console.log(`${edition.name} ${lock}: ${jobs.length} kills, ${locksLeft} left the lock`);
	return problems;
}

/** Runs a restart smoke's named parts, each timed; a problem in any fails the smoke. */
export async function runRestartParts(title: string, parts: (part: RestartPart, all: Save[]) => Promise<void>): Promise<void> {
	let exitCode = 0;
	try {
		const started = Date.now();
		const { approveBody, seedEntryId } = await prepareTemplate();
		const found: string[] = [];
		await parts(async (name, work, runs = wanted(name)) => {
			if (!runs) return;
			const began = Date.now();
			const problems = await work();
			console.log(`${name}: ${problems.length} problems (${Math.round((Date.now() - began) / 1000)}s)`);
			for (const problem of problems) console.log(`  PROBLEM ${problem}`);
			found.push(...problems);
		}, saves(approveBody, seedEntryId));
		console.log(`${title}: ${found.length} problems in ${Math.round((Date.now() - started) / 1000)}s`);
		if (found.length) exitCode = 1;
	} catch (error) {
		console.error(error);
		exitCode = 1;
	} finally {
		provider.closeAllConnections();
		provider.close();
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
	}
	process.exit(exitCode);
}
