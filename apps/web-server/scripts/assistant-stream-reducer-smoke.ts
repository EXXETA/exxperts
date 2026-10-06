// Smoke for the web-ui assistant stream reducer (apps/web-ui/src/assistant-stream.ts).
//
// Part 1 — scenario tests: the concrete flows the room chat depends on
// (paced reveal, deferred finalize, provider auto-retry, interrupts, replay
// quarantine, multi-message turns).
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
// Run: npm run smokes -- assistant-stream-reducer   (or tsx this file)

import {
	createAssistantStreamState,
	DEFAULT_REVEAL_PACING,
	normaliseAssistantText,
	reduceAssistantStream,
	type AssistantStreamAction,
	type AssistantStreamState,
	type RevealPacing,
} from "../../web-ui/src/assistant-stream.js";

interface HostItem {
	id: string;
	text: string;
	streaming: boolean;
}

/** Minimal mock of the App.tsx host: applies effects, tracks scheduling. */
class Host {
	items: HostItem[] = [];
	state: AssistantStreamState = createAssistantStreamState();
	now = 1_000;
	warnings: string[] = [];
	interrupted: (string | null)[] = [];
	tickPending = false;

	constructor(readonly pacing: RevealPacing = DEFAULT_REVEAL_PACING) {}

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
	// Pacing: reveal rate stays inside the band, no per-tick bursts.
	const host = new Host();
	const text = "x".repeat(2_000);
	host.messageStart();
	host.delta(text); // one giant burst
	const start = host.now;
	let maxStep = 0;
	let lastLen = 0;
	while (host.tickPending && host.items.length <= 1) {
		host.tick(16);
		const len = host.items[0]?.text.length ?? 0;
		maxStep = Math.max(maxStep, len - lastLen);
		lastLen = len;
		if (lastLen >= text.length) break;
	}
	const seconds = (host.now - start) / 1000;
	const cps = text.length / seconds;
	check("pacing: average rate within band (±20%)", cps >= DEFAULT_REVEAL_PACING.minCharsPerSec * 0.8 && cps <= DEFAULT_REVEAL_PACING.maxCharsPerSec * 1.2, { cps });
	// A frame may reveal at most the ceiling's share of it (the first frame
	// counts as 17 ms, plus the fractional carry): smoothing, not a
	// whole-burst dump.
	const maxFrameStep = Math.ceil((DEFAULT_REVEAL_PACING.maxCharsPerSec * 17) / 1000) + 1;
	check(`pacing: max per-frame step ≤ ${maxFrameStep} chars`, maxStep <= maxFrameStep && maxStep < text.length / 10, { maxStep });
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
	check("stray tail: warning emitted", host.warnings.some((w) => w.includes("replayed fragment")), host.warnings);
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
	check("non-streamed echo: warned", host.warnings.some((w) => w.includes("duplicate message_end")), host.warnings);
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
	check("message_end while draining: warned", host.warnings.some((w) => w.includes("message_end while previous")), host.warnings);
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

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nassistant-stream reducer smoke passed");
