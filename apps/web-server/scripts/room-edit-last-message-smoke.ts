// Editing the newest message (edit-last-message.ts), in plain node on a
// made-up session, then in the browser against a spawned server and one
// synthetic OpenAI-compatible model whose requests the smoke reads:
//
// - the step back names only the steps that changed something, a command
//   that ran and failed included and a refused one left out; it refuses a
//   message with a shortening after it, a message with a file note, and text
//   the bubble did not show, beside the same message without them; a second
//   edit keeps what the first one left; a prompt the server sent by itself is
//   passed over to the person's message;
// - the pencil ("Edit") shows beside Copy on hover on the newest message,
//   under it on a phone at a finger's size, never while the room answers, on
//   an older message, on a message with a file, after a shortening, or while
//   a held message waits, and stays after a shortening that cut nothing;
// - in the edit box, an input method's confirming Enter sends nothing;
// - Cancel and Esc put the message and its answer back as they were;
// - after Send the model's next request holds only the edited message, with
//   the hidden note naming the steps that ran, the room shows the
//   not-undone line, after a reload the saved conversation holds only the
//   edited message and its new answer, and Remember and memory search read
//   only that;
// - a late save from before an edit never brings back the replaced items,
//   more than 50 of them;
// - a refused edit says so and puts the text in the message box; refused
//   because a message from another window is held, it shows that message at
//   once, queued under the newest one, as the room opened again does; refused
//   because another window's answer runs, by the step back, or for a
//   scheduled run's prompt, nothing new shows;
// - after a quit cut the newest answer and a restart, an edit of that message
//   reaches the model as the edited text alone, without the restart note; an
//   edit of the first message sent after the restart reaches it behind the
//   restart note, as a message typed there would.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { closeBrowser } from "./smoke-close-context.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const failures: string[] = [];
async function row(name: string, run: () => Promise<void> | void): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
		failures.push(name);
	}
}

// The smoke's own home and rooms folder, set before the server's modules load, so the readers it calls in process read the spawned server's files.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-edit-last-message-"));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;

const { changedThingOf, editNoteText, keptBeforeNextMessage, lastMessageEditable, markAppPrompt, stepBackForEdit, withEditNote, withoutEditNote } = await import("../src/edit-last-message.js");
const { commandRan, createPersistentRoomBashApprovalExtension } = await import("../src/persistent-room-bash-approval.js");
const { holdMessages, readHeldMessages } = await import("../src/held-messages-store.js");
const { buildPersistentAgentCheckpointTranscriptSource, getPersistentAgentThread, openPersistentAgentPiSessionManager } = await import("../src/persistent-agents.js");
const { readSessionPathMessages } = await import("../src/session-path-reader.js");
const { ANSWER_CUT_OFF_OPEN, serverStopNote, withAnswerNote } = await import("../src/cut-answer-note.js");
const { STOP_CUT_ANSWER_SENTENCE } = await import("../src/turn-ended-by.js");

