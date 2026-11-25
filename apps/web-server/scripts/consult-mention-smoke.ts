// Smoke for asking another room from the message box: the '@' list, the room
// on the box as a label, and the rest of the consult flow the page draws.
//
// Covers: where the list opens (only at the message's start, staying open
// on the space after a word two rooms fit), filtering and ordering, which
// room a word names (exact name or id first, else one that starts with it,
// never one of two; an id only whole until the server has said it is this
// computer, since a shared server's ids are random), the label at the first space, the line for a later '@'
// word, a consult as the server keeps it and as it goes back into the box.
// Then the picker and the consult card rendered from their components, the
// message box in a JSDOM window as a person types into it, and the box in a
// room as the page draws it, on a real server, with a room whose id carries a
// tail: picked, sent, kept through leaving the room, queued while the room
// answers, handed back by Stop, refused while a card is open.
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
	ANOTHER_ROOM,
	askHint,
	askingWords,
	detectMentionQuery,
	draftAfterPick,
	filterMentionCandidates,
	fitRoom,
	labelAtFirstSpace,
	laterMentionRoom,
	memoryFreshnessHint,
	ROOM_GONE,
	TYPE_QUESTION,
	type MentionCandidateRoom,
} from "../../web-ui/src/mention-popover.js";
import { boxWithHandBack, consultOf, consultText, EDIT_NEEDS_BOX, queuedBubbles, type OutgoingMessage } from "../../web-ui/src/outgoing-messages.js";
import { failureLineText } from "../../web-ui/src/turn-failure-line.js";

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

// Rooms as a shared server named them before its ids held no name: each id
// carries a random tail, which no person ever sees.
const TAIL = "7f3a2c9d";
const HERE = `pricing-notes-${TAIL}`;
const BID_X = { id: `bid-for-client-x-${TAIL}`, displayName: "Bid for Client X" };
const BID = { id: `bid-1a2b3c4d`, displayName: "Bid" };
const tailed: MentionCandidateRoom[] = [
	BID_X,
	BID,
	{ id: `budget-review-5e6f7a8b`, displayName: "Budget review" },
	{ id: HERE, displayName: "Pricing notes" },
	{ id: `old-bid-0c0c0c0c`, displayName: "Old bid", archived: true },
];

// Rooms as a shared server names them now: 32 random hex characters, nothing of
// the name, and Budget's id starts with an "a" that no name of it has.
const HEX_HERE = "e0".repeat(16);
const BUDGET_HEX = { id: `a3f${"0".repeat(29)}`, displayName: "Budget" };
const hexed: MentionCandidateRoom[] = [
	{ id: `c4${"1".repeat(30)}`, displayName: "Angebot" },
	BUDGET_HEX,
	{ id: `d5${"2".repeat(30)}`, displayName: "Archive notes" },
	{ id: HEX_HERE, displayName: "Pricing notes" },
];

