// How the model's thinking reads in a room, rendered as the page renders it
// (components/ThinkingRow.tsx), on its own line and as a work card's row:
// live, "Thinking" and its timer and none of its words, closed, with
// something to open; done, one line "Thought for N s" that opens to the
// notes, or "Thought briefly"; a block with no words or a redacted one is the
// label alone, with nothing to open. Thoughts with nothing between are one
// row, each its own document when opened. Opening and the words growing are
// thinking-open-smoke's. In Chromium with the page's own font, the live row,
// the folded one and a step row each sit level: the dot or icon, the words,
// the timer and the arrow share one middle, the words' x height.
// Offline: no server, no provider.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPageStyles } from "./page-styles.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
const { createElement } = pageRequire("react");
(globalThis as any).React = pageRequire("react");
const { renderToStaticMarkup } = pageRequire("react-dom/server");
// Page modules (.tsx): loaded at run time, as the server build compiles scripts without JSX.
const { ThinkingRow, ThinkingCardRow }: any = await import(new URL("../../web-ui/src/components/ThinkingRow.tsx", import.meta.url).href);
const workCard: any = await import(new URL("../../web-ui/src/components/work-card.tsx", import.meta.url).href);
const { ThoughtWords }: any = await import(new URL("../../web-ui/src/components/thought-words.tsx", import.meta.url).href);
const store: any = await import(new URL("../../web-ui/src/thinking-text-store.ts", import.meta.url).href);

const NOTES = "The config holds a capacity of 20 and a refill of 5 per second.";
let n = 0;
const row = (item: Record<string, unknown>, text: string, component = ThinkingRow): string => {
	const id = `thinking-${++n}`;
	store.thinkingTextStore.set(id, text);
	return renderToStaticMarkup(createElement(component, { group: [{ kind: "thinking", id, ts: Date.now(), ...item }] }));
};
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const closedButton = (html: string) => /<button[^>]*aria-expanded="false"/.test(html);