// --- The step back, on a made-up session.
type Entry = { id: string; parentId: string | null; type: string; customType?: string; data?: unknown; message?: any };
function fakeSession(entries: Entry[]) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let leaf: string | null = entries.at(-1)?.id ?? null;
	let next = 0;
	const append = (entry: Omit<Entry, "id" | "parentId">) => {
		const id = `n${next++}`;
		byId.set(id, { ...entry, id, parentId: leaf });
		leaf = id;
		return id;
	};
	return {
		leaf: () => leaf,
		/** The person's or the server's next message, and its answer, as a turn writes them. */
		say: (text: string, answerText: string) => {
			append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
			append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answerText }] } });
		},
		sessionManager: {
			getLeafEntry: () => (leaf ? byId.get(leaf) : undefined),
			getEntry: (id: string) => byId.get(id),
			appendCustomEntry: (customType: string, data?: unknown) => append({ type: "custom", customType, data }),
		},
		navigateTree: async (id: string) => { leaf = byId.get(id)?.parentId ?? null; return { cancelled: false }; },
	};
}
const user = (id: string, parentId: string | null, text: string): Entry => ({ id, parentId, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const call = (id: string, parentId: string, name: string, args: unknown, callId = `${id}-call`, stopReason = "toolUse"): Entry => ({ id, parentId, type: "message", message: { role: "assistant", stopReason, content: [{ type: "toolCall", id: callId, name, arguments: args }] } });
const result = (id: string, parentId: string, callId: string, isError = false, details: unknown = {}): Entry => ({ id, parentId, type: "message", message: { role: "toolResult", toolCallId: callId, isError, details, content: [{ type: "text", text: isError ? "failed" : "ok" }] } });
const answer = (id: string, parentId: string, text: string): Entry => ({ id, parentId, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

await row("the step back names the steps that changed something, a command that ran and failed included", async () => {
	const session = fakeSession([
		user("u0", null, "Hello."), answer("a0", "u0", "Hi."),
		user("u1", "a0", "Write the report."),
		call("c1", "u1", "read", { path: "notes.txt" }), result("r1", "c1", "c1-call"),
		call("c2", "r1", "write", { path: "report.md", content: "x" }), result("r2", "c2", "c2-call"),
		call("c3", "r2", "write", { path: "broken.md", content: "x" }), result("r3", "c3", "c3-call", true),
		call("c4", "r3", "bash", { command: "npm test" }), result("r4", "c4", "c4-call"),
		call("c5", "r4", "write", { path: "report.md", content: "y" }), result("r5", "c5", "c5-call"),
		// Declined: an error, and it never ran.
		call("c6", "r5", "bash", { command: "rm -rf build" }), result("r6", "c6", "c6-call", true),
		// Ran and exited non-zero: the room's wrapper marked it as run.
		call("c7", "r6", "bash", { command: "npm run lint" }), result("r7", "c7", "c7-call", true, { commandRan: true }),
		// Stopped while it ran: no result, but the model had finished asking for it.
		call("c8", "r7", "bash", { command: "npm run build" }),
		// Cut while the model was still writing it: it never ran.
		call("c9", "c8", "write", { path: "draft.md", content: "x" }, "c9-call", "aborted"),
		answer("a1", "c9", "Report written."),
	]);
	assert(lastMessageEditable(session), "the newest message is editable");
	const stepped = await stepBackForEdit(session, "Write the report.");
	assert(stepped.ok, `the edit is taken, got ${JSON.stringify(stepped)}`);
	assert(JSON.stringify(stepped.ran) === JSON.stringify(["wrote report.md", "ran npm test", "ran npm run lint", "ran npm run build"]), `the read, the failed write, the declined command and the repeat are left out; the command that ran and failed and the stopped one kept, the one cut while it was written left out, got ${JSON.stringify(stepped.ran)}`);
	assert(JSON.stringify(stepped.kept) === JSON.stringify(stepped.ran), "with no earlier edit, what stays is what this answer did");
	assert(session.sessionManager.getEntry(session.leaf()!)?.parentId === "a0", `the conversation is back before the message, with what stays written down after it, got ${session.leaf()}`);
});
await row("the step back refuses after a shortening, beside the same message without one", async () => {
	const shortened = fakeSession([user("u1", null, "Write the report."), { id: "k1", parentId: "u1", type: "compaction" }, answer("a1", "k1", "Done.")]);
	assert(!lastMessageEditable(shortened), "not editable after a shortening");
	const refused = await stepBackForEdit(shortened, "Write the report.");
	assert(!refused.ok && refused.refused === "shortened" && shortened.leaf() === "a1", `refused and left as it was, got ${JSON.stringify(refused)} at ${shortened.leaf()}`);
	const plain = fakeSession([user("u1", null, "Write the report."), answer("a1", "u1", "Done.")]);
	assert((await stepBackForEdit(plain, "Write the report.")).ok, "the same message without a shortening is taken");
});
await row("the step back refuses a message with a file note, and text the bubble did not show", async () => {
	const withFile = fakeSession([user("u1", null, "[FILE ATTACHED: a.txt · 1 page · now in this room's Attachments; read it with read_file when relevant]\n\nRead it."), answer("a1", "u1", "Done.")]);
	const refused = await stepBackForEdit(withFile, "Read it.");
	assert(!refused.ok && refused.refused === "not-typed", `a file's message is refused, got ${JSON.stringify(refused)}`);
	const other = fakeSession([user("u1", null, "Write the report."), answer("a1", "u1", "Done.")]);
	const notShown = await stepBackForEdit(other, "Something else.");
	assert(!notShown.ok && notShown.refused === "not-shown" && other.leaf() === "a1", `text the bubble did not show is refused, got ${JSON.stringify(notShown)}`);
});
await row("a second edit keeps what the first one left, and an edit whose answer changed nothing leaves nothing", async () => {
	const session = fakeSession([user("u1", null, "Write the report."), call("c1", "u1", "write", { path: "report.md", content: "x" }), result("r1", "c1", "c1-call"), answer("a1", "r1", "Written.")]);
	const first = await stepBackForEdit(session, "Write the report.");
	assert(first.ok && first.kept.join("|") === "wrote report.md", `the first edit, got ${JSON.stringify(first)}`);
	session.say(withEditNote(first.kept, "Write the summary."), "Here is the summary.");
	const second = await stepBackForEdit(session, "Write the summary.");
	assert(second.ok && second.ran.length === 0 && second.kept.join("|") === "wrote report.md", `the second edit's answer ran nothing, and report.md stays named for the model, got ${JSON.stringify(second)}`);
	assert(withEditNote(second.kept, "Only the title.").includes("their effects remain: wrote report.md."), "the second edit's note names it");
	assert(JSON.stringify(keptBeforeNextMessage(session)) === JSON.stringify(["wrote report.md"]), "the next message carries it, whether the edited one or the same text sent again after a failed attempt");
	session.say("Only the title.", "The title.");
	assert(keptBeforeNextMessage(session).length === 0, "a message after that carries no note of its own");
	const quiet = fakeSession([user("u1", null, "Hello."), answer("a1", "u1", "Hi.")]);
	const plain = await stepBackForEdit(quiet, "Hello.");
	const quietMark = quiet.sessionManager.getEntry(quiet.leaf()!);
	assert(plain.ok && plain.kept.length === 0 && quietMark?.parentId === null && quietMark.customType === "edit-kept-steps" && JSON.stringify(quietMark.data) === JSON.stringify({ kept: [] }), `nothing to keep, and the step back is still written down, so a reload reopens before the message, got ${JSON.stringify(plain)} at ${JSON.stringify(quietMark)}`);
	assert(withoutEditNote(withEditNote(["ran npm test"], "Hi.")) === "Hi." && withEditNote([], "Hi.") === "Hi.", "the note comes off whole, and none is added when nothing changed");
	assert(editNoteText(["wrote report.md", "ran npm test"]).includes("The person edited their last message. The earlier answer was removed, but these steps had already run and their effects remain: wrote report.md, ran npm test."), "the note's words");
	assert(changedThingOf("mcp", { server: "github" }, "done") === undefined && changedThingOf("mcp", { server: "github", tool: "create_issue" }, "done") === "used create_issue (github)", "listing a connector reads; calling its tool acts");
});
await row("an edit after the server's own request for a missing answer goes to the person's message", async () => {
	const build = (marked: boolean) => {
		const session = fakeSession([user("u1", null, "What do the notes say?"), call("c1", "u1", "read", { path: "notes.txt" }), result("r1", "c1", "c1-call"), answer("a1", "r1", "")]);
		if (marked) markAppPrompt(session);
		session.say("[INTERNAL_TOOL_SUMMARY_REQUEST]\nWrite the missing final answer now.\n[/INTERNAL_TOOL_SUMMARY_REQUEST]", "The notes say Friday.");
		return session;
	};
	const marked = build(true);
	assert(lastMessageEditable(marked), "editable after the server's request");
	const stepped = await stepBackForEdit(marked, "What do the notes say?");
	assert(stepped.ok && marked.sessionManager.getEntry(marked.leaf()!)?.parentId === null, `the person's message is replaced, its answer and the server's request with it, got ${JSON.stringify(stepped)} at ${marked.leaf()}`);
	const unmarked = build(false);
	const refused = await stepBackForEdit(unmarked, "What do the notes say?");
	assert(!refused.ok && refused.refused === "not-shown", `an unmarked request reads as the newest message, got ${JSON.stringify(refused)}`);
});
await row("a command marks itself as run, but not when no shell was found to run it", async () => {
	const handlers: Record<string, (event: any) => Promise<any>> = {};
	await createPersistentRoomBashApprovalExtension({ beforeBashCall: async () => ({ allow: true }) } as any)({ on: (event: string, handler: any) => { handlers[event] = handler; } } as any);
	const ran = await handlers.tool_result!({ toolName: "bash", isError: true, content: [{ type: "text", text: "lint found 3 problems\n\nCommand exited with code 3" }], details: {} });
	assert(commandRan(ran?.details), "a command that ran and failed is marked");
	const noShell = await handlers.tool_result!({ toolName: "bash", isError: true, content: [{ type: "text", text: "No bash shell found. Options: install Git for Windows." }], details: {} });
	assert(!commandRan(noShell?.details), `no shell, nothing ran: no mark, got ${JSON.stringify(noShell)}`);
});

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("room edit last message smoke: browser rows skipped (Chromium not installed)");
		fs.rmSync(tempRoot, { recursive: true, force: true });
		process.exit(failures.length ? 1 : 0);
	}
}

// --- In the browser.
/** Each room's own folder, so one room's report.md is never another's. */
const workspaceOf = (room: string) => path.join(tempRoot, "workspaces", room.replace(/\W+/g, "-"));

type Tool = { name: string; args: unknown };
type Leg = { text?: string; tools?: Tool[]; held?: boolean; fail?: boolean; promptTokens?: number };
/** Each model request of a room's turn as the server sent it: its user texts, and every message's role and text. */
const calls: { userTexts: string[]; texts: string[] }[] = [];
let legs: Leg[] = [];
let releaseHeld: (() => void) | null = null;
// While set, the requests that are not the room's turn (a Remember's reading) wait until released.
let holdNotes = false;
const heldNotes: (() => void)[] = [];
const releaseNotes = () => { holdNotes = false; for (const release of heldNotes.splice(0)) release(); };
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => String(part?.text ?? "")).join("") : "");
const sseChunk = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		// Requests that are not the room's turn (a title, a memory pass) carry no tools: they get a plain answer and are not counted.
		const roomTurn = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
		if (roomTurn) calls.push({ userTexts: messages.filter((m) => m?.role === "user").map((m) => textOf(m.content)), texts: messages.map((m) => `${m?.role}: ${textOf(m.content)}${Array.isArray(m?.tool_calls) ? ` ${JSON.stringify(m.tool_calls)}` : ""}`) });
		const leg = roomTurn ? legs.shift() ?? { text: "Done." } : { text: "Room notes." };
		if (!roomTurn && holdNotes) await new Promise<void>((resolve) => { heldNotes.push(resolve); });
		// A refusal no retry helps with: the attempt fails before any word.
		if (leg.fail) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The synthetic gateway refused this request.", type: "invalid_request_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (leg.held) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Working on it. " }, finish_reason: null }] }));
			await new Promise<void>((resolve) => { releaseHeld = resolve; });
		}
		if (leg.tools) {
			const toolCalls = leg.tools.map((tool, index) => ({ index, id: `call_${calls.length}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: leg.text ?? "Done." }, finish_reason: null }] }));
			const promptTokens = leg.promptTokens ?? 150;
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 12, total_tokens: promptTokens + 12 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let port = 0;
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		assert(Date.now() < deadline, `timed out waiting until ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const ORIGINAL = "Write the report and run the tests.";
const OLD_ANSWER = "The report is written and the tests pass.";
const EDITED = "Write only the summary.";
const NEW_ANSWER = "Here is the summary.";
const NOTE = "The person edited their last message. The earlier answer was removed, but these steps had already run and their effects remain: wrote report.md, ran npm test.";
const LINE = "Done before your edit and not undone: wrote report.md, ran npm test.";
const REFUSED = "The conversation moved on, so this message can't be edited.";
const writeAndTest: Leg[] = [
	{ tools: [{ name: "write", args: { path: "report.md", content: "# Report\n" } }] },
	{ tools: [{ name: "bash", args: { command: "npm test" } }] },
	{ text: OLD_ANSWER },
];

const rooms: Record<string, string> = {};
const readyFrames = new WeakMap<Page, number>();
const shorteningEnds = new WeakMap<Page, number>();
const WebSocketImpl: any = (await import("ws")).default;
const stored = async (room: string) => {
	const status = (await json(`/api/persistent-agents/${rooms[room]}/status`)).body;
	const threadId = String(status?.activeThread?.threadId ?? "");
	const thread = (await json(`/api/persistent-agents/${rooms[room]}/threads/${encodeURIComponent(threadId)}`)).body?.thread ?? {};
	return { threadId, items: (thread.items ?? []) as any[], inFlight: status?.activeThread?.inFlight === true };
};
/** The saved items once the page's last save has landed: the same on two reads a second apart. */
const settledItems = async (room: string) => {
	let last = "";
	for (let tries = 0; tries < 20; tries++) {
		const items = (await stored(room)).items;
		const now = JSON.stringify(items.map((item) => item.id));
		if (now === last) return items;
		last = now;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(`${room}'s saves never settled`);
};

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-edit" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });
	port = await freePort();
	/** The server on the smoke's home; the restart row starts it again on the same home and port. */
	const startServer = async () => {
		const started = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: { ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_TEST_INTROSPECTION: "1" } as NodeJS.ProcessEnv,
		});
		serverProcess = started;
		started.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		started.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		await waitUntil(() => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false), "the server is up", 60_000);
	};
	await startServer();

	for (const name of ["Edit Room", "Second Room", "Recovery Room", "Late Room", "Retry Room", "Race Room", "Busy Room", "Steer Room", "Scheduled Room", "Rules Room", "Restart Room", "Hello Room", "Shortening Room", "Typing Room", "Moved Room", "Running Room", "Queued Room"]) {
		const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		const id = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
		assert(created.status === 201 && id, `${name} is created, got ${created.status}`);
		const root = workspaceOf(name);
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "edit-smoke", private: true, scripts: { test: "echo tests pass", lint: "echo lint found 3 problems && exit 3" } }, null, 2));
		fs.writeFileSync(path.join(root, "notes.txt"), "The release is on Friday.\n");
		// Local files with commands, and the write tool chosen on top.
		const workspace = await json(`/api/persistent-agents/${encodeURIComponent(id)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root, displayLabel: "Edit Workspace", workspaceAccessMode: "localFiles", bashEnabled: true, toolSelection: { kind: "custom", allowedToolNames: ["read", "ls", "grep", "write", "edit"] } }) });
		assert(workspace.status === 200, `${name}'s workspace is set, got ${workspace.status} ${JSON.stringify(workspace.body).slice(0, 200)}`);
		rooms[name] = id;
	}

	const browser: Browser = await chromium.launch();
	try {
		const enter = async (room: string, phone = false, prepare?: (context: BrowserContext) => Promise<void>): Promise<Page> => {
			const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 } });
			await prepare?.(context);
			const page = await context.newPage();
			const pageErrors: string[] = [];
			// The room's ready frames, so a check can wait for the state the room opened in.
			page.on("websocket", (socket) => socket.on("framereceived", (frame) => {
				try {
					const parsed = JSON.parse(String(frame.payload));
					if (parsed.type === "ready") readyFrames.set(page, (readyFrames.get(page) ?? 0) + 1);
					if (parsed.type === "event" && parsed.event?.type === "compaction_end") shorteningEnds.set(page, (shorteningEnds.get(page) ?? 0) + 1);
				} catch {}
			}));
			page.on("pageerror", (error) => pageErrors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
			await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			try {
				await page.locator('button[title="Send"]').first().waitFor({ timeout: 20_000 });
			} catch (error) {
				// What the room showed instead, for the failure's line.
				throw new Error(`${room} did not open: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200)} ${pageErrors.join(" | ").slice(0, 600)}`);
			}
			return page;
		};
		const composer = (page: Page) => page.locator(".composer textarea").first();
		/** Once the room's ready frame has been drawn: what the page shows from then on is the state the room opened in. */
		const readyDrawn = async (page: Page) => {
			await waitUntil(() => (readyFrames.get(page) ?? 0) > 0, "the room's ready frame arrives", 20_000);
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		};
		/** A socket into the room the way the page opens one, with the server's test options. */
		const rawSocket = async (room: string, threadId: string, extra = "") => {
			const frames: any[] = [];
			const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${rooms[room]}&conversationId=${encodeURIComponent(threadId)}&modelProvider=openai-compatible&model=room-model&reattach=1${extra}`, { headers: { ...SMOKE_AUTH_HEADERS } });
			socket.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
			await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("the socket did not open"))); });
			await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the socket's room is ready");
			return { socket, frames, send: (frame: unknown) => socket.send(JSON.stringify(frame)), close: () => socket.close() };
		};
		const idle = (page: Page) => waitUntil(async () => (await page.locator(".stop-btn").count()) === 0 && (await page.locator('button[title="Send"]').count()) > 0, "the room is idle on the page");
		/** Waits for words in the room, answering a command's question on the way. */
		const answered = async (page: Page, answerText: string) => {
			const deadline = Date.now() + 30_000;
			while ((await page.locator(".messages").getByText(answerText).count()) === 0) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for "${answerText}": ${(await page.locator(".messages").innerText()).replace(/\s+/g, " ").slice(-500)} | calls ${calls.length}`);
				const yes = page.locator(".messages").getByRole("button", { name: /^(Allow|Yes|Approve)\b/ });
				if (await yes.count()) await yes.first().click().catch(() => {});
				await page.waitForTimeout(150);
			}
			await idle(page);
		};
		/** Sends from the box and waits for the answer and its save. */
		const ask = async (page: Page, room: string, text: string, answerText: string) => {
			await composer(page).fill(text);
			await page.locator("button.send-btn").click();
			await answered(page, answerText);
			await waitUntil(async () => { const { items, inFlight } = await stored(room); return !inFlight && items.some((item) => String(item.text ?? "").includes(answerText)); }, `"${answerText}" is saved`);
		};
		const pencils = (page: Page) => page.locator(".message-edit-user");
		const newestBubble = (page: Page) => page.locator(".bubble-row.user:not(.queued)").last();
		const clickEdit = async (page: Page) => {
			await newestBubble(page).hover();
			await newestBubble(page).getByRole("button", { name: "Edit", exact: true }).click();
		};
		const editBox = (page: Page) => page.locator("textarea.bubble-edit-box");
		/** Pencil, the new text, Send; waits for the new answer. */
		const sendEdit = async (page: Page, text: string, answerText: string) => {
			await clickEdit(page);
			await editBox(page).fill(text);
			await page.locator(".bubble-edit-actions").getByRole("button", { name: "Send" }).click();
			await answered(page, answerText);
		};
		const userTexts = async (page: Page) => (await page.locator(".bubble-row.user:not(.queued) .user-message-content").allInnerTexts()).map((text) => text.trim());
		const lastRequestWith = (text: string) => [...calls].reverse().find((c) => c.userTexts.some((t) => t.includes(text)));

		// --- Pencil, Cancel, Esc, Send, a reload, and what memory reads.
		await row("pencil, Cancel and Esc restore; Send replaces the message for the model, the room, a reload and memory", async () => {
			const room = "Edit Room";
			const page = await enter(room);
			await ask(page, room, "Hello there.", "Done.");
			legs = [...writeAndTest];
			await ask(page, room, ORIGINAL, OLD_ANSWER);
			assert(fs.existsSync(path.join(workspaceOf(room), "report.md")), "the step wrote report.md");
			assert((await pencils(page).count()) === 1 && (await newestBubble(page).locator(".message-edit-user").count()) === 1, `the pencil is on the newest message only, got ${await pencils(page).count()}`);
			const pencil = newestBubble(page).locator(".message-edit-user");
			assert((await pencil.getAttribute("title")) === "Edit" && (await pencil.getAttribute("aria-label")) === "Edit", "the pencil's hover text and name are Edit");
			assert((await pencil.evaluate((el) => getComputedStyle(el).opacity)) === "0", "hidden until the message is hovered");
			const copyBox = await newestBubble(page).locator(".message-copy-user").boundingBox();
			await newestBubble(page).hover();
			await waitUntil(async () => (await pencil.evaluate((el) => getComputedStyle(el).opacity)) === "1", "the pencil shows on hover", 3000);
			const pencilBox = await pencil.boundingBox();
			assert(pencilBox && copyBox && Math.abs(pencilBox.y - copyBox.y) < 4 && pencilBox.x < copyBox.x && copyBox.x - pencilBox.x < 48, `beside Copy, before it, got ${JSON.stringify({ pencilBox, copyBox })}`);
			const before = { texts: await userTexts(page), answers: await page.locator(".messages .assistant-markdown").allInnerTexts(), calls: calls.length, items: (await settledItems(room)).map((item) => item.id) };

			// Cancel, then Esc: everything as it was.
			for (const close of ["Cancel", "Escape"] as const) {
				await clickEdit(page);
				await editBox(page).waitFor({ timeout: 5000 });
				assert((await editBox(page).inputValue()) === ORIGINAL, `the bubble's box holds the message, got ${JSON.stringify(await editBox(page).inputValue())}`);
				assert((await page.locator(".transcript-turn.edit-dim-answer").count()) === 1, "the answer below is dimmed while the bubble is edited");
				await editBox(page).fill("A change I will not keep.");
				if (close === "Cancel") await page.locator(".bubble-edit-actions").getByRole("button", { name: "Cancel" }).click();
				else await editBox(page).press("Escape");
				await waitUntil(async () => (await editBox(page).count()) === 0 && (await page.locator(".edit-dim-answer, .edit-dim-all").count()) === 0, `${close} closes the box and the dimming`, 5000);
				assert(JSON.stringify(await userTexts(page)) === JSON.stringify(before.texts), `${close} keeps the messages, got ${JSON.stringify(await userTexts(page))}`);
				assert(JSON.stringify(await page.locator(".messages .assistant-markdown").allInnerTexts()) === JSON.stringify(before.answers), `${close} keeps the answers`);
			}
			assert(calls.length === before.calls, "Cancel and Esc ask the model nothing");
			const afterCancel = (await settledItems(room)).map((item) => item.id);
			assert(JSON.stringify(afterCancel) === JSON.stringify(before.items), `Cancel and Esc change nothing saved, got ${JSON.stringify(afterCancel)} for ${JSON.stringify(before.items)}`);

			// Send.
			legs = [{ text: NEW_ANSWER }];
			await sendEdit(page, EDITED, NEW_ANSWER);
			const sent = calls.at(-1)!;
			// The room-state message may follow the person's own.
			const lastUser = sent.userTexts.find((text) => text.includes(EDITED)) ?? "";
			assert(lastUser.includes(EDITED) && lastUser.includes(NOTE), `the model gets the edited message with the note, got ${JSON.stringify(lastUser)}`);
			assert(!sent.texts.some((text) => text.includes(ORIGINAL) || text.includes(OLD_ANSWER) || text.includes("report.md\"")), `the model no longer reads the old message, its steps or its answer, got ${JSON.stringify(sent.texts)}`);
			assert(sent.texts.some((text) => text.includes("Hello there.")), "the messages before it stay");
			assert(JSON.stringify(await userTexts(page)) === JSON.stringify(["Hello there.", EDITED]), `the room shows the edited message in place of the old one, got ${JSON.stringify(await userTexts(page))}`);
			await page.locator(".system-line", { hasText: LINE }).waitFor({ timeout: 5000 });
			assert((await page.getByText(OLD_ANSWER).count()) === 0, "the old answer is gone");

			// After a reload.
			await waitUntil(async () => { const { items, inFlight } = await stored(room); return !inFlight && items.some((item) => item.text === NEW_ANSWER) && items.some((item) => item.text === LINE); }, "the new answer and the line are saved");
			await page.reload();
			await page.locator(".persistent-agent-card, .messages").first().waitFor({ timeout: 20_000 });
			if (await page.locator(".persistent-agent-card").count()) await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator(".messages").getByText(NEW_ANSWER).waitFor({ timeout: 20_000 });
			assert(JSON.stringify(await userTexts(page)) === JSON.stringify(["Hello there.", EDITED]), `after a reload, only the edited message, got ${JSON.stringify(await userTexts(page))}`);
			const saved = (await stored(room)).items;
			assert(!saved.some((item) => String(item.text ?? "").includes(ORIGINAL) || String(item.text ?? "").includes(OLD_ANSWER)), `the saved conversation lost the old message and answer, got ${JSON.stringify(saved.map((item) => [item.kind, item.text ?? item.name]))}`);
			assert(saved.filter((item) => item.kind === "user").map((item) => item.text).join("|") === `Hello there.|${EDITED}`, "the saved messages are the first and the edited one");
			assert(saved.filter((item) => item.text === LINE).length === 1, "the not-undone line is saved once");

			// What Remember reads (and Memorize folds), and what memory search indexes: the conversation's path, the corrected exchange only.
			const { threadId } = await stored(room);
			const remembered = JSON.stringify(buildPersistentAgentCheckpointTranscriptSource({ agentId: rooms[room], conversationId: threadId, l1b: "", runtimeCwd: workspaceOf(room) }).items);
			const thread = getPersistentAgentThread(rooms[room]!, threadId)!;
			const searched = JSON.stringify(readSessionPathMessages(openPersistentAgentPiSessionManager(rooms[room]!, thread.runtime as any, workspaceOf(room))));
			for (const [reader, read] of [["Remember", remembered], ["memory search", searched]] as const) {
				assert(read.includes(EDITED) && read.includes(NEW_ANSWER) && read.includes("Hello there."), `${reader} reads the corrected exchange`);
				assert(!read.includes(ORIGINAL) && !read.includes(OLD_ANSWER), `${reader} never reads the replaced message or answer`);
			}
			// The session file keeps the old branch beside the path (the runtime's tree): it is the path that leaves it out.
			const sessionFile = path.join(agentsRoot, rooms[room]!, (thread.runtime as any).sessionFileRelPath);
			assert(fs.readFileSync(sessionFile, "utf8").includes(ORIGINAL), "the replaced message is still in the file, off the path");

			// The next message goes on from the edited one.
			await ask(page, room, "And then?", "Done.");
			assert(!calls.at(-1)!.texts.some((text) => text.includes(ORIGINAL)) && calls.at(-1)!.texts.some((text) => text.includes(EDITED)), "the next request goes on from the edited message");
			await page.context().close();
		});

		// --- A command that ran and failed, and a second edit.
		await row("a command that ran and failed is named; a second edit keeps the first edit's effects in its note", async () => {
			const room = "Second Room";
			const page = await enter(room);
			legs = [
				{ tools: [{ name: "write", args: { path: "report.md", content: "# Report\n" } }] },
				{ tools: [{ name: "bash", args: { command: "npm run lint" } }] },
				{ text: "The report is written; lint found problems." },
			];
			await ask(page, room, ORIGINAL, "The report is written; lint found problems.");
			assert(calls.some((c) => c.texts.some((text) => text.startsWith("tool:") && text.includes("lint found 3 problems"))), "the command ran and failed");
			const line = "Done before your edit and not undone: wrote report.md, ran npm run lint.";
			legs = [{ text: "First edit answer." }];
			await sendEdit(page, "Write the report only.", "First edit answer.");
			await page.locator(".system-line", { hasText: line }).waitFor({ timeout: 5000 });
			const first = lastRequestWith("Write the report only.")!.userTexts.find((text) => text.includes("Write the report only.")) ?? "";
			assert(first.includes("their effects remain: wrote report.md, ran npm run lint."), `the first edit's note names the failed command, got ${JSON.stringify(first)}`);
			legs = [{ text: "Second edit answer." }];
			await sendEdit(page, "Write the title only.", "Second edit answer.");
			const second = lastRequestWith("Write the title only.")!;
			const secondUser = second.userTexts.find((text) => text.includes("Write the title only.")) ?? "";
			assert(secondUser.includes("their effects remain: wrote report.md, ran npm run lint."), `the second edit's note still names what the first one left, got ${JSON.stringify(secondUser)}`);
			assert(!second.texts.some((text) => text.includes("Write the report only.") || text.includes("First edit answer.")), "the model no longer reads the first edit or its answer");
			assert(JSON.stringify(await userTexts(page)) === JSON.stringify(["Write the title only."]), `the room shows the second edit only, got ${JSON.stringify(await userTexts(page))}`);
			assert((await page.locator(".system-line", { hasText: line }).count()) === 1, "the first edit's line stays, once; the second's answer changed nothing, so no line of its own");
			await page.context().close();
		});

		// --- After the server's own request for a missing answer.
		await row("an edit after the server's own request for a missing answer replaces the person's message", async () => {
			const room = "Recovery Room";
			const page = await enter(room);
			const asked = "What do the notes say?";
			// A read, then no words: the server asks for the missing answer itself.
			legs = [{ tools: [{ name: "read", args: { path: "notes.txt" } }] }, { text: "" }, { text: "The notes say the release is on Friday." }];
			await ask(page, room, asked, "The notes say the release is on Friday.");
			assert(calls.some((c) => c.userTexts.some((text) => text.includes("[INTERNAL_TOOL_SUMMARY_REQUEST]"))), "the server sent its own request");
			assert((await pencils(page).count()) === 1, "the pencil shows on the person's message");
			legs = [{ text: "Monday, says the calendar." }];
			await sendEdit(page, "What does the calendar say?", "Monday, says the calendar.");
			assert((await page.locator(".system-line", { hasText: REFUSED }).count()) === 0, "the edit is not refused");
			const sent = lastRequestWith("What does the calendar say?")!;
			assert(!sent.texts.some((text) => text.includes(asked) || text.includes("INTERNAL_TOOL_SUMMARY_REQUEST") || text.includes("release is on Friday")), `the model no longer reads the message, the server's request or its answer, got ${JSON.stringify(sent.texts)}`);
			assert(JSON.stringify(await userTexts(page)) === JSON.stringify(["What does the calendar say?"]), `the room shows the edited message only, got ${JSON.stringify(await userTexts(page))}`);
			await page.context().close();
		});

		// --- A late save from before the edit.
		await row("a late save from before an edit never brings back the replaced items, more than 50 of them", async () => {
			const room = "Late Room";
			const page = await enter(room);
			legs = [{ tools: Array.from({ length: 55 }, (_, index) => ({ name: "ls", args: { path: ".", limit: index + 1 } })) }, { text: "I looked at the folder fifty-five times and it holds the notes, the package file and nothing else." }];
			await ask(page, room, ORIGINAL, "I looked at the folder fifty-five times");
			const stale = await settledItems(room);
			const at = stale.findIndex((item) => item.kind === "user" && item.text === ORIGINAL);
			const replaced = stale.slice(at).map((item) => String(item.id));
			assert(at >= 0 && replaced.length > 50, `more than 50 items to replace, got ${replaced.length}`);
			legs = [{ text: NEW_ANSWER }];
			await sendEdit(page, EDITED, NEW_ANSWER);
			await waitUntil(async () => { const { items, inFlight } = await stored(room); return !inFlight && items.some((item) => item.text === NEW_ANSWER); }, "the new answer is saved");
			await settledItems(room);
			await page.context().close();
			// The page's copy from before the edit, saved late.
			const { threadId } = await stored(room);
			const late = await json(`/api/persistent-agents/${rooms[room]}/threads/${encodeURIComponent(threadId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "unknown", items: stale }) });
			assert(late.status === 200, `the late save is taken, got ${late.status}`);
			const after = (await stored(room)).items.map((item) => String(item.id));
			const back = replaced.filter((id) => after.includes(id));
			assert(back.length === 0, `none of the replaced items comes back, got ${back.length} of ${replaced.length}`);
			assert(stale.slice(0, at).every((item) => after.includes(String(item.id))), "the items before the edited message stay");
		});

		// --- The edited message fails before any answer and goes back to the box.
		await row("an edited message handed back after a failed attempt carries its note again when it is sent again", async () => {
			const room = "Retry Room";
			legs = [{ tools: [{ name: "write", args: { path: "report.md", content: "# Report\n" } }] }, { text: OLD_ANSWER }];
			const page = await enter(room);
			await ask(page, room, ORIGINAL, OLD_ANSWER);
			legs = [{ fail: true }];
			await clickEdit(page);
			await editBox(page).fill(EDITED);
			await page.locator(".bubble-edit-actions").getByRole("button", { name: "Send" }).click();
			await waitUntil(async () => (await composer(page).inputValue()) === EDITED, "the edited message is back in the box");
			await idle(page);
			const failed = lastRequestWith(EDITED)!.userTexts.find((text) => text.includes(EDITED)) ?? "";
			assert(failed.includes("their effects remain: wrote report.md."), `the failed attempt carried the note, got ${JSON.stringify(failed)}`);
			const callsBefore = calls.length;
			legs = [{ text: NEW_ANSWER }];
			await page.locator("button.send-btn").click();
			await answered(page, NEW_ANSWER);
			assert(calls.length > callsBefore, "it was sent again");
			const again = lastRequestWith(EDITED)!.userTexts.find((text) => text.includes(EDITED)) ?? "";
			assert(again.includes("their effects remain: wrote report.md."), `sent again, it carries the note, got ${JSON.stringify(again)}`);
			assert(!lastRequestWith(EDITED)!.texts.some((text) => text.includes(OLD_ANSWER)), "the replaced answer stays out");
			await page.context().close();
		});

		// --- The page saves the edited message before its turn begins.
		await row("a save of the edited message before its turn begins keeps it, on a later save too", async () => {
			const room = "Race Room";
			legs = [{ text: OLD_ANSWER }];
			const page = await enter(room);
			await ask(page, room, ORIGINAL, OLD_ANSWER);
			const before = await settledItems(room);
			const bubble = before.find((item) => item.kind === "user" && item.text === ORIGINAL);
			assert(bubble, "the message is saved");
			const { threadId } = await stored(room);
			await page.context().close();
			// The turn begins a second and a half after the message arrives, as a slow start would; the page's save lands first.
			const raw = await rawSocket(room, threadId, "&testPromptStartDelayMs=1500");
			const key = "smokeRaceEdit1";
			legs = [{ text: NEW_ANSWER }];
			raw.send({ type: "prompt", text: EDITED, id: key, shown: { text: EDITED, files: [] }, edit: { replaces: String(bubble.id), text: ORIGINAL } });
			const pageCopy = [...before, { kind: "user", id: key, text: EDITED }];
			const early = await json(`/api/persistent-agents/${rooms[room]}/threads/${encodeURIComponent(threadId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "unknown", items: pageCopy }) });
			assert(early.status === 200, `the page's save is taken, got ${early.status}`);
			await waitUntil(() => raw.frames.some((frame) => frame.type === "edit_applied"), "the edit is taken");
			await waitUntil(async () => { const { items, inFlight } = await stored(room); return !inFlight && items.some((item) => item.text === NEW_ANSWER); }, "the new answer is saved");
			raw.close();
			const landed = await settledItems(room);
			assert(landed.some((item) => item.id === key && item.kind === "user" && item.text === EDITED), `the edited message is saved, got ${JSON.stringify(landed.map((item) => [item.kind, item.id, item.text]))}`);
			assert(!landed.some((item) => item.id === bubble.id || item.text === OLD_ANSWER), "the replaced message and answer are gone");
			// The page saves its copy again, the edited message in it.
			const again = await json(`/api/persistent-agents/${rooms[room]}/threads/${encodeURIComponent(threadId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "unknown", items: [...pageCopy, ...landed.filter((item) => item.text === NEW_ANSWER)] }) });
			assert(again.status === 200, `the later save is taken, got ${again.status}`);
			const after = await stored(room);
			assert(after.items.some((item) => item.id === key), "the edited message stays after the later save");
			assert(!after.items.some((item) => item.id === bubble.id), "the replaced message does not come back");
		});

		// --- An edit while Remember reads the conversation.
		await row("an edit while Remember reads changes nothing, and the box keeps what was typed in it", async () => {
			const room = "Busy Room";
			legs = [{ text: OLD_ANSWER }];
			const page = await enter(room);
			await ask(page, room, ORIGINAL, OLD_ANSWER);
			const before = (await settledItems(room)).map((item) => item.id);
			const { threadId } = await stored(room);
			holdNotes = true;
			const started = await json(`/api/persistent-agents/${rooms[room]}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId: threadId, density: "standard", background: true }) });
			assert(started.status === 202, `Remember starts, got ${started.status} ${JSON.stringify(started.body).slice(0, 200)}`);
			await waitUntil(() => heldNotes.length > 0, "Remember is reading");
			await composer(page).fill("A draft for later.");
			await clickEdit(page);
			await editBox(page).fill("Is it gone?");
			const callsBefore = calls.length;
			await page.locator(".bubble-edit-actions").getByRole("button", { name: "Send" }).click();
			await page.locator(".system-line", { hasText: REFUSED }).waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await composer(page).inputValue()) === "Is it gone?\n\nA draft for later.", "the edit and the draft are in the box", 5000);
			assert(JSON.stringify(await userTexts(page)) === JSON.stringify([ORIGINAL]), `the message stays, got ${JSON.stringify(await userTexts(page))}`);
			const cancelled = await json(`/api/persistent-agents/${rooms[room]}/checkpoint/cancel`, { method: "POST", body: JSON.stringify({ conversationId: threadId }) });
			assert(cancelled.status === 200, `Remember is cancelled, got ${cancelled.status}`);
			releaseNotes();
			await waitUntil(async () => (await json(`/api/persistent-agents/${rooms[room]}/checkpoint/progress?conversationId=${encodeURIComponent(threadId)}`)).body?.state !== "reading", "Remember has stopped");
			assert(calls.length === callsBefore, "the model is asked nothing");
			const after = (await stored(room)).items.map((item) => item.id);
			assert(before.every((id) => after.includes(id)), `the saved message and answer stay, got ${JSON.stringify(after)} for ${JSON.stringify(before)}`);
			await page.context().close();
			// The model still reads the message and its answer.
			const next = await enter(room);
			await ask(next, room, "And the tests?", "Done.");
			const sent = lastRequestWith("And the tests?")!;
			assert(sent.texts.some((text) => text.includes(ORIGINAL)) && sent.texts.some((text) => text.includes(OLD_ANSWER)), `the next request still reads the message and its answer, got ${JSON.stringify(sent.texts)}`);
			await next.context().close();
		});

		// --- The newest message was taken while the answer before it ran.
		await row("a message taken while the room answered dims its own answer while it is edited", async () => {
			const room = "Steer Room";
			legs = [{ held: true, tools: [{ name: "ls", args: { path: "." } }] }, { text: "Both are answered." }];
			const page = await enter(room);
			await composer(page).fill("List the folder.");
			await page.locator("button.send-btn").click();
			await waitUntil(() => releaseHeld !== null, "the answer is held");
			await composer(page).fill("And read the notes.");
			await page.locator("button.send-btn").click();
			await waitUntil(async () => (await page.locator(".bubble-row.user.queued").count()) > 0, "the second message waits", 5000);
			releaseHeld!();
			releaseHeld = null;
			await answered(page, "Both are answered.");
			await waitUntil(async () => { const { items, inFlight } = await stored(room); return !inFlight && items.some((item) => item.text === "Both are answered."); }, "the answer is saved");
			assert(lastRequestWith("And read the notes.") !== undefined && calls.length >= 2, "the second message was taken into the running answer");
			assert(JSON.stringify(await userTexts(page)) === JSON.stringify(["List the folder.", "And read the notes."]), `both messages show, got ${JSON.stringify(await userTexts(page))}`);
			await clickEdit(page);
			await editBox(page).waitFor({ timeout: 5000 });
			const dimmed = page.locator(".transcript-turn.edit-dim-answer");
			assert((await dimmed.count()) === 1, "the answer below the edited message is dimmed");
			assert((await dimmed.getByText("Both are answered.").count()) === 1 && (await dimmed.getByText("List the folder.").count()) === 0, "it dims that answer, not the message before it");
			await page.locator(".bubble-edit-actions").getByRole("button", { name: "Cancel" }).click();
			await page.context().close();
		});

		// --- A scheduled run's prompt.
		await row("a scheduled run's prompt shows no pencil and the room refuses an edit of it, beside a message the person sent", async () => {
			const room = "Scheduled Room";
			legs = [{ text: "Plain answer." }];
			const page = await enter(room);
			await ask(page, room, "A plain message.", "Plain answer.");
			assert((await pencils(page).count()) === 1, "the person's own message has the pencil (the allowed neighbour)");
			const items = await settledItems(room);
			const { threadId } = await stored(room);
			await page.context().close();
			// A scheduled run's prompt and answer, as the run saves them, after the person's message.
			const scheduled = [...items, { kind: "user", id: "scheduled-user-smoke1", text: "Check the release date." }, { kind: "assistant", id: "scheduled-assistant-smoke1", text: "Friday." }];
			const saved = await json(`/api/persistent-agents/${rooms[room]}/threads/${encodeURIComponent(threadId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "unknown", items: scheduled }) });
			assert(saved.status === 200, `the scheduled exchange is saved, got ${saved.status}`);
			const reopened = await enter(room);
			await reopened.locator(".messages").getByText("Check the release date.").waitFor({ timeout: 10_000 });
			await readyDrawn(reopened);
			assert((await pencils(reopened).count()) === 0, "no pencil on the scheduled run's prompt");
			await reopened.context().close();
			const raw = await rawSocket(room, threadId);
			const callsBefore = calls.length;
			raw.send({ type: "prompt", text: "Edited.", id: "smokeSchedEdit1", shown: { text: "Edited.", files: [] }, edit: { replaces: "scheduled-user-smoke1", text: "A plain message." } });
			await waitUntil(() => raw.frames.some((frame) => frame.type === "edit_refused" || frame.type === "edit_applied"), "the room answers the edit");
			raw.close();
			const refusal = raw.frames.find((frame) => frame.type === "edit_refused");
			assert(refusal?.reason === "not-typed", `the edit is refused, got ${JSON.stringify(refusal)}`);
			assert(JSON.stringify(refusal.held) === "[]", `it carries no held message, so a window shows nothing new, got ${JSON.stringify(refusal)}`);
			assert(calls.length === callsBefore, "the model is asked nothing");
			const after = (await stored(room)).items.map((item) => item.id);
			assert(scheduled.every((item) => after.includes(item.id)), "everything saved stays");
		});

		// --- A shortening that started and shortened nothing.
		await row("a shortening that ends without shortening anything leaves the pencil on the newest message; one that shortens takes it away", async () => {
			const room = "Shortening Room";
			const page = await enter(room);
			// An answer whose usage is past the shortening line: the runtime starts a shortening as the turn ends, and this short conversation has nothing to cut.
			legs = [{ text: "Done.", promptTokens: 125_000 }];
			await ask(page, room, "A question near the limit.", "Done.");
			await waitUntil(() => (shorteningEnds.get(page) ?? 0) > 0, "the shortening ends", 20_000);
			await idle(page);
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			await newestBubble(page).hover();
			assert((await newestBubble(page).locator(".message-edit-user").count()) === 1, "the pencil shows: nothing was shortened");
			// A long answer, then one past the line again: this time the long answer is summarized.
			legs = [{ text: `Everything. ${"The release is on Friday. ".repeat(4000)}` }];
			await ask(page, room, "Tell me everything.", "Everything.");
			legs = [{ text: "Noted.", promptTokens: 125_000 }];
			await ask(page, room, "One more near the limit.", "Noted.");
			await waitUntil(() => (shorteningEnds.get(page) ?? 0) > 1, "the second shortening ends", 20_000);
			await idle(page);
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			await newestBubble(page).hover();
			assert((await pencils(page).count()) === 0, "no pencil once the conversation was shortened");
			await page.context().close();
		});

		// --- The input method's Enter in the edit box.
		await row("in the edit box, the Enter that confirms an input method's word sends nothing; a plain Enter sends", async () => {
			const room = "Typing Room";
			const page = await enter(room);
			await ask(page, room, "Translate the notes.", "Done.");
			await clickEdit(page);
			await editBox(page).fill("Translate the notes into Japanese.");
			const callsBefore = calls.length;
			// Safari ends a composition with an Enter whose keyCode is 229 and whose isComposing is already false.
			await editBox(page).evaluate((box) => {
				const enterKey = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
				Object.defineProperty(enterKey, "keyCode", { value: 229 });
				box.dispatchEvent(enterKey);
			});
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			assert((await editBox(page).count()) === 1 && calls.length === callsBefore, "the edit box stays open and nothing is sent");
			legs = [{ text: "Translated." }];
			await editBox(page).press("Enter");
			await answered(page, "Translated.");
			assert(JSON.stringify(await userTexts(page)) === JSON.stringify(["Translate the notes into Japanese."]), `a plain Enter sends the edit, got ${JSON.stringify(await userTexts(page))}`);
			await page.context().close();
		});

		// --- What moved the conversation on shows with the refusal. A room is open in one window at a time (the
		// second one gets Home), so the other window here is a socket into the room, sending what a window's page sends.
		/** What the room shows under its messages: the user messages, the queued ones, the refusal lines, and whether an answer runs. */
		const shownAfterRefusal = async (page: Page) => ({
			messages: await userTexts(page),
			queued: (await page.locator('.bubble-row.user.queued[data-held="true"] .bubble.user').allInnerTexts()).map((text) => text.trim()),
			lines: await page.locator(".system-line", { hasText: REFUSED }).count(),
			answering: (await page.locator(".stop-btn").count()) > 0,
		});
		await row("an edit refused because a message from another window is held shows that message at once, queued under the newest message, as the room opened again shows it", async () => {
			const room = "Moved Room";
			legs = [];
			const page = await enter(room);
			await ask(page, room, "Hello there.", "Done.");
			const { threadId } = await stored(room);
			await clickEdit(page);
			await editBox(page).fill("Hello again, with a fix.");
			const other = await rawSocket(room, threadId);
			other.send({ type: "hold", messages: [{ id: "other-held-1", text: "Also add the release date." }] });
			await waitUntil(() => readHeldMessages(rooms[room]!, threadId, agentsRoot).length === 1, "the other window's message is held");
			const callsBefore = calls.length;
			await page.locator(".bubble-edit-actions").getByRole("button", { name: "Send" }).click();
			await page.locator(".system-line", { hasText: REFUSED }).waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await composer(page).inputValue()) === "Hello again, with a fix.", "the text is in the message box", 5000);
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			const shown = await shownAfterRefusal(page);
			assert(JSON.stringify(shown) === JSON.stringify({ messages: ["Hello there."], queued: ["Also add the release date."], lines: 1, answering: false }), `the held message shows once, queued, and the rest once, got ${JSON.stringify(shown)}`);
			const queued = page.locator(".bubble-row.user.queued").first();
			assert((await queued.innerText()).includes("Queued"), "it says Queued");
			assert(await newestBubble(page).evaluate((newest, below) => !!(newest.compareDocumentPosition(below as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await queued.elementHandle()), "it is under the newest message");
			assert((await pencils(page).count()) === 0, "no pencil while it waits, as the room opened again shows");
			assert(calls.length === callsBefore, "the model is asked nothing");
			other.close();
			await page.context().close();
			const reopened = await enter(room);
			await readyDrawn(reopened);
			const again = await shownAfterRefusal(reopened);
			assert(JSON.stringify(again.messages) === JSON.stringify(shown.messages) && JSON.stringify(again.queued) === JSON.stringify(shown.queued), `the room opened again shows the same, got ${JSON.stringify(again)}`);
			await reopened.context().close();
		});

		await row("a message sent from the box while a refused edit is on its way still goes as the next message", async () => {
			const room = "Queued Room";
			legs = [];
			// The room's frames reach the page as sent, except that from the refusal on they wait until let go.
			let refusalHeld = false;
			const heldFrames: (() => void)[] = [];
			const page = await enter(room, false, (context) => context.routeWebSocket(/\/ws\?/, (ws) => {
				const upstream = ws.connectToServer();
				ws.onMessage((message) => upstream.send(message));
				upstream.onMessage((message) => {
					try { if (JSON.parse(String(message)).type === "edit_refused") refusalHeld = true; } catch {}
					if (refusalHeld) heldFrames.push(() => ws.send(message));
					else ws.send(message);
				});
			}));
			await ask(page, room, "Hello there.", "Done.");
			const { threadId } = await stored(room);
			await clickEdit(page);
			await editBox(page).fill("Hello again, with a fix.");
			holdMessages(rooms[room]!, threadId, [{ id: "other-held-2", text: "Also add the release date." }], agentsRoot);
			await page.locator(".bubble-edit-actions").getByRole("button", { name: "Send" }).click();
			await waitUntil(() => refusalHeld, "the refusal is on its way");
			legs = [{ text: "One more thing, answered." }];
			await composer(page).fill("One more thing.");
			await composer(page).press("Enter");
			await page.locator(".bubble-row.user.queued").filter({ hasText: "One more thing." }).waitFor({ timeout: 5000 });
			refusalHeld = false;
			for (const deliver of heldFrames.splice(0)) deliver();
			await page.locator(".system-line", { hasText: REFUSED }).waitFor({ timeout: 10_000 });
			await answered(page, "One more thing, answered.");
			const shown = await shownAfterRefusal(page);
			assert(JSON.stringify(shown) === JSON.stringify({ messages: ["Hello there.", "One more thing."], queued: ["Also add the release date."], lines: 1, answering: false }), `the box's message went next, the other window's waits, got ${JSON.stringify(shown)}`);
			assert(JSON.stringify(readHeldMessages(rooms[room]!, threadId, agentsRoot).map((message) => message.text)) === JSON.stringify(["Also add the release date."]), "the room holds only the other window's message");
			await page.context().close();
		});

		await row("an edit refused because another window's answer runs shows nothing new: no answer, no queued message, the message and the line once", async () => {
			const room = "Running Room";
			legs = [];
			const page = await enter(room);
			await ask(page, room, "Hello there.", "Done.");
			const { threadId } = await stored(room);
			await clickEdit(page);
			await editBox(page).fill("Hello again, with a fix.");
			const other = await rawSocket(room, threadId);
			legs = [{ held: true, text: "The long report." }];
			other.send({ type: "prompt", text: "Write the long report.", id: "otherPrompt1", shown: { text: "Write the long report.", files: [] } });
			await waitUntil(() => releaseHeld !== null, "the other window's answer runs");
			await page.locator(".bubble-edit-actions").getByRole("button", { name: "Send" }).click();
			await page.locator(".system-line", { hasText: REFUSED }).waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await composer(page).inputValue()) === "Hello again, with a fix.", "the text is in the message box", 5000);
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			const shown = await shownAfterRefusal(page);
			assert(JSON.stringify(shown) === JSON.stringify({ messages: ["Hello there."], queued: [], lines: 1, answering: false }), `nothing new shows, got ${JSON.stringify(shown)}`);
			assert((await page.locator(".messages").getByText("Working on it.").count()) === 0, "the other window's answer does not show here");
			releaseHeld!();
			releaseHeld = null;
			await waitUntil(async () => !(await stored(room)).inFlight, "the other window's answer lands");
			other.close();
			await page.context().close();
		});

		// The page offers no pencil where the step back refuses, so these reach the room on a socket: the lists they carry are what a window adds.
		await row("an edit the step back refuses carries no held message, so a window shows nothing new", async () => {
			const room = "Running Room";
			const { threadId, items } = await stored(room);
			const newest = [...items].reverse().find((item) => item.kind === "user");
			assert(newest?.text === "Write the long report.", `the other window's message is the newest, got ${JSON.stringify(newest?.text)}`);
			const raw = await rawSocket(room, threadId);
			raw.send({ type: "prompt", text: "Edited.", id: "smokeNotShown1", shown: { text: "Edited.", files: [] }, edit: { replaces: newest.id, text: "Not what it said." } });
			await waitUntil(() => raw.frames.some((frame) => frame.type === "edit_refused" || frame.type === "edit_applied"), "the room answers the edit");
			raw.close();
			const refusal = raw.frames.find((frame) => frame.type === "edit_refused");
			assert(refusal?.reason === "not-shown", `refused by the step back, got ${JSON.stringify(refusal)}`);
			assert(JSON.stringify(refusal.held) === "[]", `nothing waits to show, got ${JSON.stringify(refusal)}`);
		});

		// --- When the pencil does not show, and a refused edit.
		await row("no pencil while it answers, on an older message, with a file, after a shortening, or while a held message waits; a phone shows it at a finger's size", async () => {
			const room = "Rules Room";
			legs = [];
			const page = await enter(room);
			await ask(page, room, "First question.", "Done.");
			await ask(page, room, "Second question.", "Done.");
			assert((await pencils(page).count()) === 1 && (await newestBubble(page).locator(".message-edit-user").count()) === 1, "the pencil on the newest message only, not the older one");
			// While it answers.
			legs = [{ held: true, text: "Finished at last." }];
			await composer(page).fill("A slow one.");
			await page.locator("button.send-btn").click();
			await waitUntil(() => releaseHeld !== null, "the answer is held");
			await page.locator(".stop-btn").waitFor({ timeout: 5000 });
			assert((await pencils(page).count()) === 0, "no pencil while it answers");
			releaseHeld!();
			releaseHeld = null;
			await answered(page, "Finished at last.");
			assert((await pencils(page).count()) === 1, "the pencil is back once it is idle (the allowed neighbour)");
			// With a file.
			await page.locator(".composer-attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Friday.\n") });
			await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15_000 });
			await ask(page, room, "Read the file.", "Done.");
			assert((await pencils(page).count()) === 0, "no pencil on a message with a file");
			await ask(page, room, "A plain one after it.", "Done.");
			assert((await pencils(page).count()) === 1, "the pencil on the plain message after it (the allowed neighbour)");
			const { threadId } = await stored(room);
			await page.context().close();

			// A held message waits: no pencil until it is removed.
			holdMessages(rooms[room]!, threadId, [{ id: "smoke-held-1", text: "A message for later." }], agentsRoot);
			const held = await enter(room);
			await held.locator('.bubble-row.user.queued[data-held="true"]').waitFor({ timeout: 10_000 });
			assert((await pencils(held).count()) === 0, "no pencil while a held message waits");
			await held.locator(".bubble-row.user.queued").hover();
			await held.locator(".bubble-row.user.queued").getByRole("button", { name: "Remove" }).click();
			await waitUntil(async () => (await held.locator(".bubble-row.user.queued").count()) === 0, "the held message is removed", 5000);
			await waitUntil(async () => (await pencils(held).count()) === 1, "the pencil comes back once it is removed", 5000);

			// Refused: a held message arrives between the pencil and Send.
			await clickEdit(held);
			await editBox(held).fill("Is this still mine?");
			holdMessages(rooms[room]!, threadId, [{ id: "smoke-held-2", text: "Another message for later." }], agentsRoot);
			const callsBefore = calls.length;
			await held.locator(".bubble-edit-actions").getByRole("button", { name: "Send" }).click();
			await held.locator(".system-line", { hasText: REFUSED }).waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await composer(held).inputValue()) === "Is this still mine?", "the text is in the message box", 5000);
			assert(JSON.stringify((await userTexts(held)).slice(-1)) === JSON.stringify(["A plain one after it."]), `the message stays as it was, got ${JSON.stringify(await userTexts(held))}`);
			assert((await held.locator(".edit-dim-all, .edit-dim-answer").count()) === 0, "nothing stays dimmed");
			assert(calls.length === callsBefore, "the model is asked nothing");
			await held.context().close();
			const { dropHeldMessages } = await import("../src/held-messages-store.js");
			dropHeldMessages(rooms[room]!, threadId, ["smoke-held-2"], agentsRoot);

			// On a phone: under the newest message, without a hover, at least 44 px to tap.
			const phone = await enter(room, true);
			await phone.locator(".messages").getByText("A plain one after it.").waitFor({ timeout: 10_000 });
			const touchPencil = newestBubble(phone).locator(".message-edit-user");
			await touchPencil.waitFor({ timeout: 5000 });
			const tap = await touchPencil.boundingBox();
			assert(tap && tap.width >= 44 && tap.height >= 44, `the pencil is at least 44 px to tap, got ${JSON.stringify(tap)}`);
			assert(Number(await touchPencil.evaluate((el) => getComputedStyle(el).opacity)) > 0.4, "it shows without a hover");
			await touchPencil.tap();
			for (const name of ["Cancel", "Send"]) {
				const button = await phone.locator(".bubble-edit-actions").getByRole("button", { name }).boundingBox();
				assert(button && button.height >= 44, `${name} is at least 44 px tall to tap, got ${JSON.stringify(button)}`);
			}
			await phone.locator(".bubble-edit-actions").getByRole("button", { name: "Cancel" }).tap();
			await phone.context().close();

			// After a shortening: the room says so as it opens.
			const sessionFile = (() => {
				const found: string[] = [];
				const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".jsonl") && full.includes(rooms[room]!)) found.push(full); } };
				walk(agentsRoot);
				return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
			})();
			assert(sessionFile, "the room's session file is found");
			// A summary entry after the newest message, as a shortening writes it.
			const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const leaf = lines.at(-1);
			const firstKept = lines.find((line) => line.type === "message")?.id ?? leaf.id;
			fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "compaction", id: "smoke-compaction", parentId: leaf.id, timestamp: new Date().toISOString(), summary: "The conversation so far.", firstKeptEntryId: firstKept, tokensBefore: 1000 })}\n`);
			const shortened = await enter(room);
			await shortened.locator(".messages").getByText("A plain one after it.").waitFor({ timeout: 10_000 });
			await readyDrawn(shortened);
			assert((await pencils(shortened).count()) === 0, "no pencil after a shortening");
			await shortened.context().close();
		});

		// --- After a quit cut the answer. Last: it stops the server every other row runs on.
		// On Windows a stop is a forced kill, so no careful stop runs and no cut answer is landed.
		if (process.platform === "win32") console.log("  skip  after a quit cut its answer (no graceful stop on Windows)");
		else await row("after a quit cut its answer, an edit of that message carries no restart note, only the edited text", async () => {
			const room = "Restart Room";
			const page = await enter(room);
			// An answer the person stopped, so that the model's history still ends on a stopped answer once the edit steps back.
			legs = [{ held: true, text: "Never reached." }];
			await composer(page).fill("Tell me about the release.");
			await page.locator("button.send-btn").click();
			await waitUntil(() => releaseHeld !== null, "the first answer is held");
			await page.locator(".stop-btn").click();
			(releaseHeld as (() => void) | null)?.();
			releaseHeld = null;
			await idle(page);
			// The message whose answer the quit cuts.
			const cut = "Write the release notes.";
			legs = [{ held: true, text: "Never reached either." }];
			await composer(page).fill(cut);
			await page.locator("button.send-btn").click();
			await waitUntil(() => releaseHeld !== null, "the second answer is held");
			await waitUntil(async () => (await page.locator(".messages").getByText("Working on it.").count()) >= 2, "the second answer's words show");
			await stopSmokeServer(serverProcess);
			(releaseHeld as (() => void) | null)?.();
			releaseHeld = null;
			await page.context().close();
			await startServer();

			const reopened = await enter(room);
			await waitUntil(async () => (await reopened.locator(".messages").innerText()).replace(/\s+/g, " ").includes(STOP_CUT_ANSWER_SENTENCE), "the reopened room shows the answer the quit cut", 15_000);
			await readyDrawn(reopened);
			assert(serverStopNote(await settledItems(room)), "the saved conversation ends on the answer the quit cut, so a plain message would carry the restart note");
			const edited = "Write only the changelog.";
			legs = [{ text: "Here is the changelog." }];
			await sendEdit(reopened, edited, "Here is the changelog.");
			const sent = lastRequestWith(edited)!;
			const own = sent.userTexts.find((text) => text.includes(edited)) ?? "";
			assert(own === edited, `the model gets the edited text alone, with no restart note, got ${JSON.stringify(own)}`);
			assert(!sent.texts.some((text) => text.includes(cut) || text.includes(ANSWER_CUT_OFF_OPEN)), `the model no longer reads the replaced message or any note about its cut answer, got ${JSON.stringify(sent.texts)}`);
			await reopened.context().close();
		});

		// --- The first message after the restart, then its edit. It stops the server again.
		if (process.platform === "win32") console.log("  skip  an edit of the first message after a restart (no graceful stop on Windows)");
		else await row("an edit of the first message sent after a restart carries the restart note with the cut answer's saved words, then the edited text", async () => {
			const room = "Hello Room";
			const page = await enter(room);
			legs = [{ held: true, text: "Never reached." }];
			await composer(page).fill("Write the release notes.");
			await page.locator("button.send-btn").click();
			await waitUntil(() => releaseHeld !== null, "the answer is held");
			await waitUntil(async () => (await page.locator(".messages").getByText("Working on it.").count()) >= 1, "the answer's words show");
			await stopSmokeServer(serverProcess);
			(releaseHeld as (() => void) | null)?.();
			releaseHeld = null;
			await page.context().close();
			await startServer();

			const reopened = await enter(room);
			await waitUntil(async () => (await reopened.locator(".messages").innerText()).replace(/\s+/g, " ").includes(STOP_CUT_ANSWER_SENTENCE), "the reopened room shows the answer the quit cut", 15_000);
			await readyDrawn(reopened);
			const shown = serverStopNote(await settledItems(room))?.shown;
			assert(shown === "Working on it.", `the saved conversation ends on the cut answer's words, got ${JSON.stringify(shown)}`);
			const restartNote = { kind: "server-stop" as const, shown };
			legs = [{ text: "Hello." }];
			await ask(reopened, room, "Say hello", "Hello.");
			const typed = lastRequestWith("Say hello")!.userTexts.find((text) => text.includes("Say hello"));
			assert(typed === withAnswerNote(restartNote, "Say hello"), `the typed message goes with the restart note, got ${JSON.stringify(typed)}`);
			legs = [{ text: "Hi." }];
			await sendEdit(reopened, "Say hi", "Hi.");
			const sent = lastRequestWith("Say hi")!;
			const own = sent.userTexts.find((text) => text.includes("Say hi"));
			assert(own === withAnswerNote(restartNote, "Say hi"), `the edited message goes with the restart note as the typed one did, got ${JSON.stringify(own)}`);
			assert(!sent.texts.some((text) => text.includes("Say hello") || text.includes("Hello.")), `the model no longer reads the replaced message or its answer, got ${JSON.stringify(sent.texts)}`);
			await reopened.context().close();
		});
	} finally {
		await closeBrowser(browser);
	}
} catch (error) {
	failures.push(`setup: ${error instanceof Error ? error.message : String(error)}`);
	console.log(`  FAIL  setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	// Set inside the gateway's handler, which the compiler does not follow.
	(releaseHeld as (() => void) | null)?.();
	releaseNotes();
	try { gateway.close(); } catch {}
	await stopSmokeServer(serverProcess);
	if (failures.length) console.log(serverOutput.join("").split("\n").filter((line) => !line.includes("token=") && !line.includes('"level":30')).slice(-30).join("\n"));
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
if (failures.length) {
	console.log(`room edit last message smoke: ${failures.length} failed: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("room edit last message smoke: ok");
