// Every diagram type the page draws, in the browser: one answer carries one
// mermaid fence per type mermaid knows, plus two with maths and one that is
// not mermaid at all. Each drawable fence must become a drawn diagram that
// shows its own words (maths as MathML), the broken one must fall back to its
// source as a code block, and the page must log no error on the way. An
// upgrade of mermaid that stops drawing a type fails here first.
//
// Offline: the room's model is a synthetic OpenAI-compatible server in this
// process that answers with the diagrams.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("mermaid diagrams ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

// `shows` is a word the drawn diagram must carry, so a diagram that draws
// but loses its labels still fails. `maths` diagrams must carry MathML.
type Diagram = { name: string; source: string; shows: string; maths?: boolean };

const DRAWN: Diagram[] = [
	{ name: "flowchart", shows: "Approve", source: "flowchart TD\n  start([Request]) --> check{Within budget?}\n  check -->|yes| approve[Approve]\n  check -->|no| review[Ask finance]\n  subgraph Finance\n    review --> decide[Decide]\n  end\n  decide --> approve" },
	{ name: "graph", shows: "Gamma", source: "graph LR\n  A[Alpha] --> B(Beta) --> C{{Gamma}}" },
	{ name: "flowchart with a label the page repairs", shows: "twice", source: "flowchart LR\n  A[Say \"hi\"<br>twice] --> B[Done]" },
	{ name: "flowchart-elk", shows: "Parse", source: "flowchart-elk TD\n  A[Read] --> B[Parse] --> C[Write]" },
	{ name: "sequenceDiagram", shows: "Ticket", source: "sequenceDiagram\n  participant U as User\n  participant S as Support\n  U->>S: Ticket\n  S-->>U: Answer\n  Note over U,S: Same day" },
	{ name: "classDiagram", shows: "Invoice", source: "classDiagram\n  class Invoice {\n    +String number\n    +total() Money\n  }\n  Invoice --> Customer" },
	{ name: "stateDiagram", shows: "Draft", source: "stateDiagram\n  [*] --> Draft\n  Draft --> Sent\n  Sent --> [*]" },
	{ name: "stateDiagram-v2", shows: "Review", source: "stateDiagram-v2\n  [*] --> Open\n  Open --> Review: submit\n  state Review {\n    [*] --> Reading\n  }\n  Review --> Closed\n  Closed --> [*]" },
	{ name: "erDiagram", shows: "ORDER", source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains\n  CUSTOMER {\n    string name\n  }" },
	{ name: "gantt", shows: "Design", source: "gantt\n  title Launch\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2026-01-05, 5d\n  Code :after a1, 10d" },
	{ name: "pie", shows: "Rent", source: "pie title Spending\n  \"Rent\" : 40\n  \"Food\" : 25\n  \"Travel\" : 15\n  \"Savings\" : 10\n  \"Fun\" : 6\n  \"Other\" : 4" },
	{ name: "journey", shows: "Checkout", source: "journey\n  title Shopping\n  section Store\n    Browse: 5: Me\n    Checkout: 3: Me, Cashier" },
	{ name: "gitGraph", shows: "feature", source: "gitGraph\n  commit\n  branch feature\n  commit\n  checkout main\n  merge feature\n  commit" },
	{ name: "mindmap", shows: "Planning", source: "mindmap\n  root((Planning))\n    Goals\n      Revenue\n    Risks" },
	{ name: "timeline", shows: "Prototype", source: "timeline\n  title Product\n  2024 : Idea\n  2025 : Prototype : Pilot\n  2026 : Launch" },
	{ name: "quadrantChart", shows: "Quick wins", source: "quadrantChart\n  title Priorities\n  x-axis Low effort --> High effort\n  y-axis Low value --> High value\n  quadrant-1 Big bets\n  quadrant-2 Quick wins\n  quadrant-3 Fill-ins\n  quadrant-4 Money pits\n  Search: [0.3, 0.8]" },
	{ name: "xychart-beta", shows: "Revenue", source: "xychart-beta\n  title \"Revenue\"\n  x-axis [jan, feb, mar]\n  y-axis \"Euro\" 0 --> 100\n  bar [30, 50, 70]\n  line [20, 60, 80]" },
	{ name: "requirementDiagram", shows: "uptime", source: "requirementDiagram\n  requirement uptime {\n    id: 1\n    text: The service stays up.\n    risk: high\n    verifymethod: test\n  }\n  element monitor {\n    type: service\n  }\n  monitor - satisfies -> uptime" },
	{ name: "C4Context", shows: "Shop", source: "C4Context\n  title Ordering\n  Person(customer, \"Customer\")\n  System(shop, \"Shop\", \"Takes orders\")\n  System_Ext(payments, \"Payments\", \"Charges cards\")\n  Rel(customer, shop, \"Orders from\")\n  Rel(shop, payments, \"Charges<br>through\", \"HTTPS\")" },
	{ name: "C4Container with crossing lines", shows: "Tax rules", source: "C4Container\n  title Inside the shop\n  Person_Ext(guest, \"Guest\", \"Browses\")\n  Container(web, \"Web app\", \"React\", \"Shows the shop\")\n  ContainerDb(db, \"Orders\", \"Postgres\", \"Keeps orders\")\n  Container_Ext(mail, \"Mail service\", \"SMTP\", \"Sends receipts\")\n  Component(cart, \"Cart\", \"TypeScript\", \"Holds items\")\n  Component_Ext(tax, \"Tax rules\", \"API\", \"Works out tax\")\n  System_Ext(bank, \"Bank\", \"Settles payments\")\n  Rel(guest, web, \"Visits\")\n  Rel(web, db, \"Reads and writes\", \"SQL\")\n  Rel(web, mail, \"Sends receipts through\")\n  Rel(web, cart, \"Uses\")\n  Rel(cart, tax, \"Asks\")\n  Rel(db, bank, \"Reconciles with\")" },
	{ name: "C4Context with a label wider than its gap", shows: "invoices", source: "C4Context\n  title Wide\n  System(shop, \"Shop\", \"Takes orders\")\n  System_Ext(mail, \"Mail\", \"Sends mail\")\n  Rel(shop, mail, \"Sends receipts and invoices through\")" },
	{ name: "sankey-beta", shows: "Homes", source: "sankey-beta\nSolar,Grid,40\nWind,Grid,30\nGrid,Homes,70" },
	{ name: "block-beta", shows: "Ingest", source: "block-beta\n  columns 3\n  a[\"Ingest\"] b[\"Store\"] c[\"Serve\"]\n  a --> b\n  b --> c" },
	{ name: "packet-beta", shows: "Source Port", source: "packet-beta\n  0-15: \"Source Port\"\n  16-31: \"Destination Port\"" },
	{ name: "architecture-beta", shows: "Database", source: "architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service server(server)[Server] in api\n  db:L -- R:server" },
	{ name: "kanban", shows: "Write the brief", source: "kanban\n  todo[To do]\n    t1[Write the brief]\n  done[Done]\n    t2[Ship it]" },
	{ name: "radar-beta", shows: "Speed", source: "radar-beta\n  title Skills\n  axis s[\"Speed\"], p[\"Power\"], r[\"Range\"]\n  curve c[\"Car\"]{4, 3, 5}\n  max 5" },
	{ name: "treemap-beta", shows: "Leaf one", source: "treemap-beta\n\"Section\"\n    \"Leaf one\": 12\n    \"Leaf two\": 8\n\"Other\"\n    \"Leaf three\": 20" },
	{ name: "info", shows: "v1", source: "info" },
	{ name: "swimlane-beta", shows: "Triage", source: "swimlane-beta LR\n  subgraph Customer\n    request[Request]\n  end\n  subgraph Support\n    triage[Triage]\n  end\n  request --> triage" },
	{ name: "treeView-beta", shows: "index.ts", source: "treeView-beta\n├── src/\n│   └── index.ts\n└── README.md" },
	{ name: "eventmodeling", shows: "ItemAdded", source: "eventmodeling\n\ntf 01 ui CartUI\ntf 02 cmd AddItem { description: string }\ntf 03 evt ItemAdded { description: string }" },
	{ name: "ishikawa-beta", shows: "Blurry Photo", source: "ishikawa-beta\n    Blurry Photo\n    Process\n        Out of focus\n    Equipment\n        Dirty lens" },
	{ name: "venn-beta", shows: "Frontend", source: "venn-beta\n  title \"Team overlap\"\n  set Frontend\n  set Backend\n  union Frontend,Backend[\"APIs\"]" },
	{ name: "wardley-beta", shows: "Kettle", source: "wardley-beta\ntitle Tea Shop\nanchor Business [0.95, 0.63]\ncomponent Tea [0.63, 0.81]\ncomponent Kettle [0.43, 0.35]\nBusiness -> Tea\nTea -> Kettle" },
	{ name: "cynefin-beta", shows: "Restart service", source: "cynefin-beta\n  title Incident Response\n  complex\n    \"Run an experiment\"\n  clear\n    \"Restart service\"" },
	{ name: "railroad-beta", shows: "term", source: "railroad-beta\ntitle Expression\nexpression = sequence(nonterminal(\"term\"), zeroOrMore(sequence(terminal(\"+\"), nonterminal(\"term\")))) ;" },
	{ name: "railroad-ebnf-beta", shows: "digit", source: "railroad-ebnf-beta\ntitle \"Digit\"\ndigit = \"0\" | \"1\" | \"2\" ;" },
	{ name: "railroad-abnf-beta", shows: "domain", source: "railroad-abnf-beta\ntitle \"Address\"\naddress = local \"@\" domain ;\nlocal = 1*ALPHA ;\ndomain = 1*ALPHA ;" },
	{ name: "railroad-peg-beta", shows: "Number", source: "railroad-peg-beta\ntitle \"Sum\"\nSum <- Number (\"+\" Number)* ;\nNumber <- \"0\" / \"1\" ;" },
	{ name: "flowchart with maths", shows: "Area", maths: true, source: String.raw`flowchart LR
  A["$$x^2+\sqrt{y}$$"] --> B["$$\frac{a}{b}$$"] --> C[Area]` },
	{ name: "sequenceDiagram with maths", shows: "Physicist", maths: true, source: String.raw`sequenceDiagram
  participant P as Physicist
  participant W as World
  P->>W: $$E=mc^2$$` },
];
const BROKEN: Diagram = { name: "not mermaid", shows: "zorpchart", source: "zorpchart\n  A --> B" };
const ALL = [...DRAWN, BROKEN];

const answer = ALL.map((diagram) => `#### ${diagram.name}\n\n\`\`\`mermaid\n${diagram.source}\n\`\`\``).join("\n\n");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-mermaid-ui-"));
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

const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_diagrams", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] });
		sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2000, total_tokens: 2100 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

/** Runs in the page: the theme is `scheme`, and the pie and the C4 drawings carry its colours. */
function drawnIn(figures: Element[], { scheme, pieIndex, c4Indexes }: { scheme: string; pieIndex: number; c4Indexes: number[] }): boolean {
	const resolved = (token: string) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${token})`;
		document.body.append(probe);
		const colour = getComputedStyle(probe).color;
		probe.remove();
		return colour;
	};
	const slice = figures[pieIndex]?.querySelector(".mermaid-diagram-svg svg path.pieCircle");
	const relations = c4Indexes.map((index) => figures[index]?.querySelector(".mermaid-diagram-svg svg [marker-end] + text"));
	return document.documentElement.dataset.theme === scheme
		&& !!slice && getComputedStyle(slice).fill === resolved("--chart-1")
		&& relations.every((relation) => !!relation && getComputedStyle(relation).fill === resolved("--muted"));
}

/**
 * Runs in the page over every drawn fence: each pie slice's label against its
 * slice, each C4 box's text against its box, and each C4 relation label
 * against the boxes, lines, arrowheads and labels it must leave clear.
 */
function readingProblems(figures: Element[], { pieIndex, c4Index, crossingIndex, wideIndex }: { pieIndex: number; c4Index: number; crossingIndex: number; wideIndex: number }): string[] {
	const problems: string[] = [];
	/**
	 * Each relation label in a C4 drawing against the boxes, every relation's
	 * line as drawn, the arrowheads and the other relations' labels. A line's
	 * texts follow it: its label a line each, then its technology; a part is a
	 * relation's label or its technology, and a part's own lines sit one font
	 * size apart, as C4 draws them.
	 */
	const relationProblems = (svg: Element | null | undefined, name: string) => {
		const found: string[] = [];
		const boxes = [...(svg?.querySelectorAll(".c4-shape .label-container, .c4-shape .label-container *") ?? [])].filter((part) => ["rect", "circle", "path"].includes(part.tagName)).map((part) => part.getBoundingClientRect()).filter((box) => box.width > 0);
		const lines = [...(svg?.querySelectorAll("[marker-end]") ?? [])] as SVGGeometryElement[];
		const onPage = (line: SVGGeometryElement, at: DOMPoint) => { const m = line.getScreenCTM()!; return { x: m.a * at.x + m.c * at.y + m.e, y: m.b * at.x + m.d * at.y + m.f }; };
		const points = lines.flatMap((line) => { const out = []; for (let at = 0; at <= line.getTotalLength(); at += 2) out.push(onPage(line, line.getPointAtLength(at))); return out; });
		// An arrowhead is about 10 units long and wide, its tip on the line's end.
		const heads = lines.map((line) => {
			const { x, y } = onPage(line, line.getPointAtLength(Math.max(0, line.getTotalLength() - 5)));
			const m = line.getScreenCTM()!;
			const reach = 6 * Math.hypot(m.a, m.b);
			return { left: x - reach, right: x + reach, top: y - reach, bottom: y + reach };
		});
		const texts = lines.flatMap((line, i) => { const out: { text: Element; part: string }[] = []; for (let next = line.nextElementSibling; next?.tagName === "text"; next = next.nextElementSibling) out.push({ text: next, part: `${i} ${next.getAttribute("font-style") === "italic"}` }); return out; });
		for (const { text, part } of texts) {
			const box = text.getBoundingClientRect();
			if (boxes.some((other) => overlaps(box, other))) found.push(`${name}: "${text.textContent}" runs over a box`);
			if (heads.some((head) => overlaps(box, head))) found.push(`${name}: "${text.textContent}" covers an arrowhead`);
			if (points.some((p) => p.x > box.left && p.x < box.right && p.y > box.top && p.y < box.bottom)) found.push(`${name}: "${text.textContent}" sits on a line`);
			for (const other of texts) if (other.part !== part && overlaps(box, other.text.getBoundingClientRect())) found.push(`${name}: "${text.textContent}" runs into "${other.text.textContent}"`);
		}
		return found;
	};
	const rgb = (colour: string) => (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
	const luminance = (colour: string) => {
		const [r, g, b] = rgb(colour).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
	};
	const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
	const overlaps = (a: DOMRect, b: { left: number; right: number; top: number; bottom: number }) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
	const pie = figures[pieIndex]?.querySelector(".mermaid-diagram-svg svg");
	const slices = [...(pie?.querySelectorAll("path.pieCircle") ?? [])];
	const labels = [...(pie?.querySelectorAll("text.slice") ?? [])];
	if (!slices.length || slices.length !== labels.length) problems.push(`pie: ${slices.length} slices, ${labels.length} labels`);
	labels.forEach((label, i) => {
		const r = ratio(getComputedStyle(label).fill, getComputedStyle(slices[i]!).fill);
		if (r < 4.5) problems.push(`pie: "${label.textContent}" at ${r.toFixed(2)}:1 on its slice`);
	});
	const c4 = figures[c4Index]?.querySelector(".mermaid-diagram-svg svg");
	const crossing = figures[crossingIndex]?.querySelector(".mermaid-diagram-svg svg");
	const shapes = [...(c4?.querySelectorAll(".c4-shape") ?? [])];
	if (shapes.length !== 3) problems.push(`C4: ${shapes.length} boxes drawn, 3 expected`);
	for (const shape of [...shapes, ...(crossing?.querySelectorAll(".c4-shape") ?? [])]) {
		const body = shape.querySelector(".label-container rect, rect.label-container, path.label-container, .label-container path");
		if (!body) { problems.push(`C4: a box with no body: "${shape.textContent}"`); continue; }
		const fill = getComputedStyle(body).fill;
		for (const text of shape.querySelectorAll("text")) {
			const r = ratio(getComputedStyle(text).fill, fill);
			if (r < 4.5) problems.push(`C4: "${text.textContent}" at ${r.toFixed(2)}:1 on its box`);
		}
	}
	const relationTexts = (svg: Element | null | undefined) => [...(svg?.querySelectorAll("[marker-end]") ?? [])].flatMap((line) => { const texts: Element[] = []; for (let next = line.nextElementSibling; next?.tagName === "text"; next = next.nextElementSibling) texts.push(next); return texts; });
	const c4Texts = relationTexts(c4);
	if (c4Texts.length !== 4) problems.push(`C4: ${c4Texts.length} relation texts, 4 expected ("Orders from", "Charges", "through", "[HTTPS]")`);
	problems.push(...relationProblems(c4, "C4"));
	if (relationTexts(crossing).length !== 7) problems.push(`C4 crossing: ${relationTexts(crossing).length} relation texts, 7 expected`);
	problems.push(...relationProblems(crossing, "C4 crossing"));
	// A label too wide for its gap has no clear place; it stays where C4
	// puts it, starting at its line's midpoint, never spread over both boxes.
	const wide = figures[wideIndex]?.querySelector(".mermaid-diagram-svg svg");
	const wideLine = wide?.querySelector("[marker-end]") as SVGGeometryElement | null | undefined;
	const wideLabel = wideLine?.nextElementSibling;
	if (!wideLine || wideLabel?.tagName !== "text") problems.push("C4 wide: no relation label");
	else {
		const length = wideLine.getTotalLength();
		const [start, end] = [wideLine.getPointAtLength(0), wideLine.getPointAtLength(length)];
		const matrix = wideLine.getScreenCTM()!;
		const midX = matrix.a * ((start.x + end.x) / 2) + matrix.c * ((start.y + end.y) / 2) + matrix.e;
		const left = wideLabel.getBoundingClientRect().left;
		if (Math.abs(left - midX) > 3 * Math.hypot(matrix.a, matrix.b)) problems.push(`C4 wide: the label starts ${Math.round(left - midX)}px from its line's midpoint; it should stay where C4 puts it`);
	}
	return problems;
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
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		// readingProblems is sent as source; the loader names its inner functions with __name.
		await page.addInitScript("window.__name = (fn) => fn;");
		// A blocked script or style (the server's CSP) and a throw inside
		// mermaid both reach the console as errors.
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		await page.locator(".persistent-agent-card").filter({ hasText: "Diagram Room" }).getByRole("button", { name: "Enter" }).click();
		const composer = page.locator("textarea").first();
		await composer.waitFor({ timeout: 15000 });
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await composer.fill("Draw every kind of diagram.");
		await page.locator("button.send-btn").click();

		// Done when every fence is either a drawn figure or the fallback code
		// block, and none is still rendering.
		const outcomes = page.locator("figure.mermaid-diagram:not(.mermaid-diagram-loading), pre.mermaid-fallback");
		await waitUntil(async () => (await outcomes.count()) === ALL.length && (await page.locator(".mermaid-diagram-loading").count()) === 0, `all ${ALL.length} fences have drawn or fallen back`, 60_000);

		const seen = await outcomes.evaluateAll((elements) => elements.map((element) => {
			if (element.tagName === "PRE") return { drawn: false, text: element.textContent ?? "", role: "", maths: false, width: 0, height: 0 };
			const svg = element.querySelector(".mermaid-diagram-svg svg");
			const box = svg?.getBoundingClientRect();
			// The words a person reads, without the drawing's own stylesheet.
			const words = svg?.cloneNode(true) as SVGSVGElement | undefined;
			words?.querySelectorAll("style").forEach((style) => style.remove());
			return {
				drawn: Boolean(svg),
				text: words?.textContent ?? "",
				role: svg?.getAttribute("aria-roledescription") ?? "",
				maths: Boolean(svg?.querySelector("math")),
				width: box?.width ?? 0,
				height: box?.height ?? 0,
			};
		}));
		const failures: string[] = [];
		ALL.forEach((diagram, index) => {
			const got = seen[index]!;
			if (diagram === BROKEN) {
				if (got.drawn || !got.text.includes(diagram.shows)) failures.push(`${diagram.name}: should fall back to its source, got ${JSON.stringify(got)}`);
				return;
			}
			if (!got.drawn) failures.push(`${diagram.name}: not drawn, fell back to its source`);
			else if (got.role === "error") failures.push(`${diagram.name}: mermaid drew its error picture`);
			// A wrapped label puts each line in its own span, so the spaces
			// between its words are not in the text.
			else if (!got.text.replace(/\s+/g, "").includes(diagram.shows.replace(/\s+/g, ""))) failures.push(`${diagram.name}: the drawing lacks "${diagram.shows}", its text is ${JSON.stringify(got.text.slice(0, 200))}`);
			else if (got.width < 20 || got.height < 20) failures.push(`${diagram.name}: the drawing is ${got.width}x${got.height}`);
			else if (diagram.maths && !got.maths) failures.push(`${diagram.name}: the maths is not drawn as MathML`);
		});
		assert(failures.length === 0, `diagrams that did not draw as they should:\n  ${failures.join("\n  ")}`);
		console.log(`  ok  ${DRAWN.length} diagrams drawn, ${DRAWN.filter((d) => d.maths).length} of them with maths`);
		console.log("  ok  a fence that is not mermaid shows as its source");
		// What a person reads in the pie and the C4 drawing, in light and in
		// dark (the page follows the browser's scheme and draws again).
		const pieIndex = ALL.findIndex((diagram) => diagram.name === "pie");
		const c4Index = ALL.findIndex((diagram) => diagram.name === "C4Context");
		const crossingIndex = ALL.findIndex((diagram) => diagram.name === "C4Container with crossing lines");
		const wideIndex = ALL.findIndex((diagram) => diagram.name === "C4Context with a label wider than its gap");
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			// A figure keeps its old picture while the new theme's is drawn, so
			// the wait is for the drawn colours, not for the theme switch.
			await waitUntil(() => outcomes.evaluateAll(drawnIn, { scheme, pieIndex, c4Indexes: [c4Index, crossingIndex] }), `the pie and C4 drawn in ${scheme}'s colours`, 15_000);
			const problems = await outcomes.evaluateAll(readingProblems, { pieIndex, c4Index, crossingIndex, wideIndex });
			assert(problems.length === 0, `${scheme}: diagram text a person cannot read:\n  ${problems.join("\n  ")}`);
			console.log(`  ok  ${scheme}: pie labels and C4 box text at 4.5:1 or more; C4 relation labels clear of the boxes, lines, arrowheads and each other`);
		}
		assert(pageErrors.length === 0, `the page logged errors:\n  ${pageErrors.join("\n  ")}`);
		console.log("  ok  no error in the page");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("mermaid-diagrams-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	try { (provider as any).closeAllConnections?.(); } catch {}
	try { provider.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
