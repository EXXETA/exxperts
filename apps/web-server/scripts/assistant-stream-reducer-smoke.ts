// Smoke for the web-ui assistant stream reducer (apps/web-ui/src/assistant-stream.ts).
//
// Part 1 — scenario tests: the concrete flows the room chat depends on
// (paced reveal, deferred finalize, provider auto-retry, interrupts, replay
// quarantine, multi-message turns), and the transcript order of a reply that
// calls tools between its paragraphs: the host appends a message's tool chips
// right after it dispatches message_end, so the reducer reserves the item when
// message_end lands ahead of the first paint, or the sentence written before
// the tool would render below it.
//
// Part 2 — event-sequence fuzzer: hundreds of randomized scripts of logical
// assistant messages are compiled into event timelines, then corrupted with
// the observed real-world failure modes (replayed tail fragments after
// finalize, duplicated message_end, mid-stream provider errors with
// auto-retry regeneration, missing message_start boundaries, hidden-tab drain
// ticks, random tick timing). The oracle is the exactly-once invariant: after
// the stream settles, the rendered assistant items are exactly the logical
// answers — each once, none extra, no fragment bubbles.
//
// Part 3, the reveal pace: seeded arrival patterns (a fast, a normal, a
// ChatGPT-like, a slow model, one piece after a tool, a web-search table)
// streamed frame by frame, asserting what a reader sees: never more than
// about a line in a tenth of a second, never far behind the model, the last
// words shortly after it, whole words only and never a lone line marker; and
// that a reconnect replay draws only what was on screen at once.
//
// Run: npm run smokes -- assistant-stream-reducer   (or tsx this file)

import {
	createAssistantStreamState,
	normaliseAssistantText,
	partDrawnAtOnce,
	reduceAssistantStream,
	REVEAL_PACING,
	seenOfOpenAnswer,
	type AssistantStreamAction,
	type AssistantStreamState,
	type RevealPacing,
} from "../../web-ui/src/assistant-stream.js";
import { LONG_WORD, NOTHING_OPEN, visibleCosts } from "../../web-ui/src/reveal-cut.js";

interface HostItem {
	id: string;
	text: string;
	streaming: boolean;
	/** A tool chip the host appended, not an assistant item. */
	tool?: string;
}

/** Minimal mock of the App.tsx host: applies effects, tracks scheduling. */
class Host {
	items: HostItem[] = [];
	state: AssistantStreamState = createAssistantStreamState();
	now = 1_000;
	warnings: string[] = [];
	interrupted: (string | null)[] = [];
	dropped: { id: string; why: string }[] = [];
	tickPending = false;

	constructor(readonly pacing: RevealPacing = REVEAL_PACING) {}

	dispatch(action: AssistantStreamAction): void {
		const { state, effects } = reduceAssistantStream(this.state, action, this.pacing);
		this.state = state;
		for (const effect of effects) {
			if (effect.kind === "upsert") {
				const existing = this.items.find((it) => it.id === effect.id);
				if (existing) {
					existing.text = effect.text;
					existing.streaming = effect.streaming;
				} else {
					this.items.push({ id: effect.id, text: effect.text, streaming: effect.streaming });
				}
			} else if (effect.kind === "schedule_tick") {
				this.tickPending = true;
			} else if (effect.kind === "warn") {
				this.warnings.push(effect.message);
			} else if (effect.kind === "interrupted") {
				this.interrupted.push(effect.id);
			} else if (effect.kind === "drop") {
				this.dropped.push({ id: effect.id, why: effect.why });
				this.items = this.items.filter((it) => it.id !== effect.id);
			}
		}
	}

	messageStart(): void {
		this.dispatch({ type: "message_start", now: this.now });
	}
	delta(text: string): void {
		this.dispatch({ type: "delta", text, now: this.now });
	}
	textEnd(blockText: string): void {
		this.dispatch({ type: "text_end", blockText, now: this.now });
	}
	messageEnd(finalText: string, stopReason?: string): void {
		this.dispatch({ type: "message_end", finalText, stopReason, now: this.now });
	}
	/** message_end followed by the message's tool chips, as the App.tsx host does it. */
	messageEndThenChips(finalText: string, tools: string[]): void {
		this.messageEnd(finalText);
		for (const name of tools) this.items.push({ id: `tool_${this.items.length}`, text: "", streaming: false, tool: name });
	}
	tick(dtMs = 16, mode: "paced" | "drain" = "paced"): void {
		this.now += dtMs;
		this.tickPending = false;
		this.dispatch({ type: "tick", now: this.now, mode });
	}
	advance(ms: number): void {
		this.now += ms;
	}
	/** Run paced ticks until the machine goes quiet. */
	settle(maxTicks = 200_000): void {
		let ticks = 0;
		while (this.tickPending) {
			if (++ticks > maxTicks) throw new Error("stream did not settle (schedule_tick loop)");
			this.tick(16);
		}
	}
	assistantTexts(): string[] {
		return this.items.map((it) => normaliseAssistantText(it.text));
	}
	/** The transcript as it reads: "text:<text>" and "tool:<name>" in order. */
	shape(): string[] {
		return this.items.map((it) => (it.tool ? `tool:${it.tool}` : `text:${it.text}`));
	}
}

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures += 1;
		console.error(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}

function expectTexts(name: string, host: Host, expected: string[]): void {
	const got = host.assistantTexts().slice().sort();
	const want = expected.map(normaliseAssistantText).slice().sort();
	check(name, JSON.stringify(got) === JSON.stringify(want), { got: host.assistantTexts(), want: expected });
}

function expectShape(name: string, host: Host, expected: string[]): void {
	check(name, JSON.stringify(host.shape()) === JSON.stringify(expected), { got: host.shape(), want: expected });
	check(`${name}: nothing left streaming`, host.items.every((it) => !it.streaming));
}

// ---------------------------------------------------------------------------
// Part 1 — scenarios
// ---------------------------------------------------------------------------

console.log("scenarios:");

{
	// Plain stream: deltas reveal paced, message_end reconciles, one item.
	const host = new Host();
	const text = "The quick brown fox jumps over the lazy dog. ".repeat(6).trim();
	host.messageStart();
	for (let i = 0; i < text.length; i += 40) {
		host.delta(text.slice(i, i + 40));
		host.advance(50);
	}
	host.messageEnd(text);
	check("plain: draining after message_end with backlog", host.state.phase === "draining");
	host.settle();
	expectTexts("plain: exactly one item with the final text", host, [text]);
	check("plain: item not marked streaming after settle", host.items.every((it) => !it.streaming));
	check("plain: no warnings", host.warnings.length === 0, host.warnings);
}

{
	// A 400-character paragraph written at a fast model's speed takes about
	// 0.7 s on screen, in many steps: never one frame, and never the old
	// reading band's 3 s or more.
	const host = new Host();
	const text = ("The room keeps what you chose and answers at a calm pace while the model writes. ".repeat(5)).slice(0, 400).trimEnd();
	host.messageStart();
	let sent = 0, frames = 0, maxStep = 0, lastLen = 0;
	const start = host.now;
	while (!(sent >= text.length && host.items[0] && !host.items[0].streaming)) {
		if (sent < text.length) {
			// 12 characters every frame: about 720 a second.
			host.delta(text.slice(sent, sent + 12));
			sent += 12;
			if (sent >= text.length) host.messageEnd(text);
		}
		host.tick(16);
		frames += 1;
		const len = host.items[0]?.text.length ?? 0;
		maxStep = Math.max(maxStep, len - lastLen);
		lastLen = len;
		if (frames > 2_000) break;
	}
	const seconds = (host.now - start) / 1000;
	check("pace: a 400-character paragraph takes about 0.7 s (0.4 to 1.1)", seconds >= 0.4 && seconds <= 1.1, { seconds });
	check("pace: the paragraph never appears in one frame (at most about a word per frame)", maxStep <= LONG_WORD + 10 && maxStep < text.length / 10, { maxStep });
}

