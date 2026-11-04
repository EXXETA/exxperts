// What a copy from an answer puts on the clipboard, in the browser. A
// selection inside an answer, and the Copy button under it, carry clean HTML
// that takes the look of where it lands: structure only, nothing of the
// page's colours, fonts or controls, dark and light. Text/plain stays what it
// was. A selection that leaves the answer, the composer and the code block's
// Copy keep their copy. Over plain http, where the page has no clipboard API,
// the button still copies the markdown.
//
// Offline: the room's model is a synthetic OpenAI-compatible server in this
// process that answers at once.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function check(label: string, body: () => Promise<void>): Promise<void> {
	await body();
	console.log(`  ok  ${label}`);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("answer copy smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const ANSWER_PROMPT = "Write up the release plan.";
const ANSWER = [
	"## Release plan",
	"We ship **Tuesday** with *care*. See [the notes](https://example.com/notes).",
	"- First point\n- Second `point`\n- Third point",
	"| Step | Owner |\n| --- | --- |\n| Smoke | Build |\n| Pictures | Review |",
	'```ts\nconst greeting = "hi";\nconst other = 2;\n```',
	"That is the plan.",
].join("\n\n");
const EXTRAS_PROMPT = "Show the extras.";
const EXTRAS = [
	"Extras first.",
	"- [x] Done item\n- [ ] Open item",
	"4. Fourth step\n5. Fifth step",
	"The area is $$x^2+y^2$$ here.",
	"```chart\ntype: bar\ntitle: Requests refused\nHour, Refused\n09:00, 12\n10:00, 30\n```",
	"```mermaid\nflowchart LR\n  A[Request] --> B[Approve]\n```",
	"Extras last.",
].join("\n\n");
const FIGURES_PROMPT = "Show every figure.";
// The answer's own use of the words the tools show: these stay, on any copy.
const OWN_WORDS = "Copy, Code, Picture, Chart, Table and Diagram are our own words.";
const FIGURES = [
	"Figures first.",
	"| Step | Owner |\n| --- | --- |\n| Smoke | Build |",
	"$$\nx^2+y^2\n$$",
	'```ts\nconst greeting = "hi";\n```',
	"```chart\ntype: bar\ntitle: Requests refused\nHour, Refused\n09:00, 12\n10:00, 30\n```",
	"```mermaid\nflowchart LR\n  A[Request] --> B[Approve]\n```",
	OWN_WORDS,
].join("\n\n");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
// A name that is no loopback address: to the browser this origin is plain
// http on a network address, as a LAN address is.
const plainHttpUrl = `http://exxperts-lan.test:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-answer-copy-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

function sse(res: http.ServerResponse, payload: Record<string, unknown>): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_answer_copy", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		// What the person asked last decides the answer: the history repeats the earlier questions.
		const asked = JSON.stringify([...(body.messages ?? [])].reverse().find((message: { role?: string; content?: unknown }) => message.role === "user" && !JSON.stringify(message.content ?? "").includes(ROOM_STATE_HEADING)) ?? "");
		const said = asked.includes(FIGURES_PROMPT) ? FIGURES : asked.includes(EXTRAS_PROMPT) ? EXTRAS : asked.includes(ANSWER_PROMPT) ? ANSWER : "Noted.";
		sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: said }, finish_reason: null }] });
		sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

type Clipboard = { types: string[]; plain: string | null; html: string | null };

/** The clipboard as it stands, its HTML unsanitized: what a mail would be handed. */
function readClipboard(page: Page): Promise<Clipboard> {
	return page.evaluate(async () => {
		const [item] = await (navigator.clipboard.read as (options: unknown) => Promise<ClipboardItem[]>)({ unsanitized: ["text/html"] });
		const [plain, html] = await Promise.all(["text/plain", "text/html"].map((type) => (item.types.includes(type) ? item.getType(type).then((blob) => blob.text()) : null)));
		return { types: [...item.types], plain, html };
	});
}

/** Empties the clipboard, runs the copy, and waits until the clipboard holds it. */
async function copied(page: Page, copy: () => Promise<void>): Promise<Clipboard> {
	await page.bringToFront();
	await page.evaluate(() => navigator.clipboard.writeText(""));
	await copy();
	await waitUntil(async () => Boolean((await readClipboard(page)).plain), "the copy reaches the clipboard");
	return readClipboard(page);
}

const pressCopy = (page: Page) => page.keyboard.press("ControlOrMeta+c");

function selectContents(element: Locator): Promise<void> {
	return element.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		document.getSelection()!.removeAllRanges();
		document.getSelection()!.addRange(range);
	});
}

/** Copies the current selection with the browser's own copy, the one today's text/plain comes from. */
function browserCopy(page: Page): Promise<Clipboard> {
	return copied(page, async () => {
		await page.evaluate(() => window.addEventListener("copy", (event) => event.stopImmediatePropagation(), { capture: true, once: true }));
		await pressCopy(page);
	});
}

/** What must not be in pasted HTML: anything of the page. */
function assertClean(html: string | null, where: string): asserts html is string {
	assert(html, `${where}: the clipboard holds text/html`);
	for (const word of [/background/i, /(?<!-)color/i, /font/i, /\sclass=/i, /<button/i, /<svg/i, /<span/i, /<div/i, /rgb\(/i, /var\(/i, /radius/i, /letter-spacing/i]) {
		assert(!word.test(html), `${where}: the HTML holds nothing like ${word}, got ${html}`);
	}
	const styles = [...html.matchAll(/style="([^"]*)"/g)].map((match) => match[1]);
	assert(styles.every((style) => /^(?:border-collapse:collapse|border:1px solid;padding:4px 8px)$/.test(style)), `${where}: only a table's borders are styled, got ${styles}`);
}

