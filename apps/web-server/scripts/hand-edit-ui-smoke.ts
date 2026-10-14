// Typed text never fails, in the page: the browser half of the hand-edit
// battery, against the real server and one synthetic provider.
//
// A card edit the server refuses keeps its editor and the person's words, with
// the reason under the note. Closing Remember's dialog and opening it again
// keeps the edits. Every editor says its limit before Save. And a save whose
// answer is lost (the server saved, the page never heard: route.fetch(), then
// an abort or a 502 with no body) says the connection dropped, never that
// nothing was saved and never the raw error; once the server answers again the
// page shows what is true, and nothing is saved twice.
//
// HAND_EDIT_SHOTS=<folder> also writes the screenshots for the guide.
// Offline: one synthetic provider.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page, type Route } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip whole.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("hand-edit ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 41000 + Math.floor(Math.random() * 9000);
const baseUrl = `http://127.0.0.1:${port}`;
const shotsDir = process.env.HAND_EDIT_SHOTS ? path.resolve(process.env.HAND_EDIT_SHOTS) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-hand-edit-ui-"));
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
const LOST = "The connection dropped while saving. Checking whether it was saved…";
const NOT_LANDED = "It was not saved. Save again.";
const NOTHING_SAVED = /Nothing was saved|Your memory is unchanged|memory is unchanged|Failed to fetch|Load failed|NetworkError|\(502\)|Memory changed while/;

// --- The provider ------------------------------------------------------------------

const REMEMBER_PAGE = "TITLE:\nThe exam plan\n\nSESSION_ARC:\nWe planned the exam.\n\nBODY:\n- The exam is in May.\n\nPARKED:\n- The fee is still unpaid.\n";
const REVIEW_FIRST_READ = "## First read\n\n### Could be shorter\n- Exam booking says one thing twice.\n\n### Looks stale or contradicts itself\n- None\n\n### Needs your call\nNone\n\n### Topics to tidy\nExam booking\n";
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

// A conversation the Memory model finds nothing in to keep: What to keep comes back with no words.
const NOTHING_TO_KEEP_CHAT = "Just saying hello, nothing to keep.";
const REMEMBER_PAGE_EMPTY = "TITLE:\nA hello\n\nSESSION_ARC:\nWe said hello.\n\nBODY:\n- …\n\nPARKED:\nNone\n";

