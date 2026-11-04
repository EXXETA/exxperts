// Home from the first visit, and the sidebar around it, as a person sees them.
// With no rooms and no model, Home is one soft welcome block ("Connect AI"
// opens Settings at AI setup) with no New room; a shared server's member is
// asked to go to the admin instead. With rooms and no model, New room stays
// and says what it waits for. Once a gateway is saved and no room exists yet,
// Home says so and New room leads. A room whose
// open conversation keeps the model it started on shows that model's saved
// label ("Quill 70B"), not a tidied id, while a gateway model saved without a
// label still reads tidied; its greyed Maintain says why on hover, and on the
// card only for a rarer reason, such as the room being deleted. The
// gear menu stays inside the sidebar on the desktop and offers no key chord
// on a touch screen, and the sidebar's labels start at the logo's left edge.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// What a person sees is checked to the end of the run; every miss is listed at once.
const misses: string[] = [];
function check(condition: unknown, message: string): void {
	if (!condition) misses.push(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("home first run ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-home-first-run-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

function sse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// A synthetic OpenAI-compatible gateway: its model list, and one short answer per call.
const gatewayServer = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (req.method === "GET" && String(req.url).endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "quill-70b-instruct", object: "model" }, { id: "atlas-large-2", object: "model" }, { id: "team-default", object: "model" }, { id: "contoso-large", object: "model" }] }));
			return;
		}
		const body = JSON.parse(raw || "{}");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: `Answer from ${body.model}.` }, finish_reason: null }] });
		sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
// A provider key in the shell that runs the smoke would connect an AI before the first visit.
const PROVIDER_CREDENTIAL = /_API_KEY$|_OAUTH_TOKEN$|^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|HF_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_PROFILE|AWS_BEARER_TOKEN_BEDROCK)$/;
const json = (route: string, method: string, body: unknown) => authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function openHome(context: BrowserContext): Promise<Page> {
	// first-run-guide-ui-smoke.ts holds the guide; here it has had its turn.
	await context.addInitScript(() => localStorage.setItem("exxperts.first-run-guide-seen", "1"));
	const page = await context.newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	return page;
}

/** Where the logo's left edge and each sidebar label's text start, in px. */
async function textEdges(page: Page): Promise<{ logo: number; labels: Array<{ text: string; left: number; boxLeft: number }> }> {
	return page.evaluate(() => {
		const logo = document.querySelector(".brand img.logo")!.getBoundingClientRect().left;
		const labels = [...document.querySelectorAll(".product-nav .list-btn, .sidebar-primary-nav .list-btn")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => {
			const range = document.createRange();
			range.selectNodeContents(b);
			return { text: (b.textContent ?? "").trim(), left: range.getClientRects()[0].left, boxLeft: b.getBoundingClientRect().left };
		});
		return { logo, labels };
	});
}

/** The tile's background against the primary action's, as the page draws both. */
async function primaryColors(page: Page): Promise<{ tile: string; primary: string }> {
	return page.evaluate(() => {
		const probe = document.createElement("div");
		probe.style.background = "var(--exx-action-primary-bg)";
		document.body.append(probe);
		const primary = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return { tile: getComputedStyle(document.querySelector(".add-room-card")!).backgroundColor, primary };
	});
}

/** How the welcome block is drawn against the page and its heading. */
async function welcomeLook(page: Page): Promise<{ border: number; fill: string; page: string; left: number; headingLeft: number; width: number }> {
	return page.evaluate(() => {
		const card = document.querySelector(".home-connect-card")!;
		const style = getComputedStyle(card);
		const box = card.getBoundingClientRect();
		return { border: parseFloat(style.borderTopWidth), fill: style.backgroundColor, page: getComputedStyle(document.querySelector(".landing")!).backgroundColor, left: box.left, headingLeft: document.querySelector(".landing h1")!.getBoundingClientRect().left, width: box.width };
	});
}

