// Smoke for the composer @-mention consult popover pure logic
// (apps/web-ui/src/mention-popover.ts, Consult MR-3 spec §4.3).
//
// Covers: trigger-regex positions (only at the message's start, where a
// leading mention consults; caret in the middle), candidate filtering/ordering (excludes the
// current room + archived rooms, includes needs_absorb, prefix matching),
// mention completion text, leading-mention resolution incl. the stripped
// question, and the never-submit invariant at the logic level. Then what the
// picker and the consult card read, rendered from their components, the
// message box's Send waiting for a question after a room's name, and the
// picked name in the effort dial's colour, in a room as the page draws it.
//
// Run: npm run smokes -- consult-mention   (or tsx this file)

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserType, Page } from "playwright";
import { readPageStyles } from "./page-styles.js";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import {
	completeMention,
	detectMentionQuery,
	filterMentionCandidates,
	memoryFreshnessHint,
	resolveLeadingMention,
	type MentionCandidateRoom,
} from "../../web-ui/src/mention-popover.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const NOW = Date.parse("2026-07-10T14:00:00Z");
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const CURRENT = "morpheus";
const rooms: MentionCandidateRoom[] = [
	{ id: "euler", displayName: "euler", status: "ready", lastCheckpointAt: iso(2 * DAY) },
	{ id: "eugene", displayName: "Eugene (HR)", status: "needs_absorb", lastCheckpointAt: iso(21 * DAY) },
	{ id: "morpheus", displayName: "Morpheus", status: "ready", lastCheckpointAt: iso(1 * DAY) },
	{ id: "oldroom", displayName: "Old Room", status: "ready", archived: true, lastCheckpointAt: iso(5 * DAY) },
	{ id: "zeta", displayName: "Zeta", status: "ready", lastCheckpointAt: null },
];

