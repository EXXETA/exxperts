// Smoke for the transcript order of a reply that calls tools between its
// paragraphs (apps/web-ui/src/assistant-stream.ts + the App.tsx host).
//
// The host appends a message's tool chips right after it dispatches
// message_end. The reducer creates an assistant item lazily, at the first
// paint, and the host appends new items at the end — so a text segment whose
// message finished before a frame had painted got its item AFTER the chips,
// and the sentence the model wrote before calling the tool rendered below the
// tool. It depended on frame timing: the same reply came out either way.
//
// The reducer now reserves the item when message_end lands ahead of the first
// paint, and this smoke pins the order across every way that can happen:
// paced streaming, generation finishing ahead of the reveal (draining), the
// non-streamed fallback, the reattach drain tick, the orphan hold, a flush,
// and a three-segment reply. An empty segment must not leave an empty bubble,
// and a replayed answer must not sneak past the quarantine via the reservation.
//
// Run: npm run smokes -- assistant-stream-order   (or tsx this file)

import {
	createAssistantStreamState,
	reduceAssistantStream,
	type AssistantStreamAction,
	type AssistantStreamState,
} from "../../web-ui/src/assistant-stream.js";

type Item =
	| { kind: "assistant"; id: string; text: string; streaming: boolean }
	| { kind: "tool"; id: string; name: string };

/**
 * The App.tsx host, reduced to what decides order: one setItems per dispatch
 * that updates an existing item in place or appends a new one, and the tool
 * chips of a message appended right after its message_end is dispatched.
 */
class Host {
	items: Item[] = [];
	state: AssistantStreamState = createAssistantStreamState();
	now = 1_000;
	warnings: string[] = [];
	tickPending = false;
	private toolCounter = 0;

	dispatch(action: AssistantStreamAction): void {
		const { state, effects } = reduceAssistantStream(this.state, action);
		this.state = state;
		for (const effect of effects) {
			if (effect.kind === "upsert") {
				const existing = this.items.find((it) => it.kind === "assistant" && it.id === effect.id);
				if (existing && existing.kind === "assistant") {
					existing.text = effect.text;
					existing.streaming = effect.streaming;
				} else {
					this.items.push({ kind: "assistant", id: effect.id, text: effect.text, streaming: effect.streaming });
				}
			} else if (effect.kind === "schedule_tick") {
				this.tickPending = true;
			} else if (effect.kind === "warn") {
				this.warnings.push(effect.message);
			}
		}
	}

	messageStart(): void {
		this.dispatch({ type: "message_start", now: this.now });
	}
	delta(text: string): void {
		this.dispatch({ type: "delta", text, now: this.now });
	}
	/** message_end followed by the message's tool chips, as the host does it. */
	messageEnd(finalText: string, tools: string[]): void {
		this.dispatch({ type: "message_end", finalText, now: this.now });
		for (const name of tools) this.items.push({ kind: "tool", id: `tool_${++this.toolCounter}`, name });
	}
	tick(dtMs = 16, mode: "paced" | "drain" = "paced"): void {
		this.now += dtMs;
		this.tickPending = false;
		this.dispatch({ type: "tick", now: this.now, mode });
	}
	settle(maxTicks = 10_000): void {
		let ticks = 0;
		while (this.tickPending) {
			if (++ticks > maxTicks) throw new Error("stream did not settle (schedule_tick loop)");
			this.tick(16);
		}
	}
	/** The transcript as it reads: "text:<text>" and "tool:<name>" in order. */
	shape(): string[] {
		return this.items.map((it) => (it.kind === "assistant" ? `text:${it.text}` : `tool:${it.name}`));
	}
	allSettled(): boolean {
		return this.items.every((it) => it.kind !== "assistant" || !it.streaming);
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

function expectShape(name: string, host: Host, expected: string[]): void {
	check(name, JSON.stringify(host.shape()) === JSON.stringify(expected), { got: host.shape(), want: expected });
	check(`${name}: nothing left streaming`, host.allSettled());
}

const LEAD = "Let me look at the file first.";

{
	// Paced streaming: a frame painted between the delta and message_end (the
	// order that already worked).
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.tick();
	host.messageEnd(LEAD, ["read_file"]);
	host.settle();
	expectShape("paced: text above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Draining: message_end lands before any frame painted the delta.
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.messageEnd(LEAD, ["read_file"]);
	check("draining: item reserved at message_end", host.items[0]?.kind === "assistant" && host.items[0].streaming);
	host.settle();
	expectShape("draining: text above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Non-streamed fallback: the whole answer arrives at message_end.
	const host = new Host();
	host.messageStart();
	host.messageEnd(LEAD, ["read_file"]);
	check("fallback: reveal still paced, not dumped", host.items[0]?.kind === "assistant" && host.items[0].text.length < LEAD.length);
	host.settle();
	expectShape("fallback: text above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Reattach replay: the catch-up drains on a 0ms timer after the chips landed.
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.messageEnd(LEAD, ["read_file"]);
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
	host.messageEnd("Let me check.", ["read_file"]);
	host.settle();
	expectShape("orphan hold: text above the chip", host, ["text:Let me check.", "tool:read_file"]);
	check("orphan hold: no warnings", host.warnings.length === 0, host.warnings);
}

{
	// Flush right after the reservation (room exit before the first tick).
	const host = new Host();
	host.messageStart();
	host.messageEnd(LEAD, ["read_file"]);
	host.dispatch({ type: "flush", now: host.now });
	expectShape("flush: reserved item finalized in place above the chip", host, [`text:${LEAD}`, "tool:read_file"]);
}

{
	// Tool-only message: no text, no bubble — just the chip.
	const host = new Host();
	host.messageStart();
	host.messageEnd("", ["read_file"]);
	host.settle();
	expectShape("tool-only: no empty bubble", host, ["tool:read_file"]);
}

{
	// Three-segment reply, every message_end ahead of its first paint.
	const host = new Host();
	host.messageStart();
	host.delta("First, the plan.");
	host.messageEnd("First, the plan.", ["read_file"]);
	host.messageStart();
	host.delta("The file confirms it; one more check.");
	host.messageEnd("The file confirms it; one more check.", ["bash"]);
	host.messageStart();
	host.delta("Done.");
	host.messageEnd("Done.", []);
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
	// quarantine — the duplicate reserves nothing and is dropped as before.
	const host = new Host();
	host.messageStart();
	host.delta(LEAD);
	host.messageEnd(LEAD, []);
	host.settle();
	host.delta(LEAD.slice(10));
	host.messageEnd(LEAD, []);
	host.settle();
	expectShape("replayed orphan: still exactly one item", host, [`text:${LEAD}`]);
	check("replayed orphan: dropped with a warning", host.warnings.length > 0);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nassistant-stream order smoke passed");
