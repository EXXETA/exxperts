// What a running command's row says and opens to, in the room's work card
// (apps/web-ui/src/work-look.ts, apps/web-ui/src/components/work-card.tsx).
// Proves:
//   1. its line leaves out the settings it begins with, so it begins with what
//      runs, and a line of nothing but settings, or a value that runs
//      something itself, reads whole;
//   2. it opens while it runs, by click, by keyboard and at phone width, to
//      the whole command and nothing else; the timer's tick closes nothing,
//      moves no focus and drops no selected text; it stays open when the
//      command ends, in the same box, with the result under it; a running row
//      of another kind doesn't open;
//   3. while "Run outside this room?" waits, its step is the question's quiet
//      row; after Run once it runs, the choice beside it; after Not now it
//      reads as a declined step, and a folded card's words stay as they were.
// The steps and questions are handed to the page as the server sends them, on
// an answer a synthetic model holds open.
//
// Run: npm run smokes -- running-step-row   (or tsx this file)

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";

import { authedFetch, freePort, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";
import { COMMAND_DECLINED } from "../src/persistent-room-bash-approval.js";
import { NOT_NOW, OUTSIDE_RUN_ONCE, RUN_OUTSIDE_BOX_TOOL_NAME } from "../src/room-box/card-text.js";

const failures: string[] = [];
const expect = (condition: unknown, message: string) => {
	if (!condition) failures.push(message);
	console.log(`${condition ? "  ok  " : "FAIL  "}${message}`);
};
const finish = () => {
	if (failures.length > 0) {
		console.error(`running step row smoke FAILED (${failures.length})`);
		process.exit(1);
	}
	console.log("running step row smoke passed");
	process.exit(0);
};

const pageRequire = createRequire(new URL("../../web-ui/package.json", import.meta.url));
(globalThis as any).React = pageRequire("react");
// Page modules: loaded at run time, as the server build compiles scripts without JSX.
const look: any = await import(new URL("../../web-ui/src/work-look.ts", import.meta.url).href);
const workCard: any = await import(new URL("../../web-ui/src/components/work-card.tsx", import.meta.url).href);
const { createElement } = pageRequire("react");
const { renderToStaticMarkup } = pageRequire("react-dom/server");

const OUTSIDE_TITLE = "Run outside this room?";
const DECLINED_RESULT = `${COMMAND_DECLINED} Do not run it or retry variants of it unless the user asks.`;

// --- The line leaves out the settings it begins with.
{
	const line = (command: string) => {
		const action = look.commandAction(command);
		return action.kind === "line" ? action.line : `(${action.kind}) ${action.program ?? action.folder ?? ""}`.trim();
	};
	const lines: Array<[string, string]> = [
		["S=/a/b; cd $S; find / -name X", "cd $S; find / -name X"],
		["A=1 && ls", "ls"],
		["A='x y' && cd \"$A\" && ls", "cd \"$A\" && ls"],
		["A=\"x y\"; B=$A/c ls | head", "ls | head"],
		["A=a\\ b; ls", "ls"],
		["A=\"$HOME/x\"; B=${A:-y}; ls", "ls"],
		["A=1;B=2;ls|wc -l", "ls|wc -l"],
		["A=1 npm test | tee log", "npm test | tee log"],
		// A script of several lines: its settings' own lines go too, and "…" only where lines follow.
		["S=/a/b; cd $S\nfind / -name X", "cd $S …"],
		["S=/a/b\nT=/c\ncd $S\nfind / -name X", "cd $S …"],
		["S=/a/b\r\nfind / -name X", "find / -name X"],
		["A=1 \\\n  npm test | tee log", "npm test | tee log"],
		["A=\"x\ny\" && ls", "ls"],
		// As before: one program, nothing but settings, a setting another program makes, PowerShell's own.
		["A=1 B=2 npm test", "(run) npm test"],
		["A=1; B=2", "A=1; B=2"],
		["A=1;", "A=1;"],
		["A=1\nB=2", "A=1 …"],
		["export A=1; ls", "export A=1; ls"],
		["$s = \"C:\\x\"; ls", "$s = \"C:\\x\"; ls"],
		// A value that runs something is what runs; one an operator or a comment follows isn't a setting before a program.
		["A=$(find / -name X); ls", "A=$(find / -name X); ls"],
		["A=1; B=`date`; ls", "B=`date`; ls"],
		["A=\"$(date)\"; ls", "A=\"$(date)\"; ls"],
		["A='$(date)'; ls", "ls"],
		// A value that can't be read whole as one setting is left as it is, never cut inside.
		["A=${B:-one two}; ls", "ls"],
		["A=${B%;*}; ls", "ls"],
		["A=${B:-$(date)}; ls", "A=${B:-$(date)}; ls"],
		["A=\"${B:-\"x y\"}\"; ls", "A=\"${B:-\"x y\"}\"; ls"],
		["A=$'a b'; ls", "A=$'a b'; ls"],
		["A=$[1 + 2]; ls", "A=$[1 + 2]; ls"],
		["A=1 || ls", "A=1 || ls"],
		["A=1 | ls", "A=1 | ls"],
		["A=1 & ls", "A=1 & ls"],
		["A=1 > f; ls", "A=1 > f; ls"],
		["A=1 # why\nls", "A=1 # why …"],
		["cd src && A=1 npm test", "cd src && A=1 npm test"],
	];
	for (const [command, expected] of lines) expect(line(command) === expected, `line: ${JSON.stringify(command)} reads ${JSON.stringify(expected)} (${JSON.stringify(line(command))})`);
	const long = `S=${"x".repeat(400)}; ${"npm run build && ".repeat(25)}npm test`;
	expect(line(long) === long.slice(404, 704), `line: a setting longer than the line is left out before the cut (${line(long).slice(0, 40)})`);
	const kinds = ["S=/a\nls src", "A=1 && ls src"].map((command) => look.itemKind({ kind: "tool", id: "c", name: "bash", args: { command }, status: "done" }));
	expect(kinds.every((kind) => kind === "command"), `line: with a setting left out, a script and a chain still count as a command on the folded line (${kinds})`);
}

// --- The run-outside question and its step.
{
	const step = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "tool", id, name: RUN_OUTSIDE_BOX_TOOL_NAME, args: { command: "git push" }, status: "running", ...extra });
	const ask = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "approval", id: `q-${id}`, requestId: `r-${id}`, uiKind: "outside", title: OUTSIDE_TITLE, command: "git push", reason: "It needs your key.", ...extra });
	const pieces = (items: unknown[]) => look.workPieces(items).map((piece: any) => (piece.kind === "step" ? `${piece.item.id}:${piece.ask?.requestId ?? "-"}:${look.stepState(piece.item, piece.ask)}` : `ask:${piece.item.requestId}`)).join(" ");
	const nobody = { status: "error", result: "The user left the room while this response was being written" };
	const rows: Array<[string, unknown[], string]> = [
		["waiting, it is its step's", [step("a"), ask("a")], "a:r-a:asking"],
		["after Run once the step runs, the choice in a row of its own", [step("a"), ask("a", { done: OUTSIDE_RUN_ONCE })], "a:-:running ask:r-a"],
		["after Run once, done, the same", [step("a", { status: "done", result: "pushed" }), ask("a", { done: OUTSIDE_RUN_ONCE })], "a:-:done ask:r-a"],
		["after Not now, before its step's end, the step is declined", [step("a"), ask("a", { done: "Decline" })], "a:r-a:denied"],
		["after Not now, its step ended, the same", [step("a", { status: "error", result: DECLINED_RESULT }), ask("a", { done: "Decline" })], "a:r-a:denied"],
		["after Stop, as before", [step("a", { status: "stopped" }), ask("a", { stopped: true })], "a:-:stopped ask:r-a"],
		["answered by nobody, as before", [step("a", nobody), ask("a", { unanswered: true })], "a:-:denied ask:r-a"],
		["a hidden character is written out on the question's side only", [step("a", { args: { command: "git push\u202E" } }), ask("a", { command: "git push⟦U+202E⟧" })], "a:r-a:asking"],
		["two calls with one command: the first asks first", [step("a"), step("b"), ask("a")], "a:r-a:asking b:-:running"],
		["the second asks once the first has run", [step("a", { status: "done", result: "pushed" }), ask("a", { done: OUTSIDE_RUN_ONCE }), step("b"), ask("b")], "a:-:done ask:r-a b:r-b:asking"],
		["a call refused before it asked takes no question", [step("a", nobody), step("b"), ask("b")], "a:-:denied b:r-b:asking"],
		["a call refused before it asked takes no answered one", [step("a", nobody), step("b", { status: "error", result: DECLINED_RESULT }), ask("b", { done: "Decline" })], "a:-:denied b:r-b:denied"],
		["another command's question keeps a row of its own", [step("a"), ask("x", { command: "rm -r build" })], "a:-:running ask:r-x"],
		["a room command with the same words never takes it", [step("a", { name: "bash" }), ask("a")], "a:-:running ask:r-a"],
	];
	for (const [name, items, expected] of rows) expect(pieces(items) === expected, `outside: ${name} (${pieces(items)})`);

	const drawn = (items: unknown[], live: boolean) => {
		const error = console.error;
		// Drawn once, as a string: React's note that a layout effect does not run there is not the card's.
		console.error = (...args: unknown[]) => { if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) error(...args); };
		try {
			return renderToStaticMarkup(createElement(workCard.WorkStretch, { items, live, ...(live ? {} : { endTs: 12_100 }), elsewhere: false, keyboardApprovalId: null, onResolve: () => undefined })) as string;
		} finally {
			console.error = error;
		}
	};
	const head = (html: string) => (/class="wk-head"[\s\S]*?<\/(button|div)>/.exec(html)?.[0] ?? "").replace(/^[^>]*>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	const ran = head(drawn([step("a", { status: "done", result: "pushed" }), ask("a", { done: OUTSIDE_RUN_ONCE })], false));
	const declined = head(drawn([step("a", { status: "error", result: DECLINED_RESULT }), ask("a", { done: "Decline" })], false));
	expect(ran.startsWith("Ran a command") && declined.startsWith("1 step not run"), `outside: folded, the card's words are as before (${ran} / ${declined})`);

	// A running row of another kind, or a command still being written, doesn't open.
	for (const [name, args, status] of [["read", { path: "notes.md" }, "running"], ["mcp", { tool: "list_tasks", args: "{}" }, "running"], ["web_search", { query: "node" }, "running"], ["grep", { pattern: "limit" }, "running"], ["bash", { command: "npm test" }, "writing"]] as const) {
		const html = drawn([{ kind: "tool", id: `k-${name}`, name, args, status, startedAt: Date.now() }], true);
		expect(html.includes(`data-s="${status}"`) && !html.includes("wk-open"), `a ${status} ${name} row doesn't open`);
	}
}