{
	// Ep2 class — replayed tail fragment after finalize must not open a bubble.
	const host = new Host();
	const text = "Here is a complete answer about the topic that ends with a distinctive tail segment everyone would notice twice.";
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	host.settle();
	host.advance(200);
	host.delta(text.slice(60)); // orphan replay of the tail — no message_start
	host.settle();
	expectTexts("stray tail: replay dropped, single item", host, [text]);
	check("stray tail: warning emitted", host.warnings.length > 0, host.warnings);
}

{
	// Ep1/Ep3 class — duplicated message_end replay (no boundary) is dropped.
	const host = new Host();
	const text = "A full answer that the server (or a replayed event) delivers twice in quick succession.";
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	host.settle();
	host.advance(300);
	host.messageEnd(text); // replay without message_start
	host.settle();
	expectTexts("dup message_end: rendered once", host, [text]);
}

{
	// Provider auto-retry — the root-cause candidate: mid-stream error with
	// partial content, then full regeneration. One bubble, final text only.
	const host = new Host();
	const full = "The cumulative analysis of your conversation history shows a steady pattern across all sessions we examined together.";
	const partial = full.slice(0, 70);
	host.messageStart();
	host.delta(partial);
	host.messageEnd(partial, "error"); // provider died mid-stream
	host.settle();
	check("retry: partial visible after error", host.assistantTexts().length === 1 && host.assistantTexts()[0] === normaliseAssistantText(partial));
	host.dispatch({ type: "auto_retry_start", now: host.now });
	host.advance(2_000); // backoff
	host.messageStart(); // regeneration
	host.delta(full);
	host.messageEnd(full);
	host.settle();
	expectTexts("retry: regeneration replaces the errored attempt — one item", host, [full]);
}

{
	// Retry after a full-length errored attempt (error at the very end).
	const host = new Host();
	const full = "Sometimes the stream completes its whole text and only the connection teardown fails, so attempt one already shows everything.";
	host.messageStart();
	host.delta(full);
	host.messageEnd(full, "error");
	host.settle();
	host.dispatch({ type: "auto_retry_start", now: host.now });
	host.advance(2_000);
	host.messageStart();
	host.delta(full);
	host.messageEnd(full);
	host.settle();
	expectTexts("retry-full: still exactly one item", host, [full]);
}

{
	// Agent loop: second message starts while the first tail is draining.
	const host = new Host();
	const first = "First answer in a multi-message turn, long enough to still be draining when the next one begins. ".repeat(3).trim();
	const second = "Second, separate answer.";
	host.messageStart();
	host.delta(first);
	host.messageEnd(first);
	host.tick(16); // barely started draining
	host.messageStart();
	host.delta(second);
	host.messageEnd(second);
	host.settle();
	expectTexts("agent loop: two messages, two items, no merge", host, [first, second]);
}

{
	// Legit repetition: identical answers in one turn, both with message_start.
	const host = new Host();
	const text = "Done.";
	for (let i = 0; i < 2; i++) {
		host.messageStart();
		host.delta(text);
		host.messageEnd(text);
		host.settle();
		host.advance(100);
	}
	expectTexts("legit repeat: boundary-opened identical answers both render", host, [text, text]);
}

{
	// Interrupt mid-stream: buffer drains fully into the item, reported for the note.
	const host = new Host();
	const text = "An answer the user interrupts halfway through its reveal.";
	host.messageStart();
	host.delta(text);
	host.tick(16);
	host.dispatch({ type: "interrupt", now: host.now });
	host.settle();
	expectTexts("interrupt: full received text revealed", host, [text]);
	check("interrupt: item reported for annotation", host.interrupted.length === 1 && host.interrupted[0] === host.items[0]?.id);
	check("interrupt: machine idle", host.state.phase === "idle" && host.state.buffer === "");
}

{
	// Interrupt with nothing streaming: host is told to add a system line.
	const host = new Host();
	host.dispatch({ type: "interrupt", now: host.now });
	check("interrupt idle: null id reported", host.interrupted.length === 1 && host.interrupted[0] === null);
	check("interrupt idle: no items", host.items.length === 0);
}

{
	// Hidden tab: drain ticks dump the whole buffer, then finalize.
	const host = new Host();
	const text = "Streaming into a hidden tab should not trickle — the timer drains everything at once.";
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	host.tick(200, "drain");
	check("hidden: fully revealed in one drain tick", host.items[0]?.text === text);
	check("hidden: finalized", host.state.phase === "idle" && !host.tickPending);
}

{
	// Non-streamed answer (no deltas): typewriter reveal, exactly once.
	const host = new Host();
	const text = "Some providers deliver the whole answer only at message_end without any browser-visible deltas.";
	host.messageStart();
	host.messageEnd(text);
	check("typewriter: reveals paced, not dumped", (host.items[0]?.text.length ?? 0) < text.length);
	host.settle();
	expectTexts("typewriter: one item with the full text", host, [text]);
}

{
	// text_end reconciliation when caught up (lost deltas repaired).
	const host = new Host();
	const text = "A block whose deltas partially went missing gets repaired by text_end.";
	host.messageStart();
	host.delta(text.slice(0, 30));
	host.settle();
	host.textEnd(text);
	host.messageEnd(text);
	host.settle();
	expectTexts("text_end: display repaired to full block", host, [text]);
}

{
	// Multi-block message: two text blocks with a tool phase between them.
	const host = new Host();
	const block0 = "Let me check that for you. ";
	const block1 = "The check finished: everything looks consistent.";
	host.messageStart();
	host.delta(block0);
	host.settle();
	host.textEnd(block0);
	host.advance(800); // tool call runs
	host.delta(block1);
	host.messageEnd(block0 + block1);
	host.settle();
	expectTexts("multi-block: one item, blocks joined like the runtime joins them", host, [block0 + block1]);
}

{
	// Reset forgets everything, including retry reservations.
	const host = new Host();
	host.messageStart();
	host.delta("half an ans");
	host.messageEnd("half an ans", "error");
	host.settle();
	host.dispatch({ type: "reset" });
	check("reset: pristine state", host.state.phase === "idle" && host.state.retryReservation === null && host.state.recentFinals.length === 0);
}

{
	// New turn drops a stale retry reservation — a later message must not
	// overwrite the errored bubble from the previous turn.
	const host = new Host();
	const errored = "Attempt that failed for good.";
	host.messageStart();
	host.delta(errored);
	host.messageEnd(errored, "error");
	host.settle();
	host.dispatch({ type: "new_turn", now: host.now });
	const next = "Answer to the next prompt.";
	host.messageStart();
	host.delta(next);
	host.messageEnd(next);
	host.settle();
	expectTexts("new turn: errored bubble kept, next answer separate", host, [errored, next]);
}

{
	// Review finding: a legit orphan stream arriving in tiny chunks must not
	// be shredded by the quarantine (short probes match everything).
	const host = new Host();
	const first = "A prior answer that fills the recent-finals window with plenty of matchable text for tiny probes.";
	host.messageStart();
	host.delta(first);
	host.messageEnd(first);
	host.settle();
	host.advance(500);
	const orphan = "The next answer arrives without its message_start boundary but is genuinely new text.";
	for (let i = 0; i < orphan.length; i += 4) {
		host.delta(orphan.slice(i, i + 4));
		if (i % 12 === 0) host.tick(16);
	}
	host.messageEnd(orphan);
	host.settle();
	expectTexts("tiny orphan chunks: genuine answer renders whole", host, [first, orphan]);
}

{
	// Review finding: a SHORT replayed tail (delta-boundary suffix < probe
	// minimum) must still be quarantined.
	const host = new Host();
	const text = "A finalized answer whose last delta chunk is small: tail end.";
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	host.settle();
	host.advance(300);
	host.delta("tail end."); // replayed final chunk, 9 chars
	host.settle();
	expectTexts("short tail replay: dropped", host, [text]);
}

