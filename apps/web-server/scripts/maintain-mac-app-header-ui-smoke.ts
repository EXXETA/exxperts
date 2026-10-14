// The Maintain header as the Mac desktop app draws it: the shell's user agent
// turns on the desktop-only CSS, and the window buttons sit at x 18-78pt,
// y 18-32pt (trafficLightPosition 18,18; 14pt buttons, 23pt apart). On the
// chooser, Memorize's first read and discussion, and Review's discussion, at
// 100%, at 83% zoom (two Zoom Out presses) and at the next level out, 69.4%, no header text sits under the
// buttons, and off the discussion step the title keeps the content's left
// edge; the header still drags the window and its buttons still click. In the
// browser the header keeps its centred padding and its 34px top. Zoom only
// scales CSS px to points, so the 83% window is its size in CSS px with the
// buttons' box divided by the zoom. Offline: one synthetic provider.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
		console.log("maintain mac app header smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-mac-header-"));
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
const MAC_APP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 ExxpertsDesktop/0.14.3";
const REVIEW_FIRST_READ = "## First read\n\n### Could be shorter\n- Renewals says one thing twice.\n\n### Looks stale or contradicts itself\n- None\n\n### Needs your call\nNone\n\n### Topics to tidy\nRenewals\n";
const MEMORIZE_FIRST_READ = "## Absorb assessment\n\nI found 1 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n\n- The venue plan.\n\n### What to forget\n\n- The small talk.\n\n### What changes in stable memory\n\n- Deep Memory: the venue plan.\n\n### Needs your judgment\n\n- None\n";
// The window at 100% (the app's default size), and his window at 83% and at the next zoom out, 69.4%, in points.
const ZOOMS = [{ label: "100%", zoom: 1, width: 1440, height: 920 }, { label: "83%", zoom: 0.833, width: 1709, height: 987 }, { label: "69.4%", zoom: 0.694, width: 1709, height: 987 }];

const calls: string[] = [];
function replyFor(prompt: string): { kind: string; text: string } {
	if (prompt.includes("## Task: First read of these notes")) return { kind: "review-read", text: REVIEW_FIRST_READ };
	if (prompt.includes("## Task: Compact Initial Assessment")) return { kind: "memorize-read", text: MEMORIZE_FIRST_READ };
	return { kind: "other", text: "Noted." };
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

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

type HeaderLook = {
	texts: { text: string; left: number; top: number; right: number; bottom: number }[];
	titleLeft: number;
	contentLeft: number | null;
	paddingLeft: string;
	paddingTop: string;
	headerRegion: string;
	buttonRegions: string[];
};

/** The header's text boxes (outside its buttons), the title's and the content's left edges, and the drag regions. */
function lookAtHeader(page: Page): Promise<HeaderLook> {
	return page.evaluate(() => {
		// No named helpers in here: the page runs this text as it is.
		const header = document.querySelector(".maintain-workspace .absorb-workspace-header") as HTMLElement;
		const texts: HeaderLook["texts"] = [];
		const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent?.trim() || node.parentElement?.closest("button, a")) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) texts.push({ text: node.textContent.trim(), left: r.left, top: r.top, right: r.right, bottom: r.bottom });
		}
		const content = document.querySelector(".maintain-workspace .maintain-actions, .maintain-workspace .absorb-discussion-page, .maintain-workspace .absorb-workflow-card");
		const cs = getComputedStyle(header);
		return {
			texts,
			titleLeft: header.querySelector("h1")!.getBoundingClientRect().left,
			contentLeft: content ? content.getBoundingClientRect().left : null,
			paddingLeft: cs.paddingLeft,
			paddingTop: cs.paddingTop,
			headerRegion: cs.getPropertyValue("-webkit-app-region"),
			buttonRegions: [...header.querySelectorAll("button")].map((b) => getComputedStyle(b).getPropertyValue("-webkit-app-region")),
		};
	});
}

