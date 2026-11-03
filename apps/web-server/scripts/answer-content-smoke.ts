// How a diagram in an answer looks, in the browser, while the answer is
// written and after: while its fence is still open the page shows a quiet
// box, never a half-drawn diagram or an error, its code one click away; once
// the fence closes the diagram is drawn exactly once, while the answer below
// it still arrives and after it ends; it is drawn in the app's own colours,
// dark and light, following a theme change; and its hover tools copy it as a
// PNG, show its code in place, and open the viewer behind a blurred veil.
// Code in an answer is coloured: line by line while its block is written,
// the line still being written plain, in every language the page names,
// with a plain block for one it does not, in our own colours that read at
// 4.5:1 or more on the code's background, dark and light, desktop and phone.
// Maths is typeset by KaTeX, which comes from our own server with the first
// formula: inline at once, prices left as text, a display formula a quiet box
// until it parses and then its last good picture. A chart is a quiet box while
// its block is written, its language included, and is drawn once the block
// closes, with its value on hover, Table and Copy image; a block that is no
// chart stays code. Both take the theme's colours, dark and light.
//
// Offline: the room's model is a synthetic OpenAI-compatible server in this
// process that writes the answer piece by piece as the smoke asks. The
// sections build on each other, so they always run together.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { chromium, type Locator, type Page } from "playwright";
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
		console.log("answer content smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const PROMPT = "Draw the approval flow.";
const DIAGRAM = ["flowchart LR", "  A[Request] --> B{Within budget?}", "  B -->|yes| C[Approve]", "  B -->|no| D[Ask finance]"];
// A second question, answered at once: a diagram with maths, which needs
// HTML labels and so cannot be copied as a picture.
const MATHS_PROMPT = "Draw the area formula.";
const MATHS_ANSWER = "The formula:\n\n```mermaid\nflowchart LR\n  A[\"$$x^2+y^2$$\"] --> B[Area]\n```\n\nDone.";
// A third, answered at once: enough diagrams that a theme change lands while
// some still wait for their turn to be drawn.
const MANY_PROMPT = "Draw many flows.";
const MANY = 8;
const MANY_ANSWER = "Many flows:\n\n" + Array.from({ length: MANY }, (_, i) => `\`\`\`mermaid\nflowchart LR\n  S${i}[Step ${i}] --> T${i}[Next ${i}] --> U${i}[Last ${i}]\n\`\`\``).join("\n\n");
// Another, answered at once: a diagram with a picture in a node, which an
// SVG decoded on its own cannot load, so it cannot be copied as a picture either.
const PICTURE_PROMPT = "Draw the app with its icon.";
const PICTURE_ANSWER = "With a picture:\n\n```mermaid\nflowchart LR\n  A@{ img: \"/brand/icon-192.png\", label: \"App\", w: 60, h: 60 } --> B[Done]\n```";
// A fourth, written piece by piece like the first: code blocks.
const CODE_PROMPT = "Show me the commands.";
// Another, written piece by piece: formulas and charts.
const CONTENT_PROMPT = "Show the maths and the charts.";
const CHART = ["type: bar", "title: Requests refused per hour", "Hour, Refused", "09:00, 12", "10:00, 30", "11:00, 84", "12:00, 41"];
// A fifth, answered at once: one block in each language the page colours,
// under the last name its table gives it, each with a comment, a string or a
// keyword to colour.
const LANGUAGES_PROMPT = "Show every language.";
const SAMPLES: Record<string, string> = {
	shellscript: 'echo "hi" # note',
	powershell: 'Write-Host "hi" # note',
	bat: 'REM note\necho "hi"',
	python: 'def greet():\n    return "hi"  # note',
	javascript: 'const a = "hi"; // note',
	typescript: 'let a: string = "hi";',
	jsx: 'const a = <b className="x">hi</b>;',
	tsx: 'const a: JSX.Element = <b className="x">hi</b>;',
	json: '{"name": "hi", "count": 2}',
	jsonc: '{"name": "hi" // note\n}',
	yaml: 'name: "hi" # note',
	toml: 'name = "hi" # note',
	ini: '[core]\nname = hi ; note',
	html: '<p class="x">hi</p>',
	css: 'p { color: red; } /* note */',
	scss: '$c: red;\np { color: $c; }',
	sql: "SELECT name FROM t WHERE id = 'x'; -- note",
	go: 'func main() { fmt.Println("hi") }',
	rust: 'fn main() { println!("hi"); }',
	java: 'class A { String s = "hi"; }',
	kotlin: 'fun main() { val s = "hi" }',
	c: 'int main(void) { return 0; } /* note */',
	csharp: 'var s = "hi"; // note',
	swift: 'let s = "hi" // note',
	php: '<?php echo "hi"; // note',
	diff: '--- a\n+++ b\n-old\n+new',
	dockerfile: 'FROM node:20\nRUN echo "hi"',
	markdown: '# Title\n\nSome *words*',
	xml: '<a b="c">hi</a>',
	graphql: 'query { user(id: "1") { name } }',
};
// Every colour a token can take, by its variable.
const CODE_TOKENS = ["foreground", "token-keyword", "token-string", "token-string-expression", "token-constant", "token-function", "token-link", "token-comment", "token-punctuation", "token-parameter", "token-inserted", "token-deleted", "token-changed"].map((name) => `--code-${name}`);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-answer-content-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

function sse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// A turn for a question written piece by piece stays open until the smoke
// ends it: `say` writes the next piece of the answer, `finish` ends it. Any
// other request (a title, say) gets a short answer at once.
const HELD = [PROMPT, CODE_PROMPT, CONTENT_PROMPT];
const heldDone = new Set<string>();
let turn: { res: http.ServerResponse; base: Record<string, unknown>; prompt: string } | undefined;
const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_answer_content", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		// What the person asked last decides the answer: the history repeats the earlier questions.
		const asked = JSON.stringify([...(body.messages ?? [])].reverse().find((message: { role?: string; content?: unknown }) => message.role === "user" && !JSON.stringify(message.content ?? "").includes(ROOM_STATE_HEADING)) ?? "");
		const said = asked.includes(PICTURE_PROMPT) ? PICTURE_ANSWER : asked.includes(LANGUAGES_PROMPT) ? languagesAnswer() : asked.includes(MANY_PROMPT) ? MANY_ANSWER : asked.includes(MATHS_PROMPT) ? MATHS_ANSWER : "Approval flow";
		const held = HELD.find((prompt) => asked.includes(prompt) && !heldDone.has(prompt));
		if (!turn && held) {
			turn = { res, base, prompt: held };
			sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
			return;
		}
		sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: said }, finish_reason: null }] });
		sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