{
	// Review finding: identical non-streamed answer delivered again inside a
	// legitimate message_start boundary (internal re-prompt echo) dedupes.
	const host = new Host();
	const text = "The synthesized answer that an internal re-prompt makes the model repeat verbatim.";
	host.messageStart();
	host.messageEnd(text);
	host.settle();
	host.advance(15_000);
	host.messageStart();
	host.messageEnd(text);
	host.settle();
	expectTexts("non-streamed echo inside a boundary: rendered once", host, [text]);
	check("non-streamed echo: warned", host.warnings.length > 0, host.warnings);
}

{
	// Review finding: flush (room exit / teardown / server error) must land
	// the full answer instantly — never persist a truncated tail.
	const host = new Host();
	const text = "An answer whose tail is still revealing when the user leaves the room. ".repeat(4).trim();
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	host.tick(16);
	check("flush: still draining before flush", host.state.phase === "draining");
	host.dispatch({ type: "flush", now: host.now });
	expectTexts("flush: full authoritative text landed", host, [text]);
	check("flush: idle afterwards", host.state.phase === "idle", host.state.phase);
	host.tickPending = false; // the real host cancels scheduled ticks on flush
	check("flush: not streaming", host.items.every((it) => !it.streaming));
	host.dispatch({ type: "flush", now: host.now });
	check("flush: idempotent when idle", host.items.length === 1);
}

{
	// Review finding: a bare message_end (lost boundary) while the previous
	// answer drains must not overwrite its authoritative text.
	const host = new Host();
	const first = "First answer, long enough that its paced tail is still draining when the next event lands. ".repeat(3).trim();
	const second = "Second answer that arrived with no message_start at all.";
	host.messageStart();
	host.delta(first);
	host.messageEnd(first);
	host.tick(16); // draining
	host.messageEnd(second); // boundary lost
	host.settle();
	expectTexts("message_end while draining: both answers, no merge", host, [first, second]);
	check("message_end while draining: warned", host.warnings.length > 0, host.warnings);
}

{
	// Review finding: a retry that dies producing nothing must leave the
	// errored partial visible — not a blanked bubble stuck streaming.
	const host = new Host();
	const partial = "The partial answer the user was already reading when the provider died.";
	host.messageStart();
	host.delta(partial);
	host.messageEnd(partial, "error");
	host.settle();
	host.dispatch({ type: "auto_retry_start", now: host.now });
	host.advance(2_000);
	host.messageStart(); // retry begins…
	host.advance(500);
	host.messageEnd("", "error"); // …and dies with zero output
	host.settle();
	expectTexts("dead retry: partial stays visible", host, [partial]);
	check("dead retry: nothing left streaming", host.items.every((it) => !it.streaming));
}

console.log("transcript order:");

const LEAD = "Let me look at the file first.";

{
	// Paced streaming: a frame painted between the delta and message_end (the
	// order that already worked).
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.tick();
	host.messageEndThenChips(LEAD, ["read_file"]);
	host.settle();
	expectShape("paced: text above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Draining: message_end lands before any frame painted the delta.
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.messageEndThenChips(LEAD, ["read_file"]);
	check("draining: item reserved at message_end", host.items[0] !== undefined && !host.items[0].tool && host.items[0].streaming);
	host.settle();
	expectShape("draining: text above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Non-streamed fallback: the whole answer arrives at message_end.
	const host = new Host();
	host.messageStart();
	host.messageEndThenChips(LEAD, ["read_file"]);
	check("fallback: reveal still paced, not dumped", host.items[0] !== undefined && !host.items[0].tool && host.items[0].text.length < LEAD.length);
	host.settle();
	expectShape("fallback: text above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Reattach replay: the catch-up drains on a 0ms timer after the chips landed.
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.messageEndThenChips(LEAD, ["read_file"]);
	host.tick(0, "drain");
	expectShape("reattach drain: text above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Orphan hold: no message_start, a head too short to classify is held
	// unpainted; the authoritative text at message_end decides and reserves.
	const host = new Host();
	host.delta("Let me check.");
	host.tick();
	check("orphan hold: nothing painted while held", host.items.length === 0);
	host.messageEndThenChips("Let me check.", ["read_file"]);
	host.settle();
	expectShape("orphan hold: text above the chip", host, ["text:Let me check.", "tool:read_file"]);
	check("orphan hold: no warnings", host.warnings.length === 0, host.warnings);
}

{
	// Flush right after the reservation (room exit before the first tick).
	const host = new Host();
	host.messageStart();
	host.messageEndThenChips(LEAD, ["read_file"]);
	host.dispatch({ type: "flush", now: host.now });
	expectShape("flush: reserved item finalized in place above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Tool-only message: no text, no bubble, just the chip.
	const host = new Host();
	host.messageStart();
	host.messageEndThenChips("", ["read_file"]);
	host.settle();
	expectShape("tool-only: no empty bubble", host, ["tool:read_file"]);
}

{
	// Three-segment reply, every message_end ahead of its first paint.
	const host = new Host();
	host.messageStart();
	host.delta("First, the plan.");
	host.messageEndThenChips("First, the plan.", ["read_file"]);
	host.messageStart();
	host.delta("The file confirms it; one more check.");
	host.messageEndThenChips("The file confirms it; one more check.", ["bash"]);
	host.messageStart();
	host.delta("Done.");
	host.messageEndThenChips("Done.", []);
	host.settle();
	expectShape("three segments: each text above its own chip", host, [
		"text:First, the plan.",
		"tool:read_file",
		"text:The file confirms it; one more check.",
		"tool:bash",
		"text:Done.",
	]);
	check("three segments: no warnings", host.warnings.length === 0, host.warnings);
}

{
	// Replayed answer without a boundary: the reservation must not bypass the
	// quarantine: the duplicate reserves nothing and is dropped as before.
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.messageEndThenChips(LEAD, []);
	host.settle();
	host.delta(LEAD.slice(10));
	host.messageEndThenChips(LEAD, []);
	host.settle();
	expectShape("replayed orphan: still exactly one item", host, [`text:${LEAD}`]);
	check("replayed orphan: dropped with a warning", host.warnings.length > 0);
}

// A step the provider runs inside one message (its own web search): the lead
// and the answer are blocks of the same message, so the step must split it,
// or the search shows below the answer it led to.
const SEARCH_LEAD = "Let me check the latest release.";
const SEARCH_ANSWER = "Node.js 24 is the active LTS line.";
{
	// The lead painted, the search starts, the answer streams, and message_end brings the whole text.
	const host = new Host();
	host.messageStart();
	host.delta(SEARCH_LEAD);
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "srv_1", text: "", streaming: false, tool: "web_search" });
	host.textEnd(SEARCH_LEAD);
	host.delta(SEARCH_ANSWER);
	host.tick();
	host.textEnd(SEARCH_LEAD + SEARCH_ANSWER);
	host.messageEnd(SEARCH_LEAD + SEARCH_ANSWER);
	host.settle();
	expectShape("search inside a message: lead, search, answer", host, [`text:${SEARCH_LEAD}`, "tool:web_search", `text:${SEARCH_ANSWER}`]);
	check("search inside a message: nothing left streaming, no warnings", host.items.every((it) => !it.streaming) && host.warnings.length === 0, host.warnings);
}

{
	// The lead still waiting to be shown when the search starts: it shows whole, above the search.
	const host = new Host();
	host.messageStart();
	host.delta(SEARCH_LEAD);
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "srv_1", text: "", streaming: false, tool: "web_search" });
	host.delta(SEARCH_ANSWER);
	host.messageEnd(SEARCH_LEAD + SEARCH_ANSWER);
	host.settle();
	expectShape("search before the first paint: lead, search, answer", host, [`text:${SEARCH_LEAD}`, "tool:web_search", `text:${SEARCH_ANSWER}`]);
}

{
	// A search with no lead (the message opens with it): nothing to close, the answer follows it.
	const host = new Host();
	host.messageStart();
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "srv_1", text: "", streaming: false, tool: "web_search" });
	host.delta(SEARCH_ANSWER);
	host.messageEnd(SEARCH_ANSWER);
	host.settle();
	expectShape("search first: search, answer", host, ["tool:web_search", `text:${SEARCH_ANSWER}`]);
}