{
	const browserPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!browserPath || !fs.existsSync(browserPath)) {
		console.log("running step row ui smoke: the browser part skipped (Chromium not installed)");
		finish();
	}
}

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-running-row-")));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-sonnet-5-5" };
const waitUntil = waitEvery(50, 20_000);

// Every answer writes a word and then holds, as a turn does while a step runs.
let answersHeld = 0;
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const sse = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse("message_start", { type: "message_start", message: { id: `msg_row_${Date.now()}`, type: "message", role: "assistant", model: JSON.parse(raw || "{}").model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
		sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } });
		answersHeld += 1;
		res.on("close", () => { answersHeld -= 1; });
	});
});

let server: ChildProcessWithoutNullStreams | undefined;
const putJson = (url: string, body: unknown) => authedFetch(`${baseUrl}${url}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A room with an answer held open, and its page handed the steps and questions as the server sends them. */
async function openRoom(browser: Browser, options: BrowserContextOptions, roomName: string) {
	const context = await browser.newContext(options);
	const page: Page = await context.newPage();
	let pageSocket: { send(message: string): void } | undefined;
	let readies = 0;
	const responses: Array<{ id: string; value: unknown }> = [];
	await page.routeWebSocket(/\/ws\?/, (ws) => {
		pageSocket = ws;
		const upstream = ws.connectToServer();
		ws.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.type === "ui_response") responses.push(frame);
			upstream.send(message);
		});
		upstream.onMessage((message) => {
			if (String(message).includes('"type":"ready"')) readies += 1;
			ws.send(message);
		});
		upstream.onClose((code, reason) => ws.close({ code, reason }));
		ws.onClose(() => upstream.close());
	});
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").filter({ hasText: roomName }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await page.locator(".composer-box textarea").waitFor({ timeout: 15000 });
	await waitUntil(() => readies > 0, "the room's connection is ready");
	await page.locator(".composer-box textarea").fill("Look for the master file, please.");
	await sendFromBox(page);
	await page.locator(".composer-box .stop-btn").waitFor({ timeout: 15000 });
	await waitUntil(() => answersHeld > 0, "the answer is held open");
	await page.getByText("Looking.").first().waitFor();
	const send = (frame: object) => pageSocket?.send(JSON.stringify(frame));
	const event = (payload: object) => send({ type: "event", event: payload });
	return {
		context, page, responses,
		ask: (id: string, command: string) => send({ type: "ui_request", kind: "outside", id, title: OUTSIDE_TITLE, command, reason: "It needs your SSH key." }),
		written: (id: string, name: string, args: Record<string, unknown>) => event({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", id, name, preview: args } }),
		begun: (id: string, name: string) => event({ type: "tool_execution_start", toolCallId: id, toolName: name, startedAt: Date.now() }),
		reply: (text: string) => {
			event({ type: "message_start", message: { role: "assistant" } });
			event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
		},
		progress: (id: string, name: string, text: string) => event({ type: "tool_execution_update", toolCallId: id, toolName: name, partialResult: { content: [{ type: "text", text }] } }),
		ended: (id: string, name: string, text: string, isError = false) => {
			event({ type: "tool_execution_end", toolCallId: id, toolName: name, endedAt: Date.now(), isError });
			event({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError } });
		},
	};
}

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}` } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	const roomFolder = path.join(tempHome, "room-folder");
	fs.mkdirSync(roomFolder, { recursive: true, mode: 0o700 });
	const agents = await import("../src/persistent-agents.js");
	const rooms = ["Desktop Room", "Phone Room", "Outside Room"].map((displayName) => ({ displayName, id: agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId }));
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.resume();
	server.stderr.resume();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
	if (!(await putJson("/api/persistent-agent-ai-profiles/custom", { providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model })).ok) throw new Error("the key's model is not approved");
	for (const { id } of rooms) {
		if (!(await putJson(`/api/persistent-agents/${id}/models`, { conversation: ON_KEY })).ok) throw new Error("the room has no model");
		if (!(await putJson(`/api/persistent-agents/${id}/workspace-default`, { root: roomFolder, displayLabel: "Room Folder", workspaceAccessMode: "localFiles", bashEnabled: true })).ok) throw new Error("the room has no folder");
	}

	const COMMAND = "S=/Users/anna/.exxperts/agent/skills/some-skill; cd $S; ls -la scripts; find / -name 'Master*' -not -path '*/node_modules/*' 2>/dev/null | head -50";
	const SHOWN = COMMAND.slice(COMMAND.indexOf("cd $S"));
	const RESULT = Array.from({ length: 60 }, (_, index) => `/Volumes/data/Master-${index + 1}.xlsx`).join("\n");
	const browser = await chromium.launch();
	try {
		for (const [at, roomName, options] of [
			["desktop", "Desktop Room", { viewport: { width: 1280, height: 900 } }],
			["phone", "Phone Room", { viewport: { width: 390, height: 844 }, hasTouch: true }],
		] as const) {
			const room = await openRoom(browser, options, roomName);
			const { page } = room;
			try {
				const press = (row: ReturnType<Page["locator"]>) => (at === "phone" ? row.tap() : row.click());
				room.written("toolu_read", "read", { path: "notes.md" });
				room.begun("toolu_read", "read");
				const reading = page.locator('.wk-row[data-s="running"]').filter({ hasText: "notes.md" });
				await reading.waitFor();
				expect(await reading.locator("button").count() === 0, `${at}: a running file read doesn't open`);
				room.ended("toolu_read", "read", "The plan.");

				room.written("toolu_find", "bash", { command: COMMAND });
				room.begun("toolu_find", "bash");
				const row = page.locator(".wk-row").filter({ hasText: "find / -name" });
				await row.waitFor();
				expect((await row.locator(".wk-tx").innerText()).replace(/\s+/g, " ") === `Running ${SHOWN}`, `${at}: the running row begins with what runs (${await row.locator(".wk-tx").innerText()})`);
				const opener = row.getByRole("button");
				const box = page.locator(".wk-out");
				expect(await opener.count() === 1 && await opener.getAttribute("aria-expanded") === "false" && await box.count() === 0, `${at}: the running command's row is a closed button`);
				await press(opener);
				await box.waitFor();
				expect(await opener.getAttribute("aria-expanded") === "true" && await box.locator(".wk-command").textContent() === COMMAND && await box.locator(":scope > *").count() === 1, `${at}: opened, it shows the whole command, settings included, and nothing else (${await box.innerText()})`);
				const painted = await row.evaluate((element) => {
					const words = element.querySelector(".wk-sweep");
					return words ? getComputedStyle(words).backgroundImage : "no sweep";
				});
				expect(painted.includes("gradient"), `${at}: the running row's words are still swept, so they are drawn (${painted})`);
				const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
				expect(sideways <= 0, `${at}: the opened row doesn't scroll the page sideways (${sideways})`);

				// By keyboard, from the row itself.
				await opener.focus();
				await page.keyboard.press("Enter");
				await box.waitFor({ state: "detached" });
				await page.keyboard.press("Space");
				await box.waitFor();
				expect(await opener.getAttribute("aria-expanded") === "true", `${at}: Enter closes it and Space opens it`);

				// The timer ticks every second, and the command's progress arrives: neither shows in the box, closes it, moves the focus or drops selected text.
				const kept = () => page.evaluate(() => ({
					focus: document.activeElement?.classList.contains("wk-open") === true,
					selected: getSelection()?.toString() ?? "",
					sameBox: (document.querySelector(".wk-out .wk-command") as any)?.smokeMark === true,
				}));
				await page.evaluate(() => {
					const command = document.querySelector(".wk-out .wk-command")!;
					(command as any).smokeMark = true;
					getSelection()!.selectAllChildren(command);
				});
				const meta = row.locator(".wk-meta");
				const ticked = await meta.count() ? await meta.innerText() : "";
				room.progress("toolu_find", "bash", "/Volumes/data/Master-1.xlsx");
				await waitUntil(async () => await meta.count() === 1 && await meta.innerText() !== ticked, "the row's own timer ticks");
				const afterTick = await kept();
				expect(afterTick.focus && afterTick.sameBox && afterTick.selected === COMMAND && await box.locator(":scope > *").count() === 1, `${at}: a tick keeps it open, the focus, the box and the selected text, and adds nothing (${JSON.stringify(afterTick)})`);

				// It ends: the same box, the result under the command, nothing jumps.
				const before = await row.boundingBox();
				const scrolled = () => page.evaluate(() => [...document.querySelectorAll("*")].filter((element) => element.scrollTop > 0).map((element) => [element.className, element.scrollTop]));
				const scrolledBefore = await scrolled();
				room.ended("toolu_find", "bash", RESULT);
				await page.locator('.wk-row[data-s="done"]').filter({ hasText: "find / -name" }).waitFor();
				await box.getByText("Master-60.xlsx").waitFor({ state: "attached" });
				const afterEnd = await kept();
				const after = await row.boundingBox();
				expect(await opener.getAttribute("aria-expanded") === "true" && afterEnd.focus && afterEnd.sameBox && afterEnd.selected === COMMAND, `${at}: it stays open when the command ends, with the focus and the selected text (${JSON.stringify(afterEnd)})`);
				expect(await box.locator(".wk-command").textContent() === COMMAND && await box.locator(":scope > *").count() === 2 && (await box.innerText()).includes("Master-1.xlsx"), `${at}: ended, the result is under the whole command`);
				const order = await box.evaluate((element) => element.children[0].classList.contains("wk-command"));
				expect(order && before && after && Math.abs(before.y - after.y) <= 1 && JSON.stringify(scrolledBefore) === JSON.stringify(await scrolled()), `${at}: nothing moves as the result arrives (${before?.y} to ${after?.y})`);
				expect((await row.locator(".wk-tx").innerText()).replace(/\s+/g, " ") === `Ran ${SHOWN}`, `${at}: ended, the line leaves out the same settings (${await row.locator(".wk-tx").innerText()})`);
				// The reply starts: the card folds, as it does over any opened step; the row is still open in it.
				const card = page.locator(".wk-card").last();
				room.reply("Found it.");
				await page.locator('.wk-card[data-open="0"]').last().waitFor();
				await press(card.locator(".wk-head"));
				await page.locator('.wk-card[data-open="1"]').last().waitFor();
				expect(await opener.getAttribute("aria-expanded") === "true" && await box.locator(".wk-command").textContent() === COMMAND && (await box.innerText()).includes("Master-1.xlsx"), `${at}: folded with its card as the reply starts, one press on the card shows it open again, the result under the command`);
				await press(opener);
				await box.waitFor({ state: "detached" });
			} finally {
				await room.context.close();
			}
		}

		// The outside question: its step is the question's quiet row while it waits, and reads by its answer after.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 } }, "Outside Room");
			const { page } = room;
			try {
				const panel = page.locator(".ask-panel").filter({ hasText: OUTSIDE_TITLE });
				const running = page.locator('.wk-row[data-s="running"]');
				const rows = () => page.locator(".wk-row").allInnerTexts();
				room.written("toolu_push", RUN_OUTSIDE_BOX_TOOL_NAME, { command: "git push origin main", reason: "It needs your SSH key." });
				room.begun("toolu_push", RUN_OUTSIDE_BOX_TOOL_NAME);
				await running.waitFor();
				room.ask("o-yes", "git push origin main");
				await panel.waitFor();
				const quiet = page.locator('.wk-row[data-s="waiting"]');
				expect(await running.count() === 0 && await quiet.count() === 1 && (await quiet.innerText()).trim() === OUTSIDE_TITLE && await quiet.locator("button").count() === 0, `outside: while it waits no row says Running, and one quiet row asks (${JSON.stringify(await rows())})`);
				await waitUntil(() => panel.getByRole("button", { name: OUTSIDE_RUN_ONCE }).isEnabled(), "Run once wakes");
				await panel.getByRole("button", { name: OUTSIDE_RUN_ONCE }).click();
				await waitUntil(() => room.responses.some((frame) => frame.id === "o-yes" && frame.value === true), "Run once answers");
				await running.waitFor();
				expect((await running.locator(".wk-tx").innerText()).replace(/\s+/g, " ") === "Running git push" && (await rows()).some((words) => words.includes(`You chose ${OUTSIDE_RUN_ONCE} · ${OUTSIDE_TITLE}`)), `outside: after Run once the step runs, and the choice stays beside it (${JSON.stringify(await rows())})`);
				await running.getByRole("button").click();
				expect(await page.locator(".wk-out .wk-command").textContent() === "git push origin main", "outside: once it runs, its row opens to the whole command");
				room.ended("toolu_push", RUN_OUTSIDE_BOX_TOOL_NAME, "pushed");
				await page.locator('.wk-row[data-s="done"]').filter({ hasText: "git push" }).first().waitFor();

				room.written("toolu_again", RUN_OUTSIDE_BOX_TOOL_NAME, { command: "git push --tags", reason: "It needs your SSH key." });
				room.begun("toolu_again", RUN_OUTSIDE_BOX_TOOL_NAME);
				room.ask("o-no", "git push --tags");
				await panel.waitFor();
				const notNow = panel.getByRole("button", { name: NOT_NOW });
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await notNow.click();
				await waitUntil(() => room.responses.some((frame) => frame.id === "o-no" && frame.value === false), "Not now answers");
				const denied = page.locator('.wk-row[data-s="denied"]');
				await denied.waitFor();
				const words = (await denied.locator(".wk-tx").innerText()).replace(/\s+/g, " ");
				expect(words === "Not run · you said no · git push" && await running.count() === 0 && await denied.count() === 1, `outside: after Not now its step reads as a declined step, at once and once (${JSON.stringify(await rows())})`);
				room.ended("toolu_again", RUN_OUTSIDE_BOX_TOOL_NAME, DECLINED_RESULT, true);
				await denied.getByRole("button").waitFor();
				expect((await denied.locator(".wk-tx").innerText()).replace(/\s+/g, " ") === words && await denied.count() === 1, `outside: its step's end changes nothing in its words (${JSON.stringify(await rows())})`);
			} finally {
				await room.context.close();
			}
		}
	} finally {
		await browser.close();
	}
} finally {
	if (server) await stopSmokeServer(server);
	endpoint.closeAllConnections();
	endpoint.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
finish();