try {
	// Its own line, live: Thinking and its timer (from 3 s on), a closed button, none of the notes.
	assert(words(row({}, NOTES)) === "Thinking", "a thought just started shows no timer yet");
	const live = row({ ts: Date.now() - 5_000 }, NOTES);
	assert(words(live) === "Thinking 5 s" && live.includes("wk-sweep") && closedButton(live) && !live.includes(NOTES) && live.includes('role="status"'), `live: Thinking and its timer, closed, with the notes to open, got ${live}`);
	const done = row({ ms: 12_400 }, NOTES);
	assert(words(done) === "Thought for 12 s" && closedButton(done) && !done.includes(NOTES) && !done.includes("wk-sweep"), `done: Thought for 12 s, a closed button, got ${done}`);
	assert(words(row({ ms: 600 }, NOTES)) === "Thought briefly", "under a second with words: Thought briefly");
	assert(words(row({ ms: 65_000 }, NOTES)) === "Thought for 1 min 5 s", "a minute and more");
	for (const [label, item, text] of [["live, no words", {}, ""], ["done, no words", { ms: 8_000 }, " "], ["redacted", { ms: 8_000, redacted: true }, "[Reasoning redacted]"]] as const) {
		for (const component of [ThinkingRow, ThinkingCardRow]) {
			const html = row(item, text, component);
			assert(!html.includes("<button") && !html.includes("Reasoning redacted"), `${label}: the label alone, not a button, got ${html}`);
		}
	}
	assert(words(row({ ms: 8_000, redacted: true }, "[Reasoning redacted]")) === "Thought for 8 s", "a redacted block still says how long it thought");

	// A card's row: the same words and the same rule for what opens.
	const cardLive = row({}, NOTES, ThinkingCardRow);
	assert(words(cardLive) === "Thinking" && cardLive.includes("wk-sweep") && closedButton(cardLive) && !cardLive.includes(NOTES), `a card's row, live: Thinking, closed, got ${cardLive}`);
	const cardDone = row({ ms: 7_000 }, NOTES, ThinkingCardRow);
	assert(words(cardDone) === "Thought for 7 s" && closedButton(cardDone) && cardDone.includes('data-s="done"'), `a card's row, done: Thought for 7 s, got ${cardDone}`);

	// Thinking with nothing shown between is one row: the times added up, each thought in order, live while the last one is.
	const thoughtsOf = (items: Record<string, unknown>[]): { words: string; live: boolean }[] => JSON.parse(renderToStaticMarkup(createElement(() => JSON.stringify(store.useThoughtWords(items)))).replace(/&quot;/g, '"'));
	const joined = (items: Array<Record<string, unknown> & { text?: string }>, component = ThinkingRow) => {
		const group = items.map(({ text, ...item }, index) => {
			const id = `joined-${++n}-${index}`;
			store.thinkingTextStore.set(id, text ?? "");
			return { kind: "thinking", id, ts: Date.now(), ...item };
		});
		return { html: renderToStaticMarkup(createElement(component, { group })), group };
	};
	const both = joined([{ ms: 12_400, text: "First thought." }, { ms: 8_000, text: "Second thought." }]);
	assert(words(both.html) === "Thought for 20 s", `two thoughts: their times added, got ${both.html}`);
	assert(JSON.stringify(thoughtsOf(both.group)) === JSON.stringify([{ words: "First thought.", live: false }, { words: "Second thought.", live: false }]), `two thoughts open in order, one entry each, got ${JSON.stringify(thoughtsOf(both.group))}`);
	assert(/^Thinking/.test(words(joined([{ ms: 12_400, text: "First thought." }, { text: "Still going." }]).html)), "a row is live while its last thought is");
	const withRedacted = joined([{ ms: 3_000, text: "Readable." }, { ms: 2_000, redacted: true, text: "[Reasoning redacted]" }]);
	assert(JSON.stringify(thoughtsOf(withRedacted.group).map((thought) => thought.words)) === JSON.stringify(["Readable."]), "a redacted thought in a row opens to nothing of its own");

	// Each thought its own document: a fence the first left open does not swallow the second, and a rule stands between.
	const FENCE = "Drawing it:\n\n```mermaid\ngraph TD\n  A --> B";
	const fenced = renderToStaticMarkup(createElement(ThoughtWords, { thoughts: [{ words: FENCE, live: false }, { words: "The second thought, in words.", live: true }] }));
	assert(fenced.includes("The second thought, in words.") && fenced.includes('class="thought-break"'), `an unclosed fence stays in its own thought, got ${fenced}`);

	// The store: appends, replaces, tells only its own row, and clears.
	const heard: string[] = [];
	const stop = store.thinkingTextStore.subscribe("a", () => heard.push(store.thinkingTextStore.get("a")));
	store.thinkingTextStore.append("a", "one ");
	store.thinkingTextStore.append("b", "other");
	store.thinkingTextStore.append("a", "two");
	store.thinkingTextStore.set("a", "one two");
	store.thinkingTextStore.clear();
	stop();
	store.thinkingTextStore.append("a", "after");
	assert(JSON.stringify(heard) === JSON.stringify(["one ", "one two", ""]), `the store tells its own row of each change, got ${JSON.stringify(heard)}`);
	await levelRows();
	console.log("thinking row smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}

/**
 * Each part's middle against the words' x-height middle, in pixels at 2x: an
 * icon's or the dot's box middle (they are drawn centred in their boxes), and
 * for words and the timer, their baseline less half their font's x height.
 */
async function levelRows(): Promise<void> {
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: the rows' level is not measured)");
		return;
	}
	const liveRow = row({ ts: Date.now() - 4_200 }, NOTES);
	const foldedRow = row({ ms: 7_000 }, NOTES);
	const error = console.error;
	console.error = (...args: unknown[]) => { if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) error(...args); };
	const card = (items: unknown[], live: boolean) => renderToStaticMarkup(createElement(workCard.WorkStretch, { items, live, endTs: live ? undefined : Date.now(), elsewhere: false, keyboardApprovalId: null, onResolve: () => undefined }));
	store.thinkingTextStore.set("level-thought", NOTES);
	const steps = card([{ kind: "thinking", id: "level-thought", ts: 500, ms: 7_000 }, { kind: "tool", id: "s1", name: "bash", args: { command: "npm test" }, status: "done", result: "a\nb", startedAt: 1_000, endedAt: 2_200 }, { kind: "tool", id: "s2", name: "read", args: { path: "notes.txt" }, status: "done", result: "x", startedAt: 3_000, endedAt: 3_400 }], false);
	const running = card([{ kind: "tool", id: "s3", name: "bash", args: { command: "sleep 9" }, status: "running", startedAt: Date.now() - 4_200 }], true);
	console.error = error;
	const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web-ui/public/fonts");
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
		// Served from a made-up origin so the stylesheet's /fonts/ load the page's own font: the level is measured in it.
		// A label rises into place as its words change: the level is the resting one, so motion is off.
		await page.route("http://rows.test/**", (route) => {
			const url = new URL(route.request().url());
			if (url.pathname.startsWith("/fonts/")) return route.fulfill({ body: fs.readFileSync(path.join(fontsDir, path.basename(url.pathname))) });
			return route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${readPageStyles()} *, *::before { animation: none !important; transition: none !important; }</style></head><body><div class="messages" style="width:760px">${liveRow}${foldedRow}${steps}${running}</div></body></html>` });
		});
		await page.goto("http://rows.test/");
		await page.evaluate("document.fonts.ready.then(() => Promise.all([...document.fonts].map((font) => font.load())))");
		assert(await page.evaluate(`document.fonts.check('13px "Sen"')`), "the page's own font is loaded before measuring");
		// The folded card opened, so its step rows are measured too. A plain string: the compiler's helpers for named functions do not exist in the page.
		const rows: Array<{ row: string; parts: Record<string, number> }> = await page.evaluate(`(() => {
			document.querySelectorAll(".wk-card").forEach((card) => card.setAttribute("data-open", "1"));
			const xMiddle = (el) => {
				const probe = document.createElement("span");
				probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
				el.appendChild(probe);
				const baseline = probe.getBoundingClientRect().top;
				probe.remove();
				const style = getComputedStyle(el);
				const pen = document.createElement("canvas").getContext("2d");
				pen.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
				return baseline - pen.measureText("x").actualBoundingBoxAscent / 2;
			};
			const middle = (el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
			const named = { "wk-lead": "dot or icons", "wk-row-ic": "icon", "wk-label": "words", "wk-tx": "words", "wk-time": "timer", "wk-meta": "timer", "wk-caret": "arrow", "wk-ok": "check", "wk-hmk": "check" };
			return [...document.querySelectorAll(".wk-thought .wk-head, .wk-card .wk-head, .wk-card .wk-row")].map((row) => {
				const parts = {};
				for (const part of row.children) {
					const cls = [...part.classList].find((name) => named[name]);
					if (!cls) continue;
					const text = cls === "wk-label" ? part.querySelector(".wk-lbl") : cls === "wk-tx" || cls === "wk-time" || cls === "wk-meta" ? part : null;
					parts[named[cls]] = text ? xMiddle(text) : middle(part);
					// A card's thought row carries its arrow inside its words.
					const inner = cls === "wk-tx" ? part.querySelector(".wk-caret") : null;
					if (inner) parts.arrow = middle(inner);
				}
				return { row: row.textContent.trim(), parts };
			});
		})()`);
		assert(rows.length === 8 && rows.some(({ parts }) => parts.arrow !== undefined && parts.icon !== undefined), `the live row, the folded one, a card's head and rows (a thought's among them), got ${rows.length}`);
		for (const { row: words, parts } of rows) {
			const off = Object.entries(parts).filter(([name]) => name !== "words").map(([name, at]) => [name, Math.round((at - parts.words) * 2 * 100) / 100] as const);
			const level = off.every(([, by]) => Math.abs(by) <= 0.5) && off.length >= 2;
			assert(level, `"${words}": every part within 0.5 px at 2x of the words' x-height middle, got ${JSON.stringify(Object.fromEntries(off))}`);
		}
	} finally {
		await browser.close();
	}
}
