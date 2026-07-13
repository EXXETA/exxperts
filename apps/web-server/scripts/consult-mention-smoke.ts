// Smoke for the composer @-mention consult popover pure logic
// (apps/web-ui/src/mention-popover.ts, Consult MR-3 spec §4.3).
//
// Covers: trigger-regex positions (start, mid-text after a space, no match
// mid-word, caret in the middle), candidate filtering/ordering (excludes the
// current room + archived rooms, includes needs_absorb, prefix matching),
// mention completion text, leading-mention resolution incl. the stripped
// question, and the never-submit invariant at the logic level.
//
// Run: npm run smokes -- consult-mention   (or tsx this file)

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

	// mid-text, after a space
	const afterSpace = detectMentionQuery("hi @eu", 6);
	assert(afterSpace && afterSpace.query === "eu" && afterSpace.start === 3, "trigger mid-text after a space");

	// after a newline (also a word boundary)
	const afterNewline = detectMentionQuery("line1\n@eu", 9);
	assert(afterNewline && afterNewline.query === "eu" && afterNewline.start === 6, "trigger after a newline");

	// no match mid-word: '@' glued to a preceding word (e.g. an email)
	assert(detectMentionQuery("email@eu", 8) === null, "no trigger when '@' is not at a word boundary");

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
	const c1 = detectMentionQuery("hey @eu", 7)!;
	const done1 = completeMention("hey @eu", c1, rooms[0]);
	assert(done1.text === "hey @euler " && done1.caret === 11, `completion appends '@euler '; got "${done1.text}" @${done1.caret}`);

	// completes mid-text without doubling the following space
	const c2 = detectMentionQuery("@eu rest", 3)!;
	const done2 = completeMention("@eu rest", c2, rooms[0]);
	assert(done2.text === "@euler rest" && done2.caret === 7, `mid-text completion keeps a single space; got "${done2.text}" @${done2.caret}`);

	// ---- leading-mention resolution --------------------------------------
	const resolved = resolveLeadingMention("@euler what did we decide about pricing?", rooms, CURRENT);
	assert(resolved && resolved.room.id === "euler", "leading mention resolves to the room");
	assert(resolved!.question === "what did we decide about pricing?", `question is stripped of the mention; got "${resolved!.question}"`);

	// token match is case-insensitive
	assert(resolveLeadingMention("@EULER hello", rooms, CURRENT)?.room.id === "euler", "leading mention token is case-insensitive");

	// not resolved: unknown room, current room, archived room
	assert(resolveLeadingMention("@nobody hi", rooms, CURRENT) === null, "unknown room does not resolve → normal send");
	assert(resolveLeadingMention("@morpheus hi", rooms, CURRENT) === null, "current room does not resolve → normal send");
	assert(resolveLeadingMention("@oldroom hi", rooms, CURRENT) === null, "archived room does not resolve → normal send");

	// not resolved: mention not at the start of the draft
	assert(resolveLeadingMention("please ask @euler about x", rooms, CURRENT) === null, "non-leading mention does not route");

	// not resolved: no question after the mention
	assert(resolveLeadingMention("@euler ", rooms, CURRENT) === null, "mention with no question does not route");
	assert(resolveLeadingMention("@euler", rooms, CURRENT) === null, "bare mention with no whitespace does not route");

	// ---- never-submit invariant (logic level) ----------------------------
	// While a trigger is active mid-typing, the draft is NOT a routable consult:
	// Enter selects a row (completion), it never resolves+submits.
	const typing = "@eu";
	assert(detectMentionQuery(typing, typing.length) !== null, "an active trigger means the popover is open");
	assert(resolveLeadingMention(typing, rooms, CURRENT) === null, "an active trigger draft never routes a consult");

	// Selecting a room mutates the draft (keeps the mention text) rather than sending.
	const selection = completeMention(typing, detectMentionQuery(typing, typing.length)!, rooms[0]);
	assert(selection.text.includes("@euler"), "selection completes the mention in the draft");

	// And the just-completed draft neither keeps the popover open nor routes yet
	// (no question yet) — so completing a mention can never submit.
	assert(detectMentionQuery(selection.text, selection.caret) === null, "completing a mention closes the popover");
	assert(resolveLeadingMention(selection.text, rooms, CURRENT) === null, "a completed mention with no question does not route");

	// ---- freshness hint ---------------------------------------------------
	assert(memoryFreshnessHint(iso(2 * DAY), NOW) === "last checkpoint 2 days ago", "freshness hint formats days");
	assert(memoryFreshnessHint(iso(21 * DAY), NOW) === "last checkpoint 3 weeks ago", "freshness hint formats weeks");
	assert(memoryFreshnessHint(null, NOW) === null, "unknown checkpoint → no hint");

	console.log("consult mention popover smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
