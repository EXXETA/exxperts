// Smoke for the room's output-limit honesty (apps/web-ui/src/assistant-stream.ts,
// applied by the message_end branch in App.tsx).
//
// The field bug: a gateway model with withheld reasoning spent its entire
// max_tokens budget thinking and was cut before writing a single answer
// character. The assistant message arrived with stopReason "length", full
// output usage, and completely empty content. The reducer had no text to open
// a bubble with, so the room showed nothing at all — no bubble, no error, the
// composer simply idle again — three times in a row.
//
// This asserts the four turn shapes: starved -> the long notice, exactly once;
// truncated (length WITH text) -> the short notice; a normal stop -> silence;
// an aborted turn -> nothing, because the Stop path writes its own note.
//
// Run: npm run smokes -- output-limit-notice   (or tsx this file)

import {
	OUTPUT_LIMIT_STARVED_NOTICE,
	OUTPUT_LIMIT_TRUNCATED_NOTICE,
	outputLimitNoticeForTurn,
} from "../../web-ui/src/assistant-stream.js";

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (ok) {
		console.log(`  ok  ${name}`);
		return;
	}
	failures += 1;
	console.error(`FAIL  ${name}`);
	console.error(`      want ${JSON.stringify(want)}`);
	console.error(`      got  ${JSON.stringify(got)}`);
}

/**
 * The host loop as App.tsx runs it: one notice ref per turn, reset when the
 * composer sends. Returns the system lines the transcript gained.
 */
function runTurn(
	messages: Array<{ stopReason?: string; content?: unknown }>,
	options: { persistentRoom?: boolean; turnCancelling?: boolean } = {},
): string[] {
	const lines: string[] = [];
	let shown = false;
	for (const message of messages) {
		const notice = outputLimitNoticeForTurn({
			message,
			persistentRoom: options.persistentRoom !== false,
			turnCancelling: options.turnCancelling === true,
			alreadyShown: shown,
		});
		if (!notice) continue;
		shown = true;
		lines.push(notice);
	}
	return lines;
}

const textPart = (text: string) => ({ type: "text", text });
const thinkingPart = (thinking: string) => ({ type: "thinking", thinking });
const toolCallPart = (name: string) => ({ type: "toolCall", id: "call_1", name, arguments: {} });

console.log("output-limit notice smoke\n");

// 1. The reproduced bug: the whole budget went to withheld thinking.
check("empty content + length -> the starved notice", runTurn([{ stopReason: "length", content: [] }]), [OUTPUT_LIMIT_STARVED_NOTICE]);
check("thinking-only content + length -> the starved notice", runTurn([{ stopReason: "length", content: [thinkingPart("a very long deliberation")] }]), [OUTPUT_LIMIT_STARVED_NOTICE]);
check("missing content + length -> the starved notice", runTurn([{ stopReason: "length" }]), [OUTPUT_LIMIT_STARVED_NOTICE]);
check("whitespace-only text + length -> the starved notice", runTurn([{ stopReason: "length", content: [textPart("   \n ")] }]), [OUTPUT_LIMIT_STARVED_NOTICE]);

// 2. Exactly once per turn, including the reattach replay of the same frame.
check(
	"the same message_end replayed -> one notice",
	runTurn([
		{ stopReason: "length", content: [] },
		{ stopReason: "length", content: [] },
	]),
	[OUTPUT_LIMIT_STARVED_NOTICE],
);

// 3. The sibling case: a real but truncated answer.
check("text + length -> the truncated notice", runTurn([{ stopReason: "length", content: [textPart("Here is the first half of the ans")] }]), [OUTPUT_LIMIT_TRUNCATED_NOTICE]);
check("string content + length -> the truncated notice", runTurn([{ stopReason: "length", content: "Here is the first half" }]), [OUTPUT_LIMIT_TRUNCATED_NOTICE]);
check("tool call + length -> the truncated notice", runTurn([{ stopReason: "length", content: [toolCallPart("read_file")] }]), [OUTPUT_LIMIT_TRUNCATED_NOTICE]);

// 4. Every ordinary turn stays quiet.
check("normal stop with text -> nothing", runTurn([{ stopReason: "stop", content: [textPart("A complete answer.")] }]), []);
check("normal stop, no stop reason -> nothing", runTurn([{ content: [textPart("A complete answer.")] }]), []);
check("tool-call turn then a normal answer -> nothing", runTurn([{ stopReason: "toolUse", content: [toolCallPart("read_file")] }, { stopReason: "stop", content: [textPart("Done.")] }]), []);
// A provider refusal already has its own red line; this must not double up.
check("provider error -> nothing (the error line owns that turn)", runTurn([{ stopReason: "error", content: [] }]), []);

// 5. Stop: the interrupted note is the only line that turn gets.
check("aborted turn -> nothing", runTurn([{ stopReason: "length", content: [] }], { turnCancelling: true }), []);
check("aborted truncated turn -> nothing", runTurn([{ stopReason: "length", content: [textPart("partial")] }], { turnCancelling: true }), []);

// 6. Rooms only.
check("non-room chat -> nothing", runTurn([{ stopReason: "length", content: [] }], { persistentRoom: false }), []);

// 7. Copy rules for this repo: no em-dashes in what the user reads.
for (const [name, copy] of [["starved", OUTPUT_LIMIT_STARVED_NOTICE], ["truncated", OUTPUT_LIMIT_TRUNCATED_NOTICE]] as const) {
	check(`${name} copy has no em-dash`, copy.includes("—"), false);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\noutput-limit notice smoke passed");
