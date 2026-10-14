// Typed text never fails: every place a person's own words reach the memory
// file, driven through the real routes of a spawned server with one synthetic
// provider, and every save read back from the file with the real parser.
//
// The surfaces: the Memorize card's edit and Move, the Review card's edit,
// Remember's three parts at Save, and the Memory pane's add, edit and move.
// Each case runs in a room of its own, so a case that breaks the file breaks
// only its own row: the table at the end says which case went red.
//
// After each save the file must hold every typed word in the note or part it
// was typed in, in order; the other notes, topics, ids and Remember parts as
// they were; the pane's list, the room's read and the budget must see the note
// whole; and saving the stored text again must change nothing. Then the second
// press: a Save, an add or an undo sent again after its answer was lost saves
// once and says what is true.
//
// Offline: one synthetic provider, no network.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 31000 + Math.floor(Math.random() * 9000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-hand-edit-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const MODEL = { provider: "fake-claude", model: "claude-fake" };

// --- The cases ----------------------------------------------------------------

const L = "- Exam facts:";
const T = "- Book the date.";
const CARD_MAX = 2000;
const PANE_MAX = 20_000;
const PAGE_MAX = 8000;

/** Words of exactly `n` characters, no trailing space. */
function wordsOf(n: number, head = "- "): string {
	let out = head;
	while (out.length < n) out += "word ";
	return out.slice(0, n).replace(/ $/, "x");
}

const CHAT_ANSWER = [
	"## Plan for the exam", "", "Here is what to do:", "", "- Book the date.", "- Pay the fee.", "",
	"| Step | When |", "|---|---|", "| Book | May |", "",
	"```bash", "# check the portal", "open https://example.org", "```", "", "---", "", "### After the exam", "Send the results.",
].join("\n");
const CHAT_STORED = [
	"**Plan for the exam**", "", "Here is what to do:", "", "- Book the date.", "- Pay the fee.", "",
	"| Step | When |", "|---|---|", "| Book | May |", "",
	"```bash", "**check the portal**", "open https://example.org", "```", "", "---", "", "**After the exam**", "Send the results.",
].join("\n");

interface Case {
	name: string;
	typed: string;
	/** What the note or the part stores. */
	stored: string;
	/** The must-keep case: the note is pinned and the marker leaves its words; a part keeps it as typed. */
	pins?: boolean;
	part?: string;
	/** What a card edit stores where it differs: the card keeps a typed must-keep marker, by design (L7). */
	card?: string;
}

/** A case as a card edit stores it. */
const onCard = (c: Case): Case => (c.card ? { ...c, stored: c.card } : c);
const BOOKING = `${L}\n**Booking**\n${T}`;
const CASES: Case[] = [
	{ name: "# line", typed: `${L}\n# Booking\n${T}`, stored: BOOKING },
	{ name: "## line", typed: `${L}\n## Booking\n${T}`, stored: BOOKING },
	{ name: "### line", typed: `${L}\n### Booking\n${T}`, stored: BOOKING },
	{ name: "#### line", typed: `${L}\n#### Booking\n${T}`, stored: BOOKING },
	{ name: "## alone", typed: `${L}\n##\nBooking\n${T}`, stored: `${L}\nBooking\n${T}` },
	{ name: "indented ###", typed: `${L}\n  ### Booking\n${T}`, stored: BOOKING },
	{ name: "U+2028 then ###", typed: `${L}\u2028### Booking\n${T}`, stored: BOOKING },
	{ name: "U+2029 then ###", typed: `${L}\u2029### Booking\n${T}`, stored: BOOKING },
	{ name: "U+0085 then ###", typed: `${L}\u0085### Booking\n${T}`, stored: BOOKING },
	{ name: "CRLF and ##", typed: `${L}\r\n## Booking\r\n${T}`, stored: BOOKING },
	{ name: "pasted metadata comment", typed: `${L}\n<!-- e: id=m-0002 kind=fact saved=2026-09-01 -->\n${T}`, stored: `${L}\ne: id=m-0002 kind=fact saved=2026-09-01\n${T}` },
	{ name: "counter comment", typed: `${L}\n<!-- entries: next=900 -->\n${T}`, stored: `${L}\nentries: next=900\n${T}` },
	{ name: "pasted rc_metadata comment", typed: `${L}\n<!-- rc_metadata: checkpoint_id=cp_1; session_id=s_1 -->\n${T}`, stored: `${L}\nrc_metadata: checkpoint_id=cp_1; session_id=s_1\n${T}` },
	{ name: "comment mid-line", typed: `${L} <!-- e: id=m-0002 --> kept\n${T}`, stored: `${L} e: id=m-0002 kept\n${T}` },
	{ name: "**Session arc:** at a line start", typed: `${L}\n**Session arc:** typed arc\n${T}`, stored: `${L}\nSession arc: typed arc\n${T}` },
	{ name: "**Session arc**: mid-line", typed: `${L} see **session arc**: here\n${T}`, stored: `${L} see session arc: here\n${T}` },
	{ name: "**Body:** mid-line", typed: `${L} see **Body:** here\n${T}`, stored: `${L} see Body: here\n${T}` },
	{ name: "**Body**: at a line start", typed: `${L}\n**Body**:\n- typed keep\n${T}`, stored: `${L}\nBody:\n- typed keep\n${T}` },
	{ name: "**PARKED**: at a line start", typed: `${L}\n**PARKED**:\n- typed open\n${T}`, stored: `${L}\nPARKED:\n- typed open\n${T}` },
	{ name: "**Parked:** mid-line", typed: `${L} and **Parked:** this\n${T}`, stored: `${L} and Parked: this\n${T}` },
	{ name: "a heading of a marker: ## Body:", typed: `${L}\n## Body:\n${T}`, stored: `${L}\nBody:\n${T}` },
	{ name: "a heading of a marker: ## must-keep", typed: `${L}\n## must-keep\n${T}`, stored: `${L}\nmust-keep\n${T}` },
	{ name: "[m-0101]", typed: `${L} [m-0101] stays\n${T}`, stored: `${L} [m-0101] stays\n${T}` },
	{ name: "RC-DRAFT typed", typed: `${L} the RC-DRAFT heading\n${T}`, stored: `${L} the RC-DRAFT heading\n${T}` },
	{ name: "checkpoint_id = none typed", typed: `${L} checkpoint_id = none\n${T}`, stored: `${L} checkpoint_id = none\n${T}` },
	{ name: "Keep:", typed: `- Keep: the receipts\n${T}`, stored: `- Keep: the receipts\n${T}` },
	{ name: "typed must-keep", typed: `- **must-keep** the receipts\n${T}`, stored: `- the receipts\n${T}`, part: `- **must-keep** the receipts\n${T}`, card: `- **must-keep** the receipts\n${T}`, pins: true },
	{ name: "chat answer pasted whole", typed: CHAT_ANSWER, stored: CHAT_STORED },
];
const EMPTY_CASES = [
	{ name: "empty", typed: "" },
	{ name: "\"- \" alone", typed: "- " },
	{ name: "marks only", typed: "### " },
	{ name: "marks only (bullet and bold)", typed: "- **" },
];

// --- The results table ----------------------------------------------------------

const rows: Array<{ surface: string; name: string; ok: boolean; detail: string }> = [];
async function check(surface: string, name: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
		rows.push({ surface, name, ok: true, detail: "" });
	} catch (error) {
		rows.push({ surface, name, ok: false, detail: (error as Error).message.slice(0, 400) });
	}
}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const lines = (text: string) => text.split(/\r\n|[\n\r\u2028\u2029]/).join("\n");