/** Opens the gear menu and says where it sits against the sidebar, and which chord it offers. */
async function gearMenu(page: Page, sidebar: string): Promise<{ inside: boolean; chord: string | null; gearTitle: string }> {
	await page.locator("button.sidebar-config-gear").click();
	const menu = page.locator(".sidebar-config-menu");
	await menu.getByRole("menuitem", { name: "Settings" }).waitFor();
	const result = await page.evaluate((sidebarSelector) => {
		const m = document.querySelector(".sidebar-config-menu")!.getBoundingClientRect();
		const s = document.querySelector(sidebarSelector)!.getBoundingClientRect();
		const kbd = document.querySelector(".sidebar-config-menu .menu-item-kbd");
		return { inside: m.left >= s.left && m.right <= s.right, chord: kbd ? kbd.textContent : null, gearTitle: document.querySelector("button.sidebar-config-gear")!.getAttribute("title") ?? "" };
	}, sidebar);
	await page.keyboard.press("Escape");
	return result;
}

try {
	await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gatewayServer.address() as AddressInfo).port;

	const serverEnv = smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot });
	for (const key of Object.keys(serverEnv)) if (PROVIDER_CREDENTIAL.test(key)) delete serverEnv[key];
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: serverEnv as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser: Browser = await chromium.launch();
	try {
		// 1. No model: connecting comes first, and New room waits for it.
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page = await openHome(ctx);
			const card = page.locator(".home-connect-card");
			await card.getByRole("heading", { name: "Connect an AI to get started" }).waitFor({ timeout: 15000 });
			const line = (await card.locator("p").textContent())?.trim();
			assert(line === "Use a subscription you already pay for, an API key, your company's gateway, or a model running on this computer.", `the card names the ways in, got ${JSON.stringify(line)}`);
			check(!(await page.getByRole("button", { name: "Create a new room" }).count()), "no New room while nothing can answer");
			check(!(await page.locator(".landing-grid").isVisible()), "no empty Rooms region under the block");
			assert(!(await page.getByText("You're set up").count()), "no set-up line before a model exists");
			const look = await welcomeLook(page);
			check(look.border === 0 && look.fill !== look.page, `the block is a light fill with no outline, got ${JSON.stringify(look)}`);
			check(look.left === look.headingLeft && look.width > 800, `the block sits in the heading's column, as wide as the column, got ${JSON.stringify(look)}`);
			check((await page.getByRole("button").filter({ hasText: /^Connect AI$/ }).count()) === 1, "one Connect AI");
			await card.getByRole("button", { name: "Connect AI" }).click();
			const settings = page.getByRole("dialog", { name: "Settings" });
			await settings.waitFor({ timeout: 10000 });
			await settings.getByRole("button", { name: "Add provider" }).first().waitFor({ timeout: 10000 });
			await ctx.close();
		}

		// 1b. A shared server's member cannot connect one: the card asks for the admin.
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			await ctx.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: "member-1", name: "Sam", admin: false } }) }));
			const page = await openHome(ctx);
			const card = page.locator(".home-connect-card");
			await card.waitFor({ timeout: 15000 });
			const line = (await card.locator("p").textContent())?.trim();
			assert(line === "Ask your admin to add a model in Settings, AI setup.", `a member is sent to the admin, got ${JSON.stringify(line)}`);
			check(!(await card.getByRole("button").count()), "a member has nothing to press: the admin connects the AI");
			const member = await card.evaluate((block) => ({ heading: block.querySelector("h2")!.getBoundingClientRect().toJSON(), sentence: block.querySelector("p")!.getBoundingClientRect().toJSON() }));
			check(member.sentence.top >= member.heading.bottom && member.sentence.left === member.heading.left, `a member's sentence sits under the heading, got ${JSON.stringify(member)}`);
			check(!(await page.getByRole("button", { name: "Create a new room" }).count()), "no New room for a member while nothing can answer");
			await ctx.close();
		}

		// 1b2. A shared server's admin connects the AI: the block offers it.
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			await ctx.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: "admin-1", name: "Alex", admin: true } }) }));
			const page = await openHome(ctx);
			const card = page.locator(".home-connect-card");
			await card.getByRole("button", { name: "Connect AI" }).waitFor({ timeout: 15000 });
			check((await card.locator("p").textContent())?.trim() === "Add an API key or a gateway in Settings, AI setup.", `an admin is told how, got ${JSON.stringify((await card.locator("p").textContent())?.trim())}`);
			await ctx.close();
		}

		// 1c. A paired device sees AI setup read-only: it is offered a look, and told where an AI is connected.
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			await ctx.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
			const page = await openHome(ctx);
			const card = page.locator(".home-connect-card");
			await card.waitFor({ timeout: 15000 });
			check((await card.getByRole("button", { name: "See AI setup" }).count()) === 1 && !(await card.getByRole("button", { name: "Connect AI" }).count()), "a paired device is offered a look at AI setup, not Connect AI");
			check((await card.locator("p").textContent())?.trim() === "Connect one on the computer this app runs on, in Settings, AI setup.", `a paired device is told where an AI is connected, got ${JSON.stringify((await card.locator("p").textContent())?.trim())}`);
			await ctx.close();
		}

		// 2. A gateway saved, no room yet: Home says it worked and New room leads.
		const saved = await json("/api/persistent-agent-ai-profiles/gateways", "POST", { label: "Northwind AI gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, key: "synthetic-gateway-key", roomModels: [{ modelId: "quill-70b-instruct", label: "Quill 70B", contextWindow: 128000 }, { modelId: "atlas-large-2", label: "Atlas Large 2", contextWindow: 200000 }, { modelId: "team-default", contextWindow: 128000 }], maintenanceModel: "atlas-large-2" });
		assert(saved.ok, `the gateway saves, got ${saved.status} ${await saved.text()}`);
		const gateways = await (await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/gateways`)).json() as { gateways: Array<{ label: string; providerId: string }> };
		const provider = gateways.gateways.find((g) => g.label === "Northwind AI gateway")!.providerId;
		for (const colorScheme of ["light", "dark"] as const) {
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme });
			const page = await openHome(ctx);
			await page.getByText("You're set up. Create your first room.").waitFor({ timeout: 15000 });
			assert(!(await page.locator(".home-connect-card").count()), "the connect card is gone once a model exists");
			const newRoom = page.getByRole("button", { name: "Create a new room" });
			assert((await newRoom.getAttribute("class"))?.includes("is-primary") && !(await newRoom.textContent())?.includes("Connect an AI first"), "New room is the primary action");
			const colors = await primaryColors(page);
			check(colors.tile === colors.primary, `in ${colorScheme}, New room wears the primary action's colour, got ${JSON.stringify(colors)}`);
			await ctx.close();
		}

		// 2b. A gateway connected, but the default for new rooms is on a gateway since removed: a new room could not talk, so Home does not say it is set up.
		const other = await json("/api/persistent-agent-ai-profiles/gateways", "POST", { label: "Contoso gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, key: "synthetic-contoso-key", roomModels: [{ modelId: "contoso-large", contextWindow: 128000 }], maintenanceModel: "contoso-large" });
		assert(other.ok, `the second gateway saves, got ${other.status}`);
		const contoso = (await (await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/gateways`)).json() as { gateways: Array<{ id?: string; label: string; providerId: string }> }).gateways.find((g) => g.label === "Contoso gateway")!;
		assert((await json("/api/ai/defaults", "PUT", { conversation: { provider: contoso.providerId, model: "contoso-large" } })).ok, "the default moves to Contoso");
		assert((await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(contoso.id ?? contoso.providerId)}`, { method: "DELETE" })).ok, "Contoso is removed");
		const afterRemoval = await (await authedFetch(`${baseUrl}/api/persistent-agent-room/model-status`)).json() as { ready: boolean; providers: Array<{ id: string; ready: boolean }> };
		assert(!afterRemoval.ready && afterRemoval.providers.some((p) => p.id === provider && p.ready), `the default cannot run while Northwind is connected, got ${JSON.stringify({ ready: afterRemoval.ready, providers: afterRemoval.providers.map((p) => [p.id, p.ready]) })}`);
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page = await openHome(ctx);
			const newRoom = page.getByRole("button", { name: "Create a new room" });
			await newRoom.waitFor({ timeout: 15000 });
			await page.waitForLoadState("networkidle");
			check(!(await page.getByText("You're set up").count()), "no set-up line while the default for new rooms cannot run");
			check(!(await newRoom.getAttribute("class"))?.includes("is-primary"), "New room does not lead while the default for new rooms cannot run");
			check((await page.getByRole("button", { name: "AI setup needed" }).count()) === 1, "Home points to AI setup while the default for new rooms cannot run");
			check(!(await page.locator(".home-connect-card").count()) && !(await newRoom.textContent())?.includes("Connect an AI first"), "a connected AI is not asked for again");
			await ctx.close();
		}
		assert((await json("/api/ai/defaults", "PUT", { conversation: { provider, model: "atlas-large-2" } })).ok, "the default moves back to Northwind");

		// 3. Rooms: one talks on Quill and keeps it after the pick moves; one on a model saved without a label.
		const made = await json("/api/persistent-agents", "POST", { displayName: "Lisbon Trip", userName: "Synthetic User" });
		assert(made.ok, `the room is made, got ${made.status}`);
		const roomId = (await made.json() as { status?: { id?: string }; agentId?: string }).status?.id ?? "lisbon-trip";
		assert((await json(`/api/persistent-agents/${roomId}/models`, "PUT", { conversation: { provider, model: "quill-70b-instruct" } })).ok, "the room talks on Quill");
		const plain = await json("/api/persistent-agents", "POST", { displayName: "Team Room", userName: "Synthetic User" });
		const plainId = (await plain.json() as { status?: { id?: string } }).status?.id ?? "team-room";
		assert((await json(`/api/persistent-agents/${plainId}/models`, "PUT", { conversation: { provider, model: "team-default" } })).ok, "the second room talks on the unlabelled model");
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page = await openHome(ctx);
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Lisbon Trip" });
			await card.getByRole("button", { name: /Enter/ }).click();
			const composer = page.locator(".composer-box textarea").first();
			await composer.waitFor({ timeout: 20000 });
			await composer.fill("Plan three days in Lisbon.");
			await page.locator("button.send-btn").click();
			await page.getByText("Answer from quill-70b-instruct.").waitFor({ timeout: 20000 });
			await waitUntil(async () => {
				const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/status`)).json() as { runtime?: { activeThreadId?: string } };
				const thread = status.runtime?.activeThreadId;
				if (!thread) return false;
				const text = await (await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/threads/${thread}`)).text();
				return text.includes("Answer from quill-70b-instruct.");
			}, "the answer is saved");

			// The in-room rail: its gear menu stays inside it, and its list starts on the logo's edge.
			const rail = await gearMenu(page, ".app > .sidebar");
			assert(rail.inside, "the gear menu stays inside the in-room rail");
			const railEdges = await textEdges(page);
			assert(railEdges.labels.length > 0 && railEdges.labels.every((label) => Math.abs(label.left - railEdges.logo) < 1.5), `the rail's list starts on the logo's edge, got ${JSON.stringify(railEdges)}`);
			await ctx.close();
		}
		assert((await json(`/api/persistent-agents/${roomId}/models`, "PUT", { conversation: { provider, model: "atlas-large-2" } })).ok, "the pick moves to Atlas");
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page = await openHome(ctx);
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Lisbon Trip" });
			await card.waitFor({ timeout: 15000 });
			await waitUntil(async () => ((await card.locator(".card-model-label").getAttribute("title")) ?? "").includes("continues on its current model"), "the card shows the conversation's own model");
			const name = (await card.locator(".card-model-label-name").textContent())?.trim();
			assert(name === "Quill 70B", `the card shows the label saved for the model, got ${JSON.stringify(name)}`);
			const plainName = (await page.locator(".persistent-agent-card").filter({ hasText: "Team Room" }).locator(".card-model-label-name").textContent())?.trim();
			assert(plainName === "Team Default", `a model saved without a label still reads tidied, got ${JSON.stringify(plainName)}`);

			// Nothing remembered yet: Maintain is greyed, and "no memories saved yet"
			// already says why, so the reason stays on the button's hover.
			const maintain = card.getByRole("button", { name: "Maintain", exact: true });
			assert(await maintain.isDisabled(), "Maintain is greyed in a room with nothing to maintain");
			assert(await maintain.getAttribute("title") === "Nothing to maintain yet. Talk to this room and use Remember first.", `the greyed Maintain says why on hover, got ${JSON.stringify(await maintain.getAttribute("title"))}`);
			check(await card.locator(".persistent-agent-maintain-why").count() === 0, "a fresh room's card shows no reason line under Maintain");

			// Home's sidebar on the desktop: the menu inside, the chord offered, the labels on the logo's edge.
			const home = await gearMenu(page, ".product-sidebar");
			assert(home.inside, "the gear menu stays inside the sidebar");
			assert(home.chord === "⌘," || home.chord === "Ctrl+,", `the desktop menu offers the chord, got ${JSON.stringify(home.chord)}`);
			assert(home.gearTitle.endsWith(`(${home.chord})`), `the gear's title names the chord, got ${JSON.stringify(home.gearTitle)}`);
			const edges = await textEdges(page);
			assert(edges.labels.length >= 2 && edges.labels.every((label) => Math.abs(label.left - edges.logo) < 1.5), `the labels start on the logo's edge, got ${JSON.stringify(edges)}`);

			// A rarer reason does show on the card: while Team Room is being deleted
			// (its delete held here), its greyed Maintain says so above the button.
			let releasePurge = (): void => {};
			const purgeHeld = new Promise<void>((resolve) => { releasePurge = resolve; });
			await page.route("**/api/persistent-agents/*/purge", async (route) => { await purgeHeld; await route.continue(); });
			const team = page.locator(".persistent-agent-card").filter({ hasText: "Team Room" });
			await team.getByRole("button", { name: "Room settings" }).click();
			await page.getByRole("button", { name: "Archive or delete" }).click();
			await page.locator(".settings-dialog").getByRole("button", { name: "Delete room", exact: true }).click();
			await page.getByRole("alertdialog", { name: "Delete Team Room?" }).getByRole("button", { name: "Delete room", exact: true }).click();
			await waitUntil(async () => (await team.locator(".persistent-agent-maintain-why").count()) > 0, "the card being deleted shows its reason line");
			const deleting = (await team.locator(".persistent-agent-maintain-why").textContent())?.trim();
			check(deleting === "This room is being deleted.", `the card being deleted says so above Maintain, got ${JSON.stringify(deleting)}`);
			check(await card.locator(".persistent-agent-maintain-why").count() === 0, "the fresh card beside it still shows no reason line");
			releasePurge();
			await team.waitFor({ state: "detached", timeout: 15000 });
			await ctx.close();
		}

		// 3b. Rooms but no model: only the empty Home hides New room. It can still make a room that waits, and says what for.
		for (const [role, hint] of [[null, "Connect an AI first"], ["member", "Ask your admin for a model first"]] as const) {
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			await ctx.route("**/api/persistent-agent-room/model-status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ready: false, providers: [] }) }));
			if (role) await ctx.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: "member-1", name: "Sam", admin: false } }) }));
			const page = await openHome(ctx);
			const newRoom = page.getByRole("button", { name: "Create a new room" });
			await newRoom.waitFor({ timeout: 15000 });
			await page.locator("#add-room-hint").waitFor({ timeout: 15000 });
			// The hint is the tile's description for a screen reader; its name stays "Create a new room".
			const describedBy = await newRoom.getAttribute("aria-describedby");
			check(describedBy && (await page.locator(`#${describedBy}`).textContent())?.trim() === hint, `New room's hint is its accessible description, got ${JSON.stringify(describedBy)}`);
			check(!(await page.locator(".home-connect-card").count()), "no welcome block once rooms exist");
			await ctx.close();
		}

		// 4. The mac app's look keeps its labels on the logo's edge.
		{
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 ExxpertsDesktop/0.14.5" });
			const page = await openHome(ctx);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
			assert(await page.evaluate(() => document.documentElement.classList.contains("desktop-app-mac")), "the mac app's class is set");
			const edges = await textEdges(page);
			assert(edges.labels.length >= 2 && edges.labels.every((label) => Math.abs(label.left - edges.logo) < 1.5), `the mac app's labels start on the logo's edge, got ${JSON.stringify(edges)}`);
			await ctx.close();
		}

		// 5. A touch screen: the phone's top bar keeps its item padding, and the menu offers no chord.
		{
			const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
			const page = await openHome(ctx);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
			const edges = await textEdges(page);
			assert(edges.labels.length >= 2 && edges.labels.every((label) => Math.abs(label.left - label.boxLeft - 15) < 1.5), `the phone's top bar keeps 14px inside each item, got ${JSON.stringify(edges)}`);
			const phone = await gearMenu(page, "body");
			assert(phone.chord === null, `a touch screen gets no chord in the menu, got ${JSON.stringify(phone.chord)}`);
			assert(!/Ctrl|⌘/.test(phone.gearTitle), `the gear's title names no chord on a touch screen, got ${JSON.stringify(phone.gearTitle)}`);
			await ctx.close();
		}
	} finally {
		await browser.close();
	}
	assert(misses.length === 0, `Home missed ${misses.length}:\n  ${misses.join("\n  ")}`);
	console.log("home-first-run-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (gatewayServer as any).closeAllConnections?.(); } catch {}
	try { gatewayServer.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
