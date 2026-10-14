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
// only its date by its dated title. Offline: one synthetic provider.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

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
const port = 27000 + Math.floor(Math.random() * 10000);
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
		if (kind === "review-read" && busyReviewReads > 0) {
			busyReviewReads -= 1;
			res.writeHead(529, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const model = String(body.model);
		sse(res, "message_start", { type: "message_start", message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
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
		const dismiss = page.locator(".whats-new-foot .btn-primary");
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
		await memorize.getByRole("heading", { name: /^Memorize Room memorized/ }).waitFor({ timeout: 30_000 });
		assert(await memorize.getByText(OPEN_CONVERSATION_LINE, { exact: true }).count() === 1, "Memorize's saved screen says the open conversation keeps the memory it started with");
		await checkSavedPage(memorize, "Memorize");
		const memorized = fs.readFileSync(memorizeRoom.l1bPath, "utf-8");
		assert(/### Invoicing\n\n<!-- e: id=m-0101 [^\n]*-->\n- Invoices go out on the first working day\./.test(memorized) && !/^### Unsorted$/m.test(memorized), "the moved note is saved under the topic the person gave it");
		console.log("  ok  the Memorize card shows the sorted note, Move moves it, and Save keeps it there");
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