/** At each zoom: no header text under the window buttons; off the discussion step, the title on the content's edge. */
async function checkMacHeader(page: Page, screen: string, discussion: boolean): Promise<void> {
	for (const z of ZOOMS) {
		await page.setViewportSize({ width: Math.round(z.width / z.zoom), height: Math.round(z.height / z.zoom) });
		await page.waitForTimeout(300);
		const look = await lookAtHeader(page);
		const [x0, x1, y0, y1] = [18 / z.zoom, 78 / z.zoom, 18 / z.zoom, 32 / z.zoom];
		const under = look.texts.filter((t) => t.left < x1 && t.right > x0 && t.top < y1 && t.bottom > y0);
		assert(look.texts.length > 0, `${screen} at ${z.label}: the header has text`);
		assert(under.length === 0, `${screen} at ${z.label}: no header text under the window buttons (x ${x0.toFixed(0)}-${x1.toFixed(0)}, y ${y0.toFixed(0)}-${y1.toFixed(0)}), got ${JSON.stringify(under)}`);
		if (!discussion) {
			assert(look.contentLeft !== null && Math.abs(look.titleLeft - look.contentLeft) <= 1, `${screen} at ${z.label}: the title keeps the content's left edge, got title ${look.titleLeft}, content ${look.contentLeft}`);
		}
		// Chromium reports the drag regions only where it supports them; where it does, the header drags and its buttons click.
		if (look.headerRegion) {
			assert(look.headerRegion === "drag", `${screen} at ${z.label}: the header drags the window, got ${look.headerRegion}`);
			assert(look.buttonRegions.every((r) => r === "no-drag"), `${screen} at ${z.label}: the header's buttons click, got ${look.buttonRegions.join(",")}`);
		}
	}
	await page.setViewportSize({ width: 1440, height: 920 });
	await page.waitForTimeout(200);
	console.log(`  ok  ${screen}: clear of the window buttons at 100%, 83% and 69.4%${discussion ? "" : ", the title on the content's edge"}`);
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
	};
	const note = (id: string, text: string) => `<!-- e: id=${id} kind=fact saved=2026-09-01 -->\n${text}\n`;
	createRoom("Review Room", ["### Renewals", "", note("m-0201", "- The Nordwind contract renews in May, and the renewal is in May."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-09", "The renewal call", "We went through the renewals.", "- The Nordwind renewal is in May.")]);
	createRoom("Memorize Room", ["### Billing", "", note("m-0301", "- Invoices are sent by email."), ""].join("\n"), [conversationPage("RC-0001", "2026-09-11", "The venue plan", "We settled the venue.", "- The venue is Lueneburg.")]);

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
		const open = async (userAgent?: string): Promise<Page> => {
			const page = await (await browser.newContext({ viewport: { width: 1440, height: 920 }, ...(userAgent ? { userAgent } : {}) })).newPage();
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-foot .btn-primary");
			if (await dismiss.count()) await dismiss.click();
			return page;
		};
		const openChooser = async (page: Page, room: string) => {
			await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: "Maintain", exact: true }).click();
			await page.locator('[aria-label="Memory maintenance chooser"] .absorb-workspace-header h1').waitFor({ timeout: 15_000 });
		};

		// The Mac app: the chooser, Memorize's first read and discussion, Review's discussion.
		const mac = await open(MAC_APP_UA);
		assert(await mac.evaluate(() => document.documentElement.classList.contains("desktop-app-mac")), "the Mac app's user agent turns on the desktop CSS");
		await openChooser(mac, "Memorize Room");
		await checkMacHeader(mac, "the chooser", false);
		await mac.locator(".maintain-action").filter({ hasText: "Memorize" }).first().click();
		const memorize = mac.locator('[aria-label="Memory absorption workflow"]');
		await memorize.getByText("The venue plan.").first().waitFor({ timeout: 40_000 });
		await checkMacHeader(mac, "Memorize's first read", false);
		await memorize.getByRole("button", { name: "Discuss first" }).click();
		await mac.locator(".maintain-workspace .absorb-workspace-header.compact").waitFor({ timeout: 15_000 });
		await mac.locator(".maintain-workspace .absorb-discussion-page").waitFor({ timeout: 15_000 });
		await checkMacHeader(mac, "Memorize's discussion", true);
		await mac.context().close();

		const macReview = await open(MAC_APP_UA);
		await openChooser(macReview, "Review Room");
		await macReview.locator(".maintain-action").filter({ hasText: "Review" }).first().click();
		const review = macReview.locator('[aria-label="Review workflow"]');
		await review.getByRole("button", { name: "Discuss first" }).click({ timeout: 40_000 });
		await macReview.locator(".maintain-workspace .absorb-workspace-header.compact").waitFor({ timeout: 15_000 });
		await macReview.locator(".maintain-workspace .absorb-discussion-page").waitFor({ timeout: 15_000 });
		await checkMacHeader(macReview, "Review's discussion", true);
		await macReview.context().close();

		// The browser: the header keeps its centred padding and its 34px top.
		const web = await open();
		assert(!(await web.evaluate(() => document.documentElement.classList.contains("desktop-app"))), "the browser has no desktop CSS");
		await openChooser(web, "Memorize Room");
		const look = await lookAtHeader(web);
		assert(look.paddingLeft === "240px" && look.paddingTop === "34px", `the browser's header keeps its centred padding and its 34px top, got ${look.paddingLeft} ${look.paddingTop}`);
		assert(look.contentLeft !== null && Math.abs(look.titleLeft - look.contentLeft) <= 1, `the browser's title keeps the content's left edge, got title ${look.titleLeft}, content ${look.contentLeft}`);
		await web.context().close();
		console.log("  ok  the browser's Maintain header is unchanged");
	} finally {
		await browser.close();
	}
	console.log("maintain mac app header smoke: ok");
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