function replyFor(prompt: string): string {
	if (prompt.includes("Checkpoint Compression Constitution")) return prompt.includes(NOTHING_TO_KEEP_CHAT) ? REMEMBER_PAGE_EMPTY : REMEMBER_PAGE;
	if (prompt.includes("## Task: First read of these notes")) return REVIEW_FIRST_READ;
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

// --- The results table ---------------------------------------------------------------

const rows: Array<{ name: string; ok: boolean; detail: string }> = [];
// HAND_EDIT_DEBUG=<folder>: a screenshot of the page at each failure.
const debugDir = process.env.HAND_EDIT_DEBUG ? path.resolve(process.env.HAND_EDIT_DEBUG) : null;
let debugPage: Page | null = null;
async function check(name: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
		rows.push({ name, ok: true, detail: "" });
		console.log(`  ok  ${name}`);
	} catch (error) {
		if (debugDir && debugPage) {
			fs.mkdirSync(debugDir, { recursive: true });
			await debugPage.screenshot({ path: path.join(debugDir, `${rows.length + 1}.png`) }).catch(() => {});
		}
		rows.push({ name, ok: false, detail: (error as Error).message.split("\n")[0].slice(0, 300) });
		console.log(`  FAIL ${name}: ${(error as Error).message.split("\n")[0].slice(0, 300)}`);
	}
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Promise.resolve().then(predicate).catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
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
	const note = (id: string, text: string) => `<!-- e: id=${id} kind=fact saved=2026-09-01 -->\n${text}\n`;
	const page0 = [`### RC-0001 | CLOSED | 2026-09-11 | The exam call`, "", "**Session arc:** We went through the exam.", "", "**Body:**", "- The exam is in May.", "", "**Parked:**", "None", ""].join("\n");
	/** A room with two topics and several notes, an open item, and the given pages waiting. */
	const createRoom = (name: string, pages: string[] = []) => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: MODEL, memory: MODEL });
		const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
		const head = fs.readFileSync(l1bPath, "utf-8");
		const chronos = /^## Chronos[\s\S]*?(?=^## )/m.exec(head)?.[0] ?? "";
		const deep = [
			"## Deep Memory", "", "<!-- entries: next=200 -->", "",
			"### Billing", "", note("m-0011", "- Invoices go out on the first."), note("m-0012", "- Late invoices get a reminder."),
			"### Exam booking", "", note("m-0021", "- The exam portal opens in March."), note("m-0022", "- Alpha note: the exam room is booked."),
			"## Active Items", "", "<!-- e: id=m-0031 kind=item saved=2026-09-01 status=open -->", "- Send the draft to legal.", "",
			"## Recent Context", "", ...pages,
		].join("\n");
		fs.writeFileSync(l1bPath, `<!-- exxeta:l1b schema_version=1 -->\n\n${chronos}${deep}\n`, "utf-8");
		return { agentId, l1bPath, name };
	};
	const rooms = {
		memorize: createRoom("Memorize Room", [page0]),
		review: createRoom("Review Room", [page0]),
		remember: createRoom("Remember Room"),
		rememberTyped: createRoom("Typed Keep Room"),
		openPane: createRoom("Conversation Open Room"),
		pane: createRoom("Pane Room"),
	};
	// A started conversation is open in this room: it keeps the memory it started with.
	agents.writePersistentAgentThread(rooms.openPane.agentId, "pi_started_0001", { state: "active", origin: "home", model: MODEL, items: [{ kind: "user", id: "u1", text: "A question." }, { kind: "assistant", id: "a1", text: "An answer." }] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: rooms.openPane.agentId, threadId: "pi_started_0001", model, cwd: tempRoot }),
	});
	const fileOf = (room: { l1bPath: string }) => fs.readFileSync(room.l1bPath, "utf-8");
	const count = (text: string, needle: string) => text.split(needle).length - 1;

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);

	const browser = await chromium.launch();
	try {
		const page: Page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		debugPage = page;
		if (debugDir) {
			page.on("requestfailed", (request) => { if (/\/memory\/|\/checkpoint\//.test(request.url())) console.log(`    [net] failed ${request.method()} ${request.url().replace(baseUrl, "")} ${request.failure()?.errorText}`); });
			page.on("requestfinished", async (request) => { if (/\/memory\/|\/checkpoint\//.test(request.url())) console.log(`    [net] ${(await request.response())?.status()} ${request.method()} ${request.url().replace(baseUrl, "")}`); });
			page.on("console", (message) => { if (message.type() === "error") console.log(`    [console] ${message.text().slice(0, 200)}`); });
		}

		// --- The network, as a test controls it ----------------------------------------
		// `offline` drops every API request, as a dropped connection does. A
		// one-shot `lose` lets the matching request reach the server, which saves,
		// then loses its answer: an abort, or a proxy's 502 with no body.
		let offline = false;
		const losses: Array<{ method: string; url: RegExp; how: "abort" | "502" | { respond: { status: number; body: unknown } }; hit?: () => void }> = [];
		await page.route("**/api/**", async (route: Route) => {
			const request = route.request();
			const loss = losses.find((candidate) => candidate.method === request.method() && candidate.url.test(request.url()));
			if (loss) {
				losses.splice(losses.indexOf(loss), 1);
				if (typeof loss.how === "object") {
					await route.fulfill({ status: loss.how.respond.status, contentType: "application/json", body: JSON.stringify(loss.how.respond.body) });
					loss.hit?.();
					return;
				}
				await route.fetch();
				offline = true;
				loss.hit?.();
				if (loss.how === "abort") await route.abort("connectionreset");
				else await route.fulfill({ status: 502, body: "" });
				return;
			}
			if (offline) return route.abort("connectionrefused");
			return route.continue();
		});
		/** The next matching request saves on the server and its answer is lost; resolves when it has been sent. */
		const loseNext = (method: string, url: RegExp, how: "abort" | "502") => {
			const sent = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`the page never sent ${method} ${url}`)), 15_000);
				losses.push({ method, url, how, hit: () => { clearTimeout(timer); resolve(); } });
			});
			// A check that failed before it waits for the request leaves this unread.
			sent.catch(() => {});
			return sent;
		};
		const shot = async (name: string, target: Page | Locator = page) => {
			if (!shotsDir) return;
			await (target as Locator).screenshot({ path: path.join(shotsDir, `${name}.png`) }).catch(() => {});
		};
		/** While offline: the honest line, never that nothing was saved, never the raw error. Then the connection comes back. */
		const honestWhileLost = async (screen: Locator, shotName: string) => {
			await screen.getByText(LOST).first().waitFor({ timeout: 10_000 }).catch(async () => {
				// The page as it was before the fix: what the person read instead.
				await page.waitForTimeout(1_500);
				await shot(shotName, screen);
				throw new Error(`the lost-answer line shows, got ${JSON.stringify((await screen.innerText()).slice(0, 400))}`);
			});
			const text = await screen.innerText();
			assert(!NOTHING_SAVED.test(text), `no line says nothing was saved and no raw error shows, got ${JSON.stringify(text.match(NOTHING_SAVED)?.[0])}`);
			await shot(shotName, screen);
			offline = false;
		};

		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();
		const card = (name: string) => page.locator(".persistent-agent-card").filter({ hasText: name });
		const openMaintain = async (room: string, flow: "Memorize" | "Review") => {
			if (!(await page.locator('[aria-label="Memory maintenance chooser"]').count())) await card(room).getByRole("button", { name: "Maintain", exact: true }).click();
			await page.locator(".maintain-action").filter({ hasText: flow }).first().click();
		};
		/** Each surface starts from Home with the connection up, so one surface's failure never blocks the next. */
		page.on("dialog", (prompt) => void prompt.accept());
		const home = async () => {
			offline = false;
			losses.length = 0;
			await page.goto("about:blank");
			await page.goto(`${baseUrl}/#/`);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15_000 });
		};
		/** A change row found by its words, held by its place: an open editor's words are not the row's text. */
		const changeRow = (screen: Locator, words: string) => screen.locator(".absorb-run-change").filter({ hasText: words }).first();
		const heldRow = async (screen: Locator, words: string, rowClass = ".absorb-run-change") => {
			const all = screen.locator(rowClass);
			await all.filter({ hasText: words }).first().waitFor({ timeout: 10_000 });
			const n = await all.count();
			for (let i = 0; i < n; i++) if ((await all.nth(i).innerText()).includes(words)) return all.nth(i);
			throw new Error(`no change row holds ${JSON.stringify(words)}`);
		};

		// --- 1. The Memorize card ---------------------------------------------------------
		const memorize = page.locator('[aria-label="Memory absorption workflow"]');
		let memorizeReady = false;
		await check("Memorize: the card opens with the update's notes", async () => {
			await openMaintain(rooms.memorize.name, "Memorize");
			await memorize.getByRole("button", { name: "Continue →" }).click({ timeout: 30_000 });
			const saveRun = memorize.getByRole("button", { name: /^Save (to memory|over the budget)$/ });
			await waitUntil(async () => (await saveRun.count()) === 1 && (await saveRun.isEnabled()), "the card offers Save", 90_000);
			// The conversation's changes start folded.
			await memorize.locator("details.absorb-run-conversation > summary").filter({ hasText: "The exam call" }).first().click();
			await changeRow(memorize, "Fold note alpha").waitFor({ timeout: 10_000 });
			memorizeReady = true;
		});

		await check("Memorize card: a refused edit keeps the editor and the words, with the reason under the note", async () => {
			assert(memorizeReady, "the card is open");
			const row = await heldRow(memorize, "Fold note alpha");
			await row.getByRole("button", { name: "Edit", exact: true }).click();
			const editor = row.getByLabel("Note text");
			await editor.fill("Fold note alpha, typed again by hand.");
			losses.push({ method: "POST", url: /\/absorb\/runs\/[^/]+\/edit$/, how: { respond: { status: 400, body: { error: "Only a note this update adds or rewrites can be edited here.", code: "absorb_run_bad_edit" } } } });
			await row.getByRole("button", { name: "Save", exact: true }).click();
			await row.getByText("Only a note this update adds or rewrites can be edited here.").waitFor({ timeout: 10_000 }).catch(async (error) => { await shot("memorize-card-refused-edit", memorize); throw error; });
			await shot("memorize-card-refused-edit", row);
			assert(await editor.isVisible(), "the editor stays open");
			assert((await editor.inputValue()) === "Fold note alpha, typed again by hand.", `the typed words stay, got ${JSON.stringify(await editor.inputValue())}`);
			assert(await memorize.locator(".absorb-run-error, .maintain-error").filter({ hasText: "Only a note" }).count() === 0, "the reason is not at the top of the card");
			await row.getByRole("button", { name: "Cancel", exact: true }).click();
		});

		await check("Memorize card: the editor says the 2,000 limit near it, and Save waits past it", async () => {
			assert(memorizeReady, "the card is open");
			const row = await heldRow(memorize, "Fold note alpha");
			await row.getByRole("button", { name: "Edit", exact: true }).click();
			const editor = row.getByLabel("Note text");
			const save = row.getByRole("button", { name: "Save", exact: true });
			await editor.fill("word ".repeat(380).trim());
			await row.getByText(/^1,899 of 2,000 characters\.$/).waitFor({ timeout: 5_000 });
			assert(await save.isEnabled(), "Save is on near the limit");
			await editor.fill("x".repeat(2001));
			await row.getByText("2,001 of 2,000 characters. Shorten it to save.").waitFor({ timeout: 5_000 });
			assert(!(await save.isEnabled()), "Save waits past the limit");
			await editor.fill("");
			await row.getByText("Write the note before saving.").waitFor({ timeout: 5_000 });
			assert(!(await save.isEnabled()), "Save waits for words");
			await row.getByRole("button", { name: "Cancel", exact: true }).click();
		});

		await check("Memorize card: a typed heading saves as bold words in its note", async () => {
			assert(memorizeReady, "the card is open");
			const row = await heldRow(memorize, "Fold note beta");
			await row.getByRole("button", { name: "Edit", exact: true }).click();
			await row.getByLabel("Note text").fill("Exam facts:\n## Booking\nBook the date.");
			await row.getByRole("button", { name: "Save", exact: true }).click();
			await waitUntil(async () => (await row.getByLabel("Note text").count()) === 0, "the editor closes", 10_000);
			await shot("memorize-card-typed-heading", row);
			const saved = changeRow(memorize, "Exam facts:");
			const text = await saved.innerText();
			assert(text.includes("Booking") && text.includes("Book the date."), `the note shows every typed word, got ${JSON.stringify(text)}`);
			assert(await saved.locator("h1, h2, h3, h4, h5, h6").count() === 0 && await saved.locator("strong").filter({ hasText: "Booking" }).count() === 1, "the typed heading is bold words in the note, not a heading");
		});

		await check("Memorize card: an edit whose answer is lost says so under the note, then shows the saved words", async () => {
			assert(memorizeReady, "the card is open");
			const row = await heldRow(memorize, "Fold note alpha");
			await row.getByRole("button", { name: "Edit", exact: true }).click();
			await row.getByLabel("Note text").fill("Fold note alpha, kept through a dropped connection.");
			const sent = loseNext("POST", /\/absorb\/runs\/[^/]+\/edit$/, "abort");
			await row.getByRole("button", { name: "Save", exact: true }).click();
			await sent;
			await honestWhileLost(row, "memorize-card-edit-lost");
			const saved = changeRow(memorize, "kept through a dropped connection");
			await waitUntil(async () => (await saved.getByLabel("Note text").count()) === 0 && !(await saved.innerText()).includes(LOST), "the note shows the saved words, the editor closed", 20_000);
		});

		await check("Memorize: a Save whose answer is lost says so, then shows the saved screen, saved once", async () => {
			assert(memorizeReady, "the card is open");
			const before = fileOf(rooms.memorize);
			const sent = loseNext("POST", /\/absorb\/approve$/, "abort");
			await memorize.getByRole("button", { name: /^Save (to memory|over the budget)$/ }).click();
			await page.getByRole("dialog").filter({ hasText: /Save these notes to/ }).getByRole("button", { name: "Save", exact: true }).click({ timeout: 10_000 });
			await sent;
			await honestWhileLost(memorize, "memorize-save-lost");
			await memorize.getByRole("heading", { name: /^Memorize Room memorized/ }).waitFor({ timeout: 30_000 });
			const after = fileOf(rooms.memorize);
			assert(after !== before && count(after, "kept through a dropped connection") === 1, "the update is saved, once");
			assert(!/^### RC-0001 /m.test(after), "the page it memorized has gone from Recent Context");
		});

		// --- 2. The Review card ----------------------------------------------------------
		const review = page.locator('[aria-label="Review workflow"]');
		let reviewReady = false;
		await check("Review: the card opens with the tidy's notes", async () => {
			await home();
			await openMaintain(rooms.review.name, "Review");
			await review.getByRole("button", { name: "Continue →" }).click({ timeout: 30_000 });
			const saveTidy = review.getByRole("button", { name: /^Save (to memory|over the budget)$/ });
			await waitUntil(async () => (await saveTidy.count()) === 1 && (await saveTidy.isEnabled()), "the card offers Save", 90_000);
			for (const summary of await review.locator("details.review-topic-group > summary").all()) await summary.click();
			await changeRow(review, "Tidied note alpha").waitFor({ timeout: 10_000 });
			reviewReady = true;
		});

		await check("Review card: a refused edit keeps the editor and the words, with the reason under the note", async () => {
			assert(reviewReady, "the card is open");
			const row = await heldRow(review, "Tidied note alpha");
			await row.getByRole("button", { name: "Edit", exact: true }).click();
			const editor = row.getByLabel("Note text");
			await editor.fill("Tidied note alpha, typed by hand.");
			losses.push({ method: "POST", url: /\/review\/runs\/[^/]+\/edit$/, how: { respond: { status: 404, body: { error: "That note is not in this tidy any more.", code: "review_run_bad_edit" } } } });
			await row.getByRole("button", { name: "Save", exact: true }).click();
			await row.getByText("That note is not in this tidy any more.").waitFor({ timeout: 10_000 });
			assert(await editor.isVisible() && (await editor.inputValue()) === "Tidied note alpha, typed by hand.", "the editor stays open with the typed words");
			await row.getByRole("button", { name: "Cancel", exact: true }).click();
		});

		await check("Review card: an edit answered by a 502 with no body says so under the note, then shows the saved words", async () => {
			assert(reviewReady, "the card is open");
			const row = await heldRow(review, "Tidied note alpha");
			await row.getByRole("button", { name: "Edit", exact: true }).click();
			await row.getByLabel("Note text").fill("Tidied note alpha.\n### Kept through a proxy");
			const sent = loseNext("POST", /\/review\/runs\/[^/]+\/edit$/, "502");
			await row.getByRole("button", { name: "Save", exact: true }).click();
			await sent;
			await honestWhileLost(row, "review-card-edit-lost");
			const saved = changeRow(review, "Kept through a proxy");
			await waitUntil(async () => (await saved.getByLabel("Note text").count()) === 0 && !(await saved.innerText()).includes(LOST), "the note shows the saved words, the editor closed", 20_000);
		});

		await check("Review: a Save answered by a 502 with no body says so, then shows the saved screen, saved once", async () => {
			assert(reviewReady, "the card is open");
			const sent = loseNext("POST", /\/review\/runs\/[^/]+\/approve$/, "502");
			await review.getByRole("button", { name: /^Save (to memory|over the budget)$/ }).click();
			const confirmSave = page.getByRole("dialog").filter({ hasText: /Save/ }).getByRole("button", { name: "Save", exact: true });
			if (await confirmSave.count()) await confirmSave.click({ timeout: 10_000 });
			await sent;
			await honestWhileLost(review, "review-save-lost");
			await review.getByRole("heading", { name: "Review Room tidied its memory." }).waitFor({ timeout: 30_000 });
			const after = fileOf(rooms.review);
			assert(count(after, "**Kept through a proxy**") === 1, "the tidy is saved once, the typed heading as bold words");
		});

		await check("Review: an Undo whose answer is lost says so, then says it was undone", async () => {
			const before = fileOf(rooms.review);
			assert(before.includes("Tidied note"), "the tidy is in the file");
			const sent = loseNext("POST", /\/memory\/undo$/, "abort");
			await review.getByRole("button", { name: "Undo", exact: true }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Undo", exact: true }).click({ timeout: 10_000 });
			await sent;
			await honestWhileLost(review, "review-undo-lost");
			await waitUntil(async () => (await review.getByRole("button", { name: "Undo", exact: true }).count()) === 0 && !(await review.innerText()).includes(LOST), "the Undo is done", 20_000);
			const after = fileOf(rooms.review);
			assert(!after.includes("Tidied note") && after.includes("Alpha note: the exam room is booked."), "the memory is as before the tidy");
		});

		// --- 3. Remember -----------------------------------------------------------------
		const dialog = page.getByRole("dialog", { name: "Remember this conversation" });
		let proposalReady = false;
		await check("Remember: the proposal opens", async () => {
			await home();
			await card(rooms.remember.name).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			const composer = page.locator("textarea").first();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15_000 });
			await page.waitForTimeout(800);
			await composer.fill("When is the exam? We agreed it is in May.");
			await composer.press("Enter");
			await page.getByText("Answer from claude-fake.").waitFor({ timeout: 20_000 });
			await page.waitForTimeout(800);
			await page.getByRole("button", { name: "More ways to remember" }).click();
			await page.getByRole("menuitem", { name: "Remember with options…" }).click();
			await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
			await dialog.getByRole("button", { name: "Save to memory" }).waitFor({ timeout: 20_000 });
			proposalReady = true;
		});

		const typedKeep = "- The exam is in May.\n## Booking\n**Parked:** the fee, typed by hand";
		await check("Remember: closing the dialog and opening it again keeps the edits", async () => {
			assert(proposalReady, "the proposal is open");
			await dialog.getByRole("button", { name: "Edit", exact: true }).click();
			const keep = dialog.getByLabel(/What to keep/);
			await keep.fill(typedKeep);
			// Escape leaves the editor, then closes the dialog.
			await page.keyboard.press("Escape");
			await page.keyboard.press("Escape");
			await waitUntil(async () => (await dialog.count()) === 0, "the dialog closes", 5_000);
			await page.getByRole("button", { name: "More ways to remember" }).click();
			await page.getByRole("menuitem", { name: "Remember with options…" }).click();
			await dialog.waitFor({ timeout: 5_000 });
			if (await dialog.getByRole("button", { name: "Edit", exact: true }).count()) await dialog.getByRole("button", { name: "Edit", exact: true }).click();
			const value = await dialog.getByLabel(/What to keep/).inputValue();
			assert(value === typedKeep, `the edits are back, got ${JSON.stringify(value)}`);
			await shot("remember-typed-heading-and-marker", dialog);
		});

		await check("Remember: the page's count shows near 8,000 and Save waits past it", async () => {
			assert(proposalReady, "the proposal is open");
			const keep = dialog.getByLabel(/What to keep/);
			const save = dialog.getByRole("button", { name: "Save to memory" });
			try {
				await keep.fill(`- ${"x".repeat(7400)}`);
				await dialog.getByText(/^7,\d{3} of 8,000 characters\.$/).waitFor({ timeout: 5_000 });
				assert(await save.isEnabled(), "Save is on near the limit");
				await keep.fill(`- ${"x".repeat(8000)}`);
				await dialog.getByText(/^8,\d{3} of 8,000 characters\. Shorten it to save\.$/).waitFor({ timeout: 5_000 });
				assert(!(await save.isEnabled()), "Save waits past the limit");
			} finally {
				// The next check saves the typed heading and marker.
				await keep.fill(typedKeep);
			}
		});

		await check("Remember: a Save whose answer is lost says so, then shows the saved page, saved once with every typed word", async () => {
			assert(proposalReady, "the proposal is open");
			const sent = loseNext("POST", /\/checkpoint\/approve$/, "abort");
			await dialog.getByRole("button", { name: "Save to memory" }).click();
			await sent;
			await honestWhileLost(dialog, "remember-save-lost").catch(async (error) => {
				// Before the fix: what the typed heading and marker meet at Save, for the guide.
				offline = false;
				await dialog.getByRole("button", { name: "Save to memory" }).click({ timeout: 5_000 }).catch(() => {});
				await page.waitForTimeout(3_000);
				await shot("remember-saved", dialog);
				throw error;
			});
			await dialog.getByText("Memory updated").waitFor({ timeout: 30_000 });
			const after = fileOf(rooms.remember);
			assert(count(after, "the fee, typed by hand") === 1, "saved once");
			assert(after.includes("**Booking**") && after.includes("Parked: the fee, typed by hand") && count(after, "**Parked:**") === 1, "the typed heading is bold words and the typed marker plain words, in What to keep");
			await shot("remember-saved", dialog);
		});

		await check("Remember: a lost Save whose What to keep the person typed over an empty one shows the saved page, saved once, with no refusal", async () => {
			await home();
			await card(rooms.rememberTyped.name).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			const composer = page.locator("textarea").first();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15_000 });
			await page.waitForTimeout(800);
			await composer.fill(NOTHING_TO_KEEP_CHAT);
			await composer.press("Enter");
			await page.getByText("Answer from claude-fake.").waitFor({ timeout: 20_000 });
			await page.waitForTimeout(800);
			await page.getByRole("button", { name: "More ways to remember" }).click();
			await page.getByRole("menuitem", { name: "Remember with options…" }).click();
			await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
			await dialog.getByRole("button", { name: "Save to memory" }).waitFor({ timeout: 20_000 });
			if (await dialog.getByRole("button", { name: "Edit", exact: true }).count()) await dialog.getByRole("button", { name: "Edit", exact: true }).click();
			await dialog.getByLabel(/What to keep/).fill("- The person typed this keep by hand.");
			const sent = loseNext("POST", /\/checkpoint\/approve$/, "abort");
			await dialog.getByRole("button", { name: "Save to memory" }).click();
			await sent;
			await honestWhileLost(dialog, "remember-typed-keep-lost");
			await dialog.getByText("Memory updated").waitFor({ timeout: 30_000 }).catch(async () => {
				await shot("remember-typed-keep-lost-after", dialog);
				throw new Error(`the saved page shows, got ${JSON.stringify((await dialog.innerText()).slice(0, 400))}`);
			});
			const text = await dialog.innerText();
			assert(!text.includes("Write what to keep before saving.") && !text.includes(NOT_LANDED), "no refusal and no not-saved line");
			assert(count(fileOf(rooms.rememberTyped), "The person typed this keep by hand.") === 1, "saved once, with the typed words");
		});

		// --- 4. The Memory pane ------------------------------------------------------------
		const pane = page.locator(".room-settings-section:not([hidden])");
		let paneReady = false;
		await check("Pane: Room settings shows the room's memory", async () => {
			await home();
			await card(rooms.pane.name).getByRole("button", { name: "Room settings" }).click({ timeout: 10_000 });
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Memory$/ }).first().click({ timeout: 10_000 });
			await pane.getByRole("button", { name: "Add note" }).waitFor({ timeout: 10_000 });
			paneReady = true;
		});

		await check("Pane: the add form says what it waits for and the 20,000 limit", async () => {
			assert(paneReady, "the pane is open");
			await pane.getByRole("button", { name: "Add note" }).click();
			const save = pane.getByRole("button", { name: "Save note" });
			await pane.getByText("Choose a topic, or name a new one, before saving.").waitFor({ timeout: 5_000 });
			assert(!(await save.isEnabled()), "Save waits for a topic");
			await pane.locator("#memory-add-topic").selectOption("Billing");
			await pane.getByText("Write the note before saving.").waitFor({ timeout: 5_000 });
			await pane.getByLabel("Note text").fill("x".repeat(20_001));
			await pane.getByText("20,001 of 20,000 characters. Shorten it to save.").waitFor({ timeout: 5_000 });
			assert(!(await save.isEnabled()), "Save waits past the limit");
		});

		await check("Pane: an add whose answer is lost says so, then shows the note once", async () => {
			assert(paneReady, "the pane is open");
			if (!(await pane.getByLabel("Note text").count())) await pane.getByRole("button", { name: "Add note" }).click();
			await pane.locator("#memory-add-topic").selectOption("Billing");
			await pane.getByLabel("Note text").fill("Receipts:\n## Kept\nThe receipts go to finance.");
			const sent = loseNext("POST", /\/memory\/entries$/, "abort");
			await pane.getByRole("button", { name: "Save note" }).click();
			await sent;
			await honestWhileLost(pane, "pane-add-lost");
			await waitUntil(async () => (await pane.getByRole("button", { name: "Add note" }).count()) === 1 && !(await pane.innerText()).includes(LOST), "the form closes once the note is found, and the line comes down", 20_000);
			const after = fileOf(rooms.pane);
			assert(count(after, "The receipts go to finance.") === 1 && after.includes("**Kept**"), "the note is saved once, the heading as bold words");
			await shot("pane-typed-heading", pane.locator(".memory-entry").filter({ hasText: "The receipts go to finance." }));
		});

		await check("Pane: the same note sent again after a lost answer is added once", async () => {
			assert(paneReady, "the pane is open");
			await pane.getByRole("button", { name: "Add note" }).click();
			await pane.locator("#memory-add-topic").selectOption("Billing");
			await pane.getByLabel("Note text").fill("The second note, sent twice.");
			// The answer is lost and the list read after it is one from before the save: the page says it was not saved, and the person saves again.
			const staleList = await page.evaluate(async (id) => (await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/memory/entries`)).json(), rooms.pane.agentId);
			losses.push({ method: "GET", url: /\/memory\/entries$/, how: { respond: { status: 200, body: staleList } } });
			const sent = loseNext("POST", /\/memory\/entries$/, "abort");
			await pane.getByRole("button", { name: "Save note" }).click();
			await sent;
			await pane.getByText("It was not saved. Save again.").waitFor({ timeout: 10_000 });
			offline = false;
			await pane.getByRole("button", { name: "Save note" }).click();
			await waitUntil(async () => (await pane.getByRole("button", { name: "Add note" }).count()) === 1, "the form closes", 20_000);
			assert(count(fileOf(rooms.pane), "The second note, sent twice.") === 1, "the note is in the file once");
		});

		await check("Pane: a note shows its lines as written, points only where a line starts with one, and a blank line as a gap", async () => {
			assert(paneReady, "the pane is open");
			const add = async (text: string, words: string) => {
				await pane.getByRole("button", { name: "Add note" }).click();
				await pane.locator("#memory-add-topic").selectOption("Billing");
				await pane.getByLabel("Note text").fill(text);
				await pane.getByRole("button", { name: "Save note" }).click();
				await waitUntil(async () => (await pane.getByRole("button", { name: "Add note" }).count()) === 1, "the form closes", 20_000);
				const note = pane.locator(".memory-entry").filter({ hasText: words }).locator(".memory-entry-text");
				await note.waitFor({ timeout: 10_000 });
				return note;
			};
			const typed = await add("Cueta is wrogly pronnounced\n#Plan\nPizza\nremind me in May", "Cueta is wrogly pronnounced");
			const pointed = await add("Budget review\n- the rate holds\n- renewal in April\n\nAsk finance first.", "Budget review");
			if (shotsDir) {
				const notes = pane.locator(".memory-entry").filter({ has: page.locator(".memory-entry-text") }).filter({ hasText: /Cueta is wrogly|Budget review/ });
				const both = async (name: string) => { await notes.first().scrollIntoViewIfNeeded(); await shot(name); };
				await both("notes-light-desktop");
				await page.emulateMedia({ colorScheme: "dark" });
				await both("notes-dark-desktop");
				await page.setViewportSize({ width: 420, height: 900 });
				await both("notes-dark-420");
				await page.emulateMedia({ colorScheme: "light" });
				await both("notes-light-420");
				await page.setViewportSize({ width: 1280, height: 900 });
			}
			const shape = (note: Locator) => note.evaluate((el) => [...el.children].map((child) => child.tagName === "UL" ? `points:${[...child.children].map((li) => li.textContent).join("|")}` : child.classList.contains("memory-entry-gap") ? "gap" : `line:${child.textContent}`).join(" / "));
			const typedShape = await shape(typed);
			assert(typedShape === "line:Cueta is wrogly pronnounced / line:#Plan / line:Pizza / line:remind me in May", `the four typed lines show as four lines, none a point (got ${typedShape})`);
			const pointedShape = await shape(pointed);
			assert(pointedShape === "line:Budget review / points:the rate holds|renewal in April / gap / line:Ask finance first.", `the first line is plain, the two points one list, the blank line a gap (got ${pointedShape})`);
		});

		await check("Pane: after a note that was not saved and Cancel, the next note is its own, even when the first arrives late", async () => {
			assert(paneReady, "the pane is open");
			const bodies: string[] = [];
			const listen = (request: import("playwright").Request) => { if (request.method() === "POST" && /\/memory\/entries$/.test(request.url())) bodies.push(request.postData() ?? ""); };
			page.on("request", listen);
			try {
				await pane.getByRole("button", { name: "Add note" }).click();
				await pane.locator("#memory-add-topic").selectOption("Billing");
				await pane.getByLabel("Note text").fill("The first note, held up on the way.");
				// The proxy answers 502 and the note has not reached the room yet.
				losses.push({ method: "POST", url: /\/memory\/entries$/, how: { respond: { status: 502, body: {} } } });
				await pane.getByRole("button", { name: "Save note" }).click();
				await pane.getByText("It was not saved. Save again.").waitFor({ timeout: 10_000 });
				await pane.getByRole("button", { name: "Cancel", exact: true }).click();
				// The held-up request arrives now, as it was sent.
				const late = await page.evaluate(async ({ id, body }) => (await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/memory/entries`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, { id: rooms.pane.agentId, body: bodies[0] });
				assert(late === 200, `the first note lands late, got ${late}`);
				await pane.getByRole("button", { name: "Add note" }).click();
				await pane.locator("#memory-add-topic").selectOption("Billing");
				await pane.getByLabel("Note text").fill("The second note, written after Cancel.");
				await pane.getByRole("button", { name: "Save note" }).click();
				await waitUntil(async () => (await pane.getByRole("button", { name: "Add note" }).count()) === 1, "the form closes", 20_000);
			} finally {
				page.off("request", listen);
			}
			const ids = bodies.map((body) => JSON.parse(body || "{}").requestId);
			assert(ids.length >= 3 && ids[0] !== ids[ids.length - 1], `the second note goes with an id of its own, got ${JSON.stringify(ids)}`);
			const after = fileOf(rooms.pane);
			assert(count(after, "The first note, held up on the way.") === 1 && count(after, "The second note, written after Cancel.") === 1, "both notes are in the file, once each");
		});

		await check("Pane: an edit answered by a 502 with no body says so, then shows the saved words", async () => {
			assert(paneReady, "the pane is open");
			const billing = pane.getByRole("button", { name: /Billing/ }).first();
			if (!(await pane.getByText("Invoices go out on the first.").isVisible().catch(() => false))) await billing.click();
			const entry = await heldRow(pane, "Invoices go out on the first.", ".memory-entry");
			await entry.getByRole("button", { name: "Edit", exact: true }).click();
			await entry.getByLabel("Note text").fill("Invoices go out on the first working day.");
			const sent = loseNext("PUT", /\/memory\/entries\/m-0011$/, "502");
			await entry.getByRole("button", { name: "Save", exact: true }).click();
			await sent;
			await honestWhileLost(pane, "pane-edit-lost");
			await waitUntil(async () => (await pane.getByText("Invoices go out on the first working day.").count()) === 1 && !(await pane.innerText()).includes(LOST), "the pane shows the saved words", 20_000);
			assert(count(fileOf(rooms.pane), "Invoices go out on the first working day.") === 1, "saved once");
		});

		await check("Pane: a delete for good that never reached the room says it was not done, and one that did takes the row away", async () => {
			assert(paneReady, "the pane is open");
			const room = `/api/persistent-agents/${encodeURIComponent(rooms.pane.agentId)}/memory`;
			const archived = (): Promise<string[]> => page.evaluate(async (url) => ((await (await fetch(`${url}/archive?limit=200`)).json()).entries as Array<{ id: string }>).map((row) => row.id), room);
			const status = await page.evaluate(async (url) => (await fetch(`${url}/entries/m-0012`, { method: "DELETE" })).status, room);
			assert(status === 200, `the note goes to the archive first, got ${status}`);
			await pane.getByRole("button", { name: "Show", exact: true }).click();
			const row = pane.locator(".memory-archive-entries .memory-entry").filter({ hasText: "Late invoices get a reminder." });
			await row.waitFor({ timeout: 10_000 });
			await row.getByRole("button", { name: "Delete", exact: true }).click();
			// The proxy answers 502 and the delete has not reached the room.
			losses.push({ method: "DELETE", url: /\/memory\/archive\/m-0012$/, how: { respond: { status: 502, body: {} } } });
			await row.getByRole("button", { name: "Delete", exact: true }).click();
			await pane.getByText("It was not saved. Save again.").waitFor({ timeout: 10_000 }).catch(async () => {
				throw new Error(`the page says it was not done, got ${JSON.stringify((await pane.innerText()).slice(-300))}`);
			});
			assert((await archived()).includes("m-0012"), "the row is still in the archive");
			// Now it lands and its answer is lost: the row goes.
			if (!(await row.getByRole("button", { name: "Keep it" }).count())) await row.getByRole("button", { name: "Delete", exact: true }).click();
			const sent = loseNext("DELETE", /\/memory\/archive\/m-0012$/, "abort");
			await row.getByRole("button", { name: "Delete", exact: true }).click();
			await sent;
			await honestWhileLost(pane, "pane-delete-for-good-lost");
			await waitUntil(async () => (await row.count()) === 0 && !(await pane.innerText()).includes(LOST), "the row leaves the list", 20_000);
			assert(!(await archived()).includes("m-0012"), "the row is gone from the archive");
		});

		await check("Pane: an edit with a started conversation open says it keeps its memory, and the room without one says nothing", async () => {
			assert(paneReady, "the pane is open");
			const openLine = "Your open conversation keeps the memory it started with. The changes apply from your next conversation.";
			assert(await pane.getByText(openLine).count() === 0, "no line in the room without an open conversation");
			await home();
			await card(rooms.openPane.name).getByRole("button", { name: "Room settings" }).click({ timeout: 10_000 });
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Memory$/ }).first().click({ timeout: 10_000 });
			const billing = pane.getByRole("button", { name: /Billing/ }).first();
			await billing.click({ timeout: 10_000 });
			const entry = await heldRow(pane, "Late invoices get a reminder.", ".memory-entry");
			await entry.getByRole("button", { name: "Edit", exact: true }).click();
			await entry.getByLabel("Note text").fill("Late invoices get a reminder after two weeks.");
			await entry.getByRole("button", { name: "Save", exact: true }).click();
			await pane.getByText(openLine).waitFor({ timeout: 10_000 }).catch(async () => {
				await shot("pane-open-conversation-before", pane);
				throw new Error("the line shows after the edit");
			});
			await shot("pane-open-conversation", pane);
		});
	} finally {
		await browser.close();
	}

	const failed = rows.filter((row) => !row.ok);
	console.log(`hand-edit ui smoke: ${rows.length - failed.length}/${rows.length} passed`);
	if (failed.length) throw new Error(`hand-edit ui smoke failed:\n${failed.map((row) => `- ${row.name}: ${row.detail}`).join("\n")}`);
	console.log("hand-edit ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	try { (provider as any).closeAllConnections?.(); } catch {}
	try { provider.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