// --- The provider ----------------------------------------------------------------

const REMEMBER_REPLY = "TITLE:\nThe exam plan\n\nSESSION_ARC:\nWe planned the exam.\n\nBODY:\n- The exam is in May.\n\nPARKED:\n- The fee is still unpaid.\n";
const MEMORIZE_FIRST_READ = "## Absorb assessment\n\nI found 1 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n\n- The exam notes.\n\n### What to forget\n\n- The small talk.\n\n### What changes in stable memory\n\n- Deep Memory: the exam notes.\n\n### Needs your judgment\n\n- None\n";

function foldReply(): string {
	const ops = [
		{ op: "add", topic: "Exam booking", kind: "fact", text: "- Fold note alpha about the exam room." },
		{ op: "add", topic: "Exam booking", kind: "fact", text: "- Fold note beta about the exam fee." },
	];
	return `Two exam notes.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`;
}

/** The tidy rewrites every note of the group it is given. */
function tidyReply(prompt: string): string {
	const material = prompt.split(/\n\n---\n\n/).find((part) => part.trimStart().startsWith("## Material: The Notes To Tidy")) ?? "";
	const ids = material.split("\n").map((line) => /^(?:\s*[-*]\s+)?\[([^\]\s·]+)\]/.exec(line.trim())?.[1]).filter((id): id is string => Boolean(id));
	const ops = ids.map((id, n) => ({ op: "update", id, text: `- Tidied note ${n === 0 ? "alpha" : n === 1 ? "beta" : `n${n}`} about the exam.` }));
	return `Shorter.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`;
}

function replyFor(prompt: string): string {
	if (prompt.includes("Checkpoint Compression Constitution")) return REMEMBER_REPLY;
	if (prompt.includes("## Task: Tidy These Notes")) return tidyReply(prompt);
	if (prompt.includes("## Task: Compact Initial Assessment")) return MEMORIZE_FIRST_READ;
	if (prompt.includes("## Task: Fold This Session Into Memory")) return foldReply();
	if (prompt.includes("For each note")) return "m-0101: Billing";
	if (prompt.includes("Answer with the one title")) return "Billing";
	return "Answer from claude-fake.";
}

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

let providerCalls = 0;
const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const words = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(words).join("\n") : value && typeof value === "object" ? words((value as { text?: unknown; content?: unknown }).text ?? (value as { content?: unknown }).content) : "";
		const text = replyFor(`${words(body.system)}\n${words(body.messages)}`);
		providerCalls++;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: `msg_${providerCalls}`, type: "message", role: "assistant", model: String(body.model), content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});

// --- Requests ---------------------------------------------------------------------

async function api(pathname: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
	const text = await response.text();
	let parsed: any = null;
	try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
	return { status: response.status, body: parsed };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function pollRun(url: string, working: string[]): Promise<any> {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const polled = await api(url);
		if (polled.status !== 200) throw new Error(`${url} answered ${polled.status}: ${JSON.stringify(polled.body).slice(0, 200)}`);
		if (!working.includes(String(polled.body.state))) return polled.body;
		if (Date.now() > deadline) throw new Error(`${url} stayed ${polled.body.state}`);
		await sleep(250);
	}
}