try {
	// ---- where the list opens ------------------------------------------------
	const atStart = detectMentionQuery("@eu", 3);
	assert(atStart && atStart.query === "eu" && atStart.start === 0 && atStart.caret === 3, "trigger at start of text");

	// Only a message that begins with '@' opens the list, so an '@' anywhere
	// else is plain text: after other words, on a later line, after a leading
	// space, or glued to a word (an email).
	for (const draft of ["hi @eu", "Can you check @eu", "line1\n@eu", " @eu", "\n@eu", "email@eu"]) {
		assert(detectMentionQuery(draft, draft.length) === null, `no trigger in ${JSON.stringify(draft)}`);
	}
	assert(detectMentionQuery("@euler what about\n@eu", 21) === null, "no trigger for a later mention on a later line");

	// caret in the middle of the word → the query is only the part before the caret
	const midCaret = detectMentionQuery("@euler test", 3);
	assert(midCaret && midCaret.query === "eu" && midCaret.start === 0, "caret in the middle of the mention");

	// The one space after the word keeps it open, for a word two rooms fit; the next letter closes it.
	assert(detectMentionQuery("@bi ", 4)?.query === "bi", "the space after the word keeps the list open on the word");
	assert(detectMentionQuery("@bi w", 5) === null, "a letter after the space closes it");
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

	// ---- which room a word names ---------------------------------------------
	const fits = (word: string, list = tailed) => fitRoom(word, list, HERE)?.displayName ?? null;
	assert(fits("bu") === "Budget review", `a short word names the one room that starts with it, got ${fits("bu")}`);
	assert(fits("BUDGET") === "Budget review" && fits("BiD") === "Bid", `capitals name the same room, got ${fits("BUDGET")}, ${fits("BiD")}`);
	assert(fits("bid") === "Bid", `Bid beside Bid for Client X: "bid" names Bid, its exact name, got ${fits("bid")}`);
	assert(fits("bi") === null, `two rooms start with "bi": none is named, got ${fits("bi")}`);
	assert(fits("bid-for") === "Bid for Client X" && fits(BID_X.id.toUpperCase()) === "Bid for Client X", "the id names its room too, whole or its start");
	assert(fits("nobody") === null && fits("") === null, "a word no room fits names none");
	assert(fits("pricing") === null && fits("old") === null, "this room and an archived room are never named");
	assert(fits("bid", [...tailed, { id: "bid-9e9e9e9e", displayName: "bid" }]) === null, "two rooms with the exact name: none is named");

	// ---- ids that hold no name: an id counts only whole ------------------------
	const listed = (query: string, idsByStart: boolean) => filterMentionCandidates(hexed, query, HEX_HERE, idsByStart).map((room) => room.displayName).join("|");
	assert(listed("a", false) === "Angebot|Archive notes", `ids only whole: "a" lists the rooms whose names start with A, got ${listed("a", false)}`);
	assert(listed("a", true) === "Angebot|Archive notes|Budget", `the control, ids by their start: "a" lists Budget too, got ${listed("a", true)}`);
	assert(listed("a3f", false) === "" && listed("a3f", true) === "Budget", `the start of an id lists nothing, its control lists Budget, got ${listed("a3f", false)} and ${listed("a3f", true)}`);
	assert(listed(BUDGET_HEX.id.toUpperCase(), false) === "Budget", `a whole id lists its room, in any case, got ${listed(BUDGET_HEX.id.toUpperCase(), false)}`);
	assert(fitRoom("a3f", hexed, HEX_HERE, false) === null && fitRoom("a3f", hexed, HEX_HERE, true)?.displayName === "Budget", "the start of an id names no room; its control names Budget");
	assert(fitRoom(BUDGET_HEX.id, hexed, HEX_HERE, false)?.displayName === "Budget" && fitRoom("ang", hexed, HEX_HERE, false)?.displayName === "Angebot", "a whole id, and a name's start, still name their room");
	const hexLabel = labelAtFirstSpace("", `@${BUDGET_HEX.id} when?`, hexed, HEX_HERE, false);
	assert(hexLabel?.room.displayName === "Budget" && hexLabel.rest === "when?" && labelAtFirstSpace("", "@a3f when?", hexed, HEX_HERE, false) === null, `the label forms for a whole id, never for its start, got ${hexLabel?.room.displayName}`);
	assert(laterMentionRoom(`hi @${BUDGET_HEX.id}`, hexed, HEX_HERE, false)?.displayName === "Budget" && laterMentionRoom("hi @a3f", hexed, HEX_HERE, false) === null, "the later line names a room by its whole id, never by its start");

	// The label forms at the first space, typed or pasted with the rest; never again in text already written.
	const labelled = (previous: string, next: string) => {
		const result = labelAtFirstSpace(previous, next, tailed, HERE);
		return result ? `${result.room.displayName}|${result.rest}` : null;
	};
	assert(labelled("@bu", "@bu ") === "Budget review|", `"@bu " labels Budget review, got ${labelled("@bu", "@bu ")}`);
	assert(labelled("", "@bid what is the deadline?") === "Bid|what is the deadline?", `pasted, the rest stays, got ${labelled("", "@bid what is the deadline?")}`);
	assert(labelled("@bid", "@bid\nwhat?") === "Bid|what?", "a line break ends the word as a space does");
	assert(labelled("@bi", "@bi ") === null, "two fit: no label");
	assert(labelled("@nobody", "@nobody ") === null, "none fits: no label");
	assert(labelled("@bid x", "@bid xy") === null && labelled("@bid ", "@bid  ") === null, "the space was there before the edit: no label");
	assert(draftAfterPick("@bi what") === "what" && draftAfterPick("@") === "" && draftAfterPick("@bi ") === "", "picking from the list leaves only what follows the word");

	// A later '@' word that names one room: the line names it.
	const later = (text: string) => laterMentionRoom(text, tailed, HERE)?.displayName ?? null;
	assert(later("hello @bid can you reply here") === "Bid", `a later "@bid" names Bid, got ${later("hello @bid can you reply here")}`);
	assert(later("is it fine, @budget.") === "Budget review" && later("hi\n@BUDGET") === "Budget review", "after a line break, with a full stop, in capitals");
	for (const text of ["hello @bi can", "hello @nobody", "@bid hi", "mail me at me@bid", "hi @pricing"]) {
		assert(later(text) === null, `${JSON.stringify(text)} shows no line, got ${later(text)}`);
	}
	assert(askHint("Bid") === "To ask Bid, start the message with @.", `the line's words, got ${askHint("Bid")}`);

	// ---- a consult as the server keeps it, and back into the box ----------------
	const names = new Map(tailed.filter((room) => room.id !== HERE).map((room) => [room.id, room.displayName]));
	const consult = { roomId: BID_X.id, question: "what is the deadline?" };
	assert(JSON.stringify(consultOf({ text: consultText(consult) }, names)) === JSON.stringify(consult), "a held consult the server lists reads back to its room and question");
	assert(consultOf({ text: "@nobody hi" }, names) === null && consultOf({ text: `@${HERE} hi` }, names) === null, "words naming no other room stay words");
	assert(consultOf({ text: consultText(consult), consult: null }, names) === null, "words the page sent to this room stay words, even when they read like an address");
	const queuedList: OutgoingMessage[] = [
		{ id: "q1", text: consultText(consult), state: "consult", consult },
		{ id: "q2", text: consultText(consult), state: "held" },
		{ id: "q3", text: consultText({ roomId: "gone-1234abcd", question: "still there?" }), state: "consult", consult: { roomId: "gone-1234abcd", question: "still there?" } },
		{ id: "q4", text: "and the budget?", state: "later" },
	];
	const bubbles = queuedBubbles(queuedList, names);
	assert(JSON.stringify(bubbles.map((bubble) => [bubble.text, bubble.asking ?? null])) === JSON.stringify([["what is the deadline?", "Bid for Client X"], ["what is the deadline?", "Bid for Client X"], ["still there?", ANOTHER_ROOM], ["and the budget?", null]]), `a queued consult shows its room's name and its question, never the id: ${JSON.stringify(bubbles)}`);
	assert(!JSON.stringify(bubbles).includes(TAIL) && !JSON.stringify(bubbles).includes("gone-1234abcd"), `no id in a bubble: ${JSON.stringify(bubbles)}`);

	const handed = (messages: { id: string; text: string; consult?: typeof consult }[], box: { text: string; asking: string | null }) => {
		const back = boxWithHandBack(messages.map((message) => ({ ...message, consult: message.consult ?? null })), box);
		return JSON.stringify(back);
	};
	const toBid = { id: "c", text: consultText(consult), consult };
	const plain = { id: "p", text: "and the budget?" };
	assert(handed([toBid], { text: "", asking: null }) === JSON.stringify({ box: { text: "what is the deadline?", asking: BID_X.id }, taken: ["c"], held: [] }), `into an empty box, a consult puts its room on the label: ${handed([toBid], { text: "", asking: null })}`);
	assert(handed([toBid], { text: "", asking: BID_X.id }) === JSON.stringify({ box: { text: "what is the deadline?", asking: BID_X.id }, taken: ["c"], held: [] }), "into a box asking its room");
	assert(handed([toBid], { text: "more?", asking: BID_X.id }) === JSON.stringify({ box: { text: "what is the deadline?\n\nmore?", asking: BID_X.id }, taken: ["c"], held: [] }), "above what is typed for its room");
	assert(handed([plain, toBid], { text: "", asking: null }) === JSON.stringify({ box: { text: "and the budget?", asking: null }, taken: ["p"], held: ["c"] }), "after an ordinary message, a consult stays held: the box goes to this room");
	assert(handed([toBid, plain], { text: "", asking: null }) === JSON.stringify({ box: { text: "what is the deadline?", asking: BID_X.id }, taken: ["c"], held: ["p"] }), "after a consult, an ordinary message stays held: the box asks the room");
	assert(handed([toBid], { text: "typed here", asking: null }) === JSON.stringify({ box: { text: "typed here", asking: null }, taken: [], held: ["c"] }), "a consult never joins words typed for this room");
	assert(handed([plain], { text: "", asking: BID.id }) === JSON.stringify({ box: { text: "", asking: BID.id }, taken: [], held: ["p"] }), "an ordinary message never joins a box asking a room");
	assert(handed([plain], { text: "typed", asking: null }) === JSON.stringify({ box: { text: "and the budget?\n\ntyped", asking: null }, taken: ["p"], held: [] }), "an ordinary message goes above what is typed, as before");

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


	// ---- the message box as a person types into it -------------------------
	// The box as the room draws it, in a JSDOM window: pick from the list, type
	// a word and a space, take the label off, and send as the person does.
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
		// The page's question of which server it is on, held by this smoke: each read
		// takes the next of `reads`, "hold" keeping it out until `held` settles it.
		const clientContext = await import("../../web-ui/src/remote-client-context.js");
		const pageFetch = globalThis.fetch;
		const reads: (Record<string, unknown> | "hold")[] = [];
		let held: { resolve: (response: Response) => void; reject: (error: Error) => void } | null = null;
		globals.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
			if (!String(input).endsWith("/api/remote/client-context")) return pageFetch(input, init);
			const read = reads.shift();
			assert(read !== undefined, "a client-context read the smoke did not plan");
			if (read === "hold") return new Promise<Response>((resolve, reject) => (held = { resolve, reject }));
			return Promise.resolve(new Response(JSON.stringify(read), { status: 200, headers: { "content-type": "application/json" } }));
		};
		const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
		const sent: string[] = [];
		const asked: string[] = [];
		const told: (string | null)[] = [];
		let accept = true;
		let root: any = null;
		let container: HTMLElement | null = null;
		let lastProps: Record<string, unknown> = {};
		const mentionWith = (extra: Record<string, unknown> = {}) => ({ candidates: tailed, currentRoomId: HERE, busy: false, busyTitle: "", activeConsultDisplayName: null, onConsultRequest: (id: string, question: string, now: boolean) => { asked.push(`${id}: ${question}${now ? " (now)" : ""}`); return accept; }, ...extra });
		const render = (props: Record<string, unknown>) => {
			lastProps = props;
			return act(async () => root.render(createElement(ComposerInput, { onSend: (draft: string) => { sent.push(draft); return true; }, onAskingChange: (id: string | null) => told.push(id), placeholder: "Ask", mention: mentionWith(), ...props })));
		};
		const mount = async (props: Record<string, unknown> = {}) => {
			if (root) await act(async () => root.unmount());
			container?.remove();
			sent.length = 0;
			asked.length = 0;
			told.length = 0;
			accept = true;
			container = dom.window.document.createElement("div");
			dom.window.document.body.append(container);
			root = createRoot(container);
			await render(props);
		};
		const box = () => container!.querySelector("textarea") as HTMLTextAreaElement;
		const send = () => container!.querySelector("button.send-btn") as HTMLButtonElement;
		const label = () => container!.querySelector(".composer-asking-name")?.textContent ?? null;
		const hint = () => container!.querySelector(".composer-ask-hint")?.textContent ?? null;
		const rows = () => [...container!.querySelectorAll(".mention-row .m-name")].map((node) => node.textContent);
		const type = (value: string, caret = value.length) => act(async () => {
			setValue.call(box(), value);
			box().setSelectionRange(caret, caret);
			box().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
		// Letter by letter, as a keyboard types: each edit sees the one before it.
		const typeOn = async (letters: string) => {
			for (const letter of letters) await type(box().value + letter);
		};
		const press = (key: string, init: Record<string, unknown> = {}) => act(async () => { box().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
		const clickSend = () => act(async () => send().click());
		const shows = () => `label ${JSON.stringify(label())}, box ${JSON.stringify(box().value)}, line ${JSON.stringify(hint())}, list ${JSON.stringify(rows())}, Send ${send().disabled ? "greyed" : "active"} "${send().title}", sent ${JSON.stringify(sent)}, asked ${JSON.stringify(asked)}`;
		// No room id anywhere a person reads, the label, the list and the box's own words included.
		const noId = (when: string) => {
			const seen = `${container!.textContent} ${box().value} ${[...container!.querySelectorAll("[aria-label],[title]")].map((node) => `${node.getAttribute("aria-label")} ${node.getAttribute("title")}`).join(" ")}`;
			assert(!seen.includes(TAIL) && !seen.includes(BID.id), `${when}: no room id shows: ${seen}`);
		};
		try {
			// Ids count by their start only once the server has said it is this
			// computer. While its answer is out, after a failed read and on a
			// shared server, "@a" lists the rooms whose names start with A.
			const hexMention = { mention: mentionWith({ candidates: hexed, currentRoomId: HEX_HERE }) };
			const listsForA = async () => {
				await mount(hexMention);
				await typeOn("@a");
				return rows().join("|");
			};
			reads.push("hold");
			assert(await listsForA() === "Angebot|Archive notes" && held !== null && clientContext.knownRemoteClientContext() === null, `while the answer is out, "@a" lists only names that start with A: ${shows()}`);
			await act(async () => {
				held!.reject(new TypeError("no answer"));
				await clientContext.fetchRemoteClientContext();
			});
			assert(clientContext.mayBeOnSharedServer() && await listsForA() === "Angebot|Archive notes", `after a failed read, "@a" lists only names that start with A: ${shows()}`);
			let refreshed = "";
			const answerNext = (answer: Record<string, unknown>) => {
				reads.push(answer);
				return act(async () => void (refreshed = await clientContext.refreshRemoteClientContext()));
			};
			await answerNext({ sharedServer: true });
			assert(refreshed === "answered" && clientContext.knownRemoteClientContext()?.sharedServer === true, `the page has heard it is on a shared server: ${refreshed}`);
			assert(await listsForA() === "Angebot|Archive notes", `on a shared server, "@a" lists only names that start with A: ${shows()}`);
			await mount(hexMention);
			await typeOn(`@${BUDGET_HEX.id} `);
			assert(label() === askingWords("Budget") && box().value === "", `on a shared server, a whole id typed puts its room on the box: ${shows()}`);
			await answerNext({ sharedServer: false });
			assert(refreshed === "answered" && !clientContext.mayBeOnSharedServer() && await listsForA() === "Angebot|Archive notes|Budget", `the control, once the server has said it is this computer: "@a" lists Budget by its id too: ${shows()}`);
			assert(reads.length === 0, `every planned read was asked: ${reads.length} left`);

			// Picked from the list: the room is a label on the box and the draft holds only the question.
			await mount();
			await typeOn("@bi");
			assert(rows().join("|") === "Bid|Bid for Client X", `"@bi" lists both rooms: ${shows()}`);
			noId("the list");
			await press("ArrowDown");
			await press("Enter");
			assert(label() === askingWords("Bid for Client X") && box().value === "" && sent.length === 0 && asked.length === 0, `Enter picks the room as a label, the box empty: ${shows()}`);
			assert(told.at(-1) === BID_X.id, `the box tells the page the room's id: ${JSON.stringify(told)}`);
			assert(container!.querySelector(".composer-asking-off")?.getAttribute("aria-label") === "Don't ask Bid for Client X", `× says what it does: ${shows()}`);
			noId("the label");
			// Send waits for the question, files or not, and an '@' typed now opens nothing.
			await press("Enter");
			await clickSend();
			assert(send().disabled && send().title === TYPE_QUESTION && sent.length === 0 && asked.length === 0, `with only the label, Send waits: ${shows()}`);
			await typeOn("@bu");
			assert(rows().length === 0 && !container!.querySelector(".mention-pop") && label() === askingWords("Bid for Client X"), `with the label on, an '@' opens nothing: ${shows()}`);
			await type("what is the deadline?");
			assert(!send().disabled && send().title === "Send" && hint() === null, `a question lights Send: ${shows()}`);
			noId("the label and the question");
			await clickSend();
			assert(asked.join("|") === `${BID_X.id}: what is the deadline?` && sent.length === 0 && box().value === "" && label() === null, `Send asks the room by its id, and the box empties: ${shows()}`);
			assert(told.at(-1) === null, `the page is told the label went: ${JSON.stringify(told)}`);

			// A word and a space: the label forms when exactly one room fits.
			for (const [letters, room] of [["@bu ", "Budget review"], ["@BUDGET ", "Budget review"], ["@bid ", "Bid"], ["@Bid-For ", "Bid for Client X"]] as const) {
				await mount();
				await typeOn(letters);
				assert(label() === askingWords(room) && box().value === "" && rows().length === 0, `${JSON.stringify(letters)} puts ${room} on the box: ${shows()}`);
				await typeOn("when?");
				await press("Enter");
				assert(asked.slice().length === 1 && asked[0].endsWith(": when?") && fitRoom(room, tailed, HERE)?.id === asked[0].split(":")[0] && sent.length === 0, `Enter asks ${room}: ${shows()}`);
			}
			// Pasted whole: the word becomes the label, the question stays.
			await mount();
			await type("@bid what is the deadline?");
			assert(label() === askingWords("Bid") && box().value === "what is the deadline?", `a pasted "@bid question" labels Bid: ${shows()}`);

			// Two rooms that fit: the list stays open on the space, and nothing is picked.
			await mount();
			await typeOn("@bi ");
			assert(label() === null && box().value === "@bi " && rows().join("|") === "Bid|Bid for Client X", `"@bi " keeps the list open: ${shows()}`);
			await press("Enter");
			assert(label() === askingWords("Bid") && box().value === "", `Enter then picks from it: ${shows()}`);
			await mount();
			await typeOn("@bi what");
			assert(label() === null && rows().length === 0 && !send().disabled && hint() === null, `typed on, it is an ordinary message: ${shows()}`);
			await press("Enter");
			assert(sent.join("|") === "@bi what" && asked.length === 0, `and goes to this room: ${shows()}`);
			// Two rooms with the exact name: the same.
			await mount({ mention: mentionWith({ candidates: [...tailed, { id: "bid-9e9e9e9e", displayName: "Bid" }] }) });
			await typeOn("@bid ");
			assert(label() === null && box().value === "@bid " && rows().length === 3, `two rooms named Bid: no label, the list open: ${shows()}`);

			// A word no room fits is an ordinary message: Send on, no line.
			await mount();
			await typeOn("@nobody hi");
			assert(label() === null && hint() === null && !send().disabled && send().title === "Send", `"@nobody hi" stays an ordinary message: ${shows()}`);
			await press("Enter");
			assert(sent.join("|") === "@nobody hi" && asked.length === 0, `and goes to this room: ${shows()}`);
			// Esc on the list: the space after it labels nothing.
			await mount();
			await typeOn("@bu");
			assert(rows().length > 0, `"@bu" opens the list: ${shows()}`);
			await press("Escape");
			assert(rows().length === 0 && !container!.querySelector(".mention-pop"), `Esc closes the list: ${shows()}`);
			await typeOn(" hi");
			assert(label() === null && box().value === "@bu hi", `after Esc, the word stays a word: ${shows()}`);

			// × takes the label off and keeps the text, which then goes to this room.
			await mount();
			await typeOn("@bid what is the deadline?");
			await act(async () => (container!.querySelector(".composer-asking-off") as HTMLButtonElement).click());
			assert(label() === null && box().value === "what is the deadline?" && told.at(-1) === null, `× takes the label off, the text stays: ${shows()}`);
			await press("Enter");
			assert(sent.join("|") === "what is the deadline?" && asked.length === 0, `the message goes to this room: ${shows()}`);
			// Backspace at the start does the same; anywhere else it is the box's own.
			await mount();
			await typeOn("@bid what?");
			await act(async () => box().setSelectionRange(2, 2));
			const inside = new dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
			await act(async () => { box().dispatchEvent(inside); });
			assert(!inside.defaultPrevented && label() === askingWords("Bid"), `Backspace inside the text is the box's own: ${shows()}`);
			await act(async () => box().setSelectionRange(0, 0));
			await press("Backspace");
			assert(label() === null && box().value === "what?", `Backspace at the start takes the label off: ${shows()}`);
			await act(async () => box().setSelectionRange(0, box().value.length));
			const selected = new dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
			await act(async () => { box().dispatchEvent(selected); });
			assert(!selected.defaultPrevented, "with no label, Backspace is the box's own");

			// A later '@' word that fits one room: the line, Send on, and the message goes to this room.
			await mount();
			await type("hello @bid can you reply here");
			assert(hint() === askHint("Bid") && label() === null && !send().disabled, `a later "@bid" shows the line: ${shows()}`);
			await press("Enter");
			assert(sent.join("|") === "hello @bid can you reply here" && asked.length === 0, `Send goes to this room: ${shows()}`);
			for (const draft of ["hello @bi can", "hello @nobody", "mail me@bid"]) {
				await type(draft);
				assert(hint() === null, `${JSON.stringify(draft)} shows no line: ${shows()}`);
			}
			// An '@' after other text, on the first line or a later one, is plain typing: no list,
			// the arrows, Tab and Esc are the box's own, and Enter sends the message as written.
			for (const draft of ["Can you check @bi", "Can you check\n@bi"]) {
				await mount();
				await type(draft);
				assert(!container!.querySelector(".mention-pop") && label() === null, `${JSON.stringify(draft)} opens no list: ${shows()}`);
				for (const key of ["ArrowDown", "ArrowUp", "Tab", "Escape"]) {
					const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
					await act(async () => { box().dispatchEvent(event); });
					assert(!event.defaultPrevented, `${key} in ${JSON.stringify(draft)} is the box's own: ${shows()}`);
				}
				await press("Enter");
				assert(sent.join("|") === draft && asked.length === 0, `Enter sends ${JSON.stringify(draft)} as written: ${shows()}`);
			}
			await type("");
			await typeOn("@bid hello @budget");
			assert(label() === askingWords("Bid") && hint() === null, `with the label on, a later word shows no line: ${shows()}`);

			// Files attached: a consult still needs a question.
			await mount({ allowEmptySend: true });
			assert(!send().disabled, `files attached let an empty box send: ${shows()}`);
			await typeOn("@bid ");
			await press("Enter");
			assert(send().disabled && send().title === TYPE_QUESTION && sent.length === 0 && asked.length === 0, `with files attached, a label alone still waits: ${shows()}`);

			// Refused (one already open, or no connection): the label and the question stay.
			await mount();
			await typeOn("@bid what is the deadline?");
			accept = false;
			await press("Enter");
			assert(asked.slice().length === 1 && label() === askingWords("Bid") && box().value === "what is the deadline?", `a refused question stays, with its label: ${shows()}`);
			// A card open: refused with a line, nothing asked.
			await mount({ mention: mentionWith({ activeConsultDisplayName: "Budget review" }) });
			await typeOn("@bid what is the deadline?");
			await press("Enter");
			assert(asked.length === 0 && label() === askingWords("Bid") && box().value === "what is the deadline?" && container!.querySelector(".composer-consult-gate"), `with a card open, the question stays: ${shows()}`);

			// Cmd/Ctrl+Enter: asked now.
			await mount({ onSendNow: (text: string) => { sent.push(`now: ${text}`); return true; } });
			await typeOn("@bid when?");
			// The chord as the page reads it: ⌘ where the browser says Macintosh, Ctrl elsewhere.
			await press("Enter", (globalThis as any).navigator.userAgent.includes("Macintosh") ? { metaKey: true } : { ctrlKey: true });
			assert(asked.join("|") === `${BID.id}: when? (now)` && sent.length === 0, `the chord asks the room now: ${shows()}`);

			// Filled again by the page (back in the room, a message handed back): the label comes with its words.
			await mount();
			await render({ ...lastProps, initialDraftValue: "what is the deadline?", initialAsking: BID_X.id, draftResetKey: 1 });
			assert(label() === askingWords("Bid for Client X") && box().value === "what is the deadline?" && told.at(-1) === BID_X.id, `the box filled again shows its label: ${shows()}`);
			noId("the box filled again");
			await press("Enter");
			assert(asked.join("|") === `${BID_X.id}: what is the deadline?`, `and asks that room: ${shows()}`);
			await render({ ...lastProps, initialDraftValue: "plain words", initialAsking: null, draftResetKey: 2 });
			assert(label() === null && box().value === "plain words", `filled again with plain words, no label: ${shows()}`);
			// A room the list no longer has keeps its label, without its id.
			await render({ ...lastProps, initialDraftValue: "still there?", initialAsking: "gone-1234abcd", draftResetKey: 3 });
			assert(label() === askingWords(ANOTHER_ROOM) && !container!.textContent!.includes("gone-1234abcd"), `a room gone from the list: ${shows()}`);
			// Send is off for it, with the reason, and neither Enter nor the chord asks it.
			assert(send().disabled && send().title === ROOM_GONE, `a room gone from the list: Send is off with the reason: ${shows()}`);
			await press("Enter");
			await press("Enter", (globalThis as any).navigator.userAgent.includes("Macintosh") ? { metaKey: true } : { ctrlKey: true });
			assert(asked.slice().length === 1 && box().value === "still there?", `a room gone from the list is never asked: ${shows()}`);
			// × takes the label off and keeps the words, which then go to this room.
			await act(async () => (container!.querySelector(".composer-asking-off") as HTMLButtonElement).click());
			assert(label() === null && box().value === "still there?" && !send().disabled, `× keeps the words: ${shows()}`);

			// While the room answers, the greyed affordance shows for an '@' at the start only, and no label forms.
			await mount({ mention: mentionWith({ busy: true, busyTitle: "Wait for the room's answer" }) });
			await typeOn("@bu");
			assert(container!.querySelector(".mention-pop-disabled") && !container!.querySelector(".mention-row"), `while busy, "@bu" shows the greyed affordance: ${shows()}`);
			await typeOn(" hi");
			assert(label() === null, `while busy, no label: ${shows()}`);
			// No connection: its own title stays.
			await mount({ sendUnavailable: true, sendTitle: "Waiting for the connection" });
			await typeOn("@bid ");
			assert(send().disabled && send().title === "Waiting for the connection", `no connection keeps its own title: ${shows()}`);
		} finally {
			if (root) await act(async () => root.unmount());
			// Removing the box queues a selectionchange on a zero timer; let it land while the window still exists.
			await new Promise((resolve) => setTimeout(resolve, 0));
			globals.fetch = pageFetch;
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

// ---- the box in a room as the page draws it --------------------------------
// A real server on a scratch home, a synthetic model, and a room to ask whose
// id carries a tail as on a shared server. At desktop and phone width, light
// and dark: picked from the list, the room is a label with its name, measured
// against the box, and Send asks it. Then, in one room, what a draft lives
// through: leaving the room and coming back, a question queued while the room
// answers, Stop handing it back, a card already open.
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
	// The model: every question gets "Done.", except in a conversation where the
	// person said "Take your time": its answer starts and waits until the case lets it go.
	// A last question "Say nothing yet" waits with no words, and fails once let go.
	const SLOW = "Take your time";
	const QUIET = "Say nothing yet";
	// Whether a held answer waits now: the cases go on once the model has the question.
	let holding = false;
	let release = () => {};
	// Held answers the server cut before they were let go: a Stop or a Send now.
	let cut = 0;
	const gateway = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", async () => {
			if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) return void res.writeHead(404).end();
			let parsed: any = {};
			try { parsed = JSON.parse(body); } catch {}
			const asked = (Array.isArray(parsed?.messages) ? parsed.messages : []).filter((message: any) => message?.role === "user");
			const users = JSON.stringify(asked);
			const hold = () => new Promise<void>((resolve) => {
				holding = true;
				const letGo = () => { holding = false; res.off("close", cutHere); resolve(); };
				const cutHere = () => { cut += 1; letGo(); };
				release = letGo;
				res.once("close", cutHere);
			});
			if (JSON.stringify(asked.at(-1) ?? null).includes(QUIET)) {
				await hold();
				if (!res.destroyed && !res.writableEnded) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The model refused the request.", type: "invalid_request_error" } }));
				return;
			}
			const sse = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const base = { id: `cmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "gpt-fake" };
			if (users.includes(SLOW)) {
				sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Working on it" }, finish_reason: null }] });
				await hold();
				if (res.destroyed || res.writableEnded) return;
			}
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
		const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agent-create.js");
		const roomModels = await import("../src/room-models.js");
		const create = (displayName: string, id?: string) => {
			const agentId = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }, id ? { newId: () => id } : {}).agent.agentId;
			roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });
			return agentId;
		};
		// A room per pass, so each opens a fresh conversation with no consult card docked.
		const PASSES = [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const;
		for (const [width, theme] of PASSES) create(`Desk ${width} ${theme}`);
		create("Desk flow");
		const target = create("Bid for Client X", `bid-for-client-x-${TAIL}`);
		assert(target === `bid-for-client-x-${TAIL}`, `the room to ask carries a tail, got ${target}`);
		const NAME = "Bid for Client X";
		// Rooms that go while their label is on the box, at each width: one archived, one deleted.
		const goneAt = {
			1280: [
				{ id: create("Old pricing", `old-pricing-${TAIL}`), name: "Old pricing", word: "@old", way: "archive", confirm: (id: string) => `DELETE ${id}` },
				{ id: create("Scratch notes", `scratch-notes-${TAIL}`), name: "Scratch notes", word: "@scr", way: "purge", confirm: (id: string) => `DELETE ${id} FOREVER` },
			],
			390: [
				{ id: create("Past offers", `past-offers-${TAIL}`), name: "Past offers", word: "@pas", way: "archive", confirm: (id: string) => `DELETE ${id}` },
				{ id: create("Draft ideas", `draft-ideas-${TAIL}`), name: "Draft ideas", word: "@dra", way: "purge", confirm: (id: string) => `DELETE ${id} FOREVER` },
			],
		};
		// The room archived or deleted as another window does it.
		const roomGoes = async (page: Page, id: string, way: string, confirmation: string, refresh = true) => {
			const status = await page.evaluate(async ([id, way, confirmation]) => (await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/${way}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation }) })).status, [id, way, confirmation]);
			assert(status < 300, `the room ${way}d, got ${status}`);
			// Back to the window: the page reads the room list again.
			if (refresh) await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		};
		// A room asked from the queue, archived before the answer here ends.
		const spare = create("Spare notes", `spare-notes-${TAIL}`);
		// The same, while this window can't read the room list.
		const last = create("Last notes", `last-notes-${TAIL}`);

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

		const browser = await chromium.launch();
		try {
			for (const [width, theme] of PASSES) {
				const label = `${width} ${theme}`;
				const phone = width === 390;
				const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: phone ? 3 : 2, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
				try {
					const page = await ctx.newPage();
					const composer = await enterRoom(page, baseUrl, `Desk ${label}`);
					assert(await page.evaluate(() => document.documentElement.dataset.theme) === theme, `${label}: the page shows the ${theme} theme`);
					await composer.click();

					// A room on the label archived or deleted meanwhile: the line above the box says so, the label
					// stays, Send is off with the reason, and × takes the label and the line off and keeps the
					// words, which then go to this room.
					const send = page.locator(".composer-box .send-btn");
					const goneLine = page.locator(".composer-room-gone");
					if (theme === "light") for (const room of goneAt[width]) {
						const row = `${label}, ${room.way}`;
						await composer.pressSequentially(`${room.word} what changed?`);
						await waitUntil(async () => (await asking(page)) === askingWords(room.name) && (await composer.inputValue()) === "what changed?", `${row}: the room is on the box`);
						assert((await goneLine.count()) === 0, `${row}: no line while the room is there`);
						await roomGoes(page, room.id, room.way, room.confirm(room.id));
						await waitUntil(async () => (await asking(page)) === askingWords(ANOTHER_ROOM) && (await send.isDisabled()) && (await send.getAttribute("title")) === ROOM_GONE && (await goneLine.count()) === 1, `${row}: the line shows, the label stays, and Send is off with the reason`).catch(async (error) => {
							throw new Error(`${error.message}: label ${JSON.stringify(await asking(page))}, box ${JSON.stringify(await composer.inputValue())}, Send ${(await send.isDisabled()) ? "off" : "on"} ${JSON.stringify(await send.getAttribute("title"))}, lines ${JSON.stringify(await page.locator("[role=status]").allInnerTexts())}`);
						});
						assert((await goneLine.innerText()) === `${ROOM_GONE}.`, `${row}: the line's words, got ${JSON.stringify(await goneLine.innerText())}`);
						const look = await lineLook(page, ".composer-room-gone");
						assert(look.ratio >= 4.5, `${row}: the line reads at 4.5:1 or more, got ${look.ratio.toFixed(2)}:1 (${JSON.stringify(look)})`);
						assert(look.bottom <= look.boxTop && look.left >= look.textLeft - 1 && look.left <= look.textLeft + 1, `${row}: the line sits above the box, in line with its words: ${JSON.stringify(look)}`);
						await composer.press("Enter");
						assert((await page.locator(".consult-card").count()) === 0 && (await composer.inputValue()) === "what changed?", `${row}: Enter asks nothing`);
						await expectNoId(page, `${row}, the label`);
						await page.getByRole("button", { name: `Don't ask ${ANOTHER_ROOM}` }).click();
						await waitUntil(async () => (await asking(page)) === null && (await composer.inputValue()) === "what changed?" && !(await send.isDisabled()) && (await goneLine.count()) === 0, `${row}: × takes the line off, keeps the words, and Send is on`);
						await composer.fill("");
					}

					// Picked from the list: the label names the room, the box holds only the question.
					await page.keyboard.type("@bi");
					await page.locator(".mention-row").first().waitFor({ timeout: 5000 });
					await expectNoId(page, `${label}, the list`);
					await page.keyboard.press("Enter");
					await waitUntil(async () => (await asking(page)) === askingWords(NAME), `${label}: Enter puts the room on the box`);
					assert(await composer.inputValue() === "", `${label}: the box holds no name, got ${JSON.stringify(await composer.inputValue())}`);
					assert(await page.locator("button.send-btn").isDisabled(), `${label}: with only the label, Send waits`);
					await page.keyboard.type("what is the deadline?");
					await expectNoId(page, `${label}, the label and the question`);
					const look = await labelLook(page);
					for (const [part, ratio] of [["name", look.name], ["×", look.off]] as const) {
						assert(ratio >= 4.5, `${label}: the label's ${part} reads at 4.5:1 or more, got ${ratio.toFixed(2)}:1 (${JSON.stringify(look)})`);
					}
					assert(look.offSize >= (phone ? 32 : 22), `${label}: × is big enough to hit, got ${look.offSize}px`);
					console.log(`  ${label}: label name ${look.name.toFixed(2)}:1, × ${look.off.toFixed(2)}:1 on ${look.ground}`);

					// Send asks that room: its card opens with its name.
					await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
					await composer.press("Enter");
					await page.locator(".consult-card").first().waitFor({ timeout: 10_000 });
					await waitUntil(async () => (await page.locator(".consult-card").first().innerText()).includes(NAME), `${label}: the card names ${NAME}`);
					assert(await composer.inputValue() === "" && (await asking(page)) === null, `${label}: the box empties and its label goes`);

					// A later '@' word that names the room: the line, and Send stays on.
					await composer.fill("hello @bid can you reply here");
					await waitUntil(async () => (await page.locator(".composer-ask-hint").count()) === 1, `${label}: the line shows`);
					assert(await page.locator(".composer-ask-hint").innerText() === askHint(NAME), `${label}: the line's words`);
					const line = await lineLook(page);
					assert(line.ratio >= 4.5, `${label}: the line reads at 4.5:1 or more, got ${line.ratio.toFixed(2)}:1 (${JSON.stringify(line)})`);
					console.log(`  ${label}: the line ${line.ratio.toFixed(2)}:1 on ${line.ground}`);
					// Above the box, outside its border, starting where the box's words start.
					assert(line.bottom <= line.boxTop && line.left >= line.textLeft - 1 && line.left <= line.textLeft + 1, `${label}: the line sits above the box, in line with its words: ${JSON.stringify(line)}`);
					assert(!(await page.locator("button.send-btn").isDisabled()), `${label}: with the line, Send stays on`);

					// With a card open, a new question is refused and stays in the box with its label.
					await composer.fill("");
					await composer.pressSequentially("@bid and the budget?");
					await waitUntil(async () => (await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "and the budget?", `${label}: "@bid " labels the room`);
					await composer.press("Enter");
					await page.locator(".composer-consult-gate").waitFor({ timeout: 5000 });
					assert((await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "and the budget?", `${label}: refused, the question stays with its label`);
				} finally {
					await ctx.close();
				}
			}

			// What the draft lives through, in one room.
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			try {
				const page = await ctx.newPage();
				// A failed message the server handed back, as the page hears it: its place is settled after that.
				let handedBack = 0;
				page.on("websocket", (socket) => socket.on("framereceived", (frame) => { if (String(frame.payload).includes('"type":"prompt_returned"')) handedBack += 1; }));
				let composer = await enterRoom(page, baseUrl, "Desk flow");
				await composer.click();
				await composer.pressSequentially("@bid what is the deadline?");
				await waitUntil(async () => (await asking(page)) === askingWords(NAME), "flow: the room is on the box");

				// Leaving the room and coming back.
				await page.getByRole("button", { name: "Rooms", exact: true }).first().click();
				await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
				composer = await enterRoom(page, baseUrl, "Desk flow", false);
				await waitUntil(async () => (await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "what is the deadline?", "back in the room, the label and the question are there");
				await page.getByRole("button", { name: `Don't ask ${NAME}` }).click();
				await composer.fill("");

				// An input method composing the start word with its space: the words stay as composed while
				// the word is open, and the room goes on the box once it is done.
				const cdp = await ctx.newCDPSession(page);
				await composer.focus();
				await cdp.send("Input.imeSetComposition", { text: "@bid しつもん", selectionStart: 9, selectionEnd: 9 });
				await waitUntil(async () => (await composer.inputValue()) === "@bid しつもん", "the input method composes in the box").catch(async (error) => {
					throw new Error(`${error.message}: box ${JSON.stringify(await composer.inputValue())}, label ${JSON.stringify(await asking(page))}`);
				});
				assert((await asking(page)) === null, `while the word is open, no label: label ${JSON.stringify(await asking(page))}, box ${JSON.stringify(await composer.inputValue())}`);
				await cdp.send("Input.insertText", { text: "@bid 質問" });
				await waitUntil(async () => (await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "質問", "the word done, the room is on the box with the question").catch(async (error) => {
					throw new Error(`${error.message}: box ${JSON.stringify(await composer.inputValue())}, label ${JSON.stringify(await asking(page))}`);
				});
				await page.getByRole("button", { name: `Don't ask ${NAME}` }).click();
				await composer.fill("");
				// Esc on the list, then the space and the question composed: the word stays a word, and Enter
				// sends to this room.
				await composer.pressSequentially("@bid");
				await page.locator(".mention-row").first().waitFor({ timeout: 5000 });
				await composer.press("Escape");
				await page.locator(".mention-pop").waitFor({ state: "detached", timeout: 5000 });
				await cdp.send("Input.imeSetComposition", { text: " しつもん", selectionStart: 5, selectionEnd: 5 });
				await waitUntil(async () => (await composer.inputValue()) === "@bid しつもん", "after Esc, the input method composes in the box");
				await cdp.send("Input.insertText", { text: " 質問" });
				await waitUntil(async () => (await composer.inputValue()) === "@bid 質問", "after Esc, the composed word is done").catch(async (error) => {
					throw new Error(`${error.message}: box ${JSON.stringify(await composer.inputValue())}, label ${JSON.stringify(await asking(page))}`);
				});
				assert((await asking(page)) === null, `after Esc, a composed space labels nothing: label ${JSON.stringify(await asking(page))}, box ${JSON.stringify(await composer.inputValue())}`);
				await composer.fill("");

				// Queued while the room answers: the bubble names the room, never its id.
				const queued = page.locator(".bubble-row.user.queued");
				const askWhileAnswering = async () => {
					await composer.fill(SLOW);
					await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
					await composer.press("Enter");
					await waitUntil(() => holding, "the room's answer has started");
					await composer.pressSequentially("@bid what is the deadline?");
					await waitUntil(async () => (await asking(page)) === askingWords(NAME), "flow: labelled while the room answers");
					await composer.press("Enter");
					await waitUntil(async () => (await queued.count()) === 1 && (await composer.inputValue()) === "" && (await asking(page)) === null, "the question waits as a queued message, the box empty").catch(async (error) => {
						throw new Error(`${error.message}: ${await queued.count()} queued, box ${JSON.stringify(await composer.inputValue())}, label ${JSON.stringify(await asking(page))}, Send ${await page.locator(".send-btn").getAttribute("title")}, ${await page.locator(".composer-consult-gate").count()} gate lines`);
					});
				};
				await askWhileAnswering();
				assert(await queued.locator(".bubble-asking").innerText() === askingWords(NAME), `the queued bubble names the room: ${await queued.innerText()}`);
				assert((await queued.locator(".bubble").innerText()).includes("what is the deadline?"), `the queued bubble shows the question: ${await queued.innerText()}`);
				const caption = await page.evaluate(`(() => {${contrastHelpers()} return ratio(document.querySelector(".bubble-row.user.queued .bubble-asking")); })()`) as { ratio: number; ground: string };
				assert(caption.ratio >= 4.5, `the queued bubble's room reads at 4.5:1 or more, got ${caption.ratio.toFixed(3)}:1 on ${caption.ground}`);
				await expectNoId(page, "flow, a queued question");

				// Stop hands it back: the label comes back with the question.
				await page.locator(".composer-box .stop-btn").click();
				release();
				await waitUntil(async () => (await queued.count()) === 0 && (await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "what is the deadline?", "Stop hands the question back with its label");
				await expectNoId(page, "flow, a handed-back question");
				await page.locator(".composer-box .stop-btn").waitFor({ state: "detached", timeout: 15000 });
				await page.getByRole("button", { name: `Don't ask ${NAME}` }).click();
				await composer.fill("");

				// Words that only look like an address, typed after Esc, go to this room: queued, they show as
				// written, and Stop hands them back with no label.
				const asWritten = `@${target} is this one ours?`;
				await composer.fill(SLOW);
				await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
				await composer.press("Enter");
				await waitUntil(() => holding, "the room's answer has started");
				await composer.pressSequentially(`@${target}`);
				await page.locator(".mention-row").first().waitFor({ timeout: 5000 });
				await composer.press("Escape");
				await page.locator(".mention-pop").waitFor({ state: "detached", timeout: 5000 });
				await composer.pressSequentially(" is this one ours?");
				assert((await asking(page)) === null && (await composer.inputValue()) === asWritten, `after Esc, the words stay as written: label ${JSON.stringify(await asking(page))}, box ${JSON.stringify(await composer.inputValue())}`);
				await composer.press("Enter");
				await waitUntil(async () => (await queued.count()) === 1 && (await composer.inputValue()) === "", "the words wait as a queued message");
				assert((await queued.locator(".bubble-asking").count()) === 0 && (await queued.locator(".bubble").innerText()).includes(asWritten), `the queued words show as written, asking no room: ${await queued.innerText()}`);
				await page.locator(".composer-box .stop-btn").click();
				release();
				await waitUntil(async () => (await queued.count()) === 0 && (await composer.inputValue()) === asWritten, "Stop hands the words back").catch(async (error) => {
					throw new Error(`${error.message}: ${await queued.count()} queued, box ${JSON.stringify(await composer.inputValue())}, label ${JSON.stringify(await asking(page))}`);
				});
				assert((await asking(page)) === null, `handed back, the words ask no room: label ${JSON.stringify(await asking(page))}`);
				await page.locator(".composer-box .stop-btn").waitFor({ state: "detached", timeout: 15000 });
				await composer.fill("");

				// A room picked while a message to this room fails: the label stays, and the message stays above.
				await composer.fill(QUIET);
				const handedBefore = handedBack;
				await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
				await composer.press("Enter");
				await waitUntil(() => holding, "the quiet answer waits");
				await composer.pressSequentially("@bid ");
				await waitUntil(async () => (await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "", "labelled while the message waits");
				release();
				await page.locator(".composer-box .stop-btn").waitFor({ state: "detached", timeout: 15000 });
				const above = page.locator(".bubble-row.user:not(.queued)").filter({ hasText: QUIET });
				await waitUntil(() => handedBack > handedBefore, "the server hands the failed message back");
				// The page draws what it heard by the next frame.
				await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
				assert((await page.locator(".failure-line").filter({ hasText: failureLineText({ cause: "" }, "above") }).count()) === 1, `the line says the message is still above: label ${JSON.stringify(await asking(page))}, box ${JSON.stringify(await composer.inputValue())}`);
				assert((await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "" && (await above.count()) === 1, `the failed message stays above and the label stays: label ${JSON.stringify(await asking(page))}, box ${JSON.stringify(await composer.inputValue())}, ${await above.count()} above`);
				await page.getByRole("button", { name: `Don't ask ${NAME}` }).click();

				// Edit on a message the box can't take, since the box's message goes elsewhere: the message
				// stays exactly as it was, and the line above the box says what to do. Queued for the answer's
				// end, held, and in the running answer's queue; and the box takes each once it can.
				const editLine = page.locator(".composer-edit-line");
				const useEdit = (bubble: ReturnType<Page["locator"]>) => waitUntil(async () => {
					await bubble.hover();
					return bubble.getByRole("button", { name: "Edit" }).click({ timeout: 1_000 }).then(() => true, () => false);
				}, "Edit on the queued message");
				const where = async () => `box ${JSON.stringify(await composer.inputValue())}, label ${JSON.stringify(await asking(page))}, line ${JSON.stringify(await editLine.allInnerTexts())}, bubbles ${JSON.stringify(await queued.evaluateAll((rows) => rows.map((row) => `${row.textContent}${(row as HTMLElement).dataset.held ? " (held)" : ""}`)))}`;
				const refusedEdit = async (bubble: ReturnType<Page["locator"]>, box: string, label: string | null, when: string) => {
					await useEdit(bubble);
					await waitUntil(async () => (await editLine.count()) === 1, `${when}: the line says what to do`).catch(async (error) => { throw new Error(`${error.message}: ${await where()}`); });
					assert((await editLine.innerText()) === EDIT_NEEDS_BOX && (await composer.inputValue()) === box && (await asking(page)) === label, `${when}: the line's words, and the box as it was: ${await where()}`);
				};
				const consultBubble = queued.filter({ hasText: "what is the deadline?" });
				await composer.fill(SLOW);
				await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
				await composer.press("Enter");
				await waitUntil(() => holding, "the room's answer has started");
				await composer.pressSequentially("@bid what is the deadline?");
				await waitUntil(async () => (await asking(page)) === askingWords(NAME), "edit: labelled while the room answers");
				await composer.press("Enter");
				await waitUntil(async () => (await queued.count()) === 1 && (await composer.inputValue()) === "", "edit: the question waits for the answer's end");
				// Queued: words for this room in the box.
				await composer.fill("plain words");
				await refusedEdit(consultBubble, "plain words", null, "edit, a queued question");
				assert((await consultBubble.getAttribute("data-held")) === null, `edit, a queued question: it stays queued, not held: ${await where()}`);
				// Typing takes the line away.
				await composer.pressSequentially(" here");
				await waitUntil(async () => (await editLine.count()) === 0, `edit: typing takes the line away: ${await where()}`);
				// Held: Esc stops the answer (Stop shows only in an empty box) and hands back what the box
				// can't take as held messages.
				await composer.press("Escape");
				release();
				await page.locator(".composer-box .stop-btn").waitFor({ state: "detached", timeout: 15000 });
				await waitUntil(async () => (await consultBubble.getAttribute("data-held")) === "true", `edit: Stop holds the question: ${await where()}`);
				await refusedEdit(consultBubble, "plain words here", null, "edit, a held question");
				assert((await consultBubble.getAttribute("data-held")) === "true", `edit, a held question: it stays held: ${await where()}`);
				// Cleared, the box takes it, with its label.
				await composer.fill("");
				await useEdit(consultBubble);
				await waitUntil(async () => (await queued.count()) === 0 && (await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "what is the deadline?" && (await editLine.count()) === 0, `edit: the empty box takes the held question: ${await where()}`);
				await page.getByRole("button", { name: `Don't ask ${NAME}` }).click();
				await composer.fill("");
				// In the running answer's queue: a room on the box's label.
				const plainBubble = queued.filter({ hasText: "plain two" });
				await composer.fill(SLOW);
				await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
				await composer.press("Enter");
				await waitUntil(() => holding, "the room's answer has started");
				await composer.fill("plain two");
				await composer.press("Enter");
				await waitUntil(async () => (await plainBubble.getByRole("button", { name: "Edit", includeHidden: true }).count()) === 1, `edit: the answer holds the message: ${await where()}`);
				await composer.pressSequentially("@bid other question");
				await waitUntil(async () => (await asking(page)) === askingWords(NAME), "edit: labelled while the message waits");
				await refusedEdit(plainBubble, "other question", askingWords(NAME), "edit, a message in the answer's queue");
				assert((await queued.count()) === 1 && (await plainBubble.getAttribute("data-held")) === null, `edit, a message in the answer's queue: it stays there: ${await where()}`);
				// The label off, the box takes it out of the answer's queue, above what is typed.
				await page.getByRole("button", { name: `Don't ask ${NAME}` }).click();
				await waitUntil(async () => (await editLine.count()) === 0, `edit: the label off takes the line away: ${await where()}`);
				await useEdit(plainBubble);
				await waitUntil(async () => (await queued.count()) === 0 && (await composer.inputValue()) === "plain two\n\nother question", `edit: the box takes the message: ${await where()}`);
				await composer.fill("");
				await page.locator(".composer-box .stop-btn").click();
				release();
				await page.locator(".composer-box .stop-btn").waitFor({ state: "detached", timeout: 15000 });

				// Queued again, and the answer ends: the question goes to that room. With it queued, the
				// label alone waits for a question: Cmd/Ctrl+Enter sends nothing now.
				await askWhileAnswering();
				await composer.pressSequentially("@bid ");
				await waitUntil(async () => (await asking(page)) === askingWords(NAME) && (await composer.inputValue()) === "", "labelled again, with no question");
				const cutBefore = cut;
				await composer.press("ControlOrMeta+Enter");
				await page.getByRole("button", { name: `Don't ask ${NAME}` }).click();
				release();
				await page.locator(".consult-card").first().waitFor({ timeout: 15000 });
				await waitUntil(async () => (await page.locator(".consult-card").first().innerText()).includes(NAME) && (await queued.count()) === 0, "once the answer ends, the queued question asks the room");
				assert(cut === cutBefore && holding === false, `the label alone sent nothing now: ${cut - cutBefore} answers cut`);
				await expectNoId(page, "flow, the card asked from the queue");

				// Every text the consult card shows from here, as it changes, so a line shown for one frame counts too.
				const watchCard = () => page.evaluate(() => {
					const seen: string[] = [];
					(window as any).cardSaid = seen;
					new MutationObserver(() => { for (const card of document.querySelectorAll(".consult-card")) seen.push(card.textContent ?? ""); }).observe(document.body, { subtree: true, childList: true, characterData: true });
				});
				const cardSaid = async () => page.evaluate(() => ((window as any).cardSaid as string[]).join("\n"));
				await page.locator(".consult-card").getByRole("button", { name: "Dismiss" }).click();
				await page.locator(".consult-card").waitFor({ state: "detached", timeout: 10_000 });
				// Asked from the queue, and the room archived in another window before the answer here ends,
				// this window not told: the card never shows the room's id or the server's words for it, and
				// once the page has read the room list it says "another room" and that the room is gone.
				await composer.fill(SLOW);
				await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
				await composer.press("Enter");
				await waitUntil(() => holding, "the room's answer has started");
				await composer.pressSequentially("@spa what changed?");
				await waitUntil(async () => (await asking(page)) === askingWords("Spare notes"), "spare: the room is on the box");
				await composer.press("Enter");
				await waitUntil(async () => (await queued.count()) === 1, "spare: the question waits for the answer's end");
				await roomGoes(page, spare, "archive", `DELETE ${spare}`, false);
				// The room list held until the card is up, as on a busy server: the card shows before the page knows.
				const roomList = (url: URL) => url.pathname === "/api/persistent-agents";
				let letList = () => {};
				const listHeld = new Promise<void>((resolve) => { letList = resolve; });
				await page.route(roomList, async (route) => {
					if (route.request().method() === "GET") await listHeld;
					await route.continue();
				});
				await watchCard();
				release();
				await page.locator(".consult-card").first().waitFor({ timeout: 15000 });
				const card = page.locator(".consult-card").first();
				await waitUntil(async () => (await card.innerText()).includes("Consult failed."), "spare: before the list is read, the card says the consult failed").catch(async (error) => {
					throw new Error(`${error.message}: ${JSON.stringify(await card.innerText())}`);
				});
				// Let go, the hold passes every later read straight on.
				letList();
				await waitUntil(async () => (await card.innerText()).includes(ROOM_GONE), "spare: the card says the room is gone").catch(async (error) => {
					throw new Error(`${error.message}: ${JSON.stringify(await card.innerText())}`);
				});
				const said = await card.innerText();
				assert(said.includes(ANOTHER_ROOM) && !said.includes("Spare notes"), `spare: the card names another room: ${JSON.stringify(said)}`);
				await expectNoId(page, "spare, the card");
				const spareSaid = await cardSaid();
				assert(!spareSaid.includes(TAIL) && !spareSaid.includes("persistent agent"), `spare: the card never showed the id or the server's words: ${JSON.stringify(spareSaid.split("\n").filter((line) => line.includes(TAIL) || line.includes("persistent agent")))}`);
				// The same while the room list can't be read: the card says the plain failure, never the server's words.
				await card.getByRole("button", { name: "Dismiss" }).click();
				await card.waitFor({ state: "detached", timeout: 10_000 });
				await composer.fill(SLOW);
				await page.locator(".send-btn:enabled").first().waitFor({ timeout: 15000 });
				await composer.press("Enter");
				await waitUntil(() => holding, "the room's answer has started");
				await composer.pressSequentially("@las what changed?");
				await waitUntil(async () => (await asking(page)) === askingWords("Last notes"), "last: the room is on the box");
				await composer.press("Enter");
				await waitUntil(async () => (await queued.count()) === 1, "last: the question waits for the answer's end");
				// The reads held until the card is up, then failed: what the card says after the failed read is what counts.
				let letFail = () => {};
				const failHeld = new Promise<void>((resolve) => { letFail = resolve; });
				await page.route(roomList, async (route) => {
					if (route.request().method() !== "GET") return route.continue();
					await failHeld;
					await route.fulfill({ status: 503, body: "{}" });
				});
				await roomGoes(page, last, "archive", `DELETE ${last}`, false);
				await watchCard();
				release();
				await card.waitFor({ timeout: 15000 });
				await waitUntil(async () => (await card.innerText()).includes("Consult failed."), "last: before the list is read, the card says the consult failed").catch(async (error) => {
					throw new Error(`${error.message}: ${JSON.stringify(await card.innerText())}`);
				});
				const failedRead = page.waitForResponse((response) => roomList(new URL(response.url())) && response.status() === 503, { timeout: 10_000 });
				letFail();
				await failedRead;
				// Two frames: the page has drawn what the failed read left it with.
				await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
				assert((await card.innerText()).includes("Consult failed."), `last: after the list can't be read, the card still says the consult failed: ${JSON.stringify(await card.innerText())}`);
				const lastSaid = await cardSaid();
				assert(!lastSaid.includes(TAIL) && !lastSaid.includes("persistent agent"), `last: the card never showed the id or the server's words: ${JSON.stringify(lastSaid.split("\n").filter((line) => line.includes(TAIL) || line.includes("persistent agent")))}`);
				await page.unrouteAll({ behavior: "ignoreErrors" });
			} finally {
				await ctx.close();
			}
		} finally {
			release();
			await browser.close();
		}
	} catch (error) {
		console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-4000));
		throw error;
	} finally {
		release();
		await stopSmokeServer(server);
		await new Promise<void>((resolve) => gateway.close(() => resolve()));
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

/** Opens a room from Home and waits for its box; signs in first unless `fresh` is false. */
async function enterRoom(page: Page, baseUrl: string, name: string, fresh = true) {
	if (fresh) {
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
	}
	await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: "Enter" }).click();
	const composer = page.locator(".composer textarea").first();
	await composer.waitFor({ timeout: 20_000 });
	return composer;
}

/** The label's words, or null with no room on the box. */
async function asking(page: Page): Promise<string | null> {
	const name = page.locator(".composer-asking-name");
	return (await name.count()) ? name.innerText() : null;
}

/** No room id in what the page shows or names for a reader: its text, the box's words, labels and tooltips. */
async function expectNoId(page: Page, when: string): Promise<void> {
	const seen = await page.evaluate(`(() => [
		document.body.innerText,
		...[...document.querySelectorAll("textarea, input")].map((node) => node.value),
		...[...document.querySelectorAll("[aria-label], [title], [placeholder]")].map((node) => [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("placeholder")].join(" ")),
	].join("\\n"))()`) as string;
	assert(!seen.includes(TAIL), `${when}: no room id shows, but the page says ${JSON.stringify(seen.split("\\n").filter((line) => line.includes(TAIL)))}`);
}

// The page's colours as drawn: a colour over a see-through ground is mixed with what is under it.
// A function, so the checks above can use it: they run before this file's later constants exist.
function contrastHelpers(): string {
	return `
	const parse = (color) => {
		const srgb = /color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?\\)/.exec(color);
		if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
		const parts = color.match(/[\\d.]+/g).map(Number);
		return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
	};
	const over = (top, under) => { const [r, g, b, a] = parse(top); const [R, G, B] = under; return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)]; };
	const ground = (node) => { const chain = []; for (let at = node; at; at = at.parentElement) chain.unshift(getComputedStyle(at).backgroundColor); return chain.reduce((under, color) => over(color, under), [255, 255, 255]); };
	const luminance = (rgb) => { const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
	const ratio = (node) => { const back = ground(node); const fore = over(getComputedStyle(node).color, back); const [hi, lo] = [luminance(fore), luminance(back)].sort((a, b) => b - a); return { ratio: (hi + 0.05) / (lo + 0.05), ground: "rgb(" + back.map(Math.round).join(", ") + ")" }; };
`;
}

/** The label's name and × against the label's ground on the box. */
async function labelLook(page: Page) {
	return page.evaluate(`(() => {${contrastHelpers()}
		const name = ratio(document.querySelector(".composer-asking-name"));
		const off = document.querySelector(".composer-asking-off");
		const box = off.getBoundingClientRect();
		return { name: name.ratio, off: ratio(off).ratio, ground: name.ground, offSize: Math.min(box.width, box.height) };
	})()`) as Promise<{ name: number; off: number; ground: string; offSize: number }>;
}

/** The line above the box against its ground. */
async function lineLook(page: Page, selector = ".composer-ask-hint") {
	return page.evaluate(`(() => {${contrastHelpers()}
		const line = document.querySelector(${JSON.stringify(selector)});
		const box = document.querySelector(".composer-box").getBoundingClientRect();
		const field = document.querySelector(".composer textarea");
		const words = field.getBoundingClientRect().left + parseFloat(getComputedStyle(field).paddingLeft);
		const own = line.getBoundingClientRect();
		const text = document.createRange();
		text.selectNodeContents(line);
		return { ...ratio(line), bottom: own.bottom, boxTop: box.top, left: text.getBoundingClientRect().left, textLeft: words };
	})()`) as Promise<{ ratio: number; ground: string; bottom: number; boxTop: number; left: number; textLeft: number }>;
}