{
	// Two searches, each after its own lead, and an answer with no text after the last.
	const host = new Host();
	host.messageStart();
	host.delta("First.");
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "srv_1", text: "", streaming: false, tool: "web_search" });
	host.delta("Second.");
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "srv_2", text: "", streaming: false, tool: "web_search" });
	host.messageEnd("First.Second.");
	host.settle();
	expectShape("two searches: each after its own lead, no text repeated", host, ["text:First.", "tool:web_search", "text:Second.", "tool:web_search"]);
}

{
	// A whole text that does not start with the lead (a provider that rewrote it): what was shown stands, never the lead twice.
	const host = new Host();
	host.messageStart();
	host.delta(SEARCH_LEAD);
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "srv_1", text: "", streaming: false, tool: "web_search" });
	host.delta(SEARCH_ANSWER);
	host.tick();
	host.messageEnd(`Rewritten. ${SEARCH_ANSWER}`);
	host.settle();
	expectShape("rewritten whole text: what was shown stands", host, [`text:${SEARCH_LEAD}`, "tool:web_search", `text:${SEARCH_ANSWER}`]);
}

{
	// A message with no search keeps one item, as before.
	const host = new Host();
	host.messageStart();
	host.delta(SEARCH_LEAD + " " + SEARCH_ANSWER);
	host.messageEnd(SEARCH_LEAD + " " + SEARCH_ANSWER);
	host.settle();
	expectShape("no search: one item", host, [`text:${SEARCH_LEAD} ${SEARCH_ANSWER}`]);
}

// A keyed turn (the page sent its message with an id): the server names each
// answer part on the frame that opens it, and decides the echoes. Each row
// runs alone, so a reducer without these actions shows every row that fails.
function keyedRow(name: string, run: () => boolean | string): void {
	let outcome: boolean | string;
	try {
		outcome = run();
	} catch (error) {
		outcome = error instanceof Error ? error.message : String(error);
	}
	check(name, outcome === true, outcome === true ? undefined : outcome);
}
const KEYED_LEAD = "Let me look that up for you before I answer the question.";
const KEYED_ANSWER = "Here is what the search found, in a few clear sentences.";
keyedRow("keyed: the first part takes the id its message_start names", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	return host.items.length === 1 && host.items[0]!.id === "k1-a1" && host.items[0]!.text === KEYED_ANSWER || JSON.stringify(host.items);
});
keyedRow("keyed: a part after a step takes the id its text_start names", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_LEAD);
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "k1-t1", text: "", streaming: false, tool: "web_search" });
	host.dispatch({ type: "part_id", itemId: "k1-a2" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(`${KEYED_LEAD}${KEYED_ANSWER}`);
	host.settle();
	return JSON.stringify(host.items.map((it) => it.id)) === JSON.stringify(["k1-a1", "k1-t1", "k1-a2"]) && host.items[2]!.text === KEYED_ANSWER || JSON.stringify(host.items);
});
keyedRow("keyed: a part the server named only once is never reused for the next part", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_LEAD);
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	// No text_start id came (a step the server does not break at): the page makes its own id rather than repeat one.
	host.delta(KEYED_ANSWER);
	host.messageEnd(`${KEYED_LEAD}${KEYED_ANSWER}`);
	host.settle();
	const ids = host.items.map((it) => it.id);
	return ids.length === 2 && ids[0] === "k1-a1" && ids[1]!.startsWith("stream_") || JSON.stringify(ids);
});
keyedRow("keyed: a retry streams into its reserved bubble, which carries the server's id", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta("A partial answer that the provider cut");
	host.tick();
	host.messageEnd("A partial answer that the provider cut", "error");
	host.dispatch({ type: "auto_retry_start", now: host.now });
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	return host.items.length === 1 && host.items[0]!.id === "k1-a1" && host.items[0]!.text === KEYED_ANSWER || JSON.stringify(host.items);
});
keyedRow("keyed: a retry after an attempt a step split writes under the server's first id, and the attempt's later part goes", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_LEAD);
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	host.items.push({ id: "k1-t1", text: "", streaming: false, tool: "web_search" });
	host.dispatch({ type: "part_id", itemId: "k1-a2" });
	host.delta("A partial answer that the provider cut");
	host.tick();
	host.messageEnd(`${KEYED_LEAD}A partial answer that the provider cut`, "error");
	const beforeRetry = host.items.map((it) => it.id).join(",");
	host.dispatch({ type: "auto_retry_start", now: host.now });
	// The server keeps no part of the attempt and names the retry from the attempt's first part.
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	const atStart = host.items.map((it) => it.id).join(",");
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	const ids = host.items.map((it) => it.id).join(",");
	const answer = host.items.find((it) => it.id === "k1-a1")?.text;
	if (beforeRetry !== "k1-a1,k1-t1,k1-a2" || atStart !== beforeRetry) return `before the retry's first words: ${beforeRetry} / ${atStart}`;
	// The retry may write under k1-a2 again, so the page must not name it as removed.
	if (JSON.stringify(host.dropped) !== JSON.stringify([{ id: "k1-a2", why: "retried" }])) return `dropped ${JSON.stringify(host.dropped)}`;
	return (ids === "k1-a1,k1-t1" && answer === KEYED_ANSWER) || JSON.stringify(host.items);
});
keyedRow("keyed: a retry that comes whole in a text_end as an echo of an earlier part goes off the list, its reserved bubble too", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a2" });
	host.delta("A partial answer that the provider cut");
	host.tick();
	host.messageEnd("A partial answer that the provider cut", "error");
	host.dispatch({ type: "auto_retry_start", now: host.now });
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a2" });
	host.textEnd(KEYED_ANSWER);
	host.tick();
	host.dispatch({ type: "message_end", finalText: KEYED_ANSWER, now: host.now, echoOf: "k1-a1" });
	host.settle();
	const kept = JSON.stringify(host.items.map((it) => [it.id, it.text])) === JSON.stringify([["k1-a1", KEYED_ANSWER]]);
	return (kept && JSON.stringify(host.dropped) === JSON.stringify([{ id: "k1-a2", why: "echo" }])) || JSON.stringify({ items: host.items, dropped: host.dropped });
});
keyedRow("old-style: a retry after a split attempt still streams into the attempt's open bubble, and its first part stays", () => {
	const host = new Host();
	host.messageStart();
	host.delta(KEYED_LEAD);
	host.tick();
	host.dispatch({ type: "break", now: host.now });
	host.delta("A partial answer that the provider cut");
	host.tick();
	host.messageEnd(`${KEYED_LEAD}A partial answer that the provider cut`, "error");
	const before = host.items.map((it) => it.id);
	host.dispatch({ type: "auto_retry_start", now: host.now });
	host.messageStart();
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	return (host.items.length === 2 && host.items[0]!.id === before[0] && host.items[1]!.id === before[1] && host.items[1]!.text === KEYED_ANSWER) || JSON.stringify(host.items);
});
keyedRow("keyed: an echo that came whole in a text_end, with no deltas, goes off the list", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a2" });
	host.textEnd(KEYED_ANSWER);
	host.tick();
	host.dispatch({ type: "message_end", finalText: KEYED_ANSWER, now: host.now, echoOf: "k1-a1" });
	host.settle();
	return JSON.stringify(host.items.map((it) => [it.id, it.text])) === JSON.stringify([["k1-a1", KEYED_ANSWER]]) || JSON.stringify(host.items);
});
keyedRow("keyed: a message_end the server marks as an echo is dropped", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a2" });
	host.dispatch({ type: "message_end", finalText: KEYED_ANSWER, now: host.now, echoOf: "k1-a1" });
	host.settle();
	return JSON.stringify(host.items.map((it) => it.id)) === JSON.stringify(["k1-a1"]) || JSON.stringify(host.items);
});
keyedRow("keyed: a message_end with the same words and no echoOf is never dropped by the page's echo test", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a2" });
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	return JSON.stringify(host.items.map((it) => it.id)) === JSON.stringify(["k1-a1", "k1-a2"]) || JSON.stringify(host.items);
});
keyedRow("old-style: the same words with no ids are still dropped as a duplicate delivery", () => {
	const host = new Host();
	host.messageStart();
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	host.messageStart();
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	return host.items.length === 1 || JSON.stringify(host.items);
});
keyedRow("keyed: Stop right after the message ended returns that part, until the next turn", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_ANSWER);
	host.messageEnd(KEYED_ANSWER);
	host.settle();
	host.dispatch({ type: "interrupt", now: host.now });
	const afterEnd = host.interrupted.at(-1);
	host.dispatch({ type: "new_turn", now: host.now });
	host.dispatch({ type: "interrupt", now: host.now });
	const nextTurn = host.interrupted.at(-1);
	return (afterEnd === "k1-a1" && nextTurn === null) || JSON.stringify({ afterEnd, nextTurn });
});
keyedRow("keyed: Stop while a part is open returns the open part, not an ended one", () => {
	const host = new Host();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a1" });
	host.delta(KEYED_LEAD);
	host.messageEnd(KEYED_LEAD);
	host.settle();
	host.dispatch({ type: "message_start", now: host.now, itemId: "k1-a2" });
	host.delta(KEYED_ANSWER);
	host.tick();
	host.dispatch({ type: "interrupt", now: host.now });
	return host.interrupted.at(-1) === "k1-a2" || JSON.stringify(host.interrupted);
});