let server: ChildProcessWithoutNullStreams | undefined;
const afterRestart: Array<{ label: string; url: string; body: unknown; saveId: string; l1bPath?: string; newTopics?: number }> = [];
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const entries = await import("../src/memory-entries.js");
	const summary = await import("../src/absorb-summary.js");

	const note = (id: string, text: string) => `<!-- e: id=${id} kind=fact saved=2026-09-01 -->\n${text}\n`;
	const page = (id: string) => [`### ${id} | CLOSED | 2026-09-11 | The exam call`, "", "**Session arc:** We went through the exam.", "", "**Body:**", "- The exam is in May.", "", "**Parked:**", "None", ""].join("\n");
	/** A room with two topics and several notes, an open item, and the given pages waiting. */
	const createRoom = (name: string, opts: { pages?: string[]; unsorted?: boolean; conversation?: boolean; prepared?: boolean; noExamTopic?: boolean } = {}) => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: MODEL, memory: MODEL });
		const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
		const head = fs.readFileSync(l1bPath, "utf-8");
		const chronos = /^## Chronos[\s\S]*?(?=^## )/m.exec(head)?.[0] ?? "";
		const deep = [
			"## Deep Memory", "", "<!-- entries: next=200 -->", "",
			"### Billing", "", note("m-0011", "- Invoices go out on the first."), note("m-0012", "- Late invoices get a reminder."),
			...(opts.noExamTopic ? [] : ["### Exam booking", "", note("m-0021", "- The exam portal opens in March."), note("m-0022", "- Alpha note: the exam room is booked."), note("m-0023", "- Beta note: the exam fee is 90 euros.")]),
			...(opts.unsorted ? ["### Unsorted", "", note("m-0101", "- Invoices are sent by email."), ""] : []),
			"## Active Items", "", "<!-- e: id=m-0031 kind=item saved=2026-09-01 status=open -->", "- Send the draft to legal.", "",
			"## Recent Context", "", ...(opts.pages ?? []),
		].join("\n");
		fs.writeFileSync(l1bPath, `<!-- exxeta:l1b schema_version=1 -->\n\n${chronos}${deep}\n`, "utf-8");
		if (opts.conversation) {
			const written = agents.writePersistentAgentThread(agentId, "pi_exam_0001", { state: "active", origin: "home", model: MODEL, items: [{ kind: "user", id: "u1", text: "When is the exam?" }, { kind: "assistant", id: "a1", text: "In May." }] }, {
				createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: "pi_exam_0001", model, cwd: tempRoot }),
			});
			agents.openPersistentAgentPiSessionManager(agentId, written.thread.runtime as any, tempRoot).appendMessage({ role: "user", content: "When is the exam? We agreed it is in May.", timestamp: Date.now() });
		}
		// An empty conversation a Remember prepared: open, never started.
		if (opts.prepared) agents.writePersistentAgentThread(agentId, "prepared_0001", { state: "standby", origin: "checkpoint", model: MODEL, items: [] });
		return { agentId, l1bPath };
	};

	// One room per case per surface, made before the server starts.
	const rooms = {
		memorize: CASES.map((c) => createRoom(`Memorize ${c.name}`, { pages: [page("RC-0001")] })),
		memorizeRefused: createRoom("Memorize refused", { pages: [page("RC-0001")] }),
		memorizeTwice: createRoom("Memorize twice", { pages: [page("RC-0001")] }),
		// Its update makes a new topic: the answer after a restart counts it as the first did.
		memorizeRestart: createRoom("Memorize restart", { pages: [page("RC-0001")], noExamTopic: true }),
		memorizeMove: createRoom("Memorize move", { pages: [page("RC-0001")], unsorted: true, noExamTopic: true }),
		review: CASES.map((c) => createRoom(`Review ${c.name}`)),
		reviewRefused: createRoom("Review refused"),
		reviewTwice: createRoom("Review twice"),
		remember: CASES.map((c) => createRoom(`Remember ${c.name}`, { conversation: true })),
		rememberRefused: [...EMPTY_CASES, { name: "one over the limit", typed: "" }].map((c) => createRoom(`Remember refused ${c.name}`, { conversation: true })),
		rememberLimit: createRoom("Remember at the limit", { conversation: true }),
		rememberEmptied: createRoom("Remember Still open emptied", { conversation: true }),
		paneAdd: CASES.map((c) => createRoom(`Pane add ${c.name}`)),
		paneEdit: CASES.map((c) => createRoom(`Pane edit ${c.name}`)),
		paneRefused: createRoom("Pane refused"),
		paneTopics: createRoom("Pane topics"),
		paneRename: createRoom("Pane rename"),
		paneTwice: createRoom("Pane twice"),
		paneManyRecords: createRoom("Pane many records"),
		openConversation: createRoom("Open conversation", { pages: [page("RC-0001")], conversation: true }),
		noConversation: createRoom("No conversation"),
		preparedOnly: createRoom("Prepared only", { prepared: true }),
		paneArchiveTwice: createRoom("Pane archive twice"),
		memorizeNewerRun: createRoom("Memorize newer run", { pages: [page("RC-0001")], conversation: true }),
	};

	async function startServer(): Promise<void> {
		server = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		});
		server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		const deadline = Date.now() + 60_000;
		while (!(await fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false))) {
			if (Date.now() > deadline) throw new Error("the server did not start");
			await sleep(150);
		}
	}
	await startServer();

	// --- The file as the readers see it ------------------------------------------------

	type Doc = ReturnType<typeof entries.parseMemoryDocument>;
	const read = (l1bPath: string): Doc => entries.parseMemoryDocument(fs.readFileSync(l1bPath, "utf-8"));
	const notesOf = (doc: Doc) => new Map(doc.topics.flatMap((topic) => topic.entries.map((entry) => [entry.id, { topic: topic.title, section: topic.section, text: lines(entry.text), pinned: entry.pinned }])));
	const topicsOf = (doc: Doc) => doc.topics.map((topic) => `${topic.section}/${topic.title}`).join(" | ");

	/**
	 * The file after a save: the saved note holds the expected words under its
	 * topic; every other note, topic and id is as `before` says; the pane's
	 * list and the room's read see the note whole; the budget counts it.
	 */
	async function checkSaved(agentId: string, l1bPath: string, id: string, expected: Case, before: Map<string, { topic: string; section: string; text: string; pinned: boolean }>, expectedTopics: string, prefix = ""): Promise<void> {
		const doc = read(l1bPath);
		const got = notesOf(doc);
		const want = `${prefix}${expected.stored}`;
		assert(topicsOf(doc) === expectedTopics, `the topics are as they were, got ${JSON.stringify(topicsOf(doc))}, want ${JSON.stringify(expectedTopics)}`);
		assert(got.get(id)?.text === want, `the note holds the typed words, got ${JSON.stringify(got.get(id)?.text)}, want ${JSON.stringify(want)}`);
		if (!expected.card) assert(Boolean(got.get(id)?.pinned) === Boolean(expected.pins), expected.pins ? "the typed must-keep pins the note" : "the note is not pinned by anything typed");
		assert(got.size === before.size, `no note is added or lost, got ${got.size} notes, want ${before.size}`);
		for (const [otherId, other] of before) {
			if (otherId === id) continue;
			const now = got.get(otherId);
			assert(now && now.text === other.text && now.topic === other.topic, `${otherId} is as it was, got ${JSON.stringify(now)}, want ${JSON.stringify(other)}`);
		}
		const pane = await api(`/api/persistent-agents/${agentId}/memory/entries`);
		const paneNote = (pane.body?.topics ?? []).flatMap((topic: any) => (topic.entries ?? []).map((entry: any) => ({ ...entry, topic: topic.title }))).find((entry: any) => entry.id === id);
		assert(paneNote && lines(String(paneNote.text)) === want, `the pane's list shows the note whole, got ${JSON.stringify(paneNote?.text)}`);
		const context = entries.renderMemoryDocument(doc, "context");
		assert(context.includes(want.split("\n").join(entries.memoryDocumentEol(doc))), "the room's read holds the note whole");
		assert(topicsOf(entries.parseMemoryDocument(context)) === expectedTopics, "the room's read has the same topics");
		const budget = pane.body?.budget?.reviewTargetTokens;
		assert(typeof budget === "number" && budget === entries.reviewTargetTokens(doc), `the budget counts the file as written, got ${budget}`);
		// The second save of the stored text changes nothing. A card's kept must-keep marker pins on the pane's save, by design.
		if (expected.card) return;
		const stored = got.get(id)!.text;
		const again = await api(`/api/persistent-agents/${agentId}/memory/entries/${id}`, "PUT", { text: stored });
		assert(again.status === 200, `saving the stored text again is accepted, got ${again.status} ${JSON.stringify(again.body)}`);
		const after = notesOf(read(l1bPath));
		assert(after.get(id)?.text === stored && topicsOf(read(l1bPath)) === expectedTopics && after.size === got.size, `saving the stored text again changes nothing, got ${JSON.stringify(after.get(id)?.text)}`);
	}

	// --- 1. The Memorize card's edit ----------------------------------------------------

	async function readyMemorizeRun(agentId: string): Promise<{ runId: string; run: any }> {
		const assessed = await api(`/api/persistent-agents/${agentId}/absorb/assess`, "POST", {});
		assert(assessed.status === 200, `the first read answers, got ${assessed.status} ${JSON.stringify(assessed.body).slice(0, 200)}`);
		const proposed = await api(`/api/persistent-agents/${agentId}/absorb/propose`, "POST", { assessmentMarkdown: assessed.body.assessmentMarkdown });
		assert(proposed.status === 202, `Memorize starts, got ${proposed.status} ${JSON.stringify(proposed.body).slice(0, 200)}`);
		const runId = String(proposed.body.runId);
		const run = await pollRun(`/api/persistent-agents/${agentId}/absorb/runs/${runId}`, ["prepass", "folding", "budget"]);
		assert(run.state === "ready", `the run is ready, got ${run.state} ${JSON.stringify(run.error ?? "")}`);
		return { runId, run };
	}
	const addedIds = (run: any) => (run.sessions ?? []).flatMap((session: any) => session.changes ?? []).filter((change: any) => change.kind === "added").map((change: any) => change.id as string);
	const MEMORIZE_TOPICS = "Deep Memory/Billing | Deep Memory/Exam booking | Active Items/Active Items";

	await Promise.all(CASES.map((c, n) => check("Memorize card edit", c.name, async () => {
		const { agentId, l1bPath } = rooms.memorize[n];
		const { runId, run } = await readyMemorizeRun(agentId);
		const [first] = addedIds(run);
		assert(first, `the fold added notes, got ${JSON.stringify(run.sessions)}`);
		const edited = await api(`/api/persistent-agents/${agentId}/absorb/runs/${runId}/edit`, "POST", { entryId: first, text: c.typed });
		assert(edited.status === 200, `the edit is accepted, got ${edited.status} ${JSON.stringify(edited.body)}`);
		const saved = await api(`/api/persistent-agents/${agentId}/absorb/approve`, "POST", { runId });
		assert(saved.status === 200, `Save writes, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		// What the file must hold: the source's notes, the fold's other note as it wrote it, and the edit.
		const before = notesOf(entries.parseMemoryDocument(fs.readFileSync(l1bPath, "utf-8")));
		const card = (run.sessions ?? []).flatMap((session: any) => session.changes ?? []);
		for (const change of card) if (change.kind === "added" && change.id !== first) before.set(change.id, { topic: "Exam booking", section: "Deep Memory", text: lines(change.after), pinned: false });
		const prefix = /^[-*]\s/.test(c.typed.trim()) ? "" : "- ";
		await checkSaved(agentId, l1bPath, first, onCard(c), before, MEMORIZE_TOPICS, prefix);
	})));

	// --- 2. The Review card's edit ------------------------------------------------------

	async function readyReviewRun(agentId: string): Promise<{ runId: string; run: any }> {
		const started = await api(`/api/persistent-agents/${agentId}/review/runs`, "POST", { depth: "tidy", topics: ["Exam booking"] });
		assert(started.status === 202, `Review starts, got ${started.status} ${JSON.stringify(started.body).slice(0, 200)}`);
		const runId = String(started.body.runId);
		const run = await pollRun(`/api/persistent-agents/${agentId}/review/runs/${runId}`, ["tidying", "budget", "prepass", "running", "assessing"]);
		assert(run.state === "ready", `the review is ready, got ${run.state} ${JSON.stringify(run.error ?? "")}`);
		return { runId, run };
	}
	const REVIEW_TOPICS = MEMORIZE_TOPICS;

	await Promise.all(CASES.map((c, n) => check("Review card edit", c.name, async () => {
		const { agentId, l1bPath } = rooms.review[n];
		const { runId, run } = await readyReviewRun(agentId);
		const rewritten = (run.changes ?? []).filter((change: any) => change.kind === "shortened" || change.kind === "merged");
		const target = rewritten.find((change: any) => change.id === "m-0022") ?? rewritten[0];
		assert(target, `the tidy rewrote notes, got ${JSON.stringify(run.changes)}`);
		const edited = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}/edit`, "POST", { entryId: target.id, text: c.typed });
		assert(edited.status === 200, `the edit is accepted, got ${edited.status} ${JSON.stringify(edited.body)}`);
		const before = notesOf(read(l1bPath));
		for (const change of rewritten) if (change.id !== target.id) before.set(change.id, { ...before.get(change.id)!, text: lines(change.after) });
		const saved = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}/approve`, "POST", {});
		assert(saved.status === 200, `Save writes, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		const prefix = /^[-*]\s/.test(c.typed.trim()) ? "" : "- ";
		await checkSaved(agentId, l1bPath, target.id, onCard(c), before, REVIEW_TOPICS, prefix);
	})));

	// --- 3. The cards' refusals and their length limits -------------------------------------

	await check("Memorize card edit", "empty, marks only, the limit and one over", async () => {
		const { agentId } = rooms.memorizeRefused;
		const { runId, run } = await readyMemorizeRun(agentId);
		const [first] = addedIds(run);
		for (const c of EMPTY_CASES) {
			const refused = await api(`/api/persistent-agents/${agentId}/absorb/runs/${runId}/edit`, "POST", { entryId: first, text: c.typed });
			assert(refused.status === 400 && /cannot be empty/.test(String(refused.body?.error)), `${c.name} is refused with the card's sentence, got ${refused.status} ${JSON.stringify(refused.body)}`);
		}
		const atLimit = await api(`/api/persistent-agents/${agentId}/absorb/runs/${runId}/edit`, "POST", { entryId: first, text: wordsOf(CARD_MAX) });
		assert(atLimit.status === 200, `a note of ${CARD_MAX} characters is accepted, got ${atLimit.status} ${JSON.stringify(atLimit.body)}`);
		const over = await api(`/api/persistent-agents/${agentId}/absorb/runs/${runId}/edit`, "POST", { entryId: first, text: wordsOf(CARD_MAX + 1) });
		assert(over.status === 400 && String(over.body?.error).includes(String(CARD_MAX).replace(/\B(?=(\d{3})+$)/g, ",")) || over.status === 400 && String(over.body?.error).includes(String(CARD_MAX)), `one over the limit is refused with the limit named, got ${over.status} ${JSON.stringify(over.body)}`);
	});
	await check("Review card edit", "empty, marks only, the limit and one over", async () => {
		const { agentId } = rooms.reviewRefused;
		const { runId, run } = await readyReviewRun(agentId);
		const target = (run.changes ?? []).find((change: any) => change.kind === "shortened" || change.kind === "merged");
		for (const c of EMPTY_CASES) {
			const refused = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}/edit`, "POST", { entryId: target.id, text: c.typed });
			assert(refused.status === 400 && /cannot be empty/.test(String(refused.body?.error)), `${c.name} is refused with the card's sentence, got ${refused.status} ${JSON.stringify(refused.body)}`);
		}
		const atLimit = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}/edit`, "POST", { entryId: target.id, text: wordsOf(CARD_MAX) });
		assert(atLimit.status === 200, `a note of ${CARD_MAX} characters is accepted, got ${atLimit.status} ${JSON.stringify(atLimit.body)}`);
		const over = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}/edit`, "POST", { entryId: target.id, text: wordsOf(CARD_MAX + 1) });
		assert(over.status === 400 && /2,?000/.test(String(over.body?.error)), `one over the limit is refused with the limit named, got ${over.status} ${JSON.stringify(over.body)}`);
	});

	// --- 4. The Memorize card's Move: typed topic names ------------------------------------

	await check("Memorize card Move", "topic names", async () => {
		const { agentId, l1bPath } = rooms.memorizeMove;
		const { runId, run } = await readyMemorizeRun(agentId);
		const sorted = (run.sorted ?? [])[0];
		assert(sorted?.id === "m-0101", `the one-time sort placed the note, got ${JSON.stringify(run.sorted)}`);
		const move = (topic: string) => api(`/api/persistent-agents/${agentId}/absorb/runs/${runId}/move`, "POST", { entryId: sorted.id, topic });
		const topicNow = (body: any) => (body?.sorted ?? []).find((row: any) => row.id === sorted.id)?.topic;
		const failures: string[] = [];
		// Move's list: the topics this update saves, the one its fold creates included, never Unsorted.
		const listed = [...(run.topics ?? [])].sort().join(", ");
		if (listed !== "Billing, Exam booking") failures.push(`the run lists the topics it saves, got ${JSON.stringify(run.topics)}`);
		for (const [typed, want] of [["Billing\nTerms", "Billing Terms"], ["Billing\u2028Terms", "Billing Terms"], ["C# tips", "C# tips"]] as const) {
			const moved = await move(typed);
			if (moved.status !== 200 || topicNow(moved.body) !== want) failures.push(`${JSON.stringify(typed)} moves to ${JSON.stringify(want)}, got ${moved.status} ${JSON.stringify(topicNow(moved.body) ?? moved.body?.error)}`);
		}
		for (const typed of ["## Payment terms", "Active Items"]) {
			const refused = await move(typed);
			if (refused.status !== 400 || !refused.body?.error || /[#<>]/.test(String(refused.body.error)) && typed === "Active Items") failures.push(`${JSON.stringify(typed)} is refused with its own sentence, got ${refused.status} ${JSON.stringify(refused.body?.error ?? topicNow(refused.body))}`);
		}
		const last = await move("Payment terms");
		assert(last.status === 200, `a plain name moves, got ${last.status}`);
		if (!(last.body?.topics ?? []).includes("Payment terms")) failures.push(`a topic a Move creates joins the list, got ${JSON.stringify(last.body?.topics)}`);
		const saved = await api(`/api/persistent-agents/${agentId}/absorb/approve`, "POST", { runId });
		assert(saved.status === 200, `Save writes, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		const doc = read(l1bPath);
		const moved = notesOf(doc).get("m-0101");
		if (moved?.topic !== "Payment terms" || moved.section !== "Deep Memory") failures.push(`the note is under its typed topic, got ${JSON.stringify(moved)}`);
		assert(failures.length === 0, failures.join("; "));
	});

	// --- 5. Remember's three parts at Save --------------------------------------------------

	/** A Remember proposal for the room's open conversation, as the page asks for one. */
	async function rememberProposal(agentId: string): Promise<any> {
		const conversationId = "pi_exam_0001";
		const asked = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, "POST", { conversationId, density: "standard", rememberText: "", background: true, items: [{ kind: "user", id: "u1", text: "When is the exam?" }, { kind: "assistant", id: "a1", text: "In May." }] });
		assert(asked.status === 200 || asked.status === 202, `Remember starts, got ${asked.status} ${JSON.stringify(asked.body).slice(0, 200)}`);
		const deadline = Date.now() + 60_000;
		for (;;) {
			const progress = await api(`/api/persistent-agents/${agentId}/checkpoint/progress?conversationId=${conversationId}`);
			if (progress.body?.state && progress.body.state !== "reading") break;
			if (Date.now() > deadline) throw new Error("Remember kept reading");
			await sleep(250);
		}
		const result = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${conversationId}`);
		assert(result.status === 200 && result.body?.proposedRecentContext, `Remember has a proposal, got ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
		return result.body;
	}
	type Parts = { sessionArc: string; body: string; parked: string };
	/** The page as the page assembled it before this change, kept so the request reads the same on the base. */
	function pageOf(proposal: any, fields: Parts): string {
		const heading = String(proposal.proposedRecentContext).split(/\r?\n/)[0].trim().replace(/\|\s*(OPEN|CLOSED)\s*\|/, `| ${fields.parked.trim() ? "OPEN" : "CLOSED"} |`);
		const arc = fields.sessionArc.trim() ? `**Session arc:** ${fields.sessionArc.trim()}\n\n` : "";
		return `${heading}\n\n${arc}**Body:**\n${fields.body.trim()}\n\n**Parked:**\n${fields.parked.trim() || "None"}\n`;
	}
	const save = (agentId: string, proposal: any, fields: Parts) => api(`/api/persistent-agents/${agentId}/checkpoint/approve`, "POST", {
		conversationId: proposal.conversationId,
		model: MODEL,
		density: proposal.density,
		proposal,
		approvedRecentContext: pageOf(proposal, fields),
		approvedFields: fields,
	});
	/** The newest page's parts, read by their labels the way the readers find them. */
	const FIELD_LABEL = /^\s*\*\*(Session arc|Body|Parked)(?::\*\*|\*\*:)\s*(.*)$/i;
	function pagesIn(l1b: string): string[] {
		const recent = l1b.slice(l1b.search(/^## Recent Context\s*$/m));
		return recent.split(/^(?=### RC-)/m).filter((block) => block.startsWith("### RC-"));
	}
	function partsOf(pageText: string): { labels: string[]; parts: Record<string, string> } {
		const labels: string[] = [];
		const parts: Record<string, string[]> = {};
		let current: string[] | null = null;
		for (const line of pageText.split(/\r\n|[\n\r\u2028\u2029]/).slice(1)) {
			const label = FIELD_LABEL.exec(line);
			if (label) {
				const name = label[1].toLowerCase();
				labels.push(name);
				current = parts[name] = label[2].trim() ? [label[2]] : [];
				continue;
			}
			if (/^<!--\s*rc_metadata:/.test(line)) continue;
			current?.push(line);
		}
		return { labels, parts: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, value.join("\n").trim()])) };
	}
	const deepOf = (l1b: string) => l1b.slice(l1b.search(/^## Deep Memory\s*$/m), l1b.search(/^## Recent Context\s*$/m));

	await Promise.all(CASES.map((c, n) => check("Remember parts", c.name, async () => {
		const { agentId, l1bPath } = rooms.remember[n];
		const proposal = await rememberProposal(agentId);
		const beforeL1b = fs.readFileSync(l1bPath, "utf-8");
		const fields = { sessionArc: `Arc words.\n${c.typed}`, body: `- Keep words.\n${c.typed}`, parked: `- Open words.\n${c.typed}` };
		const saved = await save(agentId, proposal, fields);
		assert(saved.status === 200, `Save writes, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		const l1b = fs.readFileSync(l1bPath, "utf-8");
		assert(deepOf(l1b) === deepOf(beforeL1b), "the notes and open items are as they were");
		const pages = pagesIn(l1b);
		assert(pages.length === 1, `one page, got ${pages.length}: ${JSON.stringify(pages.map((p) => p.split("\n")[0]))}`);
		const { labels, parts } = partsOf(pages[0]);
		assert(labels.join(",") === "session arc,body,parked", `the page has its three parts once each, in order, got ${JSON.stringify(labels)}`);
		const want = c.part ?? c.stored;
		const got = { arc: lines(parts["session arc"] ?? ""), body: lines(parts.body ?? ""), parked: lines(parts.parked ?? "") };
		assert(got.arc === lines(`Arc words.\n${want}`).trim(), `What happened holds its words, got ${JSON.stringify(got.arc)}`);
		assert(got.body === lines(`- Keep words.\n${want}`).trim(), `What to keep holds its words, got ${JSON.stringify(got.body)}`);
		assert(got.parked === lines(`- Open words.\n${want}`).trim(), `Still open holds its words, got ${JSON.stringify(got.parked)}`);
		// Memorize's summary filing: what to keep files into the summary note, what is still open into items.
		const ops = summary.summaryFilingOps({ id: "RC-0001", title: "The exam plan", text: pages[0] }) as Array<{ op: string; kind?: string; text?: string }>;
		const items = ops.filter((op) => op.kind === "item").map((op) => op.text ?? "").join("\n");
		const facts = ops.filter((op) => op.kind !== "item").map((op) => op.text ?? "").join("\n");
		assert(facts.includes("Keep words") && facts.includes("Arc words") && !facts.includes("Open words"), `the summary note files what to keep and what happened, got ${JSON.stringify(facts.slice(0, 200))}`);
		assert(items.includes("Open words") && !items.includes("Keep words"), `the open items file what is still open, got ${JSON.stringify(items.slice(0, 200))}`);
		// The room's status reads one waiting conversation.
		const status = await api(`/api/persistent-agents/${agentId}/absorb/status`);
		assert((status.body?.sessions ?? []).length === 1, `the room reads one waiting conversation, got ${JSON.stringify((status.body?.sessions ?? []).map((s: any) => s.id))}`);
	})));

	await Promise.all([...EMPTY_CASES, { name: "one over the limit", typed: "" }].map((c, n) => check("Remember parts", `${c.name} is refused`, async () => {
		const { agentId, l1bPath } = rooms.rememberRefused[n];
		const proposal = await rememberProposal(agentId);
		const before = fs.readFileSync(l1bPath, "utf-8");
		let fields = { sessionArc: "Arc words.", body: c.typed, parked: "- Open words." };
		if (c.name === "one over the limit") {
			const room = PAGE_MAX + 1 - pageOf(proposal, { ...fields, body: "" }).trim().length;
			fields = { ...fields, body: wordsOf(room) };
			assert(pageOf(proposal, fields).trim().length === PAGE_MAX + 1, "the page is one over");
		}
		const saved = await save(agentId, proposal, fields);
		assert(saved.status === 400, `nothing is saved, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
		assert(c.name === "one over the limit" ? /8,000/.test(String(saved.body?.error)) : /what to keep/i.test(String(saved.body?.error)), `the sentence says why, got ${JSON.stringify(saved.body?.error)}`);
		assert(fs.readFileSync(l1bPath, "utf-8") === before, "the file is as it was");
	})));

	await check("Remember parts", "a page at the limit saves", async () => {
		const { agentId } = rooms.rememberLimit;
		const proposal = await rememberProposal(agentId);
		let fields = { sessionArc: "Arc words.", body: "", parked: "- Open words." };
		fields = { ...fields, body: wordsOf(PAGE_MAX - pageOf(proposal, fields).trim().length) };
		assert(pageOf(proposal, fields).trim().length === PAGE_MAX, "the page is at the limit");
		const saved = await save(agentId, proposal, fields);
		assert(saved.status === 200, `a page of ${PAGE_MAX} characters saves, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
	});

	await check("Remember parts", "a Still open emptied by hand saves without the OPEN mark", async () => {
		const { agentId, l1bPath } = rooms.rememberEmptied;
		const proposal = await rememberProposal(agentId);
		assert(/\|\s*OPEN\s*\|/.test(String(proposal.proposedRecentContext).split("\n")[0]), "the proposal's heading is OPEN");
		const fields = { sessionArc: "Arc words.", body: "- Keep words.", parked: "" };
		// The page as the page sent it before: the proposal's own heading.
		const body = { conversationId: proposal.conversationId, model: MODEL, density: proposal.density, proposal, approvedRecentContext: `${String(proposal.proposedRecentContext).split("\n")[0]}\n\n**Session arc:** Arc words.\n\n**Body:**\n- Keep words.\n\n**Parked:**\nNone\n`, approvedFields: fields };
		const saved = await api(`/api/persistent-agents/${agentId}/checkpoint/approve`, "POST", body);
		assert(saved.status === 200, `Save writes, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
		const heading = pagesIn(fs.readFileSync(l1bPath, "utf-8"))[0]?.split("\n")[0] ?? "";
		assert(/\|\s*CLOSED\s*\|/.test(heading), `the saved page is CLOSED, got ${JSON.stringify(heading)}`);
	});

	// --- 6. The Memory pane: add and edit ----------------------------------------------------

	const PANE_TOPICS = MEMORIZE_TOPICS;
	await Promise.all(CASES.map((c, n) => check("Pane add", c.name, async () => {
		const { agentId, l1bPath } = rooms.paneAdd[n];
		const before = notesOf(read(l1bPath));
		const added = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", { topic: "Exam booking", kind: "fact", text: c.typed });
		assert(added.status === 200, `the add is accepted, got ${added.status} ${JSON.stringify(added.body)}`);
		const id = String(added.body?.entry?.id ?? "");
		before.set(id, { topic: "Exam booking", section: "Deep Memory", text: c.stored, pinned: Boolean(c.pins) });
		await checkSaved(agentId, l1bPath, id, c, before, PANE_TOPICS);
	})));
	await Promise.all(CASES.map((c, n) => check("Pane edit", c.name, async () => {
		const { agentId, l1bPath } = rooms.paneEdit[n];
		const before = notesOf(read(l1bPath));
		const edited = await api(`/api/persistent-agents/${agentId}/memory/entries/m-0022`, "PUT", { text: c.typed });
		assert(edited.status === 200, `the edit is accepted, got ${edited.status} ${JSON.stringify(edited.body)}`);
		await checkSaved(agentId, l1bPath, "m-0022", c, before, PANE_TOPICS);
	})));
	await check("Pane add", "empty, marks only, the limit and one over", async () => {
		const { agentId, l1bPath } = rooms.paneRefused;
		const failures: string[] = [];
		for (const c of EMPTY_CASES) {
			const before = fs.readFileSync(l1bPath, "utf-8");
			const refused = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", { topic: "Exam booking", kind: "fact", text: c.typed });
			if (refused.status !== 400 || !refused.body?.error) failures.push(`${c.name} is refused with a sentence, got ${refused.status} ${JSON.stringify(refused.body).slice(0, 120)}`);
			if (fs.readFileSync(l1bPath, "utf-8") !== before) failures.push(`${c.name} leaves the file as it was`);
		}
		const atLimit = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", { topic: "Exam booking", kind: "fact", text: wordsOf(PANE_MAX) });
		if (atLimit.status !== 200) failures.push(`a note of ${PANE_MAX} characters is accepted, got ${atLimit.status}`);
		const over = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", { topic: "Exam booking", kind: "fact", text: wordsOf(PANE_MAX + 1) });
		if (over.status !== 400) failures.push(`one over the limit is refused, got ${over.status}`);
		assert(failures.length === 0, failures.join("; "));
	});

	// --- 7. The pane's typed topic names -------------------------------------------------------

	await check("Pane topics", "line breaks, heading marks and the file's own names", async () => {
		const { agentId, l1bPath } = rooms.paneTopics;
		const failures: string[] = [];
		const add = (topic: string, text: string) => api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", { topic, newTopic: true, kind: "fact", text });
		for (const [typed, want, words] of [["Payment\nterms", "Payment terms", "- Paid on the first."], ["Payment\u2028terms", "Payment terms", "- Paid by transfer."], ["C# tips", "C# tips", "- Use records."]] as const) {
			const added = await add(typed, words);
			const id = added.body?.entry?.id;
			const where = notesOf(read(l1bPath)).get(id);
			if (added.status !== 200 || where?.topic !== want) failures.push(`${JSON.stringify(typed)} files under ${JSON.stringify(want)}, got ${added.status} ${JSON.stringify(where?.topic ?? added.body?.error)}`);
		}
		const titles = read(l1bPath).topics.map((topic) => topic.title);
		if (titles.filter((title) => title === "Payment terms").length !== 1) failures.push(`one Payment terms topic, got ${JSON.stringify(titles)}`);
		const before = fs.readFileSync(l1bPath, "utf-8");
		for (const typed of ["## Payment terms", "Active Items"]) {
			const refused = await add(typed, "- Not filed.");
			if (refused.status !== 400 || !refused.body?.error) failures.push(`a new topic typed as ${JSON.stringify(typed)} is refused with a sentence, got ${refused.status} ${JSON.stringify(refused.body?.error ?? refused.body?.entry)}`);
			const movedIn = await api(`/api/persistent-agents/${agentId}/memory/entries/m-0011`, "PUT", { topic: typed, newTopic: true });
			if (movedIn.status !== 400) failures.push(`a note moved to a new topic typed as ${JSON.stringify(typed)} is refused, got ${movedIn.status}`);
		}
		if (fs.readFileSync(l1bPath, "utf-8") !== before) failures.push("a refused name leaves the file as it was");
		const empty = await add("", "- No topic.");
		if (empty.status !== 400 || !empty.body?.error) failures.push(`an empty new topic name is refused with a sentence, got ${empty.status}`);
		// The pane's own list offers the open-items list: a note moved there from the list is the person's choice.
		// A caller that does not say the name was chosen from the list is taken as typing it (L4).
		const unflagged = await api(`/api/persistent-agents/${agentId}/memory/entries/m-0012`, "PUT", { topic: "Active Items" });
		if (unflagged.status !== 400) failures.push(`a move to the open-items list without saying it was chosen is refused, got ${unflagged.status}`);
		const listed = await api(`/api/persistent-agents/${agentId}/memory/entries/m-0012`, "PUT", { topic: "Active Items", newTopic: false });
		if (listed.status !== 200) failures.push(`a move to the open-items list chosen from the pane's list is taken, got ${listed.status} ${JSON.stringify(listed.body?.error)}`);
		const general = await add("General", "- A general note.");
		const pane = await api(`/api/persistent-agents/${agentId}/memory/entries`);
		const shownUnder = (pane.body?.topics ?? []).find((topic: any) => (topic.entries ?? []).some((entry: any) => entry.id === general.body?.entry?.id))?.title;
		if (general.status === 200 && shownUnder !== "General") failures.push(`a note filed under "General" shows under General, got ${JSON.stringify(shownUnder)}`);
		const item = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", { topic: "", kind: "item", text: "- Call the exam office." });
		if (item.status !== 200 || notesOf(read(l1bPath)).get(item.body?.entry?.id)?.section !== "Active Items") failures.push(`an open item still files into the open items, got ${item.status}`);
		assert(failures.length === 0, failures.join("; "));
	});

	await check("Room name", "a name starting with # or <!-- is refused", async () => {
		const { agentId, l1bPath } = rooms.paneRename;
		const failures: string[] = [];
		const before = fs.readFileSync(l1bPath, "utf-8");
		for (const name of ["# Exam room", "<!-- Exam room -->"]) {
			const renamed = await api(`/api/persistent-agents/${agentId}/rename`, "POST", { displayName: name });
			if (renamed.status !== 400 || !renamed.body?.error) failures.push(`${JSON.stringify(name)} is refused with a sentence, got ${renamed.status} ${JSON.stringify(renamed.body).slice(0, 160)}`);
		}
		if (fs.readFileSync(l1bPath, "utf-8") !== before) failures.push("the memory file is as it was");
		const plain = await api(`/api/persistent-agents/${agentId}/rename`, "POST", { displayName: "C# exam room" });
		if (plain.status !== 200) failures.push(`"C# exam room" is a fine name, got ${plain.status} ${JSON.stringify(plain.body).slice(0, 160)}`);
		assert(failures.length === 0, failures.join("; "));
	});

	// --- 8. The second press: a save sent again after its answer was lost ------------------------

	await check("Second press", "Memorize's Save sent again answers that it saved", async () => {
		const { agentId, l1bPath } = rooms.memorizeTwice;
		const { runId } = await readyMemorizeRun(agentId);
		const first = await api(`/api/persistent-agents/${agentId}/absorb/approve`, "POST", { runId });
		assert(first.status === 200, `the first Save writes, got ${first.status}`);
		const written = fs.readFileSync(l1bPath, "utf-8");
		const found = await api(`/api/persistent-agents/${agentId}/absorb/runs/${runId}`);
		assert(found.status === 200 && found.body?.state === "saved", `the saved run can still be found, got ${found.status} ${JSON.stringify(found.body?.state ?? found.body)}`);
		const again = await api(`/api/persistent-agents/${agentId}/absorb/approve`, "POST", { runId });
		assert(again.status === 200 && again.body?.alreadySaved === true && again.body?.saveId === first.body?.saveId, `the second Save answers that it saved, got ${again.status} ${JSON.stringify(again.body).slice(0, 200)}`);
		assert(fs.readFileSync(l1bPath, "utf-8") === written, "the second Save writes nothing");
		// Undo, and Undo again.
		const undo = await api(`/api/persistent-agents/${agentId}/memory/undo`, "POST", { saveId: first.body.saveId });
		assert(undo.status === 200, `Undo undoes, got ${undo.status} ${JSON.stringify(undo.body).slice(0, 200)}`);
		const undone = fs.readFileSync(l1bPath, "utf-8");
		const undoAgain = await api(`/api/persistent-agents/${agentId}/memory/undo`, "POST", { saveId: first.body.saveId });
		assert(undoAgain.status === 200 && undoAgain.body?.alreadyUndone === true, `Undo sent again answers that it is undone, got ${undoAgain.status} ${JSON.stringify(undoAgain.body).slice(0, 200)}`);
		assert(fs.readFileSync(l1bPath, "utf-8") === undone, "the second Undo writes nothing");
	});
	await check("Second press", "a saved Memorize run, kept for the restart", async () => {
		const { agentId, l1bPath } = rooms.memorizeRestart;
		const { runId } = await readyMemorizeRun(agentId);
		const first = await api(`/api/persistent-agents/${agentId}/absorb/approve`, "POST", { runId });
		assert(first.status === 200, `the first Save writes, got ${first.status}`);
		assert(first.body?.newTopics === 1, `the update makes one new topic, got ${first.body?.newTopics}`);
		afterRestart.push({ label: "Memorize", url: `/api/persistent-agents/${agentId}/absorb/approve`, body: { runId }, saveId: first.body?.saveId, l1bPath, newTopics: first.body?.newTopics });
	});
	await check("Second press", "Review's Save sent again answers that it saved", async () => {
		const { agentId, l1bPath } = rooms.reviewTwice;
		const { runId } = await readyReviewRun(agentId);
		const first = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}/approve`, "POST", {});
		assert(first.status === 200, `the first Save writes, got ${first.status}`);
		const written = fs.readFileSync(l1bPath, "utf-8");
		afterRestart.push({ label: "Review", url: `/api/persistent-agents/${agentId}/review/runs/${runId}/approve`, body: {}, saveId: first.body?.saveId, l1bPath });
		const found = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}`);
		assert(found.status === 200 && found.body?.state === "saved", `the saved review can still be found, got ${found.status} ${JSON.stringify(found.body?.state ?? found.body)}`);
		const again = await api(`/api/persistent-agents/${agentId}/review/runs/${runId}/approve`, "POST", {});
		assert(again.status === 200 && again.body?.alreadySaved === true && again.body?.saveId === first.body?.saveId, `the second Save answers that it saved, got ${again.status} ${JSON.stringify(again.body).slice(0, 200)}`);
		assert(fs.readFileSync(l1bPath, "utf-8") === written, "the second Save writes nothing");
	});
	await check("Second press", "the pane's Save note sent again adds one note", async () => {
		const { agentId, l1bPath } = rooms.paneTwice;
		const body = { topic: "Exam booking", kind: "fact", text: "- The exam is on a Tuesday.", requestId: "add-0001" };
		const first = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", body);
		const second = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", body);
		const count = [...notesOf(read(l1bPath)).values()].filter((n) => n.text === "- The exam is on a Tuesday.").length;
		assert(first.status === 200 && second.status === 200 && count === 1 && second.body?.entry?.id === first.body?.entry?.id, `one note, and the second answer names it, got ${first.status}/${second.status}, ${count} notes, ids ${first.body?.entry?.id}/${second.body?.entry?.id}`);
		const third = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", { ...body, requestId: "add-0002" });
		const count2 = [...notesOf(read(l1bPath)).values()].filter((n) => n.text === "- The exam is on a Tuesday.").length;
		assert(third.status === 200 && count2 === 2, `a new add with the same words is a new note, got ${third.status}, ${count2}`);
	});

	await check("Second press", "the pane's Save note sent again adds one note when more than 500 older records of other kinds follow its own", async () => {
		const { agentId, l1bPath } = rooms.paneManyRecords;
		const body = { topic: "Exam booking", kind: "fact", text: "- The exam fee is due in April.", requestId: "add-many" };
		const first = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", body);
		// Older records whose label sorts after "edit_": a room with a long Review history.
		const dir = path.join(agentsRoot, agentId, "events", "memory-edit");
		for (let n = 0; n < 501; n++) fs.writeFileSync(path.join(dir, `review_20260101T${String(Math.floor(n / 60)).padStart(4, "0")}${String(n % 60).padStart(2, "0")}Z_old${n}.json`), "{}");
		const second = await api(`/api/persistent-agents/${agentId}/memory/entries`, "POST", body);
		const count = [...notesOf(read(l1bPath)).values()].filter((n) => n.text === "- The exam fee is due in April.").length;
		assert(first.status === 200 && second.status === 200 && count === 1, `one note, got ${first.status}/${second.status}, ${count} notes`);
	});

	await check("Open conversation", "a hand edit and an Undo say the open conversation keeps its memory; none without one, or with only an empty prepared one", async () => {
		const failures: string[] = [];
		const edit = (agentId: string) => api(`/api/persistent-agents/${agentId}/memory/entries/m-0011`, "PUT", { text: "- Invoices go out on the second." });
		const open = rooms.openConversation.agentId;
		const edited = await edit(open);
		if (edited.status !== 200 || edited.body?.openConversationKeepsMemory !== true) failures.push(`an edit with a started conversation open says so, got ${edited.status} ${JSON.stringify(edited.body?.openConversationKeepsMemory)}`);
		const { runId } = await readyMemorizeRun(open);
		const saved = await api(`/api/persistent-agents/${open}/absorb/approve`, "POST", { runId });
		assert(saved.status === 200, `the Memorize save writes, got ${saved.status}`);
		const undone = await api(`/api/persistent-agents/${open}/memory/undo`, "POST", { saveId: saved.body.saveId });
		if (undone.status !== 200 || undone.body?.openConversationKeepsMemory !== true) failures.push(`an Undo with a started conversation open says so, got ${undone.status} ${JSON.stringify(undone.body?.openConversationKeepsMemory)}`);
		for (const [label, room] of [["no conversation", rooms.noConversation], ["only an empty prepared one", rooms.preparedOnly]] as const) {
			const quiet = await edit(room.agentId);
			if (quiet.status !== 200 || "openConversationKeepsMemory" in (quiet.body ?? {})) failures.push(`an edit with ${label} says nothing of it, got ${quiet.status} ${JSON.stringify(quiet.body?.openConversationKeepsMemory)}`);
		}
		assert(failures.length === 0, failures.join("; "));
	});

	await check("Second press", "the pane's delete, restore and delete for good sent again say what is true", async () => {
		const { agentId, l1bPath } = rooms.paneArchiveTwice;
		const room = `/api/persistent-agents/${agentId}/memory`;
		const failures: string[] = [];
		const deleted = await api(`${room}/entries/m-0012`, "DELETE");
		const deletedAgain = await api(`${room}/entries/m-0012`, "DELETE");
		if (deleted.status !== 200 || deletedAgain.status !== 200 || deletedAgain.body?.alreadySaved !== true || deletedAgain.body?.archived?.id !== "m-0012") failures.push(`a delete sent again answers that the note is in the archive, got ${deleted.status}/${deletedAgain.status} ${JSON.stringify(deletedAgain.body).slice(0, 160)}`);
		const restored = await api(`${room}/archive/m-0012/restore`, "POST", {});
		const before = fs.readFileSync(l1bPath, "utf-8");
		const restoredAgain = await api(`${room}/archive/m-0012/restore`, "POST", {});
		if (restored.status !== 200 || restoredAgain.status !== 200 || restoredAgain.body?.alreadySaved !== true || restoredAgain.body?.entry?.id !== "m-0012") failures.push(`a restore sent again answers that the note is back, got ${restored.status}/${restoredAgain.status} ${JSON.stringify(restoredAgain.body).slice(0, 160)}`);
		if (fs.readFileSync(l1bPath, "utf-8") !== before) failures.push("the restore sent again writes nothing");
		await api(`${room}/entries/m-0011`, "DELETE");
		const gone = await api(`${room}/archive/m-0011`, "DELETE");
		const goneAgain = await api(`${room}/archive/m-0011`, "DELETE");
		if (gone.status !== 200 || goneAgain.status !== 200 || goneAgain.body?.alreadySaved !== true) failures.push(`a delete for good sent again answers that the row is gone, got ${gone.status}/${goneAgain.status} ${JSON.stringify(goneAgain.body).slice(0, 160)}`);
		assert(failures.length === 0, failures.join("; "));
	});
	await check("Second press", "Memorize's Save sent again after a newer run started answers that it saved", async () => {
		const { agentId, l1bPath } = rooms.memorizeNewerRun;
		const { runId } = await readyMemorizeRun(agentId);
		const first = await api(`/api/persistent-agents/${agentId}/absorb/approve`, "POST", { runId });
		assert(first.status === 200, `the first Save writes, got ${first.status}`);
		// A conversation remembered, and a newer Memorize ready on it: the first run is gone.
		const proposal = await rememberProposal(agentId);
		const remembered = await save(agentId, proposal, { sessionArc: "Arc words.", body: "- Keep words.", parked: "" });
		assert(remembered.status === 200, `Remember saves, got ${remembered.status} ${JSON.stringify(remembered.body).slice(0, 160)}`);
		const newer = await readyMemorizeRun(agentId);
		assert(newer.runId !== runId, "a newer run");
		const before = fs.readFileSync(l1bPath, "utf-8");
		const again = await api(`/api/persistent-agents/${agentId}/absorb/approve`, "POST", { runId });
		assert(again.status === 200 && again.body?.alreadySaved === true && again.body?.saveId === first.body?.saveId, `the old run's Save answers that it saved, got ${again.status} ${JSON.stringify(again.body).slice(0, 200)}`);
		assert(fs.readFileSync(l1bPath, "utf-8") === before, "nothing is written");
	});

	// A Save sent again after the server restarted: the run is gone, and the answer still says it saved.
	await stopSmokeServer(server);
	await startServer();
	for (const save of afterRestart) {
		await check("Second press", `${save.label}'s Save sent again after a restart answers that it saved`, async () => {
			const before = save.l1bPath ? fs.readFileSync(save.l1bPath, "utf-8") : "";
			const again = await api(save.url, "POST", save.body);
			assert(again.status === 200 && again.body?.alreadySaved === true && again.body?.saveId === save.saveId, `got ${again.status} ${JSON.stringify(again.body).slice(0, 200)}`);
			if (save.l1bPath) assert(fs.readFileSync(save.l1bPath, "utf-8") === before, "nothing is written");
			if (save.newTopics !== undefined) assert(again.body?.newTopics === save.newTopics, `the new topics are counted as the first answer counted them, got ${again.body?.newTopics}, want ${save.newTopics}`);
		});
	}

	// --- The table -------------------------------------------------------------------------------
	const width = Math.max(...rows.map((row) => `${row.surface}: ${row.name}`.length));
	for (const row of rows) console.log(`  ${row.ok ? "ok  " : "FAIL"}  ${`${row.surface}: ${row.name}`.padEnd(width)}${row.ok ? "" : `  ${row.detail}`}`);
	const failed = rows.filter((row) => !row.ok);
	console.log(`hand-edit battery: ${rows.length - failed.length} of ${rows.length} cases pass`);
	if (failed.length > 0) process.exitCode = 1;
} catch (error) {
	console.error(error);
	console.error(serverOutput.join("").slice(-4000));
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	provider.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
