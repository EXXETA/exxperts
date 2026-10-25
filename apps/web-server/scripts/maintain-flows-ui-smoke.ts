// The Maintain screens as a person drives them in the page, against the real
// server and one synthetic provider: Review as a whole (a busy first read says
// its wait on Review's screen, then the tidy, its card and the saved screen,
// which says the open conversation keeps the memory it started with);
// Back during a Memorize or Review discussion asks Leave, Keep discussing
// stays, Leave goes, and the discussion is back on the next open; the
// Memorize card's block for notes the one-time sort placed, with Move, and the
// same open-conversation line on its saved screen; Return Home from an
// ordinary saved Remember writes nothing into the conversation it closed; and
// the Memory page shows a saved page in plain words, and a page that holds
// only its date by its dated title; a Review whose every tidy call failed says
// it could not finish and records nothing, even with automatic maintenance on,
// and a budget raised on such a card is kept for Save;
// Memorize with its Memory model signed out shows the notice at once; Read
// again asks the model again; a first read ends only on Cancel: after a reload
// or a proxy's cut, the page joins the read still being made; a Review card
// left ready waits behind the chooser, and Try again after its save keeps the
// run's guidance; Back on a Memorize run that was waiting shows the first read;
// and a gateway's bare 403 on a memory screen offers the buttons the chat's line
// offers on a shared server and on a paired phone.
// Offline: one synthetic provider.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip whole.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("maintain flows smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-maintain-flows-"));
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
const OPEN_CONVERSATION_LINE = "Your open conversation keeps the memory it started with. The changes apply from your next conversation.";
const REMEMBER_PAGE = "TITLE:\nThe launch plan\n\nSESSION_ARC:\nWe planned the launch.\n\nBODY:\n- **must-keep:** The launch moves to May.\n\nPARKED:\nNone\n";
const REVIEW_FIRST_READ = "## First read\n\n### Could be shorter\n- Renewals says one thing twice.\n\n### Looks stale or contradicts itself\n- None\n\n### Needs your call\nNone\n\n### Topics to tidy\nRenewals\n";
const MEMORIZE_FIRST_READ = "## Absorb assessment\n\nI found 1 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n\n- The venue plan.\n\n### What to forget\n\n- The small talk.\n\n### What changes in stable memory\n\n- Deep Memory: the venue plan.\n\n### Needs your judgment\n\n- None\n";

// The calls the provider has answered, by kind; a first read of Review answers busy while `busyReviewReads` lasts.
const calls: string[] = [];
let busyReviewReads = 0;
// The Waiting Room's first read fails with a 500 every time, counted apart.
let waitingRoomReads = 0;
// The slow rooms' first reads, as "<marker> <kind>", and those the server ended before their answer.
const slowReads: string[] = [];
const slowReadsCut: string[] = [];
const slowCount = (read: string) => slowReads.filter((one) => one === read).length;
// While set, the Busy Card Room's tidy of its warehouse note answers late: another window's Try again still at work.
let kestrelTidyWaits = false;
// The Flaky Key Room's first reads: the first is answered, every later one refused as signed out.
let flakyKeyReads = 0;
// A first read with all its sections, so Read again has no missing part to ask about.
const COMPLETE_FIRST_READ = MEMORIZE_FIRST_READ.replace("- Deep Memory: the venue plan.", "- Deep Memory: the venue plan.\n- Active Items: the venue booking.");

/** The sign-off's sections, each None: the shape the Task asks for, read from the prompt itself. */
function signoffReply(prompt: string): string {
	const task = prompt.slice(prompt.lastIndexOf("## Task:"));
	const heading = /^## ((?:Memorize|Review) discussion sign-?off)\s*$/im.exec(task)?.[1] ?? "Sign-off";
	const sections = [...task.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
	return [`## ${heading}`, "", ...sections.flatMap((title) => [`### ${title}`, "None", ""])].join("\n");
}

/** The tidy shortens the first note it is given: a card with one change. */
function tidyReply(prompt: string): string {
	const material = prompt.split(/\n\n---\n\n/).find((part) => part.trimStart().startsWith("## Material: The Notes To Tidy")) ?? "";
	const first = material.split("\n").map((line) => /^(?:\s*[-*]\s+)?\[([^\]\s·]+)\]\s*(.*)$/.exec(line.trim())).find(Boolean);
	const ops = first ? [{ op: "update", id: first[1], text: "- The Nordwind contract renews in May." }] : [];
	return `One note said the same twice.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`;
}

function replyFor(prompt: string): { kind: string; text: string } {
	if (prompt.includes("Checkpoint Compression Constitution")) return { kind: "remember", text: REMEMBER_PAGE };
	if (prompt.includes("## Task: First read of these notes")) return { kind: "review-read", text: REVIEW_FIRST_READ };
	if (prompt.includes("## Task: Review discussion turn")) return { kind: "review-turn", text: "Noted: the renewal notes stay short." };
	if (prompt.includes("## Task: Review discussion sign-off")) return { kind: "review-signoff", text: signoffReply(prompt) };
	if (prompt.includes("## Task: Tidy These Notes")) return { kind: "tidy", text: tidyReply(prompt) };
	if (prompt.includes("## Task: Compact Initial Assessment")) return { kind: "memorize-read", text: MEMORIZE_FIRST_READ };
	if (prompt.includes("## Task: Absorb Discussion Turn")) return { kind: "memorize-turn", text: "Noted: the venue plan is what matters." };
	if (prompt.includes("## Task: Memorize Discussion Signoff")) return { kind: "memorize-signoff", text: signoffReply(prompt) };
	if (prompt.includes("## Task: Fold This Session Into Memory")) return { kind: "fold", text: `Nothing new.\n\n\`\`\`json\n${JSON.stringify({ ops: [{ op: "drop", reason: "This conversation repeats what the room already knows." }] })}\n\`\`\`\n` };
	if (prompt.includes("For each note")) return { kind: "sort", text: "m-0101: Billing" };
	if (prompt.includes("Answer with the one title")) return { kind: "place", text: "Billing" };
	return { kind: "other", text: "Answer from claude-fake." };
}

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const words = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(words).join("\n") : value && typeof value === "object" ? words((value as { text?: unknown; content?: unknown }).text ?? (value as { content?: unknown }).content) : "";
		const { kind, text } = replyFor(`${words(body.system)}\n${words(body.messages)}`);
		calls.push(kind);
		// The Failing Room's tidy is refused with a plain 400, the Signed-out Room's first read with a 401, and the Flaky Key Room's after its first.
		const prompt = `${words(body.system)}\n${words(body.messages)}`;
		if (kind === "memorize-read" && prompt.includes("Ostrander")) flakyKeyReads += 1;
		if ((kind === "tidy" && prompt.includes("Halvorsen")) || (kind === "memorize-read" && (prompt.includes("Quillfeather") || (prompt.includes("Ostrander") && flakyKeyReads > 1)))) {
			const refusal = kind === "tidy" ? { status: 400, type: "invalid_request_error", message: "Bad request" } : { status: 401, type: "authentication_error", message: "invalid x-api-key" };
			res.writeHead(refusal.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: refusal.type, message: refusal.message } }));
			return;
		}
		if (kind === "memorize-read" && prompt.includes("Zellweger")) {
			waitingRoomReads += 1;
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error" } }));
			return;
		}
		if (kind === "review-read" && busyReviewReads > 0) {
			busyReviewReads -= 1;
			res.writeHead(529, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
			return;
		}
		const answer = () => {
			// A request the server gave up on is not answered.
			if (res.destroyed) return;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const model = String(body.model);
			// The model declines to tidy the Guided Room's supplier note and the Busy Card Room's warehouse note: a refusal, so the group is split and that topic alone is left.
			const refused = kind === "tidy" && (prompt.includes("Vexholm") || prompt.includes("Kestrel"));
			sse(res, "message_start", { type: "message_start", message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: refused ? "" : kind === "memorize-read" && ["Quorvale", "Brightwater", "Ravensholt", "Pembertine", "Ostrander"].some((marker) => prompt.includes(marker)) ? COMPLETE_FIRST_READ : text } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: refused ? "refusal" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
		};
		// The slow rooms' first reads answer after a few seconds: time for a reload, a Cancel or a proxy's cut in the middle of them.
		const slowMarker = ["Brightwater", "Ravensholt", "Pembertine"].find((marker) => prompt.includes(marker));
		const slow = (kind === "memorize-read" || kind === "review-read") && slowMarker ? `${slowMarker} ${kind}` : kind === "tidy" && kestrelTidyWaits && prompt.includes("Kestrel") ? "Kestrel tidy" : null;
		if (slow) {
			slowReads.push(slow);
			const timer = setTimeout(answer, slow === "Kestrel tidy" ? 10_000 : 4_000);
			res.on("close", () => { if (!res.writableFinished) { clearTimeout(timer); slowReadsCut.push(slow); } });
			return;
		}
		answer();
	});
});