try {
	// ---- trigger regex positions -----------------------------------------
	// start of text
	const atStart = detectMentionQuery("@eu", 3);
	assert(atStart && atStart.query === "eu" && atStart.start === 0 && atStart.caret === 3, "trigger at start of text");

	// Only a message that begins with the mention consults, so an '@' anywhere
	// else is plain text: after other words, on a later line, after a leading
	// space, or glued to a word (an email).
	// Each of these, finished as "@euler hi", sends as an ordinary message.
	for (const draft of ["hi @eu", "Can you check @eu", "line1\n@eu", " @eu", "\n@eu", "email@eu"]) {
		assert(detectMentionQuery(draft, draft.length) === null, `no trigger in ${JSON.stringify(draft)}`);
		assert(resolveLeadingMention(draft.replace(/@eu$/, "@euler hi"), rooms, CURRENT) === null, `and no consult from ${JSON.stringify(draft)}`);
	}
	// A second mention in a question that already begins with one opens nothing either.
	assert(detectMentionQuery("@euler what about\n@eu", 21) === null, "no trigger for a later mention on a later line");

	// caret in the middle of the mention → query is only the part before the caret
	const midCaret = detectMentionQuery("@euler test", 3);
	assert(midCaret && midCaret.query === "eu" && midCaret.start === 0, "caret in the middle of the mention");

	// caret after a completed word + space → no open trigger
	assert(detectMentionQuery("@euler test", 11) === null, "no trigger once the caret sits after a following word");

	// bare '@' → empty query, popover would open on all candidates
	const bare = detectMentionQuery("@", 1);
	assert(bare && bare.query === "" && bare.start === 0, "bare '@' opens with an empty query");

	// ---- filtering / ordering --------------------------------------------
	// query "eu": excludes current (morpheus) + archived (oldroom); includes the
	// needs_absorb room (eugene); freshest checkpoint first (euler 2d < eugene 21d).
	const eu = filterMentionCandidates(rooms, "eu", CURRENT).map((r) => r.id);
	assert(eu.join(",") === "euler,eugene", `filter "eu" → euler,eugene (freshest first); got ${eu.join(",")}`);
	assert(!eu.includes("morpheus"), "current room is never a candidate");
	assert(!eu.includes("oldroom"), "archived room is never a candidate");

	// empty query → every eligible room, freshest first, unknown checkpoint last
	const all = filterMentionCandidates(rooms, "", CURRENT).map((r) => r.id);
	assert(all.join(",") === "euler,eugene,zeta", `empty query → euler,eugene,zeta; got ${all.join(",")}`);

	// needs_absorb is explicitly included
	assert(filterMentionCandidates(rooms, "eugene", CURRENT).some((r) => r.id === "eugene"), "needs_absorb room is included");

	// the current room cannot be reached even by exact prefix
	assert(filterMentionCandidates(rooms, "mor", CURRENT).length === 0, "current room excluded even on exact prefix");

	// prefix matches displayName too (Eugene → "Eug"), case-insensitively
	assert(filterMentionCandidates(rooms, "eug", CURRENT).map((r) => r.id).join(",") === "eugene", "displayName prefix match, case-insensitive");

	// prefix matches the id even when the displayName diverges
	const idPrefixRooms: MentionCandidateRoom[] = [{ id: "euler", displayName: "The Pricing Room", status: "ready", lastCheckpointAt: null }];
	assert(filterMentionCandidates(idPrefixRooms, "eul", CURRENT).map((r) => r.id).join(",") === "euler", "id prefix match when displayName diverges");

	// ---- mention completion ----------------------------------------------
	// completes to '@<id> ' with a trailing space, caret after it
	const c1 = detectMentionQuery("@eu", 3)!;
	const done1 = completeMention("@eu", c1, rooms[0]);
	assert(done1.text === "@euler " && done1.caret === 7, `completion appends '@euler '; got "${done1.text}" @${done1.caret}`);

	// completes mid-text without doubling the following space
	const c2 = detectMentionQuery("@eu rest", 3)!;
	const done2 = completeMention("@eu rest", c2, rooms[0]);
	assert(done2.text === "@euler rest" && done2.caret === 7, `mid-text completion keeps a single space; got "${done2.text}" @${done2.caret}`);

	// ---- leading-mention resolution --------------------------------------
	const resolved = resolveLeadingMention("@euler what did we decide about pricing?", rooms, CURRENT);
	assert(resolved?.kind === "consult" && resolved.room.id === "euler", "leading mention resolves to the room");
	assert(resolved.question === "what did we decide about pricing?", `question is stripped of the mention; got "${resolved.question}"`);

	// token match is case-insensitive
	assert(resolveLeadingMention("@EULER hello", rooms, CURRENT)?.room.id === "euler", "leading mention token is case-insensitive");

	// not resolved: unknown room, current room, archived room
	assert(resolveLeadingMention("@nobody hi", rooms, CURRENT) === null, "unknown room does not resolve → normal send");
	assert(resolveLeadingMention("@morpheus hi", rooms, CURRENT) === null, "current room does not resolve → normal send");
	assert(resolveLeadingMention("@oldroom hi", rooms, CURRENT) === null, "archived room does not resolve → normal send");

	// not resolved: mention not at the start of the draft
	assert(resolveLeadingMention("please ask @euler about x", rooms, CURRENT) === null, "non-leading mention does not route");

	// a known room's name with no question after it waits for one (Send greys),
	// with or without the space the completion leaves; an unknown name stays an
	// ordinary message
	for (const draft of ["@euler ", "@euler", "@EULER", "@euler  \n "]) {
		const waiting = resolveLeadingMention(draft, rooms, CURRENT);
		assert(waiting?.kind === "awaiting-question" && waiting.room.id === "euler", `${JSON.stringify(draft)} waits for a question; got ${JSON.stringify(waiting)}`);
	}
	assert(resolveLeadingMention("@nobody", rooms, CURRENT) === null, "an unknown name alone is an ordinary message");
	assert(resolveLeadingMention("@morpheus ", rooms, CURRENT) === null, "the current room's name alone is an ordinary message");
	assert(resolveLeadingMention("@eul", rooms, CURRENT) === null, "part of a room's name is no room yet");

	// ---- never-submit invariant (logic level) ----------------------------
	// While a trigger is active mid-typing, the draft is NOT a routable consult:
	// Enter selects a row (completion), it never resolves+submits.
	const typing = "@eu";
	assert(detectMentionQuery(typing, typing.length) !== null, "an active trigger means the popover is open");
	assert(resolveLeadingMention(typing, rooms, CURRENT)?.kind !== "consult", "an active trigger draft never routes a consult");

	// Selecting a room mutates the draft (keeps the mention text) rather than sending.
	const selection = completeMention(typing, detectMentionQuery(typing, typing.length)!, rooms[0]);
	assert(selection.text.includes("@euler"), "selection completes the mention in the draft");

	// And the just-completed draft neither keeps the popover open nor routes yet
	// (no question yet) — so completing a mention can never submit.
	assert(detectMentionQuery(selection.text, selection.caret) === null, "completing a mention closes the popover");
	assert(resolveLeadingMention(selection.text, rooms, CURRENT)?.kind === "awaiting-question", "a completed mention with no question does not route");

	// ---- freshness hint ---------------------------------------------------
	assert(memoryFreshnessHint(null, NOW) === null, "unknown checkpoint → no hint");

	// ---- what the picker and the card read --------------------------------
	const pageRequire = createRequire(new URL("../../web-ui/package.json", import.meta.url));
	const { createElement } = pageRequire("react");
	const { renderToStaticMarkup } = pageRequire("react-dom/server");
	// The page's components build their elements through the global React, as the smoke compiles them.
	(globalThis as any).React = pageRequire("react");
	const component = (file: string) => import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../web-ui/src/components/${file}`)).href) as Promise<any>;
	const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

	// The picker: the full room name first, "remembered …" on its own line under
	// it (one column beside the dot), the keys part apart from the memory line.
	const { MentionConsultPopover } = await component("mention-consult-popover.tsx");
	const longRoom: MentionCandidateRoom = { id: "contracts", displayName: "Client Contracts and Procurement Archive", status: "ready", lastCheckpointAt: new Date(Date.now() - 2 * DAY).toISOString() };
	const picker = renderToStaticMarkup(createElement(MentionConsultPopover, { matches: [longRoom], query: "", activeIndex: 0, onHover: () => {}, onSelect: () => {} })) as string;
	assert(/<span class="m-lines"><span class="m-name">Client Contracts and Procurement Archive<\/span><span class="m-fresh">remembered 2 days ago<\/span><\/span>/.test(picker), `the row shows the full name with "remembered …" under it: ${picker}`);
	assert(/<span class="pop-keys">↑↓ choose · Enter select · Esc dismiss<\/span>The room&#x27;s memory is read, never changed/.test(picker), `the keys part stands apart from the memory line: ${picker}`);
	// No dot before a row, whatever the room's memory: the consult card carries its warnings.
	const states = ["ready", "needs_absorb", "error", "missing", undefined].map((status, index) => ({ ...longRoom, id: `room${index}`, status }));
	const stateRows = renderToStaticMarkup(createElement(MentionConsultPopover, { matches: states, query: "", activeIndex: 0, onHover: () => {}, onSelect: () => {} })) as string;
	const rowStarts = [...stateRows.matchAll(/<div role="option"[^>]*>(<span class="[^"]*")/g)].map((match) => match[1]);
	assert(rowStarts.length === states.length && rowStarts.every((start) => start === '<span class="m-lines"'), `each row starts with the room's name, in every state: ${JSON.stringify(rowStarts)}`);
	assert(!stateRows.includes("m-dot"), `no row draws a dot: ${stateRows}`);

	// The done card: "From Client Contracts' memory · 1 Nov", said once, with
	// "Ask a follow-up" and "Add to this conversation".
	const { ConsultDock, consultSourceLine } = await component("delegation-card.tsx");
	const { createConsultState } = await import("../../web-ui/src/consult-stream.js");
	const thisYear = new Date().getFullYear();
	const asOf = new Date(thisYear, 10, 1, 12).toISOString();
	const dayMonth = new Date(asOf).toLocaleDateString(undefined, { day: "numeric", month: "short" });
	const done = { ...createConsultState(), phase: "done", consultId: "c1", targetRoomId: "contracts", targetDisplayName: "Client Contracts", question: "What does clause 7.2 mean?", text: "It caps liability.", asOfCheckpointAt: asOf };
	const noop = () => {};
	const card = text(renderToStaticMarkup(createElement(ConsultDock, { state: done, onMinimize: noop, onOpen: noop, onStop: noop, onDismiss: noop, onTransfer: noop, onFollowUp: () => true })));
	assert(card.includes(`From Client Contracts' memory · ${dayMonth}`), `the card names its source as "From Client Contracts' memory · ${dayMonth}": ${card}`);
	assert(!card.includes("Contracts's") && !card.includes("is not modified") && !card.includes("answered from"), `no "s's", no repeated "memory is not modified": ${card}`);
	assert(card.includes("Ask a follow-up") && card.includes("Add to this conversation") && !card.includes("Transfer to thread"), `the card offers "Ask a follow-up" and "Add to this conversation": ${card}`);
	const streaming = text(renderToStaticMarkup(createElement(ConsultDock, { state: { ...done, phase: "streaming", text: "" }, onMinimize: noop, onOpen: noop, onStop: noop, onDismiss: noop, onTransfer: noop, onFollowUp: () => true })));
	assert(streaming.includes(`From Client Contracts' memory · ${dayMonth}`) && !streaming.includes("is not modified"), `while it answers the card names the same source: ${streaming}`);
	// A name not ending in s takes 's; another year shows its year; no date, no dot.
	assert(consultSourceLine("euler", asOf) === `From euler's memory · ${dayMonth}`, `"euler's", got ${consultSourceLine("euler", asOf)}`);
	const lastYear = new Date(thisYear - 1, 10, 1, 12).toISOString();
	assert(consultSourceLine("euler", lastYear) === `From euler's memory · ${new Date(lastYear).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`, `another year shows its year, got ${consultSourceLine("euler", lastYear)}`);
	assert(consultSourceLine("Atlas", null) === "From Atlas' memory", `no date, no dot, got ${consultSourceLine("Atlas", null)}`);

	// The done card at phone width, in a browser with the page's own stylesheets:
	// a long room name never squeezes the source line under the minimize
	// control, and no button breaks onto several lines.
	const { chromium } = await import("playwright");
	const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!chromiumPath || !fs.existsSync(chromiumPath)) {
		console.log("consult mention smoke: card layout case skipped (Chromium not installed)");
	} else {
		const css = readPageStyles();
		const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web-ui/public/fonts");
		const cardWith = (name: string) => renderToStaticMarkup(createElement(ConsultDock, { state: { ...done, targetDisplayName: name }, onMinimize: noop, onOpen: noop, onStop: noop, onDismiss: noop, onTransfer: noop, onFollowUp: () => true })) as string;
		const longCard = cardWith("Client Contracts and Procurement Archive, Regional Agreements");
		const unbrokenCard = cardWith("W".repeat(80));
		const shortCard = renderToStaticMarkup(createElement(ConsultDock, { state: done, onMinimize: noop, onOpen: noop, onStop: noop, onDismiss: noop, onTransfer: noop, onFollowUp: () => true })) as string;
		const browser = await chromium.launch();
		try {
			for (const [label, markup, width] of [["a long name at phone width", longCard, 390], ["a short name at phone width", shortCard, 390], ["an unbroken name at phone width", unbrokenCard, 390], ["a long name on a desktop", longCard, 1280]] as const) {
				const page = await browser.newPage({ viewport: { width, height: 900 } });
				// Served from a made-up origin so the stylesheet's /fonts/ load the page's own fonts: wrapping is measured in them.
				await page.route("http://card.test/**", (route) => {
					const url = new URL(route.request().url());
					if (url.pathname.startsWith("/fonts/")) return route.fulfill({ body: fs.readFileSync(path.join(fontsDir, path.basename(url.pathname))) });
					return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div style="display:flex;flex-direction:column">${markup}</div></body></html>` });
				});
				await page.goto("http://card.test/");
				await page.evaluate("document.fonts.ready.then(() => Promise.all([...document.fonts].map((font) => font.load())))");
				assert(await page.evaluate(`document.fonts.check('13px "Sen"')`), `${label}: the page's own font is loaded before measuring`);
				// A plain string: the compiler's helpers for named functions do not exist in the page.
				const layout = await page.evaluate(`(() => {
					const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
					const line = (node) => parseFloat(getComputedStyle(node).lineHeight) || 20;
					const sub = document.querySelector(".consult-sub");
					const card = document.querySelector(".consult-card");
					const ask = document.querySelector(".consult-followup .btn");
					const input = document.querySelector(".consult-followup-input");
					const inputStyle = getComputedStyle(input);
					const pen = document.createElement("canvas").getContext("2d");
					pen.font = inputStyle.font;
					const chip = document.querySelector(".consult-chip");
					return {
						sub: box(".consult-sub"), mini: box(".mini-btn"), subOverflows: sub.scrollWidth > sub.clientWidth + 1,
						ask: box(".consult-followup .btn"), askLine: line(ask),
						buttons: [...document.querySelectorAll(".consult-actions .btn")].map((node) => ({ height: node.getBoundingClientRect().height, line: line(node) })),
						card: box(".consult-card"), cardOverflows: card.scrollWidth > card.clientWidth + 1,
						placeholder: { text: input.placeholder, width: pen.measureText(input.placeholder).width, room: input.clientWidth - parseFloat(inputStyle.paddingLeft) - parseFloat(inputStyle.paddingRight) },
						chip: { height: chip.getBoundingClientRect().height, line: line(chip) },
					};
				})()`) as any;
				const overlaps = layout.sub.left < layout.mini.right && layout.mini.left < layout.sub.right && layout.sub.top < layout.mini.bottom && layout.mini.top < layout.sub.bottom;
				assert(layout.sub.width >= 120 && !layout.subOverflows, `${label}: the source line keeps room for its words, got ${JSON.stringify(layout.sub)}`);
				assert(!overlaps, `${label}: the source line never runs under the minimize control: line ${JSON.stringify(layout.sub)}, control ${JSON.stringify(layout.mini)}`);
				assert(layout.mini.right <= layout.card.right && layout.mini.top < layout.sub.bottom + 1, `${label}: the minimize control stays at the card's top, never alone on a later line: ${JSON.stringify(layout.mini)}`);
				assert(layout.ask.height < layout.askLine * 2 + 16, `${label}: "Ask a follow-up" stays on one line, got ${layout.ask.height}px`);
				assert(layout.buttons.every((button: { height: number; line: number }) => button.height < button.line * 2 + 12), `${label}: the footer buttons stay on one line each, got ${JSON.stringify(layout.buttons)}`);
				assert(!layout.cardOverflows, `${label}: nothing in the card runs past its edge`);
				assert(layout.placeholder.width <= layout.placeholder.room, `${label}: the follow-up box shows its whole placeholder, got ${JSON.stringify(layout.placeholder)}`);
				assert(layout.chip.height < layout.chip.line * 2, `${label}: the room's chip stays one line (the source line names the room in full), got ${JSON.stringify(layout.chip)}`);
				await page.close();
			}
		} finally {
			await browser.close();
		}
	}

	// ---- Send waits for a question after the room's name -------------------
	// The message box as the room draws it, in a JSDOM window: pick a room with
	// Enter, then press Enter and click Send as the person does.
	{
		const { JSDOM } = await import("jsdom");
		const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://page.test/" });
		// A wide screen with a mouse: JSDOM has no media queries, and the room's modules read them on load.
		dom.window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as any;
		// JSDOM lays nothing out, so the picker's highlighted row has nowhere to scroll.
		dom.window.HTMLElement.prototype.scrollIntoView = () => {};
		const globals = globalThis as any;
		globals.window = dom.window;
		globals.document = dom.window.document;
		// The page's own Enter and Esc listener reads it once a key reaches the document.
		globals.HTMLElement = dom.window.HTMLElement;
		// Node 21 and later have a global navigator, which React reads once a window exists; Node 20 has none.
		const ownNavigator = !("navigator" in globalThis);
		if (ownNavigator) globals.navigator = dom.window.navigator;
		globals.IS_REACT_ACT_ENVIRONMENT = true;
		const { act } = pageRequire("react");
		const { createRoot } = pageRequire("react-dom/client");
		const { ComposerInput } = await component("in-room-chat.tsx");
		const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
		const sent: string[] = [];
		const asked: string[] = [];
		let root: any = null;
		let container: HTMLElement | null = null;
		const mount = async (props: Record<string, unknown> = {}) => {
			if (root) await act(async () => root.unmount());
			container?.remove();
			sent.length = 0;
			asked.length = 0;
			container = dom.window.document.createElement("div");
			dom.window.document.body.append(container);
			root = createRoot(container);
			const mention = { candidates: rooms, currentRoomId: CURRENT, busy: false, busyTitle: "", activeConsultDisplayName: null, onConsultRequest: (id: string, question: string) => { asked.push(`${id}: ${question}`); return true; } };
			await act(async () => root.render(createElement(ComposerInput, { onSend: (draft: string) => { sent.push(draft); return true; }, placeholder: "Ask", mention, ...props })));
		};
		const box = () => container!.querySelector("textarea") as HTMLTextAreaElement;
		const send = () => container!.querySelector("button.send-btn") as HTMLButtonElement;
		const type = (value: string) => act(async () => {
			setValue.call(box(), value);
			box().setSelectionRange(value.length, value.length);
			box().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		const press = (key: string) => act(async () => { box().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
		const clickSend = () => act(async () => send().click());
		const shows = () => `box ${JSON.stringify(box().value)}, Send ${send().disabled ? "greyed" : "active"} "${send().title}", sent ${JSON.stringify(sent)}, asked ${JSON.stringify(asked)}`;
		const WAIT = "Type your question after the name";
		try {
			// Picked from the picker: "@euler " greys Send, and neither Enter nor Send sends.
			await mount();
			await type("@eu");
			assert(container!.querySelector(".mention-pop"), `typing "@eu" opens the picker: ${shows()}`);
			await press("Enter");
			await press("Enter");
			await clickSend();
			assert(box().value === "@euler " && send().disabled && send().title === WAIT && sent.length === 0 && asked.length === 0, `a picked room with no question greys Send and sends nothing: ${shows()}`);
			// The name typed out, no space, picker dismissed: still waiting.
			await type("@euler");
			await press("Escape");
			assert(!container!.querySelector(".mention-pop"), `Esc closes the picker: ${shows()}`);
			await press("Enter");
			await clickSend();
			assert(send().disabled && send().title === WAIT && sent.length === 0 && asked.length === 0, `"@euler" alone greys Send and sends nothing: ${shows()}`);
			// A question after it: Send works and the consult goes out, by click and by Enter.
			await type("@euler what about pricing?");
			assert(!send().disabled && send().title === "Send", `a question after the name makes Send work: ${shows()}`);
			await clickSend();
			assert(asked.join("|") === "euler: what about pricing?" && sent.length === 0 && box().value === "", `Send asks the room: ${shows()}`);
			await type("@euler and the deadline?");
			await press("Enter");
			assert(asked.join("|") === "euler: what about pricing?|euler: and the deadline?" && sent.length === 0, `Enter asks the room: ${shows()}`);
			// An unknown name is an ordinary message, as before.
			asked.length = 0;
			await type("@nobody");
			assert(!send().disabled && send().title === "Send", `an unknown name leaves Send working: ${shows()}`);
			await press("Enter");
			assert(sent.join("|") === "@nobody" && asked.length === 0, `an unknown name sends as an ordinary message: ${shows()}`);
			// The picked room's name shows in the effort dial's colour: a layer over
			// the box draws its text, the name in a span of its own. Only a known
			// room's name at the start, as it routes the send, and it follows each edit.
			const layer = () => {
				const mirror = container!.querySelector(".composer-mirror");
				return { name: mirror?.querySelector(".composer-mention")?.textContent ?? null, text: mirror?.textContent ?? null, box: box().className };
			};
			const NONE = JSON.stringify({ name: null, text: null, box: "" });
			await mount();
			assert(JSON.stringify(layer()) === NONE, `an empty box has no layer: ${JSON.stringify(layer())}`);
			await type("@eu");
			assert(JSON.stringify(layer()) === NONE, `"@eu" with the picker open is not coloured: ${JSON.stringify(layer())}`);
			await press("Enter");
			assert(JSON.stringify(layer()) === JSON.stringify({ name: "@euler", text: "@euler ", box: "has-mention" }), `the picked "@euler " shows its name coloured: ${JSON.stringify(layer())}`);
			await type("@euler what about pricing?");
			assert(JSON.stringify(layer()) === JSON.stringify({ name: "@euler", text: "@euler what about pricing?", box: "has-mention" }), `the question after the name stays plain: ${JSON.stringify(layer())}`);
			await type("@EULER hi");
			assert(layer().name === "@EULER", `the name as typed, in any case: ${JSON.stringify(layer())}`);
			await type("@eule");
			assert(JSON.stringify(layer()) === NONE, `a letter of the name deleted, the colour goes: ${JSON.stringify(layer())}`);
			await press("Enter");
			assert(JSON.stringify(layer()) === JSON.stringify({ name: "@euler", text: "@euler ", box: "has-mention" }), `picked again, the colour comes back: ${JSON.stringify(layer())}`);
			for (const draft of ["@nobody hi", "@eul hi", "@morpheus hi", "Can you check @euler", " @euler hi", "hi\n@euler hi"]) {
				await type(draft);
				assert(JSON.stringify(layer()) === NONE, `${JSON.stringify(draft)} is not coloured: ${JSON.stringify(layer())}`);
			}
			// The box shows a line after a final line break, so the layer does too.
			await type("@euler hi\n");
			assert(layer().text === "@euler hi\n\u200b", `a final line break gets its line in the layer: ${JSON.stringify(layer())}`);
			// While an input method composes, the box draws its own text and the layer only the name.
			const nameOnly = () => container!.querySelector(".composer-mirror")?.classList.contains("name-only") ?? false;
			await act(async () => { box().dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })); });
			assert(layer().name === "@euler" && layer().box === "" && nameOnly(), `while composing, the box draws its own text and the layer the name: ${JSON.stringify(layer())}`);
			await act(async () => { box().dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "" })); });
			assert(layer().box === "has-mention" && !nameOnly(), `the composition done, the layer draws the text again: ${JSON.stringify(layer())}`);
			// Text selected: the box draws its own text, in the system's selection colours.
			const selectThrough = (end: number) => act(async () => {
				box().setSelectionRange(0, end);
				box().dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
			});
			await selectThrough(box().value.length);
			assert(JSON.stringify(layer()) === NONE, `with text selected, the box draws its own text: ${JSON.stringify(layer())}`);
			await selectThrough(0);
			assert(layer().box === "has-mention", `nothing selected, the name is coloured again: ${JSON.stringify(layer())}`);
			// Attached files do not change it: a consult needs a question.
			await mount({ allowEmptySend: true });
			assert(!send().disabled, `files attached let an empty box send: ${shows()}`);
			await type("@euler ");
			await press("Enter");
			assert(send().disabled && send().title === WAIT && sent.length === 0 && asked.length === 0, `with files attached, a room's name alone still waits: ${shows()}`);
			// An '@' after other text, on the first line or a later one, is plain
			// typing: no picker, the arrows, Tab and Esc are the box's own, and
			// Enter sends the message as written.
			for (const draft of ["Can you check @eu", "Can you check\n@eu"]) {
				await mount();
				await type(draft);
				assert(!container!.querySelector(".mention-pop"), `${JSON.stringify(draft)} opens no picker: ${shows()}`);
				for (const key of ["ArrowDown", "ArrowUp", "Tab", "Escape"]) {
					const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
					await act(async () => { box().dispatchEvent(event); });
					assert(!event.defaultPrevented, `${key} in ${JSON.stringify(draft)} is the box's own: ${shows()}`);
				}
				await press("Enter");
				assert(sent.join("|") === draft && asked.length === 0, `Enter sends ${JSON.stringify(draft)} as written: ${shows()}`);
			}
			// While the room answers, the greyed affordance shows for an '@' at the
			// start only.
			await mount({ mention: { candidates: rooms, currentRoomId: CURRENT, busy: true, busyTitle: "Wait for the room's answer", activeConsultDisplayName: null, onConsultRequest: () => true } });
			await type("@eu");
			assert(container!.querySelector(".mention-pop-disabled") && !container!.querySelector(".mention-row"), `while busy, "@eu" shows the greyed affordance: ${shows()}`);
			await type("Can you check @eu");
			assert(!container!.querySelector(".mention-pop"), `while busy, an '@' after other text shows nothing: ${shows()}`);
			// While busy the draft goes as an ordinary message, so the name is not coloured.
			await type("@euler hi");
			assert(!container!.querySelector(".composer-mirror") && box().className === "", `while busy, "@euler hi" is not coloured: ${shows()}`);
			// No connection: its own title stays.
			await mount({ sendUnavailable: true, sendTitle: "Waiting for the connection" });
			await type("@euler ");
			assert(send().disabled && send().title === "Waiting for the connection", `no connection keeps its own title: ${shows()}`);
		} finally {
			if (root) await act(async () => root.unmount());
			// Removing the box queues a selectionchange on a zero timer; let it land while the window still exists.
			await new Promise((resolve) => setTimeout(resolve, 0));
			delete globals.window;
			delete globals.document;
			delete globals.HTMLElement;
			if (ownNavigator) delete globals.navigator;
			delete globals.IS_REACT_ACT_ENVIRONMENT;
		}
	}

	if (chromiumPath && fs.existsSync(chromiumPath)) await checkMessageBox(chromium);
	else console.log("consult mention smoke: message box cases skipped (Chromium not installed)");

	console.log("consult mention popover smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}

// ---- the picked name's colour, in a room as the page draws it --------------
// A real server on a scratch home with two rooms and a synthetic model; the
// room's message box at desktop and phone width, light and dark: the name in
// the effort dial's colour at 4.5:1 or more, the layer's letters exactly where
// the box draws its own (pixel for pixel, wrapped and scrolled), and typing,
// an input method, paste, undo and Send as before.
async function checkMessageBox(chromium: BrowserType): Promise<void> {
	const waitUntil = waitEvery(100, 15_000);
	const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const repoRoot = path.resolve(webServerDir, "..", "..");
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-consult-mention-"));
	const tempHome = path.join(tempRoot, "home");
	const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
	const agentDir = path.join(tempHome, ".exxperts", "agent");
	const appDir = path.join(tempHome, ".exxperts", "app");
	for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
	// The model: every question gets "Done.".
	const gateway = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) return void res.writeHead(404).end();
			const sse = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const base = { id: `cmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "gpt-fake" };
			sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] });
			sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	let server: ChildProcessWithoutNullStreams | undefined;
	const serverOutput: string[] = [];
	try {
		const gatewayPort = await freePort();
		await new Promise<void>((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));
		fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
			providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } },
		}, null, 2), { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-consult-mention" } }, null, 2), { mode: 0o600 });
		fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
			{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
		] }, null, 2), { mode: 0o600 });
		fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });
		const agents = await import("../src/persistent-agents.js");
		const roomModels = await import("../src/room-models.js");
		const create = (displayName: string) => {
			const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
			roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });
			return agentId;
		};
		// A room per pass, so each opens a fresh conversation with no consult card docked.
		const PASSES = [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const;
		for (const [width, theme] of PASSES) create(`Desk ${width} ${theme}`);
		const target = create("Client Contracts");
		assert(target === "client-contracts", `the room to consult is client-contracts, got ${target}`);
		const NAME = `@${target}`;

		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		server = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		});
		server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		await waitForServer(server, baseUrl, 30_000);

		// Scrollbars drawn, as on a real screen (headless hides them), at a Mac's and a phone's pixel density.
		const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
		try {
			for (const [width, theme] of PASSES) {
				const label = `${width} ${theme}`;
				const desk = `Desk ${label}`;
				const phone = width === 390;
				const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: phone ? 3 : 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
				try {
					const page = await ctx.newPage();
					await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
					await page.waitForLoadState("networkidle");
					const dismiss = page.locator(".whats-new-close");
					if (await dismiss.count()) await dismiss.click();
					await page.locator(".persistent-agent-card").filter({ hasText: desk }).getByRole("button", { name: "Enter" }).click();
					const composer = page.locator(".composer textarea").first();
					await composer.waitFor({ timeout: 20_000 });
					assert(await page.evaluate(() => document.documentElement.dataset.theme) === theme, `${label}: the page shows the ${theme} theme`);
					await composer.click();

					// The list after "@cl": no dot before its row.
					await page.keyboard.type("@cl");
					await page.locator(".mention-row").first().waitFor({ timeout: 5000 });
					assert(await page.locator(".mention-row .m-dot").count() === 0, `${label}: the list's rows show no dot`);
					assert(await layerOf(page) === null, `${label}: "@cl" is not coloured`);
					await page.keyboard.press("Enter");
					await waitUntil(async () => (await composer.inputValue()) === `${NAME} `, `${label}: Enter picks the room`);
					const picked = await layerOf(page);
					assert(picked?.name === NAME && picked.text === `${NAME} `, `${label}: the picked name is coloured: ${JSON.stringify(picked)}`);
					assert(picked.nameColor === picked.plan && picked.restColor === picked.fg && picked.boxColor === "rgba(0, 0, 0, 0)", `${label}: the name in --exx-plan, the rest in the box's own colour: ${JSON.stringify(picked)}`);
					assert(picked.contrast >= 4.5, `${label}: the name reads at 4.5:1 or more against the box, got ${picked.contrast.toFixed(2)}:1 (${picked.nameColor} on ${picked.background})`);
					console.log(`  ${label}: the name ${picked.nameColor} on the box ${picked.background}: ${picked.contrast.toFixed(2)}:1`);
					assert(await page.locator("button.send-btn").isDisabled(), `${label}: with only the name, Send waits`);
					await expectAligned(page, `${label}, the name picked`);

					// A question long enough to wrap: the layer wraps with the box.
					await page.keyboard.type("what does clause 7.2 of the framework agreement say about liability caps, and does it differ for the regional agreements signed after the merger?");
					const wrapped = await page.evaluate(() => {
						const box = document.querySelector(".composer textarea") as HTMLTextAreaElement;
						return box.scrollHeight / parseFloat(getComputedStyle(box).lineHeight);
					});
					assert(wrapped >= 2, `${label}: the question wraps onto a second line, got ${wrapped.toFixed(1)} lines`);
					const asked = await layerOf(page);
					assert(asked?.name === NAME && asked.restColor === asked.fg, `${label}: the question stays in the box's colour: ${JSON.stringify(asked)}`);
					await expectAligned(page, `${label}, a wrapped question`);

					// Past the box's height it scrolls: the layer scrolls with it.
					await composer.fill(`${NAME} ${Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long question`).join("\n")}`);
					await composer.evaluate((node: HTMLTextAreaElement) => { node.scrollTop = node.scrollHeight; });
					await waitUntil(() => scrolledTogether(page, true), `${label}: the layer follows the box to its end`);
					await expectAligned(page, `${label}, scrolled to the end`);
					await composer.evaluate((node: HTMLTextAreaElement) => { node.scrollTop = 40; });
					await waitUntil(() => scrolledTogether(page, false), `${label}: the layer follows the box back up`);
					await expectAligned(page, `${label}, scrolled part way`);

					// The colour follows edits: a letter of the name deleted, it goes; picked again, it comes back.
					await composer.fill(`${NAME} what about pricing?`);
					await composer.evaluate((node: HTMLTextAreaElement, at: number) => { node.focus(); node.setSelectionRange(at, at); }, NAME.length);
					await page.keyboard.press("Backspace");
					await waitUntil(async () => (await layerOf(page)) === null, `${label}: a letter of the name deleted, the colour goes`);
					assert(await composer.evaluate((node) => getComputedStyle(node).color) === picked.fg, `${label}: the box draws its own text again`);
					await page.locator(".mention-row").first().waitFor({ timeout: 5000 });
					await page.keyboard.press("Enter");
					await waitUntil(async () => (await layerOf(page))?.name === NAME, `${label}: picked again, the colour comes back`);
					assert(await composer.inputValue() === `${NAME} what about pricing?`, `${label}: picking again keeps the question, got ${JSON.stringify(await composer.inputValue())}`);
					for (const draft of ["@nobody what about pricing?", `Can you ask ${NAME} about pricing?`]) {
						await composer.fill(draft);
						assert(await layerOf(page) === null && await composer.evaluate((node) => getComputedStyle(node).color) === picked.fg, `${label}: ${JSON.stringify(draft)} is not coloured`);
					}

					// Text selected: the box draws it with the system's selection colours, as
					// before the layer; the name's colour comes back once nothing is selected.
					await composer.fill(`${NAME} what about pricing?`);
					await composer.press("ControlOrMeta+A");
					await waitUntil(() => composer.evaluate((node: HTMLTextAreaElement) => node.selectionStart === 0 && node.selectionEnd === node.value.length), `${label}: the whole text is selected`);
					await waitUntil(async () => (await layerOf(page)) === null, `${label}: with text selected, the box draws its own text`);
					const selected = await differsFromOwnText(page, "");
					assert(selected === 0, `${label}: the selected text looks as the box draws it, but ${selected} pixels differ`);
					// A click puts the caret back; on a phone, where a tap inside a selection
					// keeps it, the system clears it as it does when the selection is let go.
					if (phone) await composer.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(node.value.length, node.value.length));
					else await composer.click();
					await waitUntil(async () => (await layerOf(page))?.name === NAME, `${label}: nothing selected, the name is coloured again`);

					if (width === 1280 && theme === "dark") {
						// An input method: the box draws the composing word with its underline, the name coloured again once it is done.
						await composer.fill(`${NAME} `);
						await composer.focus();
						const cdp = await ctx.newCDPSession(page);
						await cdp.send("Input.imeSetComposition", { text: "しつもん", selectionStart: 4, selectionEnd: 4 });
						await waitUntil(async () => (await composer.inputValue()) === `${NAME} しつもん`, `${label}: the input method composes in the box`);
						const composing = await layerOf(page);
						assert(composing?.name === NAME && composing.restColor === "rgba(0, 0, 0, 0)" && composing.boxColor === picked.fg, `${label}: while composing, the box draws its own text (the input method's underline with it) and the layer only the name: ${JSON.stringify(composing)}`);
						await cdp.send("Input.insertText", { text: "質問" });
						await waitUntil(async () => (await composer.inputValue()) === `${NAME} 質問` && (await layerOf(page))?.text === `${NAME} 質問`, `${label}: the word done, the layer shows it with the name coloured`);
						// Paste, then undo it.
						await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
						await page.evaluate((text) => navigator.clipboard.writeText(text), " and clause 7.2?");
						await composer.press("ControlOrMeta+V");
						await waitUntil(async () => (await composer.inputValue()) === `${NAME} 質問 and clause 7.2?`, `${label}: paste lands in the box`);
						assert((await layerOf(page))?.text === `${NAME} 質問 and clause 7.2?`, `${label}: the layer shows the pasted text`);
						await composer.press("ControlOrMeta+Z");
						await waitUntil(async () => (await composer.inputValue()) === `${NAME} 質問`, `${label}: undo takes the paste back`);
						assert((await layerOf(page))?.text === `${NAME} 質問`, `${label}: the layer follows the undo`);
						await expectAligned(page, `${label}, after an input method, paste and undo`);
					}

					// Send: the consult goes out, the box empties and draws its own text again.
					await composer.fill(`${NAME} what about pricing?`);
					await page.keyboard.press("Enter");
					await waitUntil(async () => (await composer.inputValue()) === "", `${label}: Enter sends the consult`);
					await page.locator(".consult-card").first().waitFor({ timeout: 10_000 });
					assert(await page.locator(".composer-mirror").count() === 0, `${label}: the empty box has no layer`);
				} finally {
					await ctx.close();
				}
			}
		} finally {
			await browser.close();
		}
	} catch (error) {
		console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-4000));
		throw error;
	} finally {
		await stopSmokeServer(server);
		await new Promise<void>((resolve) => gateway.close(() => resolve()));
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

/** What the layer over the message box draws, with the colours it uses; null with no layer. */
async function layerOf(page: Page) {
	return page.evaluate(`(() => {
		const mirror = document.querySelector(".composer-mirror");
		if (!mirror) return null;
		const name = mirror.querySelector(".composer-mention");
		const box = document.querySelector(".composer textarea");
		const probe = (value) => { const node = document.createElement("span"); node.style.color = value; document.body.append(node); const color = getComputedStyle(node).color; node.remove(); return color; };
		const rgb = (color) => color.match(/[\\d.]+/g).slice(0, 3).map(Number);
		const luminance = (color) => { const [r, g, b] = rgb(color).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
		const nameColor = name ? getComputedStyle(name).color : null;
		const background = getComputedStyle(document.querySelector(".composer-box")).backgroundColor;
		const [hi, lo] = nameColor ? [luminance(nameColor), luminance(background)].sort((a, b) => b - a) : [0, 0];
		return {
			name: name ? name.textContent : null,
			text: mirror.textContent,
			nameColor,
			restColor: getComputedStyle(mirror).color,
			boxColor: getComputedStyle(box).color,
			plan: probe("var(--exx-plan)"),
			fg: probe("var(--fg)"),
			background,
			contrast: (hi + 0.05) / (lo + 0.05),
		};
	})()`) as Promise<{ name: string | null; text: string; nameColor: string; restColor: string; boxColor: string; plan: string; fg: string; background: string; contrast: number } | null>;
}

async function scrolledTogether(page: Page, atEnd: boolean): Promise<boolean> {
	return page.evaluate(`(() => {
		const box = document.querySelector(".composer textarea");
		const mirror = document.querySelector(".composer-mirror");
		const top = box.scrollTop;
		return Boolean(mirror) && top > 0 && mirror.scrollTop === top && (${atEnd} ? top + box.clientHeight >= box.scrollHeight - 1 : top + box.clientHeight < box.scrollHeight - 1);
	})()`) as Promise<boolean>;
}

/**
 * How many pixels of the box differ between the page as drawn (with `layerCss`
 * added) and the box drawing its own text with the layer hidden; the caret
 * hidden in both.
 */
async function differsFromOwnText(page: Page, layerCss: string): Promise<number> {
	const clip = await page.locator(".composer textarea").evaluate((node) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
	const common = await page.addStyleTag({ content: `.composer textarea { caret-color: transparent !important; } ${layerCss}` });
	const asDrawn = await page.screenshot({ clip, animations: "disabled" });
	const own = await page.addStyleTag({ content: ".composer-mirror { visibility: hidden !important; } .composer .composer-input textarea.has-mention { color: var(--fg) !important; }" });
	const byBox = await page.screenshot({ clip, animations: "disabled" });
	await own.evaluate((node) => (node as Element).remove());
	await common.evaluate((node) => (node as Element).remove());
	return page.evaluate(`(async () => {
		const pixels = async (data) => {
			const image = new Image();
			image.src = "data:image/png;base64," + data;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			return context.getImageData(0, 0, image.width, image.height).data;
		};
		const a = await pixels(${JSON.stringify(asDrawn.toString("base64"))});
		const b = await pixels(${JSON.stringify(byBox.toString("base64"))});
		let count = 0;
		for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 32) count++;
		return count;
	})()`) as Promise<number>;
}

/**
 * The layer's letters sit exactly where the box would draw its own: the layer
 * drawing (the name in the text's colour, so only placement can differ)
 * against the box drawing. The name's own span starts a new run of text, so a
 * few letters after it can land a fraction of a pixel apart and shade a pixel
 * or two differently; a letter or a line out of place changes far more. So
 * the same layer one pixel off is the yardstick: it must differ plainly, and
 * the real layer by less than a twentieth of that.
 */
async function expectAligned(page: Page, label: string): Promise<void> {
	const shifted = (x: number) => differsFromOwnText(page, `.composer-mirror .composer-mention { color: inherit !important; } .composer-mirror { translate: ${x}px 0; }`);
	const aligned = await shifted(0);
	const off = await shifted(1);
	assert(off > 50, `${label}: one pixel off, the comparison sees it (${off} pixels differ)`);
	assert(aligned * 20 < off, `${label}: the layer's letters sit where the box draws its own, but ${aligned} pixels differ (one pixel off: ${off})`);
	console.log(`  ${label}: ${aligned} pixels differ from the box's own text (one pixel off: ${off})`);
}