function say(text: string): void {
	assert(turn, "the room's turn has reached the model");
	sse(turn.res, { ...turn.base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}
function finish(): void {
	assert(turn, "the room's turn has reached the model");
	sse(turn.res, { ...turn.base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } });
	turn.res.write("data: [DONE]\n\n");
	turn.res.end();
	heldDone.add(turn.prompt);
	turn = undefined;
}

// What the page shows of its diagrams, read in one go.
async function diagramState(page: Page) {
	return page.evaluate(() => ({
		boxes: document.querySelectorAll('figure[aria-label="Drawing diagram"]').length,
		drawn: document.querySelectorAll("figure.mermaid-diagram .mermaid-diagram-svg svg").length,
		// Any svg mermaid made: a drawing, or its own error picture.
		svgs: document.querySelectorAll('svg[id^="mermaid-"]').length,
		fallbacks: document.querySelectorAll("pre.mermaid-fallback").length,
		errors: document.querySelectorAll('[aria-roledescription="error"], .mermaid-viewer-error').length,
		draws: (window as unknown as { diagramDraws: number }).diagramDraws,
	}));
}

/** The colour a token resolves to on the page, as the browser writes it (rgb). */
function tokenColour(page: Page, token: string): Promise<string> {
	return page.evaluate((name) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${name})`;
		document.body.append(probe);
		const colour = getComputedStyle(probe).color;
		probe.remove();
		return colour;
	}, token);
}

/** Turns the device's theme, which the page follows ("System"), and waits until it has. */
async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
	await page.emulateMedia({ colorScheme: theme });
	await waitUntil(() => page.evaluate((want) => document.documentElement.dataset.theme === want, theme), `the page turns ${theme}`);
}

/** The drawn diagram's colours: a node's box and border, its words, an edge line. */
function diagramColours(page: Page) {
	return page.evaluate(() => {
		const svg = document.querySelector("figure.mermaid-diagram .mermaid-diagram-svg svg")!;
		const box = svg.querySelector(".node rect")!;
		const words = svg.querySelector(".node text, .node tspan")!;
		const edge = svg.querySelector(".flowchart-link")!;
		return { box: getComputedStyle(box).fill, border: getComputedStyle(box).stroke, words: getComputedStyle(words).fill, edge: getComputedStyle(edge).stroke };
	});
}

/** What the page shows of an answer's code blocks, in order: the label, the text, the colours, and the plain text after the last coloured line. */
function codeBlocks(answer: Locator) {
	return answer.locator(".code-block").evaluateAll((blocks) => blocks.map((block) => {
		const code = block.querySelector("pre code") ?? block.querySelector("pre")!;
		const spans = [...code.querySelectorAll<HTMLElement>("span[style]")];
		// The plain text after the last coloured piece: the line being written.
		const nodes = [...code.childNodes];
		let cut = nodes.length;
		while (cut > 0 && nodes[cut - 1].nodeType === Node.TEXT_NODE) cut--;
		return {
			label: block.querySelector(".code-block-lang")?.textContent ?? null,
			text: code.textContent ?? "",
			styles: [...new Set(spans.map((span) => span.style.color))],
			colours: [...new Set(spans.map((span) => getComputedStyle(span).color))],
			coloured: nodes.slice(0, cut).map((node) => node.textContent ?? "").join(""),
			plainTail: nodes.slice(cut).map((node) => node.textContent ?? "").join(""),
		};
	}));
}

/** The colour and style of the first coloured piece of code holding a word. */
function wordStyle(answer: Locator, word: string) {
	return answer.locator(".code-block pre code span[style]", { hasText: word }).first().evaluate((span) => ({ colour: getComputedStyle(span).color, italic: getComputedStyle(span).fontStyle === "italic" }));
}

/** Each code colour and the code's background in the page's theme, as [r, g, b], and which colours the theme leaves unset. */
function codePalette(page: Page) {
	return page.evaluate((tokens) => {
		const pre = document.querySelector(".assistant-markdown .code-block pre")!;
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext("2d", { willReadFrequently: true })!;
		const probe = document.createElement("span");
		pre.append(probe);
		const rgb: Record<string, number[]> = {};
		const unset: string[] = [];
		for (const name of ["background", ...tokens]) {
			if (name !== "background" && !getComputedStyle(pre).getPropertyValue(name).trim()) unset.push(name);
			probe.style.color = name === "background" ? "" : `var(${name})`;
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = name === "background" ? getComputedStyle(pre).backgroundColor : getComputedStyle(probe).color;
			context.fillRect(0, 0, 1, 1);
			rgb[name] = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
		}
		probe.remove();
		return { rgb, unset };
	}, CODE_TOKENS);
}

/** WCAG contrast of two colours given as [r, g, b]. */
function contrast(a: number[], b: number[]): number {
	const luminance = (colour: number[]) => {
		const [r, g, bl] = colour.map((value) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

// The fences of the every-language answer, from the page's own table once the smoke has read it.
let languageFences: { id: string; fence: string; label: string }[] = [];
function languagesAnswer(): string {
	return "Every language:\n\n" + languageFences.map(({ id, fence }) => `\`\`\`${fence}\n${SAMPLES[id]}\n\`\`\``).join("\n\n");
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await check("the built page starts with no Shiki, holds no WebAssembly and no grammar without a licence", async () => {
		const dist = path.join(repoRoot, "apps", "web-ui", "dist");
		const assets = fs.readdirSync(path.join(dist, "assets"));
		// What index.html loads at start: its script and the chunks it preloads.
		const start = [...fs.readFileSync(path.join(dist, "index.html"), "utf8").matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((match) => match[1]);
		assert(start.length > 0, "index.html loads a script");
		const shikiAtStart = start.filter((file) => /createHighlighterCore|createJavaScriptRegexEngine|vscode-textmate/.test(fs.readFileSync(path.join(dist, file), "utf8")));
		assert(shikiAtStart.length === 0, `no Shiki code in what the page loads at start, found in ${shikiAtStart}`);
		assert(assets.some((file) => fs.readFileSync(path.join(dist, "assets", file), "utf8").includes("createJavaScriptRegexEngine")), "Shiki's JavaScript engine is a chunk of the build");
		const wasm = assets.filter((file) => file.endsWith(".wasm"));
		assert(wasm.length === 0, `the build holds no WebAssembly, found ${wasm}`);
		// Shiki's GLSL grammar carries no licence; only C++ (and Ruby, through it) would bring it in.
		const glsl = assets.filter((file) => file.endsWith(".js") && fs.readFileSync(path.join(dist, "assets", file), "utf8").includes("source.glsl"));
		assert(glsl.length === 0, `no chunk holds the GLSL grammar, found in ${glsl}`);
	});

	await check("the built page starts with no KaTeX and no chart drawing, and holds one KaTeX, shared with the diagrams' maths", async () => {
		const dist = path.join(repoRoot, "apps", "web-ui", "dist");
		const assets = fs.readdirSync(path.join(dist, "assets"));
		const read = (file: string) => fs.readFileSync(path.join(dist, file), "utf8");
		const start = [...read("index.html").matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]);
		// The chart's rules are in the page's stylesheet; its drawing code (ChartBlock.tsx) is not.
		const late = start.filter((file) => (file.endsWith(".css") ? /font-family:\s*KaTeX_/ : /KaTeX parse error|answer-chart-hit/).test(read(file)));
		assert(start.length > 0 && late.length === 0, `what index.html loads at start holds no KaTeX, its stylesheet or the chart drawing, found in ${late}`);
		const katex = assets.filter((file) => file.endsWith(".js") && read(`assets/${file}`).includes("KaTeX parse error"));
		assert(katex.length === 1, `the build holds one KaTeX, got ${katex}`);
		const users = assets.filter((file) => file.endsWith(".js") && read(`assets/${file}`).includes(katex[0]));
		assert(users.some((file) => file.startsWith("mermaid")) && users.some((file) => !file.startsWith("mermaid")), `the answer's maths and mermaid's load the same KaTeX chunk, got ${users}`);
		const inlined = assets.filter((file) => file.endsWith(".css") && /url\(\s*["']?data:font/.test(read(`assets/${file}`)));
		assert(inlined.length === 0 && assets.some((file) => /^KaTeX_Main-Regular-.*\.woff2$/.test(file)), `KaTeX's fonts stay files, none inlined, got ${inlined}`);
	});

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
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Diagram Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });

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
		// The theme follows the device ("System"), which starts dark here.
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
		await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
		await ctx.addInitScript(() => {
			try { localStorage.setItem("exxperts.appearance", "system"); } catch {}
			// Counts every drawing of a diagram put into the page, however it got there.
			const counter = window as unknown as { diagramDraws: number };
			counter.diagramDraws = 0;
			new MutationObserver((records) => {
				for (const record of records) for (const node of record.addedNodes) {
					if (!(node instanceof Element)) continue;
					const drawings = [node, ...node.querySelectorAll("svg")].filter((element) => element.tagName.toLowerCase() === "svg" && element.parentElement?.classList.contains("mermaid-diagram-svg"));
					counter.diagramDraws += drawings.length;
				}
			}).observe(document, { childList: true, subtree: true });
		});
		const page = await ctx.newPage();
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
		// Shiki, its grammars and mermaid come from our own build: the page asks no other origin.
		const elsewhere: string[] = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (/^(?:https?|wss?):$/.test(url.protocol) && url.host !== new URL(baseUrl).host) elsewhere.push(request.url());
		});
		page.on("websocket", (socket) => { if (new URL(socket.url()).host !== new URL(baseUrl).host) elsewhere.push(socket.url()); });
		// KaTeX's script, stylesheet and fonts, as the page loads them.
		const katexLoads: { url: string; status: number }[] = [];
		page.on("response", (response) => { if (/katex/i.test(response.url())) katexLoads.push({ url: response.url(), status: response.status() }); });
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".persistent-agent-card").filter({ hasText: "Diagram Room" }).getByRole("button", { name: "Enter" }).click();
		const composer = page.locator("textarea").first();
		await composer.waitFor({ timeout: 15000 });
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForLoadState("networkidle");
		assert(katexLoads.length === 0, `the page loads no KaTeX before a formula, got ${JSON.stringify(katexLoads)}`);
		await composer.fill(PROMPT);
		await page.locator("button.send-btn").click();
		await waitUntil(() => turn !== undefined, "the room's turn reaches the model");
		const figure = page.locator("figure.mermaid-diagram:not(.mermaid-diagram-loading)");

		await check("while a diagram's fence is open the page shows a quiet box, never a drawing or an error", async () => {
			// Its language half typed: already the box, never a code block first.
			say("Here is the flow:\n\n```mer");
			const box = page.locator('figure[aria-label="Drawing diagram"]');
			await box.waitFor({ timeout: 15000 });
			assert(!(await page.locator(".assistant-markdown .code-block").count()), "a fence whose language may become mermaid shows no code block");
			say("maid\n" + DIAGRAM[0] + "\n");
			assert(await box.getByText("Drawing diagram…").isVisible(), "the box says the diagram is being drawn");
			assert(!(await box.locator("code").count()), "the box hides the code being written");
			// Its code is one click away, and keeps growing behind the toggle.
			await box.getByRole("button", { name: "Show code" }).click();
			for (let line = 1; line < DIAGRAM.length; line++) {
				say(DIAGRAM[line] + "\n");
				const written = DIAGRAM[line].trim();
				await waitUntil(async () => ((await box.locator("code").textContent()) ?? "").includes(written), `the box's code shows line ${line + 1}`);
				const state = await diagramState(page);
				assert(state.boxes === 1 && state.svgs === 0 && state.fallbacks === 0 && state.errors === 0 && state.draws === 0, `with ${line + 1} of ${DIAGRAM.length} lines written there is only the box, got ${JSON.stringify(state)}`);
			}
		});

		await check("once the fence closes the diagram is drawn once, while the answer goes on and after it ends", async () => {
			say("```\n\nThe text below it is still");
			await figure.locator(".mermaid-diagram-svg svg").waitFor({ timeout: 30000 });
			assert(await page.locator(".stop-btn").count(), "the answer is still being written when the diagram is drawn");
			const drawn = await diagramState(page);
			assert(drawn.boxes === 0 && drawn.drawn === 1 && drawn.draws === 1 && drawn.errors === 0, `the box gives way to one drawing, got ${JSON.stringify(drawn)}`);
			say(" arriving,");
			await page.getByText("still arriving,").waitFor({ timeout: 15000 });
			say(" word by word.");
			finish();
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the answer has ended", 30000);
			await page.getByText("still arriving, word by word.").waitFor({ timeout: 15000 });
			const ended = await diagramState(page);
			assert(ended.drawn === 1 && ended.draws === 1 && ended.boxes === 0, `the diagram is not drawn again as the answer goes on or ends, got ${JSON.stringify(ended)}`);
		});

		await check("the diagram takes its colours from the app's tokens, dark and light", async () => {
			const expected = async () => ({ box: await tokenColour(page, "--panel"), border: await tokenColour(page, "--border"), words: await tokenColour(page, "--fg"), edge: await tokenColour(page, "--muted") });
			const dark = await expected();
			const drawnDark = await diagramColours(page);
			assert(JSON.stringify(drawnDark) === JSON.stringify(dark), `dark: the diagram's box, border, words and lines are the card, border, text and muted colours, got ${JSON.stringify(drawnDark)}, want ${JSON.stringify(dark)}`);
			const cardDark = await figure.evaluate((element) => getComputedStyle(element).backgroundColor);
			assert(cardDark === dark.box, `dark: the diagram sits on the card colour, got ${cardDark}`);
			await setTheme(page, "light");
			const light = await expected();
			assert(light.box !== dark.box && light.words !== dark.words, `the two themes have their own colours, got ${JSON.stringify({ light, dark })}`);
			await waitUntil(async () => JSON.stringify(await diagramColours(page)) === JSON.stringify(light), `light: the diagram is drawn again in the light colours ${JSON.stringify(light)}`, 15000);
		});

		await check("Copy image puts the diagram on the clipboard as a PNG on the card's colour", async () => {
			await figure.hover();
			const copy = figure.getByRole("button", { name: "Copy image" });
			assert(await copy.isVisible(), "Copy image shows on hover");
			await copy.click();
			await figure.getByRole("button", { name: "Copied image" }).waitFor({ timeout: 15000 });
			const card = await figure.evaluate((element) => getComputedStyle(element).backgroundColor);
			const png = await page.evaluate(async () => {
				const items = await navigator.clipboard.read();
				const item = items.find((entry) => entry.types.includes("image/png"));
				if (!item) return { types: items.flatMap((entry) => entry.types), width: 0, height: 0, corner: "" };
				const bitmap = await createImageBitmap(await item.getType("image/png"));
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const context = canvas.getContext("2d")!;
				context.drawImage(bitmap, 0, 0);
				const [r, g, b] = context.getImageData(1, 1, 1, 1).data;
				return { types: ["image/png"], width: bitmap.width, height: bitmap.height, corner: `rgb(${r}, ${g}, ${b})` };
			});
			const svgWidth = await figure.locator(".mermaid-diagram-svg svg").evaluate((svg) => svg.getBoundingClientRect().width);
			assert(png.types.includes("image/png") && png.width > 0 && png.height > 0, `the clipboard holds a PNG, got ${JSON.stringify(png)}`);
			assert(Math.abs(png.width - Math.round(svgWidth * 2)) <= 2, `the PNG is twice the diagram's size on screen, got ${png.width} for ${svgWidth}`);
			assert(png.corner === card, `the PNG is on the card's colour ${card}, got ${png.corner}`);
		});

		await check("Code shows the diagram's source in place of the drawing, and back", async () => {
			await figure.hover();
			await figure.getByRole("button", { name: "Code", exact: true }).click();
			const code = figure.locator(".figure-code code");
			await code.waitFor();
			assert((await code.textContent())?.trim() === DIAGRAM.join("\n"), `the code reads as written, got ${await code.textContent()}`);
			assert(!(await figure.locator(".mermaid-diagram-svg").count()) && !(await figure.getByRole("button", { name: "Copy image" }).count()), "the drawing and Copy image give way to the code");
			assert(await figure.locator(".figure-code").getByRole("button", { name: /copy/i }).count(), "the code has its own Copy");
			const clear = await figure.evaluate((element) => {
				const tools = element.querySelector(".figure-tools")!.getBoundingClientRect();
				const firstLine = element.querySelector(".figure-code code > span")!.getBoundingClientRect();
				return { toolsBottom: tools.bottom, lineTop: firstLine.top };
			});
			assert(clear.lineTop >= clear.toolsBottom, `the code's first line starts below the tools, got ${JSON.stringify(clear)}`);
			await figure.getByRole("button", { name: "Code", exact: true }).click();
			await figure.locator(".mermaid-diagram-svg svg").waitFor();
		});

		await check("expand opens the viewer, its veil blurred like every dialog's", async () => {
			await figure.hover();
			await figure.getByRole("button", { name: "Open expanded diagram" }).click();
			const viewer = page.getByRole("dialog", { name: "Expanded Mermaid diagram" });
			await viewer.locator(".mermaid-viewer-svg svg").waitFor({ timeout: 15000 });
			const veil = await viewer.evaluate((element) => getComputedStyle(element).backdropFilter);
			assert(veil === "blur(10px)", `the viewer's veil is blurred, got ${veil}`);
			await viewer.getByRole("button", { name: "Code", exact: true }).click();
			assert((await viewer.locator(".figure-code code").textContent())?.trim() === DIAGRAM.join("\n"), "the viewer shows the code too");
			// The theme changes while the code is shown: back on the drawing, Fit and zoom still work.
			await setTheme(page, "dark");
			await viewer.getByRole("button", { name: "Code", exact: true }).click();
			await viewer.locator(".mermaid-viewer-svg svg").waitFor({ timeout: 15000 });
			await waitUntil(() => viewer.getByRole("button", { name: "Fit to window" }).isEnabled(), "Fit works again once the drawing is back");
			const before = await viewer.getByRole("button", { name: "Actual size" }).textContent();
			await viewer.getByRole("button", { name: "Zoom in" }).click();
			await waitUntil(async () => (await viewer.getByRole("button", { name: "Actual size" }).textContent()) !== before, "zoom in changes the zoom");
			// The same drawing back from its code keeps the zoom the person chose.
			const chosen = await viewer.getByRole("button", { name: "Actual size" }).textContent();
			await viewer.getByRole("button", { name: "Code", exact: true }).click();
			await viewer.locator(".figure-code code").waitFor();
			await viewer.getByRole("button", { name: "Code", exact: true }).click();
			await viewer.locator(".mermaid-viewer-svg svg").waitFor({ timeout: 15000 });
			await waitUntil(() => viewer.getByRole("button", { name: "Fit to window" }).isEnabled(), "the drawing is measured again");
			const kept = await viewer.getByRole("button", { name: "Actual size" }).textContent();
			assert(kept === chosen, `back from the code the zoom stays at ${chosen}, got ${kept}`);
			// …and the place it was scrolled to.
			const body = viewer.locator(".mermaid-viewer-body");
			for (let i = 0; i < 8 && !(await body.evaluate((element) => element.scrollWidth > element.clientWidth + 40)); i++) await viewer.getByRole("button", { name: "Zoom in" }).click();
			const panned = await body.evaluate((element) => {
				element.scrollLeft = Math.round((element.scrollWidth - element.clientWidth) / 2);
				return element.scrollLeft;
			});
			assert(panned > 0, "the zoomed drawing scrolls sideways");
			await viewer.getByRole("button", { name: "Code", exact: true }).click();
			await viewer.locator(".figure-code code").waitFor();
			await viewer.getByRole("button", { name: "Code", exact: true }).click();
			await viewer.locator(".mermaid-viewer-svg svg").waitFor({ timeout: 15000 });
			const back = await body.evaluate((element) => element.scrollLeft);
			assert(Math.abs(back - panned) <= 1, `back from the code the drawing is where it was scrolled to, ${panned}, got ${back}`);
			await page.keyboard.press("Escape");
			await waitUntil(async () => (await viewer.count()) === 0, "the viewer closes");
		});

		await check("a diagram with maths keeps its maths, its Code and expand, but offers no Copy image", async () => {
			await composer.fill(MATHS_PROMPT);
			await page.locator("button.send-btn").click();
			const maths = figure.nth(1);
			await maths.locator(".mermaid-diagram-svg svg math").waitFor({ timeout: 30000 });
			await maths.hover();
			assert(await maths.getByRole("button", { name: "Code", exact: true }).isVisible() && await maths.getByRole("button", { name: "Open expanded diagram" }).isVisible(), "the maths diagram has Code and expand");
			assert(!(await maths.getByRole("button", { name: "Copy image" }).count()), "a drawing the browser cannot copy offers no Copy image");
			await figure.first().hover();
			assert(await figure.first().getByRole("button", { name: "Copy image" }).isVisible(), "the diagram without maths still offers it");
		});

		await check("a theme change while diagrams wait to be drawn leaves none in the other theme's colours", async () => {
			await setTheme(page, "dark");
			// The drawing script is held back after a reload until the theme has
			// changed, so every draw asked for in dark starts in light.
			let release = () => {};
			const held = new Promise<void>((resolve) => { release = resolve; });
			const drawingScript = /\/mermaid\.core-[^/]*\.js$/;
			await page.route(drawingScript, async (route) => { await held; await route.continue(); });
			await page.reload({ waitUntil: "domcontentloaded" });
			await composer.waitFor({ timeout: 15000 });
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await composer.fill(MANY_PROMPT);
			await page.locator("button.send-btn").click();
			const answer = page.locator(".assistant-markdown").filter({ hasText: "Many flows:" });
			await waitUntil(async () => (await answer.locator("figure.mermaid-diagram-loading").count()) === MANY, "all eight wait to be drawn", 30000);
			await setTheme(page, "light");
			release();
			const drawnIn = () => answer.locator("figure.mermaid-diagram .mermaid-diagram-svg svg .node rect").evaluateAll((rects) => [...new Set(rects.map((rect) => getComputedStyle(rect).fill))]);
			const lightBox = await tokenColour(page, "--panel");
			await waitUntil(async () => (await answer.locator(".mermaid-diagram-svg svg").count()) === MANY && JSON.stringify(await drawnIn()) === JSON.stringify([lightBox]), "all eight are drawn in the light colours", 30000);
			await page.unroute(drawingScript);
			await setTheme(page, "dark");
			const darkBox = await tokenColour(page, "--panel");
			await waitUntil(async () => JSON.stringify(await drawnIn()) === JSON.stringify([darkBox]), "back in dark, all eight show the dark colours", 15000);
		});

		await check("a diagram with a picture in a node keeps its Code and expand, but offers no Copy image", async () => {
			await composer.fill(PICTURE_PROMPT);
			await page.locator("button.send-btn").click();
			const pictured = page.locator(".assistant-markdown").filter({ hasText: "With a picture:" }).locator("figure.mermaid-diagram:not(.mermaid-diagram-loading)");
			await pictured.locator(".mermaid-diagram-svg svg image").waitFor({ state: "attached", timeout: 30000 });
			await pictured.hover();
			assert(await pictured.getByRole("button", { name: "Code", exact: true }).isVisible() && await pictured.getByRole("button", { name: "Open expanded diagram" }).isVisible(), "the pictured diagram has Code and expand");
			assert(!(await pictured.getByRole("button", { name: "Copy image" }).count()), "a drawing whose picture the copy would leave out offers no Copy image");
		});

		const codeAnswer = page.locator(".assistant-markdown").filter({ hasText: "Run these:" });
		await check("while a code block is written its finished lines are coloured and the line being written stays plain", async () => {
			await composer.fill(CODE_PROMPT);
			await page.locator("button.send-btn").click();
			await waitUntil(() => turn?.prompt === CODE_PROMPT, "the code question's turn reaches the model");
			say("Run these:\n\n```sh\n# install\nnpm ci\nnpm run");
			// The page shows a streamed answer as it arrives, a few letters at a time: wait until all of it is shown.
			await waitUntil(async () => {
				const [block] = await codeBlocks(codeAnswer);
				return block?.text === "# install\nnpm ci\nnpm run" && block.styles.length > 0;
			}, "the block's finished lines are coloured while it is written", 15000);
			const [writing] = await codeBlocks(codeAnswer);
			assert(writing.label === "Shell", `the label shows the language's name, got ${writing.label}`);
			assert(writing.coloured === "# install\nnpm ci" && writing.plainTail === "\nnpm run", `the finished lines are coloured and the line being written is plain, got ${JSON.stringify(writing)}`);
			assert(writing.styles.every((style) => style.startsWith("var(--code-")), `every colour is one of our code tokens, got ${writing.styles}`);
			const comment = await wordStyle(codeAnswer, "install");
			assert(comment.colour === (await tokenColour(page, "--code-token-comment")) && comment.italic, `a comment is in the comment colour, in italic, got ${JSON.stringify(comment)}`);
			// The finished lines keep their coloured pieces as the next lines arrive.
			const seen = await codeAnswer.locator(".code-block").first().evaluate((block) => {
				const spans = block.querySelectorAll("pre code span[style]");
				spans.forEach((span) => span.setAttribute("data-seen", ""));
				return spans.length;
			});
			say(" build\n# check\n");
			await waitUntil(async () => (await codeBlocks(codeAnswer))[0]?.text === "# install\nnpm ci\nnpm run build\n# check", "the next line is shown", 15000);
			const [grown] = await codeBlocks(codeAnswer);
			assert(grown.coloured === "# install\nnpm ci\nnpm run build", `the line that ended is coloured too, got ${JSON.stringify(grown)}`);
			const kept = await codeAnswer.locator(".code-block pre code span[data-seen]").count();
			assert(kept === seen, `the earlier lines keep their coloured pieces, ${kept} of ${seen}`);
			say("```\n\nThen the types:\n\n```ts\nconst total: number = 2;\n```\n\n```json\n{\"name\": \"exxperts\", \"count\": 2}\n```\n\n```zzlang\nplain words here\n```\n\nDone.");
			finish();
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the answer has ended", 30000);
		});

		await check("a finished answer's blocks are coloured in their language under its name; an unknown language stays plain, labelled as written", async () => {
			await waitUntil(async () => {
				const blocks = await codeBlocks(codeAnswer);
				// Send comes back when the model is done, while the answer's last words may still be appearing: wait until the last block is whole.
				return blocks.length === 4 && blocks.slice(0, 3).every((block) => block.colours.length >= 2) && blocks[3].text.trimEnd() === "plain words here";
			}, "the shell, TypeScript and JSON blocks are coloured and the last block is whole", 15000);
			const blocks = await codeBlocks(codeAnswer);
			assert(JSON.stringify(blocks.map((block) => block.label)) === JSON.stringify(["Shell", "TypeScript", "JSON", "zzlang"]), `the labels read ${blocks.map((block) => block.label)}`);
			assert(blocks[0].coloured === "# install\nnpm ci\nnpm run build\n# check" && blocks[0].plainTail === "", `once the block closes every line is coloured, got ${JSON.stringify(blocks[0])}`);
			assert(blocks[3].styles.length === 0 && blocks[3].text.trimEnd() === "plain words here", `an unknown language is plain code, got ${JSON.stringify(blocks[3])}`);
			const keyword = await wordStyle(codeAnswer, "const");
			assert(keyword.colour === (await tokenColour(page, "--code-token-keyword")), `a TypeScript keyword is in the keyword colour, got ${keyword.colour}`);
			const text = await wordStyle(codeAnswer, "exxperts");
			assert(text.colour === (await tokenColour(page, "--code-token-string")), `a JSON string is in the string colour, got ${text.colour}`);
		});

		await check("every code colour is one of our tokens, at least 4.5:1 on the code's background, dark and light", async () => {
			for (const theme of ["dark", "light"] as const) {
				await setTheme(page, theme);
				const { rgb, unset } = await codePalette(page);
				assert(unset.length === 0, `${theme}: every code colour is set, missing ${unset}`);
				const ratios = CODE_TOKENS.map((name) => [name, Math.floor(contrast(rgb[name], rgb.background) * 100) / 100] as const);
				console.log(`      ${theme} on rgb(${rgb.background}): ${ratios.map(([name, ratio]) => `${name.replace("--code-", "")} ${ratio}`).join(", ")}`);
				const low = ratios.filter(([, ratio]) => ratio < 4.5);
				assert(low.length === 0, `${theme}: under 4.5:1 on the code's background: ${JSON.stringify(low)}`);
				// The drawn code follows the theme at once: its colours are this theme's.
				const palette = new Set(CODE_TOKENS.map((name) => `rgb(${rgb[name].join(", ")})`));
				const shown = (await codeBlocks(codeAnswer)).flatMap((block) => block.colours);
				assert(shown.every((colour) => palette.has(colour)), `${theme}: the code shows this theme's colours, got ${shown} for ${[...palette]}`);
			}
			await setTheme(page, "dark");
		});

		const contentAnswer = page.locator(".assistant-markdown").filter({ hasText: "Maths first:" });
		await check("maths is typeset as it is written: inline at once, prices as text, a display formula a quiet box and then its last good picture", async () => {
			await composer.fill(CONTENT_PROMPT);
			await page.locator("button.send-btn").click();
			await waitUntil(() => turn?.prompt === CONTENT_PROMPT, "the maths question's turn reaches the model");
			assert(!katexLoads.some(({ url }) => /\.(?:css|woff2?|ttf)$/.test(url)), `before the answer's first formula no KaTeX stylesheet or font is loaded, got ${JSON.stringify(katexLoads)}`);
			// Every look the display formula takes while it is written (its TeX when typeset, else what it shows),
			// and whether the chart's numbers ever show as code before its fence closes.
			await page.evaluate(() => {
				const watch = window as unknown as { displayLooks: string[]; chartAsCode: boolean };
				watch.displayLooks = [];
				watch.chartAsCode = false;
				new MutationObserver(() => {
					const display = document.querySelector(".maths-display");
					if (display) {
						const look = display.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? `shown:${display.textContent}${display.classList.contains("maths-pending") ? ":pending" : ""}`;
						if (watch.displayLooks.at(-1) !== look) watch.displayLooks.push(look);
					}
					if ([...document.querySelectorAll(".assistant-markdown pre")].some((pre) => pre.textContent?.includes("Requests refused per hour"))) watch.chartAsCode = true;
				}).observe(document, { childList: true, subtree: true, characterData: true });
			});
			say("Maths first: the circle is \\( x^2 + y^2 = r^2 \\), each $x$ counts, it costs $5 and $10, run `echo $HOME` in C:\\exxtest\\.\n\n$$\n\\frac{a}{");
			await waitUntil(async () => ((await contentAnswer.textContent()) ?? "").includes("run echo $HOME in C:\\exxtest\\.") && (await contentAnswer.locator(".maths-display.maths-pending").count()) === 1, "the inline part is shown and the display formula is a quiet box", 15000);
			const inline = await contentAnswer.locator(".maths:not(.maths-display) annotation").allTextContents();
			assert(JSON.stringify(inline) === JSON.stringify(["x^2 + y^2 = r^2", "x"]), `the inline formulas are typeset as they arrive, got ${JSON.stringify(inline)}`);
			const text = (await contentAnswer.textContent()) ?? "";
			assert(text.includes("it costs $5 and $10") && text.includes("echo $HOME") && !text.includes("\\frac"), `prices, code and the path show as written, the formula being written never as TeX, got ${text}`);
			say("b}");
			await waitUntil(async () => (await contentAnswer.locator(".maths-display annotation").textContent().catch(() => null)) === "\\frac{a}{b}", "the display formula is typeset once it parses", 15000);
			say(" + \\frac{c}{");
			say("d}\n$$\n\n");
			await waitUntil(async () => (await contentAnswer.locator(".maths-display annotation").textContent().catch(() => null)) === "\\frac{a}{b} + \\frac{c}{d}", "the finished formula is typeset", 15000);
			const looks = await page.evaluate(() => (window as unknown as { displayLooks: string[] }).displayLooks);
			const allowed = (look: string) => look === "shown::pending" || look === "\\frac{a}{b}" || look === "\\frac{a}{b} +" || look === "\\frac{a}{b} + \\frac{c}{d}";
			// The reveal holds a word still being written, so the formula may wait just after a space; KaTeX draws it the same.
			assert(looks[0] === "shown::pending" && looks.every((look) => allowed(look.trimEnd())),`the display formula is a quiet box, then only good pictures, never its TeX: ${JSON.stringify(looks)}`);
			assert(!(await contentAnswer.locator(".katex-error").count()), "no formula shows KaTeX's error");
			// The diagrams' maths before used only KaTeX's script: its stylesheet and fonts come with the answer's first formula.
			await waitUntil(() => page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/["']/g, "") === "KaTeX_Main" && face.status === "loaded")), "KaTeX's own font is loaded", 15000);
			const own = new URL(baseUrl).host;
			// One script, the chunk the diagrams' maths loaded too.
			const scripts = new Set(katexLoads.filter(({ url }) => /\/katex-[\w-]+\.js$/.test(url)).map(({ url }) => url));
			const styles = katexLoads.filter(({ url }) => /\/katex-[\w-]+\.css$/.test(url));
			const fonts = katexLoads.filter(({ url }) => /\/KaTeX_[\w-]+\.woff2$/.test(url));
			assert(scripts.size === 1 && styles.length === 1 && fonts.length > 0, `one KaTeX, its stylesheet and its fonts are loaded, got ${JSON.stringify(katexLoads)}`);
			assert(katexLoads.every(({ url, status }) => new URL(url).host === own && status === 200), `all from our own server, got ${JSON.stringify(katexLoads)}`);
		});

		await check("a chart is a quiet box while written, its language included, and drawn once its fence closes", async () => {
			say("A chart:\n\n```cha");
			const box = contentAnswer.locator('figure[aria-label="Drawing chart"]');
			await box.waitFor({ timeout: 15000 });
			assert(!(await contentAnswer.locator(".code-block").count()), "a fence whose language may become chart shows no code block");
			say("rt\n" + CHART.slice(0, -1).join("\n") + "\n");
			assert(await box.getByText("Drawing chart…").isVisible(), "the box says the chart is being drawn");
			say(CHART.at(-1) + "\n```\n\nBelow the chart, still");
			const chart = contentAnswer.locator("figure.answer-chart-card:not(.answer-chart-writing)");
			await chart.locator(".answer-chart-svg").waitFor({ timeout: 30000 });
			assert(await page.locator(".stop-btn").count(), "the answer is still being written when the chart is drawn");
			assert((await chart.locator(".answer-chart-bar").count()) === 4 && !(await box.count()), "the box gives way to one bar per row");
			assert(!(await page.evaluate(() => (window as unknown as { chartAsCode: boolean }).chartAsCode)), "the chart's numbers never showed as code while its block was written");
			await chart.locator('.answer-chart-hit[data-i="2"]').hover();
			const tip = chart.locator(".answer-chart-tip");
			await tip.waitFor({ timeout: 5000 });
			const value = (await tip.textContent()) ?? "";
			assert(value.includes("11:00") && value.includes("Refused") && value.includes("84"), `hover shows that bar's label and value, got ${value}`);
		});

		await check("Table shows the chart's numbers, and Copy image puts the chart on the clipboard as a PNG", async () => {
			const chart = contentAnswer.locator("figure.answer-chart-card:not(.answer-chart-writing)");
			await chart.getByRole("button", { name: "Table" }).click();
			const rows = await chart.locator(".answer-chart-table tr").evaluateAll((trs) => trs.map((tr) => [...tr.children].map((cell) => cell.textContent).join("|")));
			assert(rows.join("\n") === "Hour|Refused\n09:00|12\n10:00|30\n11:00|84\n12:00|41", `the table holds every row, got ${rows.join(" / ")}`);
			await chart.getByRole("button", { name: "Chart" }).click();
			await chart.locator(".answer-chart-svg").waitFor();
			await chart.getByRole("button", { name: "Copy image" }).click();
			await chart.getByRole("button", { name: "Copied image" }).waitFor({ timeout: 15000 });
			const png = await page.evaluate(async () => {
				const items = await navigator.clipboard.read();
				const item = items.find((entry) => entry.types.includes("image/png"));
				if (!item) return { types: items.flatMap((entry) => entry.types), width: 0, height: 0 };
				const bitmap = await createImageBitmap(await item.getType("image/png"));
				return { types: ["image/png"], width: bitmap.width, height: bitmap.height };
			});
			const svgWidth = await chart.locator(".answer-chart-svg").evaluate((svg) => svg.getBoundingClientRect().width);
			assert(png.types.includes("image/png") && Math.abs(png.width - Math.round(svgWidth * 2)) <= 2 && png.height > 0, `the clipboard holds the chart as a PNG twice its size on screen, got ${JSON.stringify(png)} for ${svgWidth}`);
		});

		await check("a block that is no chart stays its code, and the chart is not drawn again as the answer ends", async () => {
			const drawn = await contentAnswer.locator(".answer-chart-svg").elementHandle();
			say(" arriving.\n\n```chart\ntype: radar\nClient, Refused\nMobile app, forty-one\n```\n\nDone.");
			finish();
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the answer has ended", 30000);
			await contentAnswer.getByText("Done.").waitFor({ timeout: 15000 });
			const code = contentAnswer.locator(".code-block", { hasText: "forty-one" });
			assert((await code.count()) === 1 && (await contentAnswer.locator("figure.answer-chart-card").count()) === 1, "the wrong block is a code block, and the only chart is the right one");
			assert(await drawn!.evaluate((svg) => svg.isConnected), "the drawn chart keeps its element as the answer ends");
		});

		await check("formulas and charts take this theme's colours, dark and light", async () => {
			for (const theme of ["dark", "light"] as const) {
				await setTheme(page, theme);
				const want = await tokenColour(page, "--chart-1");
				await waitUntil(async () => (await contentAnswer.locator(".answer-chart-bar").first().evaluate((bar) => getComputedStyle(bar).fill)) === want, `${theme}: the bars are in --chart-1, ${want}`, 15000);
				const ink = await contentAnswer.evaluate((answer) => {
					const formula = answer.querySelector(".maths-display .katex-html")!;
					return { formula: getComputedStyle(formula).color, text: getComputedStyle(answer.querySelector("p")!).color, height: formula.getBoundingClientRect().height };
				});
				assert(ink.formula === ink.text && ink.height > 10, `${theme}: the formula is typeset in the answer's own text colour, got ${JSON.stringify(ink)}`);
			}
			await setTheme(page, "dark");
		});

		await check("every language the page's table names is coloured, under its readable name", async () => {
			const { CODE_LANGUAGES } = await import(new URL("../../web-ui/src/code-highlight.ts", import.meta.url).href) as { CODE_LANGUAGES: Record<string, readonly string[]> };
			const missing = Object.keys(CODE_LANGUAGES).filter((id) => !SAMPLES[id]);
			assert(missing.length === 0 && Object.keys(SAMPLES).length === Object.keys(CODE_LANGUAGES).length, `the smoke has a sample for each language in the table, missing ${missing}`);
			languageFences = Object.entries(CODE_LANGUAGES).map(([id, names]) => ({ id, fence: names.length > 1 ? names[names.length - 1] : id, label: names[0] }));
			await composer.fill(LANGUAGES_PROMPT);
			await page.locator("button.send-btn").click();
			const answer = page.locator(".assistant-markdown").filter({ hasText: "Every language:" });
			let blocks: Awaited<ReturnType<typeof codeBlocks>> = [];
			await waitUntil(async () => {
				blocks = await codeBlocks(answer);
				return blocks.length === languageFences.length && blocks.every((block) => block.colours.length >= 2);
			}, "every block is coloured", 30000).catch(() => undefined);
			const plain = languageFences.filter((_, i) => !blocks[i] || blocks[i].colours.length < 2).map(({ fence }) => fence);
			assert(blocks.length === languageFences.length && plain.length === 0, `each block shows two colours or more; plain: ${plain}`);
			const labels = blocks.map((block) => block.label);
			assert(JSON.stringify(labels) === JSON.stringify(languageFences.map(({ label }) => label)), `each block is labelled with its language's name, got ${labels}`);
		});

		assert(pageErrors.length === 0, `the page logged errors:\n  ${pageErrors.join("\n  ")}`);
		console.log("  ok  no error in the page");
		assert(elsewhere.length === 0, `the page asked other origins: ${elsewhere}`);
		console.log("  ok  the page asked no other origin");
		await ctx.close();

		await check("on a touch screen the tools stay in view, above the drawing and never over it, each a 44px tap", async () => {
			const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
			try {
				await phone.addInitScript(() => { try { localStorage.setItem("exxperts.appearance", "system"); } catch {} });
				const touch = await phone.newPage();
				await touch.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await touch.waitForLoadState("networkidle");
				const close = touch.locator(".whats-new-close");
				if (await close.count()) await close.click();
				await touch.locator(".persistent-agent-card").filter({ hasText: "Diagram Room" }).getByRole("button", { name: "Resume" }).click();
				const drawn = touch.locator("figure.mermaid-diagram:not(.mermaid-diagram-loading)").first();
				await drawn.locator(".mermaid-diagram-svg svg").waitFor({ timeout: 30000 });
				await waitUntil(() => drawn.locator(".figure-tools").evaluate((tools) => getComputedStyle(tools).opacity === "1"), "the tools show with no hover");
				// Where any drawing can start, however tall: a short one is centred lower down.
				const where = await drawn.evaluate((figure) => {
					const canvas = figure.querySelector(".mermaid-diagram-canvas")!;
					return { toolsBottom: figure.querySelector(".figure-tools")!.getBoundingClientRect().bottom, drawingTop: canvas.getBoundingClientRect().top + parseFloat(getComputedStyle(canvas).paddingTop) };
				});
				assert(where.drawingTop >= where.toolsBottom, `a drawing starts below the tools, got ${JSON.stringify(where)}`);
				// A finger needs 44px: a tap a little above or below a tool, or on its edge, still reaches it.
				await drawn.evaluate((figure) => figure.scrollIntoView({ block: "center" }));
				const taps = await drawn.evaluate((figure) => [...figure.querySelectorAll(".figure-tool")].map((tool) => {
					const box = tool.getBoundingClientRect();
					const x = box.left + box.width / 2;
					return { label: tool.getAttribute("aria-label") ?? tool.textContent, width: box.width, above: tool.contains(document.elementFromPoint(x, box.top - 8)), below: tool.contains(document.elementFromPoint(x, box.bottom + 8)) };
				}));
				assert(taps.length === 3 && taps.every((tap) => tap.width >= 44 && tap.above && tap.below), `each tool takes a 44px tap, got ${JSON.stringify(taps)}`);
			} finally {
				await phone.close();
			}
		});

		await check("at phone width the code is coloured too, dark and light", async () => {
			const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
			try {
				await phone.addInitScript(() => { try { localStorage.setItem("exxperts.appearance", "system"); } catch {} });
				const touch = await phone.newPage();
				await touch.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await touch.waitForLoadState("networkidle");
				const close = touch.locator(".whats-new-close");
				if (await close.count()) await close.click();
				await touch.locator(".persistent-agent-card").filter({ hasText: "Diagram Room" }).getByRole("button", { name: "Resume" }).click();
				const answer = touch.locator(".assistant-markdown").filter({ hasText: "Every language:" });
				for (const theme of ["dark", "light"] as const) {
					await setTheme(touch, theme);
					const want = await tokenColour(touch, "--code-token-string");
					await waitUntil(async () => {
						const blocks = await codeBlocks(answer);
						return blocks.length > 0 && blocks.every((block) => block.colours.length >= 2) && blocks.some((block) => block.colours.includes(want));
					}, `${theme}: the blocks are coloured in this theme's colours`, 30000);
				}
			} finally {
				await phone.close();
			}
		});
	} finally {
		await browser.close();
	}
	console.log("answer content smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	try { (provider as any).closeAllConnections?.(); } catch {}
	try { provider.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