// A saved page as it reads: the open conversation's line stands apart from the
// counts paragraph before it; the heading's text runs the full width of the page,
// as the chips row below it does; and no footnote about undoing remains.
async function checkSavedPage(screen: ReturnType<Page["locator"]>, label: string): Promise<void> {
	const look = await screen.locator(".checkpoint-saved-page").first().evaluate((page) => {
		// No named helpers in here: the page runs this text as it is.
		const line = [...page.querySelectorAll("p")].find((p) => p.textContent === "Your open conversation keeps the memory it started with. The changes apply from your next conversation.");
		const before = line?.previousElementSibling;
		const heading = page.querySelector(".checkpoint-input-heading");
		const strip = page.querySelector(".absorb-review-strip");
		const widths = [...(heading?.querySelectorAll("p") ?? [])].map((p) => Math.round(p.getBoundingClientRect().width));
		return {
			gap: line && before ? Math.round(line.getBoundingClientRect().top - before.getBoundingClientRect().bottom) : -1,
			page: Math.round(page.getBoundingClientRect().width),
			heading: heading ? Math.round(heading.getBoundingClientRect().width) : -1,
			strip: strip ? Math.round(strip.getBoundingClientRect().width) : -1,
			narrowest: widths.length ? Math.min(...widths) : -1,
			text: (page as HTMLElement).innerText,
		};
	});
	assert(look.gap >= 8, `${label}: the open conversation's line stands apart from the paragraph before it, got a gap of ${look.gap}px`);
	assert(look.heading >= look.page - 1 && look.narrowest >= look.page - 1 && look.strip >= look.page - 1, `${label}: the heading's text runs the page's full width, as the chips do, got ${JSON.stringify({ page: look.page, heading: look.heading, narrowest: look.narrowest, strip: look.strip })}`);
	assert(!/can (also )?be undone/.test(look.text), `${label}: no footnote about undoing, got ${JSON.stringify(look.text)}`);
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

/** Every file under a folder, by path, with a hash of its bytes. */
function snapshot(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (at: string) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			const full = path.join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.set(full, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
		}
	};
	walk(dir);
	return out;
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const conversationPage = (id: string, date: string, title: string, arc: string, body: string) => [`### ${id} | CLOSED | ${date} | ${title}`, "", `**Session arc:** ${arc}`, "", "**Body:**", body, "", "**Parked:**", "None", ""].join("\n");
	/** A room with the given topics in its memory, and the given saved pages waiting. */
	const createRoom = (name: string, topics: string, pages: string[]) => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: MODEL, memory: MODEL });
		const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
		let text = fs.readFileSync(l1bPath, "utf-8");
		const active = /^##\s+Active Items\s*$/m.exec(text)!;
		text = `${text.slice(0, active.index)}${topics}${text.slice(active.index)}`;
		const recent = /^##\s+Recent Context\s*$/m.exec(text)!;
		fs.writeFileSync(l1bPath, `${text.slice(0, recent.index + recent[0].length)}\n\n${pages.join("\n")}\n`, "utf-8");
		return { agentId, l1bPath };
	};
	const note = (id: string, text: string) => `<!-- e: id=${id} kind=fact saved=2026-09-01 -->\n${text}\n`;
	const reviewRoom = createRoom("Review Room", ["### Renewals", "", note("m-0201", "- The Nordwind contract renews in May, and the renewal is in May."), note("m-0202", "- The Lueneburg venue holds two hundred."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-09", "The renewal call", "We went through the renewals.", "- The Nordwind renewal is in May.")]);
	const memorizeRoom = createRoom("Memorize Room", ["### Billing", "", note("m-0301", "- Invoices are sent by email."), "### Unsorted", "", note("m-0101", "- Invoices go out on the first working day."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-11", "The venue plan", "We settled the venue.", "- The venue is Lueneburg.")]);
	// Both rooms hold an open conversation that has started: it keeps the memory it started with, and each saved screen says so.
	for (const { agentId } of [reviewRoom, memorizeRoom]) {
		const threadId = "pi_started_0001";
		agents.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model: MODEL, items: [{ kind: "user", id: "u1", text: "A question." }, { kind: "assistant", id: "a1", text: "An answer." }] }, {
			createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempRoot }),
		});
	}
	const failingRoom = createRoom("Failing Room", ["### Renewals", "", note("m-0401", "- The Halvorsen contract renews in May, and the renewal is in May."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-09", "The renewal call", "We went through the renewals.", "- The renewal is in May.")]);
	const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
	writePersistentRoomMaintenanceSettings(failingRoom.agentId, { fastPathSecondApproval: true });
	// The Over Budget Room: every tidy fails as the Failing Room's does, and its memory is over its 10k budget.
	const overBudgetRoom = createRoom("Over Budget Room", ["### Renewals", "", ...Array.from({ length: 200 }, (_, n) => note(`m-${8000 + n}`, `- The Halvorsen contract ${n} renews in May; the renewal call with the finance desk is booked for the first Monday, and the signed copy goes to the northern office archive with the stamped customs papers and the delivery notes of the quarter.`)), ""].join("\n"), [conversationPage("RC-0001", "2026-09-09", "The renewal call", "We went through the renewals.", "- The renewal is in May.")]);
	writePersistentRoomMaintenanceSettings(overBudgetRoom.agentId, { memoryBudgetTokens: 10_000, memoryBudgetSettled: true });
	createRoom("Signed-out Room", "", [conversationPage("RC-0001", "2026-09-12", "The Quillfeather call", "We spoke about Quillfeather.", "- Quillfeather signs in June.")]);
	createRoom("Read Again Room", ["### Renewals", "", note("m-0501", "- The Quorvale contract renews in May."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-12", "The Quorvale call", "We spoke about Quorvale.", "- Quorvale renews in May.")]);
	createRoom("Waiting Room", "", [conversationPage("RC-0001", "2026-09-12", "The Zellweger call", "We spoke about Zellweger.", "- Zellweger signs in June.")]);
	createRoom("Slow Room", ["### Harbour", "", note("m-0601", "- The Brightwater harbour opens in July."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-12", "The Brightwater call", "We spoke about Brightwater.", "- Brightwater signs in July.")]);
	const proxyRoom = createRoom("Proxy Room", "", [conversationPage("RC-0001", "2026-09-12", "The Ravensholt call", "We spoke about Ravensholt.", "- Ravensholt signs in August.")]);
	const cutRoom = createRoom("Cut Room", "", [conversationPage("RC-0001", "2026-09-12", "The Pembertine call", "We spoke about Pembertine.", "- Pembertine signs in September.")]);
	createRoom("Flaky Key Room", "", [conversationPage("RC-0001", "2026-09-12", "The Ostrander call", "We spoke about Ostrander.", "- Ostrander signs in October.")]);
	const busyCardRoom = createRoom("Busy Card Room", ["### Renewals", "", note("m-0701", "- The Nordwind contract renews in May, and the renewal is in May."), "### Warehouse", "", note("m-0702", "- The Kestrel warehouse opens at seven."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-14", "The opening hours call", "We went through the opening hours.", "- Opening hours stay the same.")]);
	const guidedRoom = createRoom("Guided Room", ["### Renewals", "", note("m-0601", "- The Nordwind contract renews in May, and the renewal is in May."), "### Suppliers", "", note("m-0602", "- The Vexholm supplier delivers on Fridays."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-13", "The supply call", "We went through the deliveries.", "- Deliveries stay on Fridays.")]);
	createRoom("Waiting Card Room", "", [conversationPage("RC-0001", "2026-09-12", "The Brightwell call", "We spoke about Brightwell.", "- Brightwell signs in June.")]);
	const savedRoom = createRoom("Saved Room", "", [conversationPage("RC-0001", "2026-09-10", "Conversation of 2026-09-10", "Conversation of 2026-09-10", "- Conversation of 2026-09-10")]);
	const goneRoom = createRoom("Gone Room", "", []);
	// A task that met the empty conversation Remember prepared, twice: the newer run waits for it, the older one ended.
	const tasksRoom = createRoom("Tasks Room", "", []);
	agents.writePersistentAgentThread(tasksRoom.agentId, "tasks_prepared_0001", { state: "standby", origin: "checkpoint", model: MODEL, items: [] });
	const { addPersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
	const taskJob = addPersistentRoomScheduleJob(tasksRoom.agentId, { name: "Morning summary", type: "once", schedule: "+30m", prompt: "Summarise the morning." });
	const blockedAt = new Date(Date.now() - 10 * 60_000);
	const taskRuns = [20, 15].map((minutesAgo) => createScheduledPromptBackgroundRunPreflight({ roomId: tasksRoom.agentId, scheduleJobId: taskJob.id, dueAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), now: blockedAt }).run);
	assert(taskRuns.every((run) => run.status === "blocked" && run.reason === "prepared_runtime_boundary"), `both runs meet the prepared conversation, got ${taskRuns.map((run) => run.reason).join(",")}`);
	const { reviveTransientlyBlockedBackgroundRuns } = await import("../src/background-runs.js");
	const { scheduledRunMetCurrentConversation } = await import("../src/scheduled-prompt-background-readiness.js");
	reviveTransientlyBlockedBackgroundRuns({ kind: "scheduled-prompt", now: new Date(), limit: 10, metCurrentConversation: scheduledRunMetCurrentConversation });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser = await chromium.launch();
	try {
		const page: Page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		const card = (name: string) => page.locator(".persistent-agent-card").filter({ hasText: name });
		const hash = () => page.evaluate(() => window.location.hash);
		const openMaintain = async (room: string, flow: "Memorize" | "Review") => {
			if (!(await page.locator('[aria-label="Memory maintenance chooser"]').count())) await card(room).getByRole("button", { name: "Maintain", exact: true }).click();
			await page.locator(".maintain-action").filter({ hasText: flow }).first().click();
		};
		const confirm = (title: string) => page.getByRole("dialog", { name: title });
		const transcript = page.locator('[aria-label="Discussion transcript"]');

		// 1. Review as a whole. A busy first read says its wait on Review's own screen, then the read comes.
		busyReviewReads = 1;
		await openMaintain("Review Room", "Review");
		const review = page.locator('[aria-label="Review workflow"]');
		await review.getByText(/^The Memory model is busy\. Trying again at .+\.$/).waitFor({ timeout: 15_000 });
		await review.getByText("Renewals says one thing twice.").waitFor({ timeout: 40_000 });
		assert(await review.getByText(/is busy/).count() === 0, "the wait line comes down once the first read is in");
		// The read names the topics a person sees: Renewals, not the open items or the memory's opening lines.
		assert(await review.getByText("A first read of 1 topic.", { exact: true }).count() === 1, `the first read counts the titled topics that hold notes, got ${JSON.stringify((await review.innerText()).match(/A first read[^.]*\./)?.[0])}`);
		console.log("  ok  Review's first read says the busy wait on its screen, then shows the read");

		// 2. Back during the Review discussion: Leave Review?, Keep discussing stays, Leave goes, the discussion comes back.
		await review.getByRole("button", { name: "Discuss first" }).click();
		await review.getByPlaceholder("Your answer or instruction…").fill("Keep the renewal notes short.");
		await review.getByRole("button", { name: "Send" }).click();
		await transcript.getByText("Noted: the renewal notes stay short.").waitFor({ timeout: 20_000 });
		const reviewHash = await hash();
		await page.goBack();
		await confirm("Leave Review?").waitFor({ timeout: 10_000 });
		await confirm("Leave Review?").getByRole("button", { name: "Keep discussing" }).click();
		await confirm("Leave Review?").waitFor({ state: "detached", timeout: 10_000 });
		await waitUntil(async () => (await hash()) === reviewHash, `the address is the discussion's again (${reviewHash})`, 5_000);
		assert(await transcript.getByText("Keep the renewal notes short.").count() === 1, "Keep discussing stays in the discussion");
		// The entry Back went to is still there: a second Back asks again, never leaves the app.
		await page.goBack();
		await confirm("Leave Review?").waitFor({ timeout: 10_000 }).catch(() => { throw new Error(`a second Back after Keep discussing asks Leave again, got ${page.url()}`); });
		await confirm("Leave Review?").getByRole("button", { name: "Leave", exact: true }).click();
		await waitUntil(async () => (await review.count()) === 0, "Leave leaves Review");
		await openMaintain("Review Room", "Review");
		await transcript.getByText("Keep the renewal notes short.").waitFor({ timeout: 20_000 });
		assert(await transcript.getByText("Noted: the renewal notes stay short.").count() === 1, "the discussion comes back whole on the next open");
		console.log("  ok  Back during Review's discussion asks Leave; Keep discussing stays; Leave goes; the discussion comes back");

		// 3. The tidy from the discussion, its card, Save and the saved screen.
		// The tidy's progress, however briefly it shows, runs the card's full width.
		await page.evaluate(`(() => {
			window.__progressLook = null;
			const look = () => {
				const progress = document.querySelector(".review-run-progress");
				if (!progress || window.__progressLook) return;
				const parent = progress.parentElement.getBoundingClientRect().width - parseFloat(getComputedStyle(progress.parentElement).paddingLeft) - parseFloat(getComputedStyle(progress.parentElement).paddingRight);
				window.__progressLook = { width: Math.round(progress.getBoundingClientRect().width), parent: Math.round(parent) };
			};
			new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
		})()`);
		await review.getByRole("button", { name: "Continue →" }).click();
		const saveTidy = review.getByRole("button", { name: /^Save (to memory|over the budget)$/ });
		await saveTidy.waitFor({ timeout: 60_000 });
		const progressLook = await page.evaluate("window.__progressLook") as { width: number; parent: number } | null;
		assert(progressLook && progressLook.width >= progressLook.parent - 1, `the tidy's progress runs the card's full width, got ${JSON.stringify(progressLook)}`);
		const cardHead = await review.getByRole("heading", { level: 2 }).first().innerText();
		assert(cardHead === "1 topic tidied.", `the card says what the tidy did, got ${JSON.stringify(cardHead)}`);
		assert(!/can (also )?be undone/.test(await review.innerText()), "Review's card has no footnote about undoing");
		await saveTidy.click();
		const saveConfirm = page.getByRole("dialog").filter({ hasText: /Save/ }).getByRole("button", { name: "Save", exact: true });
		if (await saveConfirm.count()) await saveConfirm.click();
		await review.getByRole("heading", { name: "Review Room tidied its memory." }).waitFor({ timeout: 30_000 });
		assert(await review.getByText(OPEN_CONVERSATION_LINE, { exact: true }).count() === 1, "Review's saved screen says the open conversation keeps the memory it started with");
		await checkSavedPage(review, "Review");
		// At phone width the stacked header starts on the left edge, like the page under it.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(400);
		const headerLook = await page.evaluate(`(() => {
			const header = document.querySelector(".maintain-workspace .absorb-workspace-header");
			const edge = header.getBoundingClientRect().left + parseFloat(getComputedStyle(header).paddingLeft);
			return [...header.children].map((child) => Math.round(child.getBoundingClientRect().left - edge));
		})()`) as number[];
		assert(headerLook.length > 0 && headerLook.every((offset) => Math.abs(offset) <= 1), `the Maintain header starts on the left edge at phone width, got offsets ${JSON.stringify(headerLook)}`);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.waitForTimeout(300);
		const reviewMemory = fs.readFileSync(reviewRoom.l1bPath, "utf-8");
		assert(reviewMemory.includes("- The Nordwind contract renews in May.\n") && !reviewMemory.includes("and the renewal is in May"), "the saved tidy is in memory");
		await review.getByRole("button", { name: /^Back to rooms$/ }).first().click();
		await waitUntil(async () => (await review.count()) === 0, "the saved screen's button leaves Review");
		console.log("  ok  Review runs to its saved screen in the page, and its tidy is in memory");
		await page.waitForTimeout(400);
		if (await page.locator('[aria-label="Memory maintenance chooser"]').count()) await page.goBack();
		await card("Memorize Room").waitFor({ timeout: 10_000 });

		// 4. Back during the Memorize discussion, the same; then the run's card shows the sorted note, and Move moves it.
		await openMaintain("Memorize Room", "Memorize");
		const memorize = page.locator('[aria-label="Memory absorption workflow"]');
		await memorize.getByText("The venue plan.").first().waitFor({ timeout: 30_000 });
		await memorize.getByRole("button", { name: "Discuss first" }).click();
		await memorize.getByPlaceholder("Your answer or instruction…").fill("The venue plan matters most.");
		await memorize.getByRole("button", { name: "Send" }).click();
		await transcript.getByText("Noted: the venue plan is what matters.").waitFor({ timeout: 20_000 });
		const memorizeHash = await hash();
		await page.goBack();
		await confirm("Leave Memorize?").waitFor({ timeout: 10_000 });
		await confirm("Leave Memorize?").getByRole("button", { name: "Keep discussing" }).click();
		await waitUntil(async () => (await hash()) === memorizeHash, `the address is the discussion's again (${memorizeHash})`, 5_000);
		assert(await transcript.getByText("The venue plan matters most.").count() === 1, "Keep discussing stays in the discussion");
		await page.goBack();
		await confirm("Leave Memorize?").waitFor({ timeout: 10_000 }).catch(() => { throw new Error(`a second Back after Keep discussing asks Leave again, got ${page.url()}`); });
		await confirm("Leave Memorize?").getByRole("button", { name: "Leave", exact: true }).click();
		await waitUntil(async () => (await memorize.count()) === 0, "Leave leaves Memorize");
		await openMaintain("Memorize Room", "Memorize");
		await transcript.getByText("The venue plan matters most.").waitFor({ timeout: 20_000 });
		console.log("  ok  Back during Memorize's discussion asks Leave; Keep discussing stays; Leave goes; the discussion comes back");
		await memorize.getByRole("button", { name: "Continue →" }).click();
		const sortedBlock = memorize.locator(".absorb-run-sorted");
		await sortedBlock.getByRole("heading", { name: "1 note waiting in Unsorted was sorted into a topic" }).waitFor({ timeout: 90_000 });
		const sortedRow = sortedBlock.locator(".absorb-run-sorted-row").filter({ hasText: "Invoices go out on the first working day." });
		assert(await sortedRow.getByText("under Billing").count() === 1, "the sorted note's row names its topic");
		await waitUntil(async () => (await sortedRow.getByRole("button", { name: "Move" }).count()) === 1, "Move is offered once the run is done", 60_000);
		await sortedRow.getByRole("button", { name: "Move" }).click();
		// Move lists the topics this update saves, never Unsorted, and "new topic…" asks for the name.
		const picker = sortedRow.getByLabel("Move to");
		const listed = await picker.locator("option").allInnerTexts();
		assert(listed.includes("Billing") && listed.includes("new topic…") && !listed.includes("Unsorted"), `Move lists the update's topics, got ${JSON.stringify(listed)}`);
		await picker.selectOption({ label: "new topic…" });
		await sortedRow.getByLabel("New topic name").fill("Invoicing");
		await sortedRow.getByRole("button", { name: "Move", exact: true }).click();
		await sortedRow.getByText("under Invoicing").waitFor({ timeout: 10_000 });
		const saveRun = memorize.getByRole("button", { name: /^Save (to memory|over the budget)$/ });
		await waitUntil(async () => (await saveRun.count()) === 1 && (await saveRun.isEnabled()), "the run's card offers Save", 60_000);
		assert(!/can (also )?be undone/.test(await memorize.innerText()), "Memorize's card has no footnote about undoing");
		await saveRun.click();
		await page.getByRole("dialog").filter({ hasText: "Save these notes to Memorize Room's memory?" }).getByRole("button", { name: "Save", exact: true }).click({ timeout: 10_000 });
		// Its one conversation had nothing to keep and a note was sorted: the headline says that, not "memorized".
		await memorize.getByRole("heading", { name: "Memorize Room sorted its notes into topics" }).waitFor({ timeout: 30_000 });
		assert(await memorize.getByText(OPEN_CONVERSATION_LINE, { exact: true }).count() === 1, "Memorize's saved screen says the open conversation keeps the memory it started with");
		await checkSavedPage(memorize, "Memorize");
		const memorized = fs.readFileSync(memorizeRoom.l1bPath, "utf-8");
		assert(/### Invoicing\n\n<!-- e: id=m-0101 [^\n]*-->\n- Invoices go out on the first working day\./.test(memorized) && !/^### Unsorted$/m.test(memorized), "the moved note is saved under the topic the person gave it");
		console.log("  ok  the Memorize card shows the sorted note, Move moves it, and Save keeps it there");
		// A save that only sorted a note changed the memory file all the same: Undo is offered, as on Review's saved screen, and takes it back.
		assert(await memorize.getByRole("button", { name: "Undo", exact: true }).count() === 1, "a save that sorted notes into topics offers Undo");
		await memorize.getByRole("button", { name: "Undo", exact: true }).click();
		await confirm("Undo this update of Memorize Room's memory?").getByRole("button", { name: "Undo", exact: true }).click({ timeout: 10_000 });
		await memorize.getByRole("heading", { name: "Undone." }).waitFor({ timeout: 30_000 });
		// After Undo the screen says only what is true: no "Saved" above it, and nothing counted from the undone save.
		const undoneText = await memorize.innerText();
		assert(!/\bSaved\b/.test(undoneText) && !/added or updated|Conversations\s*\d+ of \d+/i.test(undoneText) && !undoneText.includes(OPEN_CONVERSATION_LINE), `the undone screen keeps nothing of the save, got ${JSON.stringify(undoneText)}`);
		assert(/### Unsorted\n\n<!-- e: id=m-0101 [^\n]*-->\n- Invoices go out on the first working day\./.test(fs.readFileSync(memorizeRoom.l1bPath, "utf-8")), "Undo puts the sorted note back in Unsorted");
		console.log("  ok  Undo on Memorize's saved screen after a save that only sorted notes takes the sort back");
		await memorize.getByRole("button").filter({ hasText: /^Back to rooms$/ }).first().click();
		await page.waitForTimeout(400);
		if (await page.locator('[aria-label="Memory maintenance chooser"]').count()) await page.goBack();
		await card("Saved Room").waitFor({ timeout: 10_000 });

		// 5. Return Home from an ordinary saved Remember: Home, and nothing is written into the conversation the save closed.
		await card("Saved Room").getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		const composer = page.locator("textarea").first();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15_000 });
		await page.waitForTimeout(800);
		await composer.fill("We moved the launch to May.");
		await composer.press("Enter");
		await page.getByText("Answer from claude-fake.").waitFor({ timeout: 20_000 });
		await page.waitForTimeout(800);
		const closedId = await page.evaluate(async (id) => (await (await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/status`)).json()).activeThread?.threadId as string, savedRoom.agentId);
		const dialog = page.getByRole("dialog", { name: "Remember this conversation" });
		await page.getByRole("button", { name: "More ways to remember" }).click();
		await page.getByRole("menuitem", { name: "Remember with options…" }).click();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		await dialog.getByRole("button", { name: "Save to memory" }).click({ timeout: 20_000 });
		await dialog.getByText("Memory updated").waitFor({ timeout: 15_000 });
		const roomDir = path.join(agentsRoot, savedRoom.agentId);
		const closedFiles = () => new Map([...snapshot(roomDir)].filter(([file]) => file.includes(closedId)));
		const before = closedFiles();
		assert(before.size > 0, `the closed conversation has its file (${closedId})`);
		const toClosed: string[] = [];
		page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes(encodeURIComponent(closedId))) toClosed.push(`${request.method()} ${request.url()}`); });
		page.on("websocket", (socket) => socket.on("framesent", (frame) => { if (String(frame.payload).includes('"prompt"')) toClosed.push(`ws ${String(frame.payload).slice(0, 80)}`); }));
		await dialog.getByRole("button", { name: "Return Home" }).click();
		await card("Saved Room").waitFor({ timeout: 10_000 });
		await page.waitForTimeout(2_000);
		const after = closedFiles();
		assert(await page.locator(".system-line.error").count() === 0, "no red line on the way Home");
		assert(toClosed.length === 0, `nothing is sent to the closed conversation, got ${toClosed.join(" | ")}`);
		assert([...before].every(([file, sum]) => after.get(file) === sum) && after.size === before.size, "the closed conversation's files are unchanged after Return Home");
		console.log("  ok  Return Home from the ordinary saved page goes Home and leaves the closed conversation as it was");

		// 6. The Memory page: the saved page in plain words, and the page that holds only its date by its dated title.
		await page.evaluate(() => { window.location.hash = "#/memory"; });
		const memoryPage = page.locator("body");
		await memoryPage.getByText("Saved Room").first().click({ timeout: 15_000 });
		await memoryPage.getByText("Conversation of 2026-09-10", { exact: true }).first().waitFor({ timeout: 15_000 });
		const launch = page.locator(".mem-li").filter({ hasText: "The launch plan" });
		await launch.getByRole("button", { name: "Details" }).click();
		const details = launch.locator(".mem-prov-body");
		await details.getByText("The launch moves to May.").waitFor({ timeout: 10_000 });
		const words = await details.innerText();
		assert(/What happened/.test(words) && /What to keep/.test(words), `the saved page reads in plain labels, got ${JSON.stringify(words)}`);
		assert(!/Session arc|Body:|Parked|must-keep/i.test(words), `no stored labels or marker on the page, got ${JSON.stringify(words)}`);
		console.log("  ok  the Memory page shows a saved page in plain words, and a dated page by its dated title");

		// 7. A double Back during a discussion, then Keep discussing: the history is as it was, every entry kept.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Review Room").waitFor({ timeout: 10_000 });
		await openMaintain("Review Room", "Review");
		await review.getByRole("button", { name: "Discuss first" }).click({ timeout: 30_000 }).catch(() => {});
		if (!(await transcript.getByText("Keep the renewal notes short.").count())) {
			await review.getByPlaceholder("Your answer or instruction…").fill("Keep the renewal notes short.");
			await review.getByRole("button", { name: "Send" }).click();
		}
		await transcript.getByText("Noted: the renewal notes stay short.").first().waitFor({ timeout: 20_000 });
		const discussionHash = await hash();
		const entries = await page.evaluate(() => window.history.length);
		await page.evaluate(() => window.history.go(-2));
		await confirm("Leave Review?").getByRole("button", { name: "Keep discussing" }).click({ timeout: 10_000 });
		await waitUntil(async () => (await hash()) === discussionHash, "the address is the discussion's again", 5_000);
		await page.waitForTimeout(500);
		assert(await page.evaluate(() => window.history.length) === entries, `a refused double Back keeps every entry, got ${await page.evaluate(() => window.history.length)} of ${entries}`);
		await page.goBack();
		await confirm("Leave Review?").getByRole("button", { name: "Leave", exact: true }).click({ timeout: 10_000 });
		await card("Gone Room").waitFor({ timeout: 10_000 });
		console.log("  ok  a refused double Back keeps every history entry");
		// Leave on the confirm Back asked lands where Back went, with no entry added: Back from there never reopens Maintain.
		await page.waitForTimeout(500);
		assert(await page.evaluate(() => window.history.length) === entries && (await hash()) === "#/", `Leave goes where Back went, adding no entry, got ${await hash()} with ${await page.evaluate(() => window.history.length)} of ${entries}`);
		await page.goBack();
		await page.waitForTimeout(600);
		assert(await page.locator('[aria-label="Memory maintenance chooser"]').count() === 0 && !(await hash()).startsWith("#/maintain"), `Back from there does not reopen Maintain, got ${await hash()}`);
		console.log("  ok  Leave after Back lands where Back went, and the next Back does not reopen Maintain");


		// 8. Back onto the address of a room that is gone never keeps the person there: the next Back goes on.
		await page.evaluate(() => { window.location.hash = "#/memory"; });
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Gone Room").getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await waitUntil(async () => (await hash()) === `#/room/${goneRoom.agentId}`, "the room is open");
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Gone Room").waitFor({ timeout: 10_000 });
		const archived = await page.evaluate(async (id) => (await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: `DELETE ${id}` }) })).status, goneRoom.agentId);
		assert(archived < 300, `the room is archived, got ${archived}`);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await waitUntil(async () => (await card("Gone Room").count()) === 0, "Home no longer lists the room");
		for (let backs = 0; backs < 4 && (await hash()) !== "#/memory"; backs += 1) {
			await page.goBack();
			await page.waitForTimeout(600);
		}
		assert((await hash()) === "#/memory", `Back gets past the gone room's address, got ${await hash()}`);
		console.log("  ok  Back gets past the address of a room that is gone");

		// 9. The Scheduled tasks pane says plainly what each run waits for or why it ended, never the engine's words.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Tasks Room").getByRole("button", { name: "Room settings" }).click({ timeout: 10_000 });
		await page.getByRole("button", { name: "Scheduled tasks" }).first().click({ timeout: 10_000 });
		const runsPane = page.locator('[aria-label="Recent scheduled runs"]');
		await runsPane.getByText("Waits until the next conversation in this room has started.").waitFor({ timeout: 15_000 });
		await runsPane.getByText("A later run of this task took its place.").waitFor({ timeout: 5_000 });
		assert(await runsPane.getByText(/transient condition|rechecked before execution|prepared .*boundary/).count() === 0, "no engine words in the pane");
		console.log("  ok  the Scheduled tasks pane says what a run waits for, and that a later run took an older one's place");

		// 10. Every tidy call fails, with automatic maintenance on: the card says Review could not finish, offers Try again and Close, and nothing is recorded.
		await page.keyboard.press("Escape");
		await page.locator(".settings-dialog-backdrop").waitFor({ state: "detached", timeout: 10_000 });
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Failing Room").waitFor({ timeout: 10_000 });
		const tidyCallsAtStart = calls.filter((kind) => kind === "tidy").length;
		await openMaintain("Failing Room", "Review");
		const failing = page.locator('[aria-label="Review workflow"]');
		const reviewRequests: string[] = [];
		page.on("request", (request) => { if (request.method() === "POST" && /\/review\/runs(\/[^/]+\/resume)?$/.test(new URL(request.url()).pathname)) reviewRequests.push(new URL(request.url()).pathname.endsWith("/resume") ? "resume" : "start"); });
		const notFinished = failing.getByRole("heading", { name: "Review could not finish." });
		const continueRead = failing.getByRole("button", { name: "Continue →" });
		await Promise.race([notFinished.waitFor({ timeout: 60_000 }), continueRead.waitFor({ timeout: 60_000 }).then(() => continueRead.click())]);
		await notFinished.waitFor({ timeout: 60_000 });
		const failingText = await failing.innerText();
		assert(failingText.includes("The Memory model could not tidy Renewals this time, so it was left as it was. Nothing was lost. Try again; if it repeats, choose another model.") && !/already tidy|Nothing needed changing/.test(failingText), `the card says the tidy could not finish, got ${JSON.stringify(failingText)}`);
		assert(!failingText.includes("Step 2 of 2"), `no step line names a change over a card that changed nothing, got ${JSON.stringify(failingText)}`);
		assert(await failing.getByRole("button", { name: /^Save/ }).count() === 0, "there is nothing to save, so no Save");
		assert(await failing.getByRole("button", { name: "Choose another model", exact: true }).count() === 1, "the card's way to another model is a button");
		const tidyCallsBefore = calls.filter((kind) => kind === "tidy").length - tidyCallsAtStart;
		const readCallsBefore = calls.filter((kind) => kind === "review-read").length;
		await failing.getByRole("button", { name: "Try again", exact: true }).click();
		const tidyCalls = () => calls.filter((kind) => kind === "tidy").length - tidyCallsAtStart;
		await waitUntil(async () => tidyCalls() >= tidyCallsBefore * 2, "Try again tidies Renewals again");
		await notFinished.waitFor({ timeout: 60_000 });
		assert(tidyCallsBefore > 0 && tidyCalls() === tidyCallsBefore * 2 && calls.filter((kind) => kind === "review-read").length === readCallsBefore, `Try again asks only for the topic left, as many calls as the first tidy and no first read, got ${calls.join(",")}`);
		assert(reviewRequests.join(",") === "start,resume", `Try again goes on with the same run, got ${reviewRequests.join(",")}`);
		assert((await failing.innerText()).includes("The Memory model could not tidy Renewals this time"), "a second failure gives the same card, with the topic named");
		await failing.getByRole("button", { name: "Close", exact: true }).click();
		await waitUntil(async () => (await failing.count()) === 0, "Close leaves Review");
		assert(await page.getByRole("dialog", { name: "Stop this tidy?" }).count() === 0, "Close asks nothing: nothing could be lost");
		const failingMemory = fs.readFileSync(failingRoom.l1bPath, "utf-8");
		assert(!/Last review/.test(failingMemory) && failingMemory.includes("and the renewal is in May"), "no review is stamped and the notes are as they were");
		const reviewEvents = path.join(agentsRoot, failingRoom.agentId, "events", "review");
		const recorded = fs.existsSync(reviewEvents) ? fs.readdirSync(reviewEvents) : [];
		assert(recorded.length === 0, `no review is recorded, got ${JSON.stringify(recorded)}`);
		console.log("  ok  a Review whose tidy calls all failed says it could not finish, tries the topic left again on the same run, closes, and records nothing");

		// 10b. Every tidy fails in a room over its budget, and the person raises the budget on the card: the raise is something to save, as on Memorize's card.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Over Budget Room").waitFor({ timeout: 10_000 });
		await openMaintain("Over Budget Room", "Review");
		const overBudget = page.locator('[aria-label="Review workflow"]');
		const overBudgetCard = overBudget.getByRole("heading", { name: "Review could not finish." });
		const overBudgetContinue = overBudget.getByRole("button", { name: "Continue →" });
		await Promise.race([overBudgetCard.waitFor({ timeout: 60_000 }), overBudgetContinue.waitFor({ timeout: 60_000 }).then(() => overBudgetContinue.click())]);
		await overBudgetCard.waitFor({ timeout: 60_000 });
		const raise = overBudget.getByRole("button", { name: /^Raise the budget to \d+k/ });
		await overBudget.locator(".absorb-run-archive summary").click();
		await raise.waitFor({ timeout: 10_000 });
		const raisedTo = Number(/(\d+)k/.exec(await raise.innerText())![1]) * 1000;
		await raise.click();
		await waitUntil(async () => (await overBudget.getByText(/notes? going to the archive/).count()) === 0, "the card takes the raised budget: nothing goes to the archive");
		const save = overBudget.getByRole("button", { name: /^Save/ });
		assert(await save.count() === 1 && await overBudget.getByRole("button", { name: "Close", exact: true }).count() === 0, `a raised budget is something to save, so Save stays and Close would not drop it, got ${JSON.stringify(await overBudget.innerText())}`);
		await save.click();
		await confirm(`Save these changes to Over Budget Room's memory?`).getByRole("button", { name: /^Save/ }).click();
		await overBudget.getByText("The memory budget was raised with this save.").waitFor({ timeout: 20_000 });
		const { readPersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
		assert(readPersistentRoomMaintenanceSettings(overBudgetRoom.agentId).memoryBudgetTokens === raisedTo, `the saved raise is the room's budget, got ${readPersistentRoomMaintenanceSettings(overBudgetRoom.agentId).memoryBudgetTokens} for ${raisedTo}`);
		console.log("  ok  a budget raised on a Review card whose every tidy failed is kept: Save stays, and saving makes it the room's budget");

		// 11. Memorize with its Memory model signed out: the notice at once, in place of "No first read" and its Continue.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Signed-out Room").waitFor({ timeout: 10_000 });
		await openMaintain("Signed-out Room", "Memorize");
		const signedOut = page.locator('[aria-label="Memory absorption workflow"]');
		await signedOut.locator(".model-notice").waitFor({ timeout: 30_000 });
		assert(await signedOut.getByText(/No first read this time/).count() === 0, "the notice replaces the No first read line");
		assert(await signedOut.getByRole("button", { name: "Continue →" }).count() === 0 && await signedOut.getByRole("button", { name: "Read again" }).count() === 0, "and its Continue and Read again");
		const noticeButtons = await signedOut.locator(".model-notice button").allInnerTexts();
		assert(!noticeButtons.includes("Try again") && noticeButtons.includes("Choose another model") && noticeButtons.length >= 2, `signed out: no Try again, which would fail the same way; the sign-in way and Choose another model, got ${JSON.stringify(noticeButtons)}`);
		await signedOut.locator(".model-notice").getByRole("button", { name: "Choose another model" }).click();
		await page.locator(".settings-dialog-backdrop").waitFor({ timeout: 10_000 });
		await page.keyboard.press("Escape");
		await page.locator(".settings-dialog-backdrop").waitFor({ state: "detached", timeout: 10_000 });
		assert(await signedOut.locator(".model-notice").getByRole("button", { name: "Try again" }).count() === 1, "after Choose another model, Try again is the way on");
		assert(await signedOut.getByText("The Quillfeather call").count() === 1, "the waiting conversations stay listed under the notice");
		console.log("  ok  Memorize with its Memory model signed out shows the notice at once, with the sign-in way and no Try again, and the conversations listed");

		// 12. Read again asks the model again, on both screens, even when the first read had nothing missing.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Read Again Room").waitFor({ timeout: 10_000 });
		await openMaintain("Read Again Room", "Memorize");
		const readAgainMemorize = page.locator('[aria-label="Memory absorption workflow"]');
		await readAgainMemorize.getByRole("button", { name: "Read again", exact: true }).waitFor({ timeout: 30_000 });
		const memorizeReads = calls.filter((kind) => kind === "memorize-read").length;
		await readAgainMemorize.getByRole("button", { name: "Read again", exact: true }).click();
		await waitUntil(async () => calls.filter((kind) => kind === "memorize-read").length > memorizeReads, "Memorize's Read again asks the model");
		await readAgainMemorize.getByRole("button", { name: "Read again", exact: true }).waitFor({ timeout: 30_000 });
		await readAgainMemorize.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(async () => (await readAgainMemorize.count()) === 0, "Cancel leaves Memorize");
		await openMaintain("Read Again Room", "Review");
		const readAgainReview = page.locator('[aria-label="Review workflow"]');
		await readAgainReview.getByRole("button", { name: "Read again", exact: true }).waitFor({ timeout: 30_000 });
		const reviewReads = calls.filter((kind) => kind === "review-read").length;
		await readAgainReview.getByRole("button", { name: "Read again", exact: true }).click();
		await waitUntil(async () => calls.filter((kind) => kind === "review-read").length > reviewReads, "Review's Read again asks the model");
		await readAgainReview.getByRole("button", { name: "Read again", exact: true }).waitFor({ timeout: 30_000 });
		await readAgainReview.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(async () => (await readAgainReview.count()) === 0, "Cancel leaves Review");
		console.log("  ok  Read again asks the model again on Memorize and on Review");

		// 13. Cancel during a first read that waits out a failing model ends the wait: nothing is called after it.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Waiting Room").waitFor({ timeout: 10_000 });
		await openMaintain("Waiting Room", "Memorize");
		const waitingMemorize = page.locator('[aria-label="Memory absorption workflow"]');
		await waitUntil(async () => waitingRoomReads > 0, "the first read meets the failing model");
		await page.waitForTimeout(1_000);
		await waitingMemorize.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(async () => (await waitingMemorize.count()) === 0, "Cancel leaves Memorize");
		const readsAtCancel = waitingRoomReads;
		await page.waitForTimeout(20_000);
		assert(waitingRoomReads === readsAtCancel, `no call after Cancel, got ${waitingRoomReads - readsAtCancel} more`);
		console.log("  ok  Cancel during a first read's wait ends it, with no call after");

		// 14. A reload during a first read never ends it: the reloaded page joins the read in flight, and the model is asked once.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Slow Room").waitFor({ timeout: 10_000 });
		await openMaintain("Slow Room", "Memorize");
		await waitUntil(() => slowCount("Brightwater memorize-read") > 0, "the first read reaches the model");
		await page.reload({ waitUntil: "domcontentloaded" });
		const slowMemorize = page.locator('[aria-label="Memory absorption workflow"]');
		await page.waitForTimeout(1_000);
		if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();
		if (!(await slowMemorize.count())) {
			await page.evaluate(() => { window.location.hash = "#/"; });
			await card("Slow Room").waitFor({ timeout: 10_000 });
			await openMaintain("Slow Room", "Memorize");
		}
		await slowMemorize.getByRole("button", { name: "Read again", exact: true }).waitFor({ timeout: 30_000 });
		assert(slowCount("Brightwater memorize-read") === 1, `the reloaded page joins the read in flight: the model is asked once, got ${slowCount("Brightwater memorize-read")}`);
		await slowMemorize.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(async () => (await slowMemorize.count()) === 0, "Cancel leaves Memorize");
		// A proxy that cuts a long first read off: the page shows no first read, and Read again joins the read still being made.
		const proxyAssess = `**/api/persistent-agents/${proxyRoom.agentId}/absorb/assess`;
		let proxyAsks = 0;
		await page.route(proxyAssess, async (route) => {
			proxyAsks += 1;
			if (proxyAsks > 1) return route.continue();
			void route.fetch().catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			await route.fulfill({ status: 504, contentType: "text/html", body: "<html><body>Gateway Timeout</body></html>" });
		});
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Proxy Room").waitFor({ timeout: 10_000 });
		await openMaintain("Proxy Room", "Memorize");
		const proxyMemorize = page.locator('[aria-label="Memory absorption workflow"]');
		await proxyMemorize.getByText(/No first read this time/).waitFor({ timeout: 15_000 });
		assert(slowCount("Ravensholt memorize-read") === 1, `the cut-off request's read goes on on the server, got ${slowCount("Ravensholt memorize-read")} reads`);
		await proxyMemorize.getByRole("button", { name: "Read again", exact: true }).click();
		await waitUntil(async () => (await proxyMemorize.getByText(/No first read this time/).count()) === 0 && (await proxyMemorize.getByRole("button", { name: "Read again", exact: true }).count()) === 1, "the first read lands", 30_000);
		assert(slowCount("Ravensholt memorize-read") === 1, `Read again after a cut-off request joins the read still being made, got ${slowCount("Ravensholt memorize-read")} reads`);
		await page.unroute(proxyAssess);
		await proxyMemorize.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(async () => (await proxyMemorize.count()) === 0, "Cancel leaves Memorize");
		// The read a cut request left running is still the page's: Cancel ends it on the server, as it ends any first read.
		const cutAssess = `**/api/persistent-agents/${cutRoom.agentId}/absorb/assess`;
		let cutAsks = 0;
		await page.route(cutAssess, async (route) => {
			cutAsks += 1;
			if (cutAsks > 1) return route.continue();
			void route.fetch().catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			await route.fulfill({ status: 504, contentType: "text/html", body: "<html><body>Gateway Timeout</body></html>" });
		});
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Cut Room").waitFor({ timeout: 10_000 });
		await openMaintain("Cut Room", "Memorize");
		const cutMemorize = page.locator('[aria-label="Memory absorption workflow"]');
		await cutMemorize.getByText(/No first read this time/).waitFor({ timeout: 15_000 });
		await cutMemorize.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(() => slowReadsCut.includes("Pembertine memorize-read"), "Cancel after a cut request ends its read on the server", 2_500);
		await page.unroute(cutAssess);
		// Cancel during Review's first read ends it on the server: the model's answer is not waited for.
		await openMaintain("Slow Room", "Review");
		const slowReview = page.locator('[aria-label="Review workflow"]');
		await waitUntil(() => slowCount("Brightwater review-read") > 0, "Review's first read reaches the model");
		await slowReview.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(() => slowReadsCut.includes("Brightwater review-read"), "Cancel ends Review's first read on the server", 3_000);
		assert(slowCount("Brightwater review-read") === 1 && slowReadsCut.join(",") === "Pembertine memorize-read,Brightwater review-read", `one Review read, ended by Cancel; only the cancelled reads were cut, got ${JSON.stringify({ slowReads, slowReadsCut })}`);
		console.log("  ok  a reload or a proxy's cut during a first read joins the read in flight, with one call; Cancel ends a first read on the server, a cut one included");

		// 15. A Review card a closed tab left ready waits behind the chooser, and Review opens it. The page then holds
		// no guidance of its own, as after a reload: Try again after the save still asks with the run's guidance.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Guided Room").waitFor({ timeout: 10_000 });
		const roomApi = `/api/persistent-agents/${encodeURIComponent(guidedRoom.agentId)}/review/runs`;
		const guidance = { keepAsIs: [], shorten: [], remove: [], answers: [], instructions: ["Keep the renewal notes short."], topics: [] };
		const leftBehind = await page.evaluate(async ({ url, guidance }) => {
			const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ depth: "wording", topics: ["Renewals", "Suppliers"], guidance }) });
			return { status: res.status, runId: String((await res.json()).runId ?? "") };
		}, { url: roomApi, guidance });
		assert(leftBehind.status === 202 && leftBehind.runId, `the tidy starts, got ${JSON.stringify(leftBehind)}`);
		const leftState = () => page.evaluate(async (url) => String((await (await fetch(url)).json()).state), `${roomApi}/${leftBehind.runId}`);
		await waitUntil(async () => (await leftState()) === "ready", "the tidy nobody watches reaches its card", 60_000);
		await card("Guided Room").getByRole("button", { name: "Maintain", exact: true }).click();
		const chooser = page.locator('[aria-label="Memory maintenance chooser"]');
		await chooser.waitFor({ timeout: 10_000 });
		await page.waitForTimeout(2_500);
		const guided = page.locator('[aria-label="Review workflow"]');
		assert(await guided.count() === 0 && await chooser.count() === 1, "a ready Review card left behind is not opened by Maintain on its own: the chooser stays");
		await chooser.locator(".maintain-action").filter({ hasText: "Review" }).first().click();
		await guided.getByRole("heading", { name: "1 topic tidied." }).waitFor({ timeout: 20_000 });
		await guided.getByRole("button", { name: "Save to memory" }).click();
		await confirm("Save these changes to Guided Room's memory?").getByRole("button", { name: "Save", exact: true }).click({ timeout: 10_000 });
		await guided.getByRole("heading", { name: "Guided Room tidied its memory." }).waitFor({ timeout: 30_000 });
		const again = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/review/runs"), { timeout: 10_000 });
		await guided.getByRole("button", { name: "Try again", exact: true }).click();
		const asked = JSON.parse((await again).postData() ?? "{}");
		assert(JSON.stringify(asked.topics) === '["Suppliers"]' && JSON.stringify(asked.guidance?.instructions) === JSON.stringify(guidance.instructions), `Try again on the saved screen asks for the topic left with the saved run's guidance, got ${JSON.stringify(asked)}`);
		await guided.getByRole("heading", { name: "Review could not finish." }).waitFor({ timeout: 60_000 });
		await guided.getByRole("button", { name: "Close", exact: true }).click();
		await waitUntil(async () => (await guided.count()) === 0, "Close leaves Review");
		console.log("  ok  a ready Review card left behind waits behind the chooser, and Try again after its save keeps the run's guidance");

		// 16. Back on a Memorize run opened because it was waiting stops it and shows the first read, not the discussion.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Waiting Card Room").waitFor({ timeout: 10_000 });
		await openMaintain("Waiting Card Room", "Memorize");
		const waitingCard = page.locator('[aria-label="Memory absorption workflow"]');
		await waitingCard.getByRole("button", { name: "Continue →" }).click({ timeout: 30_000 });
		const leftSave = waitingCard.getByRole("button", { name: /^Save (to memory|over the budget)$/ });
		await waitUntil(async () => (await leftSave.count()) === 1 && (await leftSave.isEnabled()), "the update reaches its card", 60_000);
		// The reload reopens Maintain from the address, and the update waiting on its card opens at once.
		await page.reload();
		await waitingCard.getByRole("button", { name: "Back", exact: true }).first().click({ timeout: 30_000 });
		const discussionBox = waitingCard.getByPlaceholder("Your answer or instruction…");
		await waitingCard.getByRole("button", { name: "Discuss first" }).or(discussionBox).first().waitFor({ timeout: 30_000 });
		assert(await discussionBox.count() === 0 && await waitingCard.getByRole("button", { name: "Continue →" }).count() === 1, "Back on an update opened because it was waiting shows the first read, not the discussion");
		await waitingCard.getByRole("button", { name: "Cancel", exact: true }).first().click();
		await waitUntil(async () => (await waitingCard.count()) === 0, "Cancel leaves Memorize");
		console.log("  ok  Back on a Memorize update opened because it was waiting shows the first read");

		// 17. Read again that ends on the notice keeps the waiting conversations listed under it, as the first open does.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Flaky Key Room").waitFor({ timeout: 10_000 });
		await openMaintain("Flaky Key Room", "Memorize");
		const flaky = page.locator('[aria-label="Memory absorption workflow"]');
		await flaky.getByRole("button", { name: "Read again", exact: true }).click({ timeout: 30_000 });
		await flaky.locator(".model-notice").waitFor({ timeout: 30_000 });
		assert(flakyKeyReads >= 2 && await flaky.getByText("The Ostrander call").count() === 1, `the waiting conversation stays listed under the notice after Read again, got ${flakyKeyReads} reads and ${JSON.stringify(await flaky.innerText())}`);
		console.log("  ok  Read again that ends on the notice keeps the waiting conversations listed");

		// 18. Save on a card another window is tidying again says so, and a reload follows that tidy here;
		// Save on a card another window cancelled says the tidy is no longer open.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await card("Busy Card Room").waitFor({ timeout: 10_000 });
		const busyRuns = `/api/persistent-agents/${encodeURIComponent(busyCardRoom.agentId)}/review/runs`;
		const busyStart = await page.evaluate(async (url) => {
			const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ depth: "wording", topics: ["Renewals", "Warehouse"] }) });
			return { status: res.status, runId: String((await res.json()).runId ?? "") };
		}, busyRuns);
		assert(busyStart.status === 202 && busyStart.runId, `the tidy starts, got ${JSON.stringify(busyStart)}`);
		const busyRun = `${busyRuns}/${busyStart.runId}`;
		const busyState = () => page.evaluate(async (url) => String((await (await fetch(url)).json()).state), busyRun);
		await waitUntil(async () => (await busyState()) === "ready", "the tidy reaches its card", 60_000);
		await openMaintain("Busy Card Room", "Review");
		const busy = page.locator('[aria-label="Review workflow"]');
		await busy.getByRole("heading", { name: "1 topic tidied." }).waitFor({ timeout: 20_000 });
		// Another window presses Try again: the warehouse note is tidied again, slowly.
		kestrelTidyWaits = true;
		const resumed = await page.evaluate(async (url) => (await fetch(url, { method: "POST" })).status, `${busyRun}/resume`);
		assert(resumed === 200 && (await busyState()) === "tidying", `another window's Try again tidies again, got ${resumed}`);
		await busy.getByRole("button", { name: /^Save/ }).click();
		await confirm("Save these changes to Busy Card Room's memory?").getByRole("button", { name: "Save", exact: true }).click({ timeout: 10_000 });
		await busy.getByText("This tidy is being worked on in another window, so nothing was saved here. Finish it there, or reload this page to follow it here.").waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`Save on a card another window is tidying says so, got ${JSON.stringify(await busy.innerText())}`); });
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitUntil(async () => (await busy.count()) === 1, "the reload follows the tidy still at work here", 8_000);
		assert((await busyState()) === "tidying", "the page followed the tidy while it was still at work");
		kestrelTidyWaits = false;
		await busy.getByRole("heading", { name: "1 topic tidied." }).waitFor({ timeout: 30_000 });
		// Another window cancels it: Save here says the tidy is no longer open.
		await page.evaluate(async (url) => { await fetch(url, { method: "POST" }); }, `${busyRun}/cancel`);
		await busy.getByRole("button", { name: /^Save/ }).click();
		await confirm("Save these changes to Busy Card Room's memory?").getByRole("button", { name: "Save", exact: true }).click({ timeout: 10_000 });
		await busy.getByText("This tidy is no longer open, so nothing was saved. Start Review again to read the notes as they are now.").waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`Save on a card another window cancelled says it is no longer open, got ${JSON.stringify(await busy.innerText())}`); });
		console.log("  ok  Save on a card another window is working on says so and a reload follows it here; on one another window cancelled, that it is no longer open");

		// 19. A gateway's bare 403 on Review's first read, on a shared server and on a paired phone: the buttons the chat's line has there.
		// On a shared server the key is the admin's: no Replace key into the locked AI setup. A paired phone shows what the chat shows there.
		for (const [where, viewer, expected] of [["shared", { remote: false, capability: "full", sharedServer: true }, "Choose another model"], ["paired", { remote: true, capability: "full", sharedServer: false }, "Replace key|Choose another model"]] as const) {
			const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			await viewerContext.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(viewer) }));
			await viewerContext.route(/\/review\/assess$/, (route) => route.request().method() !== "POST" ? route.fallback() : route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Acme Model refused this request: the gateway may not accept the saved key, or the model may not be offered to you. Nothing was lost.", code: "model_unreachable", details: { detail: "gateway-refused", provider: "acme-gw", model: "acme-model", key: "refused" } }) }));
			const viewerPage = await viewerContext.newPage();
			await viewerPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await viewerPage.waitForLoadState("networkidle");
			const close = viewerPage.locator(".whats-new-close");
			if (await close.count()) await close.click();
			await viewerPage.locator(".persistent-agent-card").filter({ hasText: "Read Again Room" }).getByRole("button", { name: "Maintain", exact: true }).click();
			await viewerPage.locator(".maintain-action").filter({ hasText: "Review" }).first().click();
			const notice = viewerPage.locator('[aria-label="Review workflow"] .model-notice');
			await notice.waitFor({ timeout: 20_000 });
			const shown = (await notice.locator(".rs-btn").allInnerTexts()).map((text) => text.trim()).join("|");
			assert(shown === expected, `${where}: a gateway's bare 403 on Review's first read offers ${expected}, got ${shown}`);
			await viewerContext.close();
		}
		console.log("  ok  a gateway's bare 403 on a memory screen: no Replace key on a shared server; a paired phone shows the chat's buttons");
	} finally {
		await browser.close();
	}
	console.log("maintain flows smoke: ok");
} catch (error) {
	console.error(`provider calls: ${calls.join(",")}`);
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