// ---------------------------------------------------------------------------
// Part 2 — fuzzer
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = "stream reducer answer invariant paced reveal retry provider message boundary quarantine fragment finalize backlog carry frame token model room memory".split(" ");

function makeText(rng: () => number, seed: number, msg: number): string {
	const words: string[] = [`u${seed}m${msg}`]; // unique head so texts never collide across messages
	const count = 8 + Math.floor(rng() * 180);
	for (let i = 0; i < count; i++) words.push(WORDS[Math.floor(rng() * WORDS.length)]);
	return words.join(" ") + ".";
}

function maybeTicks(host: Host, rng: () => number): void {
	const n = Math.floor(rng() * 3);
	for (let i = 0; i < n; i++) {
		if (!host.tickPending) break;
		if (rng() < 0.05) host.tick(200, "drain");
		else host.tick(8 + Math.floor(rng() * 42));
	}
}

function streamDeltas(host: Host, rng: () => number, text: string): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		const size = 1 + Math.floor(rng() * 199);
		chunks.push(text.slice(i, i + size));
		i += size;
	}
	for (const chunk of chunks) {
		host.delta(chunk);
		host.advance(Math.floor(rng() * 120));
		maybeTicks(host, rng);
	}
	return chunks;
}

console.log("fuzzer:");
let fuzzWarnings = 0;
const SEEDS = 600;
for (let seed = 0; seed < SEEDS; seed++) {
	const rng = mulberry32(seed * 2_654_435_761 + 1);
	const host = new Host();
	const expected: string[] = [];
	const messageCount = 1 + Math.floor(rng() * 4);

	for (let m = 0; m < messageCount; m++) {
		const text = makeText(rng, seed, m);
		const dropStart = rng() < 0.15; // lost boundary: orphan but legitimate
		const retry = !dropStart && rng() < 0.2; // provider dies mid-stream, regenerates

		if (retry) {
			const cut = Math.max(1, Math.floor(text.length * rng()));
			host.messageStart();
			streamDeltas(host, rng, text.slice(0, cut));
			host.messageEnd(text.slice(0, cut), "error");
			maybeTicks(host, rng);
			host.dispatch({ type: "auto_retry_start", now: host.now });
			host.advance(500 + Math.floor(rng() * 3_000));
			host.messageStart();
			streamDeltas(host, rng, text);
			host.messageEnd(text);
		} else {
			if (!dropStart) host.messageStart();
			const chunks = streamDeltas(host, rng, text);
			if (rng() < 0.3) host.textEnd(text);
			host.messageEnd(text);
			maybeTicks(host, rng);

			// Corruptions after the message finalizes:
			if (rng() < 0.35 && chunks.length > 1) {
				// replay a delta-aligned tail fragment (the Ep2 signature)
				host.advance(Math.floor(rng() * 2_000));
				const from = 1 + Math.floor(rng() * (chunks.length - 1));
				for (const chunk of chunks.slice(from)) {
					host.delta(chunk);
					maybeTicks(host, rng);
				}
			}
			if (rng() < 0.25) {
				// duplicate the message_end wholesale
				host.advance(Math.floor(rng() * 2_000));
				host.messageEnd(text);
				maybeTicks(host, rng);
			}
			if (rng() < 0.15) {
				// duplicate a text_end after the fact
				host.textEnd(text);
			}
		}
		expected.push(text);
		// Usually settle; sometimes let the tail keep draining into the next
		// message so boundary-crossing paths (hard-finalize on message_start,
		// delta/message_end while draining) get fuzzed too.
		if (rng() < 0.8) host.settle();
		host.advance(Math.floor(rng() * 1_500));
	}

	if (rng() < 0.2) host.dispatch({ type: "flush", now: host.now });
	host.settle();
	const got = host.assistantTexts().slice().sort();
	const want = expected.map(normaliseAssistantText).slice().sort();
	fuzzWarnings += host.warnings.length;
	if (JSON.stringify(got) !== JSON.stringify(want)) {
		failures += 1;
		console.error(`FAIL  fuzz seed ${seed}: rendered items diverge from logical answers`);
		console.error(`      want ${want.length} items, got ${got.length}`);
		for (const t of got) if (!want.includes(t)) console.error(`      extra: ${t.slice(0, 120)}`);
		for (const t of want) if (!got.includes(t)) console.error(`      missing: ${t.slice(0, 120)}`);
		break;
	}
	if (host.items.some((it) => it.streaming)) {
		failures += 1;
		console.error(`FAIL  fuzz seed ${seed}: item left in streaming state after settle`);
		break;
	}
}
if (failures === 0) {
	console.log(`  ok  ${SEEDS} randomized scripts: every logical answer rendered exactly once (${fuzzWarnings} corruptions quarantined with warnings)`);
}

// ---------------------------------------------------------------------------
// Part 3: the reveal pace
// ---------------------------------------------------------------------------

console.log("pace:");