// What the tools on a figure show: their names, a view's word, the "Diagram" label, code's language label.
const TOOL_WORDS = /\b(?:Copy|Copied|Picture|Code|Chart|Table|Diagram|TypeScript)\b/;

function assertNoToolWords(text: string | null, where: string): void {
	assert(text !== null, `${where}: the clipboard holds it`);
	const word = text.replace(OWN_WORDS, "").match(TOOL_WORDS);
	assert(!word, `${where}: no figure's tools come along, found ${word?.[0]} in ${text}`);
}

function assertWholeAnswer(html: string, where: string): void {
	for (const piece of ["<h2>Release plan</h2>", "<strong>Tuesday</strong>", "<em>care</em>", '<a href="https://example.com/notes">the notes</a>', "<li>First point</li>", "<code>point</code>", "<th ", ">Build</td>", '<pre><code>const greeting = "hi";\nconst other = 2;', "<p>That is the plan.</p>"]) {
		assert(html.includes(piece), `${where}: the HTML holds ${piece}, got ${html}`);
	}
	assert(/<table[^>]*>/.test(html) && html.includes("border:1px solid"), `${where}: the table has thin borders, got ${html}`);
	assertNoToolWords(html, where);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Copy Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60000);

	const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP exxperts-lan.test 127.0.0.1"] });
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
		await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
		await ctx.addInitScript(() => {
			try { localStorage.setItem("exxperts.appearance", "system"); } catch {}
		});
		const page = await ctx.newPage();
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		const enterRoom = async (on: Page, origin: string, action: "Enter" | "Resume") => {
			await on.goto(`${origin}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await on.waitForLoadState("networkidle");
			const dismiss = on.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await on.locator(".persistent-agent-card").filter({ hasText: "Copy Room" }).getByRole("button", { name: action }).click();
		};
		await enterRoom(page, baseUrl, "Enter");
		const composer = page.locator("textarea").first();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		const ask = async (prompt: string, firstWords: string) => {
			await composer.fill(prompt);
			await page.locator("button.send-btn").click();
			const answer = page.locator(".assistant-markdown").filter({ hasText: firstWords });
			await answer.waitFor();
			return answer;
		};
		const answer = await ask(ANSWER_PROMPT, "Release plan");
		await waitUntil(() => answer.evaluate((node) => node.querySelectorAll(".code-block pre code span[style]").length > 0), "the code is coloured");
		const answerButton = page.locator(".message-copy-assistant").first();
		await answerButton.waitFor();

		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await waitUntil(() => page.evaluate((want) => document.documentElement.dataset.theme === want, theme), `the page turns ${theme}`);

			await check(`${theme}: a selection copy inside an answer carries clean HTML, and the same text/plain as the browser's own copy`, async () => {
				await selectContents(answer);
				const today = await browserCopy(page);
				assert(today.html?.includes("background-color"), `the browser's own copy carries the page's look, got ${today.html}`);
				const got = await copied(page, () => pressCopy(page));
				assertClean(got.html, theme);
				assertWholeAnswer(got.html, theme);
				assert(got.plain === today.plain, `text/plain stays the browser's, ${JSON.stringify(today.plain)} became ${JSON.stringify(got.plain)}`);
			});

			await check(`${theme}: the answer's Copy button carries the markdown and the same clean HTML`, async () => {
				const got = await copied(page, () => answerButton.click());
				assert(got.plain === ANSWER, `text/plain is the markdown, got ${JSON.stringify(got.plain)}`);
				assertClean(got.html, `${theme} button`);
				assertWholeAnswer(got.html, `${theme} button`);
			});
		}

		await check("the code block's Copy stays plain text", async () => {
			await answer.locator(".code-block").hover();
			const got = await copied(page, () => answer.locator(".code-block").getByRole("button", { name: "Copy code" }).click());
			assert(got.plain === 'const greeting = "hi";\nconst other = 2;', `the code alone, got ${JSON.stringify(got.plain)}`);
			assert(got.html === null, `no HTML beside it, got ${got.html}`);
		});

		await check("part of an answer keeps the marks it needs: lines of code, list items, table rows, a word", async () => {
			const select = async (start: Locator, startOffset: number, end: Locator, endOffset: number) => {
				const last = await end.elementHandle();
				await start.evaluate((from, [to, a, b]) => {
					const [first, second] = [from, to as Node].map((node) => { let at = node; while (at.firstChild) at = at.firstChild; return at; });
					const range = document.createRange();
					range.setStart(first, a as number);
					range.setEnd(second, b as number);
					document.getSelection()!.removeAllRanges();
					document.getSelection()!.addRange(range);
				}, [last, startOffset, endOffset] as const);
			};
			const code = answer.locator(".code-block pre code");
			await select(code, 0, code, 5);
			const line = await copied(page, () => pressCopy(page));
			assertClean(line.html, "code");
			assert(line.html === "<pre><code>const</code></pre>", `a piece of code stays code, got ${line.html}`);
			const items = answer.locator("li");
			await select(items.nth(0), 0, items.nth(1), 3);
			const list = await copied(page, () => pressCopy(page));
			assertClean(list.html, "list");
			assert(/^<ul>/.test(list.html) && list.html.includes("<li>First point</li>"), `list items stay a list, got ${list.html}`);
			const rows = answer.locator("tbody tr");
			await select(rows.nth(0).locator("td").first(), 0, rows.nth(1).locator("td").first(), 3);
			const table = await copied(page, () => pressCopy(page));
			assertClean(table.html, "rows");
			assert(/^<table[^>]*>/.test(table.html) && table.html.includes("<td"), `table rows stay a table, got ${table.html}`);
			const paragraph = answer.locator("p").first();
			await select(paragraph, 0, paragraph, 2);
			const word = await copied(page, () => pressCopy(page));
			assert(word.html === "We", `a word in a paragraph stays a word, got ${word.html}`);
			await answer.locator("h2").click({ clickCount: 3 });
			const heading = await copied(page, () => pressCopy(page));
			assertClean(heading.html, "a triple click");
			assert(heading.html.includes("Release plan"), `a triple click copies the heading, got ${heading.html}`);
		});

		await check("a triple click on an answer's last line stays inside the answer", async () => {
			await answer.locator("p").last().click({ clickCount: 3 });
			const got = await copied(page, () => pressCopy(page));
			assertClean(got.html, "the last line");
			assert(got.plain?.trim() === "That is the plan.", `the line alone, got ${JSON.stringify(got.plain)}`);
		});

		await check("a selection that leaves the answer keeps the browser's copy", async () => {
			await page.evaluate(() => {
				const [person] = document.querySelectorAll(".bubble.user");
				const range = document.createRange();
				range.setStartBefore(person);
				range.setEnd(document.querySelector(".assistant-markdown")!, 1);
				document.getSelection()!.removeAllRanges();
				document.getSelection()!.addRange(range);
			});
			const got = await copied(page, () => pressCopy(page));
			assert(got.plain?.includes(ANSWER_PROMPT), `the selection holds the person's message, got ${JSON.stringify(got.plain)}`);
			assert(got.html?.includes("background-color"), `the browser's own HTML stays, got ${got.html}`);
		});

		await check("the composer keeps the browser's copy", async () => {
			await composer.fill("Words in the box");
			await composer.selectText();
			const got = await copied(page, () => pressCopy(page));
			assert(got.plain === "Words in the box", `the box's words, got ${JSON.stringify(got.plain)}`);
			await composer.fill("");
		});

		const extras = await ask(EXTRAS_PROMPT, "Extras first.");
		await check("a triple click on an answer's last line stays inside the answer with a message after it", async () => {
			await answer.locator("p").last().click({ clickCount: 3 });
			const got = await copied(page, () => pressCopy(page));
			assertClean(got.html, "the last line, a message after it");
			assert(got.plain?.trim() === "That is the plan.", `the line alone, got ${JSON.stringify(got.plain)}`);
		});

		await check("ticks, numbers and formulas stay readable; charts, diagrams and their controls stay behind", async () => {
			await extras.locator("figure.mermaid-diagram svg").first().waitFor();
			await selectContents(extras);
			const selected = await copied(page, () => pressCopy(page));
			const pressed = await copied(page, () => page.locator(".message-copy-assistant").nth(1).click());
			for (const [where, html] of [["selection", selected.html], ["button", pressed.html]] as const) {
				assertClean(html, where);
				assert(html.includes("[x] ") && html.includes("[ ] "), `${where}: a list's ticks read as text, got ${html}`);
				assert(html.includes("<code>x^2+y^2</code>"), `${where}: a formula reads as its TeX, got ${html}`);
				assert(/<ol start="4">\s*<li>Fourth step<\/li>/.test(html), `${where}: a numbered list keeps its first number, got ${html}`);
				assert(!/Requests refused|Approve|Drawing|09:00/.test(html), `${where}: charts and diagrams stay behind, got ${html}`);
				assert(html.includes("Extras first.") && html.includes("Extras last."), `${where}: the words around them stay, got ${html}`);
			}
			assert(pressed.plain === EXTRAS, `the button's text/plain stays the markdown, got ${JSON.stringify(pressed.plain)}`);
		});

		const figures = await ask(FIGURES_PROMPT, "Figures first.");
		const parts = [".figure-table", ".figure-maths", ".code-block", ".answer-chart-card", "figure.mermaid-diagram"].map((selector) => figures.locator(selector));
		await check("a copy across every figure holds none of their tools' words, and keeps the answer's own", async () => {
			await figures.locator("figure.mermaid-diagram .mermaid-diagram-svg svg").waitFor();
			await figures.locator(".answer-chart-svg").waitFor();
			await figures.locator(".figure-maths .katex").waitFor();
			for (const part of parts) await part.getByRole("button", { name: /^Copy / }).waitFor({ state: "attached" });
			assert(await figures.locator(".figure-strip-label").allTextContents().then((labels) => labels.join() === "TypeScript,Diagram"), "the code and the diagram show their labels");
			const copyAcross = async (where: string) => {
				await selectContents(figures);
				const got = await copied(page, () => pressCopy(page));
				assertClean(got.html, where);
				for (const [what, text] of [["html", got.html], ["plain", got.plain]] as const) {
					assertNoToolWords(text, `${where}, ${what}`);
					assert(text?.includes(OWN_WORDS), `${where}, ${what}: the answer's own words stay, got ${text}`);
				}
			};
			await copyAcross("a selection");
			const pressed = await copied(page, () => page.locator(".message-copy-assistant").nth(2).click());
			assertClean(pressed.html, "the button");
			assertNoToolWords(pressed.html, "the button");
			assert(pressed.html.includes(OWN_WORDS), `the button: the answer's own words stay, got ${pressed.html}`);
			assert(pressed.plain === FIGURES, `the button's text/plain stays the markdown, got ${JSON.stringify(pressed.plain)}`);
			await figures.getByRole("button", { name: "Code", exact: true }).click();
			await figures.locator(".answer-chart-card").getByRole("button", { name: "Table", exact: true }).click();
			await copyAcross("a selection with a diagram's code and a chart's table showing");
		});

		await check("a copy from inside one figure holds none of its tools' words", async () => {
			for (const part of parts) {
				await selectContents(part);
				const got = await copied(page, () => pressCopy(page));
				const where = await part.evaluate((node) => node.className);
				assertClean(got.html, where);
				assertNoToolWords(got.html, `${where}, html`);
				assertNoToolWords(got.plain, `${where}, plain`);
			}
		});

		await check("over plain http the page has no clipboard API, and the button still copies the markdown", async () => {
			// The server answers only its own address, so the origin itself shows what plain http takes away and a room page is then built the same way.
			const lan = await ctx.newPage();
			await lan.goto(plainHttpUrl);
			assert(await lan.evaluate(() => navigator.clipboard === undefined && !("ClipboardItem" in window) && !isSecureContext), "plain http has no clipboard API");
			await lan.close();
			// One window holds a room at a time; this one stays on the secure origin to read the clipboard.
			await page.goto(`${baseUrl}/healthz`);
			const plain = await ctx.newPage();
			await plain.addInitScript(() => {
				// A value, not a getter: tsx wraps a function here in a helper the page does not have, and a throw in an init script is silent.
				Object.defineProperty(Navigator.prototype, "clipboard", { value: undefined });
				delete (window as { ClipboardItem?: unknown }).ClipboardItem;
			});
			await enterRoom(plain, baseUrl, "Resume");
			assert(await plain.evaluate(() => navigator.clipboard === undefined && !("ClipboardItem" in window)), "the room page has no clipboard API");
			const button = plain.locator(".message-copy-assistant").first();
			await button.waitFor();
			await page.bringToFront();
			await page.evaluate(() => navigator.clipboard.writeText(""));
			await plain.bringToFront();
			await button.click();
			await waitUntil(() => button.evaluate((node) => node.classList.contains("is-copied")), "the button says it copied");
			await page.bringToFront();
			const got = await readClipboard(page);
			assert(got.plain === ANSWER, `text/plain is the markdown, got ${JSON.stringify(got.plain)}`);
			await plain.close();
		});

		assert(pageErrors.length === 0, `the page threw nothing: ${pageErrors.join(" | ")}`);
	} finally {
		await browser.close();
	}
	console.log("answer copy smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	try { (provider as any).closeAllConnections?.(); } catch {}
	try { provider.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