function seeded(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const between = (r: () => number, low: number, high: number) => low + (high - low) * r();

const PACE_WORDS = "the room keeps what you chose and answers at a calm pace while the model writes each new line appears in order so the person can read along without waiting memory decides what is in every chat settings files folder conversation remember review approval budget gateway provider".split(" ");
/** A Markdown answer of about `size` characters: paragraphs, lists, headings, a table, code, bold, inline code and links. */
function answerOf(size: number, r: () => number): string {
	const word = () => PACE_WORDS[Math.floor(r() * PACE_WORDS.length)];
	const sentence = () => {
		const out: string[] = [];
		for (let i = 0, n = 8 + Math.floor(r() * 14); i < n; i++) {
			const p = r();
			out.push(p < 0.03 ? `**${word()} ${word()}**` : p < 0.05 ? "`" + word() + "_id`" : p < 0.06 ? `[${word()}](https://example.com/docs/${word()}/reference-guide)` : word());
		}
		const s = out.join(" ");
		return s[0].toUpperCase() + s.slice(1) + ".";
	};
	const blocks = [
		() => Array.from({ length: 2 + Math.floor(r() * 4) }, sentence).join(" "),
		() => Array.from({ length: 3 + Math.floor(r() * 3) }, () => "- " + sentence()).join("\n"),
		() => "## " + word() + " " + word(),
		() => "| Option | What it does | Cost |\n|---|---|---|\n" + Array.from({ length: 4 }, () => `| ${word()} | ${sentence()} | ${Math.floor(r() * 90)} |`).join("\n"),
		() => "```ts\n" + Array.from({ length: 6 }, (_, i) => `const value${i} = compute(${i}, "${word()}");`).join("\n") + "\n```",
	];
	let out = "";
	while (out.length < size) {
		const p = r();
		out += blocks[p < 0.55 ? 0 : p < 0.7 ? 1 : p < 0.8 ? 2 : p < 0.9 ? 3 : 4]() + "\n\n";
	}
	return out.slice(0, size).trimEnd();
}

type Delivery = { t: number; end: number };
/** Pieces cut at token-like ends, a model speed that drifts, and stalls that hold pieces back. */
function streamedPieces(text: string, r: () => number, o: { cps: number; gapLow: number; gapHigh: number; stallP?: number; stallLow?: number; stallHigh?: number; drift?: number }): Delivery[] {
	const ends: number[] = [];
	const token = /\s*[A-Za-z]{1,6}|\s*\d{1,3}|\s*[^\sA-Za-z\d]|\s+/g;
	for (let m; (m = token.exec(text)); ) ends.push(m.index + m[0].length);
	const out: Delivery[] = [{ t: 0, end: ends[0] }];
	const drift = o.drift ?? 0.2;
	let t = 0, produced = ends[0], generated = ends[0], speed = o.cps, k = 0;
	while (produced < text.length) {
		let gap = between(r, o.gapLow, o.gapHigh);
		if (r() < (o.stallP ?? 0)) gap += between(r, o.stallLow ?? 0, o.stallHigh ?? 0);
		speed = Math.max(o.cps * (1 - drift), Math.min(o.cps * (1 + drift), speed + between(r, -0.1, 0.1) * o.cps));
		t += gap;
		generated += (speed * gap) / 1000;
		while (k < ends.length && ends[k] <= generated) k++;
		const end = Math.min(text.length, ends[Math.max(0, k - 1)] ?? text.length);
		if (end > produced) out.push({ t, end: (produced = end) });
		if (k >= ends.length) break;
	}
	if (out[out.length - 1].end < text.length) out.push({ t: t + 20, end: text.length });
	return out;
}

const FRAME = 1000 / 60;
interface PaceRun { maxVisible100: number; lagP95: number; tail: number; shown: string[]; receivedThen: number[] }
/** Streams `deliveries` of `text` into a fresh host, one paced tick per frame, as the page does. */
function runPace(pacing: RevealPacing, text: string, deliveries: Delivery[]): PaceRun {
	const host = new Host(pacing);
	const costs = visibleCosts("", NOTHING_OPEN, text);
	const visibleBefore = new Float64Array(text.length + 1);
	for (let i = 0; i < text.length; i++) visibleBefore[i + 1] = visibleBefore[i] + costs[i];
	const arrivedAt = new Float64Array(text.length);
	const doneAt = deliveries[deliveries.length - 1].t;
	const reveals: [number, number][] = [];
	const lags: number[] = [];
	const shown: string[] = [];
	const receivedThen: number[] = [];
	let received = 0, di = 0, textDoneAt = -1, last = 0;
	host.now = 0;
	host.messageStart();
	for (let t = 0; t < 600_000; t += FRAME) {
		host.now = t;
		while (di < deliveries.length && deliveries[di].t <= t) {
			const d = deliveries[di++];
			for (let i = received; i < d.end; i++) arrivedAt[i] = d.t;
			host.delta(text.slice(received, d.end));
			received = d.end;
			if (di === deliveries.length) host.messageEnd(text);
		}
		if (host.tickPending) {
			host.tickPending = false;
			host.dispatch({ type: "tick", now: t, mode: "paced" });
		}
		const now = host.items[0]?.text ?? "";
		if (now.length !== last) {
			reveals.push([t, visibleBefore[Math.min(now.length, text.length)] - visibleBefore[Math.min(last, text.length)]]);
			if (host.items[0]?.streaming) {
				shown.push(now);
				receivedThen.push(received);
			}
			last = now.length;
		}
		if (di < deliveries.length) lags.push(last < received ? (t - arrivedAt[last]) / 1000 : 0);
		if (di >= deliveries.length && host.items[0] && !host.items[0].streaming) { textDoneAt = t; break; }
	}
	let maxVisible100 = 0;
	for (let i = 0, j = 0, sum = 0; i < reveals.length; i++) {
		sum += reveals[i][1];
		while (reveals[j][0] <= reveals[i][0] - 100) sum -= reveals[j++][1];
		maxVisible100 = Math.max(maxVisible100, sum);
	}
	const sorted = [...lags].sort((a, b) => a - b);
	return { maxVisible100, lagP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, tail: (textDoneAt - doneAt) / 1000, shown, receivedThen };
}

const runOf = (size: number, seed: number, profile: Parameters<typeof streamedPieces>[2] | "one piece") => {
	const r = seeded(seed);
	const text = answerOf(size, r);
	return { text, deliveries: profile === "one piece" ? [{ t: 0, end: text.length }] : streamedPieces(text, r, profile) };
};
const PATTERNS = {
	"fast, 8,000": () => runOf(8000, 12, { cps: 600, gapLow: 30, gapHigh: 120, stallP: 0.03, stallLow: 300, stallHigh: 600 }),
	"normal, 4,000": () => runOf(4000, 14, { cps: 240, gapLow: 20, gapHigh: 90, stallP: 0.02, stallLow: 200, stallHigh: 400 }),
	"ChatGPT-like, 2,500": () => runOf(2500, 15, { cps: 280, gapLow: 100, gapHigh: 400, stallP: 0.03, stallLow: 300, stallHigh: 600 }),
	"slow, 1,200": () => runOf(1200, 16, { cps: 80, gapLow: 30, gapHigh: 80, stallP: 0.03, stallLow: 400, stallHigh: 900 }),
	"one piece after a tool, 3,000": () => runOf(3000, 17, "one piece"),
	"web-search table, 2,800 in 2.2 s": () => runOf(2800, 18, { cps: 1270, gapLow: 5, gapHigh: 15, drift: 0.05 }),
};
const BURSTS = new Set(["one piece after a tool, 3,000", "web-search table, 2,800 in 2.2 s"]);
const LINE_MARKER_ALONE = /(?:^|\n)[ \t]*(?:[-*+]|#{1,6}|\d{1,9}[.)]|>)[ \t]*$/;

/** The first cut inside a word, or null. A word still being written may show after waiting 250 ms: then the cut is at the end of what had arrived. */
function wholeWords(text: string, run: PaceRun): string | null {
	for (const [n, s] of run.shown.entries()) {
		const i = s.length;
		if (i >= text.length || i === run.receivedThen[n] || /\s/.test(text[i - 1]) || /\s/.test(text[i])) continue;
		const start = text.slice(0, i).search(/\S+$/);
		const end = i + (text.slice(i).match(/^\S+/)?.[0].length ?? 0);
		if (end - start > LONG_WORD) continue;
		return JSON.stringify(text.slice(Math.max(0, i - 20), i)) + " | " + JSON.stringify(text.slice(i, i + 10));
	}
	return null;
}

for (const [pattern, make] of Object.entries(PATTERNS)) {
	const { text, deliveries } = make();
	const run = runPace(REVEAL_PACING, text, deliveries);
	const burst = BURSTS.has(pattern);
	const ceiling = burst ? REVEAL_PACING.catchUpCapCharsPerSec : REVEAL_PACING.capCharsPerSec;
	// Over 100 ms: the ceiling's tenth, plus one word arriving whole and the frame's rounding.
	const most = Math.round(ceiling * 0.1 + LONG_WORD + 5);
	check(`pace, ${pattern}: at most ${most} visible chars in any 100 ms`, run.maxVisible100 <= most, { most: run.maxVisible100 });
	if (!burst) check(`pace, ${pattern}: lag p95 ≤ 1.3 s`, run.lagP95 <= 1.3, { lagP95: run.lagP95 });
	const tailLimit = pattern.startsWith("one piece") ? 6 : burst ? 3.2 : 1.5;
	check(`pace, ${pattern}: last words within ${tailLimit} s of the model`, run.tail <= tailLimit, { tail: run.tail });
	const split = wholeWords(text, run);
	check(`pace, ${pattern}: every cut on a whole word`, split === null, split);
	const marker = run.shown.find((s) => LINE_MARKER_ALONE.test(s));
	check(`pace, ${pattern}: never a lone line marker`, marker === undefined, marker?.slice(-40));
}

{
	// No dump at the end: once the model is done, a paced tick never shows more than the catch-up ceiling's share of its frame (plus a word).
	const host = new Host(REVEAL_PACING);
	const text = answerOf(3000, seeded(21));
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	let most = 0, last = 0;
	const costs = visibleCosts("", NOTHING_OPEN, text);
	while (host.tickPending) {
		host.tick(FRAME);
		const len = host.items[0]?.text.length ?? 0;
		let visible = 0;
		for (let i = last; i < Math.min(len, text.length); i++) visible += costs[i];
		most = Math.max(most, visible);
		last = len;
	}
	check("pace: after the model is done, no frame shows more than the ceiling's share plus a word", most <= (REVEAL_PACING.catchUpCapCharsPerSec * 0.25) + LONG_WORD + 4, { most });
}

{
	// A link written as code shows every character, its address too: it costs what it shows.
	const host = new Host(REVEAL_PACING);
	const address = `https://example.com/${"segment/".repeat(50)}end`;
	const text = `Write it like this: \`[name](${address})\` and the page shows it as code.`;
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	let most = 0, last = 0;
	while (host.tickPending) {
		host.tick(FRAME);
		const len = host.items[0]?.text.length ?? 0;
		most = Math.max(most, len - last);
		last = len;
	}
	check("pace: a link inside inline code is paced like the code it is", most <= (REVEAL_PACING.catchUpCapCharsPerSec * 0.25) + LONG_WORD + 4, { most, address: address.length });
}

{
	// Inline code may go on over a line break: the link on its second line is still code.
	const host = new Host(REVEAL_PACING);
	const address = `https://example.com/${"segment/".repeat(50)}end`;
	const text = `Write it like this: \`a link such as\n[name](${address})\` and the page shows it as code.`;
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	let most = 0, last = 0;
	while (host.tickPending) {
		host.tick(FRAME);
		const len = host.items[0]?.text.length ?? 0;
		most = Math.max(most, len - last);
		last = len;
	}
	check("pace: a link on a later line of inline code is paced like the code it is", most <= (REVEAL_PACING.catchUpCapCharsPerSec * 0.25) + LONG_WORD + 4, { most, address: address.length });
}

{
	// Words of languages written without spaces, and emoji, are never cut apart.
	const host = new Host(REVEAL_PACING);
	const text = "这是一个用于测试的句子，我们希望每次只显示完整的词语。日本語の文章も同じように表示されます。👩‍👩‍👧‍👦 家族の絵文字は分割されません。";
	host.messageStart();
	const seen: string[] = [];
	for (let i = 0; i < text.length; i += 3) {
		host.delta(text.slice(i, i + 3));
		host.tick(FRAME);
		if (host.items[0]) seen.push(host.items[0].text);
	}
	host.messageEnd(text);
	host.settle();
	const brokenEmoji = seen.find((s) => /‍$|[\ud800-\udbff]$/.test(s) || (s.includes("👩") && !s.includes("👩‍👩‍👧‍👦")));
	check("pace: an emoji family never shows in parts", brokenEmoji === undefined, brokenEmoji);
	check("pace: unspaced text appears in words, not one character at a time", seen.length > 3 && new Set(seen).size < text.length / 2, { steps: new Set(seen).size });
	expectTexts("pace: unspaced text ends whole", host, [text]);
}

{
	// Link addresses cost no reveal time: an answer full of links is not slower on screen than plain prose of the same visible length.
	const plain = "word ".repeat(400).trim();
	const linked = Array.from({ length: 200 }, (_, i) => `[word word](https://example.com/a/very/long/address/that/takes/no/time/${i})`).join(" ");
	const timeOf = (text: string) => {
		const host = new Host(REVEAL_PACING);
		host.messageStart();
		host.delta(text);
		host.messageEnd(text);
		let ticks = 0;
		while (host.tickPending) { host.tick(FRAME); ticks++; }
		return ticks;
	};
	const plainTicks = timeOf(plain), linkedTicks = timeOf(linked);
	check("pace: link addresses are free (links take no longer than the same words)", linkedTicks <= plainTicks * 1.15, { plainTicks, linkedTicks });
}

{
	// A short drop while watching: the replay draws what was on screen at once and paces the rest.
	const host = new Host(REVEAL_PACING);
	const text = answerOf(3000, seeded(22));
	host.messageStart();
	host.delta(text.slice(0, 1200));
	for (let i = 0; i < 60; i++) host.tick(FRAME);
	const seen = seenOfOpenAnswer(host.state);
	check("drop: the open answer's shown part is known", seen !== null && seen.chars > 0 && seen.chars < 1200, seen);
	// A reconnect that gives up ends the answer: what was received but not yet shown goes on screen.
	const gaveUp = new Host(REVEAL_PACING);
	gaveUp.messageStart();
	gaveUp.delta(text.slice(0, 1200));
	for (let i = 0; i < 60; i++) gaveUp.tick(FRAME);
	gaveUp.dispatch({ type: "interrupt", now: gaveUp.now });
	expectTexts("drop: a reconnect that gives up shows everything received", gaveUp, [text.slice(0, 1200)]);
	// The reattach: forget, then the replay of the whole turn so far, drained.
	const replay = new Host(REVEAL_PACING);
	replay.now = host.now + 2000;
	replay.dispatch({ type: "reset" });
	replay.dispatch({ type: "replay_seen", seen: seen! });
	replay.messageStart();
	replay.delta(text.slice(0, 2400));
	replay.tick(0, "drain");
	check("drop: the replay draws exactly what was on screen at once", replay.items[0]?.text.length === seen!.chars, { drawn: replay.items[0]?.text.length, seen: seen!.chars });
	replay.tick(0, "drain");
	check("drop: further replay ticks draw nothing more", replay.items[0]?.text.length === seen!.chars);
	replay.dispatch({ type: "replay_seen", seen: null });
	check("drop: the replay's end hands the rest to the pace", replay.tickPending);
	replay.tick(FRAME);
	const step = (replay.items[0]?.text.length ?? 0) - seen!.chars;
	check("drop: the missed text comes at the pace, not at once", step > 0 && step < 60, { step });
	replay.delta(text.slice(2400));
	replay.messageEnd(text);
	replay.settle();
	expectTexts("drop: the answer ends whole and once", replay, [text]);
	// Coming back to the room (no drop seen): everything replayed is drawn at once, as before.
	const back = new Host(REVEAL_PACING);
	back.dispatch({ type: "reset" });
	back.messageStart();
	back.delta(text.slice(0, 2400));
	back.tick(0, "drain");
	check("back in the room: the replay is drawn at once", back.items[0]?.text.length === 2400);
}

/** The most characters any one paced frame adds to the answer's first item, read frame by frame until it settles. */
function largestFrameStep(text: string): number {
	const host = new Host(REVEAL_PACING);
	host.messageStart();
	host.delta(text);
	host.messageEnd(text);
	let most = 0, last = 0;
	while (host.tickPending) {
		host.tick(FRAME);
		const len = host.items[0]?.text.length ?? 0;
		most = Math.max(most, len - last);
		last = len;
	}
	return most;
}

{
	// A short drop before the first words, or while a step runs between two parts of the reply: the replay draws
	// only what was on screen at once, as the page saw it, and paces what was written while it was away.
	const lead = "Let me look that up first.";
	const away = answerOf(1500, seeded(31));
	/** The page as App.tsx runs it: the live turn up to the drop, then the reattach's replay of the whole turn. */
	const blipReplay = (live: (host: Host) => void, replayed: (host: Host) => void) => {
		const host = new Host(REVEAL_PACING);
		host.dispatch({ type: "new_turn", now: host.now });
		live(host);
		const seen = seenOfOpenAnswer(host.state);
		const replay = new Host(REVEAL_PACING);
		replay.now = host.now + 2000;
		replay.dispatch({ type: "reset" });
		if (seen) replay.dispatch({ type: "replay_seen", seen });
		replayed(replay);
		replay.tick(0, "drain");
		const answers = () => replay.items.filter((it) => !it.tool).map((it) => it.text);
		const drawn = answers();
		replay.dispatch({ type: "replay_seen", seen: null });
		// A tenth of a second at the pace, which starts slow on a part with nothing shown.
		for (let i = 0; i < 6; i++) replay.tick(FRAME);
		const firstStep = answers().join("").length - drawn.join("").length;
		replay.messageEnd(replay.state.shownBefore ? lead + away : away);
		replay.settle();
		return { drawn, firstStep, texts: answers().map(normaliseAssistantText) };
	};
	{
		const { drawn, firstStep, texts } = blipReplay((host) => {
			host.messageStart();
			host.tick(FRAME);
		}, (host) => {
			host.messageStart();
			host.delta(away);
		});
		check("drop before the first words: the replay draws nothing at once", drawn.every((text) => text === ""), { drawn: drawn.map((text) => text.length) });
		check("drop before the first words: what was written away comes at the pace", firstStep > 0 && firstStep < 120, { firstStep });
		check("drop before the first words: the answer ends whole and once", JSON.stringify(texts) === JSON.stringify([away].map(normaliseAssistantText)), texts);
	}
	{
		const { drawn, firstStep, texts } = blipReplay((host) => {
			host.messageStart();
			host.delta(lead);
			host.settle();
			host.messageEndThenChips(lead, ["read"]);
			host.settle();
		}, (host) => {
			host.messageStart();
			host.delta(lead);
			host.messageEndThenChips(lead, ["read"]);
			host.tick(0, "drain");
			host.messageStart();
			host.delta(away);
		});
		check("drop between two messages around a step: the replay draws only the first message at once", JSON.stringify(drawn) === JSON.stringify([lead]), { drawn: drawn.map((text) => text.length) });
		check("drop between two messages around a step: the next message comes at the pace", firstStep > 0 && firstStep < 120, { firstStep });
		check("drop between two messages around a step: each message ends whole and once", JSON.stringify(texts) === JSON.stringify([lead, away].map(normaliseAssistantText)), texts);
	}
	{
		const { drawn, firstStep, texts } = blipReplay((host) => {
			host.messageStart();
			host.delta(lead);
			host.settle();
			host.dispatch({ type: "break", now: host.now });
		}, (host) => {
			host.messageStart();
			host.delta(lead);
			host.dispatch({ type: "break", now: host.now });
			host.items.push({ id: "srv_1", text: "", streaming: false, tool: "web_search" });
			host.delta(away);
		});
		check("drop during a step inside one message: the replay draws only the words before the step at once", JSON.stringify(drawn) === JSON.stringify([lead]), { drawn: drawn.map((text) => text.length) });
		check("drop during a step inside one message: the words after it come at the pace", firstStep > 0 && firstStep < 120, { firstStep });
		check("drop during a step inside one message: both parts end whole and once", JSON.stringify(texts) === JSON.stringify([lead, away].map(normaliseAssistantText)), texts);
	}
}

{
	// A drop before a message's first words, and the message ends while away (a step follows it): the replay draws
	// none of it at once, and the part it reserves is no answer the replay drew.
	const away = answerOf(1500, seeded(32));
	const host = new Host(REVEAL_PACING);
	host.dispatch({ type: "new_turn", now: host.now });
	host.messageStart();
	host.tick(FRAME);
	const seen = seenOfOpenAnswer(host.state);
	const replay = new Host(REVEAL_PACING);
	replay.now = host.now + 2000;
	replay.dispatch({ type: "reset" });
	replay.dispatch({ type: "replay_seen", seen });
	replay.messageStart();
	replay.delta(away);
	replay.messageEndThenChips(away, ["read"]);
	replay.tick(0, "drain");
	const reserved = replay.items.find((it) => !it.tool);
	check("drop before words that end while away: the replay draws none of them at once", reserved !== undefined && reserved.text === "", { drawn: reserved?.text.length });
	check("drop before words that end while away: that empty part is not marked as drawn at once", partDrawnAtOnce(replay.state) === null, { marked: partDrawnAtOnce(replay.state) });
	replay.dispatch({ type: "replay_seen", seen: null });
	replay.settle();
	check("drop before words that end while away: they end whole and once, above the step", JSON.stringify(replay.shape()) === JSON.stringify([`text:${away}`, "tool:read"]), replay.shape().map((row) => row.slice(0, 40)));
}

{
	// The stream stops in the middle of a joined emoji: no part of it shows until the rest arrives.
	const family = "👩‍👩‍👧‍👦";
	for (const [label, upTo] of [["after a joiner", family.indexOf("👧")], ["after its first person", 2]] as const) {
		const host = new Host(REVEAL_PACING);
		const head = `Here is the family ${family.slice(0, upTo)}`;
		host.messageStart();
		host.delta(head);
		const shown: string[] = [];
		for (let i = 0; i < 60; i++) {
			host.tick(FRAME);
			shown.push(host.items[0]?.text ?? "");
		}
		const partial = shown.find((text) => text.includes("👩"));
		check(`emoji: a stall ${label} shows none of the family`, partial === undefined, partial);
		check(`emoji: a stall ${label} still shows the words before it`, shown.at(-1) === "Here is the family ", shown.at(-1));
		const text = `Here is the family ${family} and more words.`;
		host.delta(text.slice(head.length));
		host.tick(FRAME);
		const next = host.items[0]?.text ?? "";
		check(`emoji: a stall ${label} shows the family whole once it is complete`, !next.includes("👩") || next.includes(family), next);
		host.messageEnd(text);
		host.settle();
		expectTexts(`emoji: a stall ${label} ends whole`, host, [text]);
	}
	// An emoji the message ends on shows once the message is done.
	const host = new Host(REVEAL_PACING);
	host.messageStart();
	host.delta("All done 🎉");
	for (let i = 0; i < 30; i++) host.tick(FRAME);
	host.messageEnd("All done 🎉");
	host.settle();
	expectTexts("emoji: an emoji the message ends on shows at its end", host, ["All done 🎉"]);
}

{
	// An address inside inline code is paced like the code it is, in rare text too.
	const address = `https://example.com/${"segment/".repeat(50)}end`;
	const bound = (REVEAL_PACING.catchUpCapCharsPerSec * 0.25) + LONG_WORD + 4;
	const sameLine = largestFrameStep(`Type \\\` to show a backtick, and write a link as code: \`[name](${address})\` here.`);
	check("pace: an escaped backtick earlier on the line leaves the link in code paced", sameLine <= bound, { most: sameLine, address: address.length });
	const earlierLine = largestFrameStep(`Type \\\` to show a backtick.\nWrite a link as code: \`[name](${address})\` here.`);
	check("pace: an escaped backtick on an earlier line leaves the link in code paced", earlierLine <= bound, { most: earlierLine, address: address.length });
	const longCode = largestFrameStep(`A long code span: \`start\n${"some code that goes on and on\n".repeat(160)}[name](${address})\` here.`);
	check("pace: a link at the end of inline code over 4,000 characters is paced", longCode <= bound, { most: longCode, address: address.length });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nassistant-stream reducer smoke passed");
