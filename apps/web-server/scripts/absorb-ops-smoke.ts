export {};

// Memory v2 stream C: the Memorize fold operation layer's promises as
// predicates. Everything is imported from the real module — never an inline
// copy. Each refusal is proven twice: green-with, the validator names it; and
// red-without, the same op list passes once that one refusal line is taken out
// of the result (nothing else catches it) and applying it then does the damage
// the rule exists to prevent.

import type { AreaRow, FoldGuidance, FoldOp, MemoryDocument, MemoryEntry } from "../src/absorb-ops.js";

const {
	applyFoldOps,
	buildFoldGuidanceSignoffTask,
	buildFoldPrompt,
	extractFoldOpsJson,
	isFoldOpsJsonProblem,
	countWords,
	nearDuplicateTopicTitle,
	normalizeTopicTitle,
	FOLD_ACTIVE_ITEMS_TOPIC,
	FOLD_MAX_OPS,
	FOLD_MAX_TEXT_WORDS,
	FOLD_TOPIC_TITLE_MAX_CHARS,
	FOLD_TRIGGER_PROMPT,
	foldEntryId,
	parseFoldGuidance,
	parseFoldOps,
	renderFoldGuidance,
	summarizeFold,
	validateFoldOps,
} = await import("../src/absorb-ops.js");
const { estimateTokens } = await import("../src/token-estimate.js");
const {
	demoteToBudget,
	MEMORY_SECTIONS,
	migrateMemoryDocument,
	parseMemoryDocument,
	renderMemoryDocument,
	reviewTargetTokens,
	listAreas,
} = await import("../src/memory-entries.js");
const { execFileSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// --- The document, by hand ---------------------------------------------------

function entry(id: string, kind: MemoryEntry["kind"], text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
	return { id, kind, saved: "2026-07-08", from: "RC-0003", pinned: false, text, ...extra };
}

const DOC: MemoryDocument = {
	preamble: "# Room memory\n",
	chronos: "## Chronos\n\n- 2026-09-08 — checkpoint saved.\n",
	topics: [
		{
			section: "Deep Memory",
			title: "Commercial terms",
			heading: "### Commercial terms",
			intro: "",
			entries: [
				entry("m-0001", "fact", "- The Nordwind contract renews annually; legal signs before June."),
				entry("m-0002", "fact", "- The quarterly report is due on the 10th working day of the quarter.", { updated: "2026-09-01" }),
			],
		},
		{
			section: "Deep Memory",
			title: "Working style",
			heading: "### Working style",
			intro: "",
			entries: [
				entry("m-0003", "practice", "- **must-keep** Send commercial summaries as one page, numbers first.", { pinned: true, saved: "2026-08-21" }),
				entry("m-0004", "practice", "- Decisions are written down the same day they are taken."),
			],
		},
		{
			section: "Active Items",
			title: FOLD_ACTIVE_ITEMS_TOPIC,
			heading: null,
			intro: "",
			entries: [
				entry("m-0005", "item", "- Close out the billing reconciliation before the renewal.", { status: "open" }),
				entry("m-0006", "item", "- Decide whether the vendor follow-up is still worth the time.", { status: "open" }),
			],
		},
	],
	recentContext: "## Recent Context\n\n### RC-0007 | CHECKPOINTED | 2026-09-08 | Renewal and reporting rhythm\n\nkept by the route, not by the fold\n",
	otherSections: [],
	nextEntryNumber: 7,
};

/** The area map the entry model will build; derived here so the smoke needs no sibling module. */
function areasFrom(doc: MemoryDocument): AreaRow[] {
	return doc.topics.flatMap((topic) =>
		topic.entries.map((e) => ({
			id: e.id,
			topic: topic.title,
			section: topic.section,
			kind: e.kind,
			pinned: e.pinned,
			saved: e.saved,
			...(e.updated ? { updated: e.updated } : {}),
			tokens: estimateTokens(e.text),
			firstLine: e.text.split("\n")[0],
			text: e.text,
		})),
	);
}

const AREAS = areasFrom(DOC);
const PINNED = "m-0003";
const SESSION_ID = "RC-0007";
const SESSION_DATE = "2026-09-08";
const PIN_REQUEST = "Please keep the one-page rule pinned; I never want it rewritten.";
const SESSION_TEXT = `### RC-0007 | CHECKPOINTED | 2026-09-08 | Renewal and reporting rhythm

<!-- rc_metadata id=RC-0007 saved=2026-09-08 density=standard -->

**Session arc**

Went through the Nordwind renewal, the reporting rhythm and what is left open before the renewal date.

**Body**

- The renewal now needs legal sign-off before the end of April, not June: the counterparty moved the notice window.
- The quarterly report moved from the 10th to the 5th working day of the quarter.
- ${PIN_REQUEST}
- The billing reconciliation is finished and signed off.
- New: the counterparty's escalation contact is the commercial lead, reachable through the shared inbox.

**Parked**

- The vendor follow-up waits until the renewal lands.
`;
const SESSION = { id: SESSION_ID, text: SESSION_TEXT, date: SESSION_DATE };
const CTX = { sessionId: SESSION_ID, savedDate: "2026-09-12", nextEntryNumber: 7 };

const ASSESSMENT = `## Memorize assessment

I found 3 remembered sessions. Here is the proposed direction.

### What to remember
- The renewal's notice window moved.
- The reporting day moved.

### What to forget
- Implementation chatter about the shared inbox setup.`;

const GUIDANCE: FoldGuidance = {
	pin: ["m-0003"],
	drop: [{ session: "RC-0009", reason: "a short status check with nothing durable in it" }],
	corrections: ["The reporting day is the 5th working day, not the 10th."],
	topics: [{ action: "create", title: "Counterparties" }],
	instructions: ["Keep entries to one line where the point fits in one."],
};

// --- 1. The prompt -----------------------------------------------------------

{
	// An entry no conversation wrote (the upgrade or a hand edit gave it its id)
	// reads "in memory since", so the fold treats its date as a floor on its age.
	const sinceAreas = AREAS.map((area, i) => (i === 0 ? { ...area, since: true as const } : area));
	const { prompt } = buildFoldPrompt({
		agentId: "room-smoke",
		model: { provider: "gateway", model: "fold-model" },
		coreContext: renderMemoryDocument(DOC, "context", { entryIds: true, sections: MEMORY_SECTIONS }).trim(),
		areas: sinceAreas,
		assessmentMarkdown: ASSESSMENT,
		guidance: GUIDANCE,
		session: SESSION,
		sessionIndex: 2,
		sessionCount: 3,
		now: new Date("2026-09-12T09:00:00.000Z"),
	});
	const first = sinceAreas[0];
	assert(prompt.includes(`[${first.id} · in memory since ${first.saved}]`), `an entry without a conversation of origin reads "in memory since" (${first.id})`);
	assert(!prompt.includes(`[${first.id} · saved`), "and not as saved on that day");
	assert(prompt.includes(`[${sinceAreas[1].id} · saved ${sinceAreas[1].saved}`), "an entry a conversation wrote still reads saved");
	assert(prompt.includes('reads "in memory since"'), "the constitution tells the fold how to read such a date");
}

/** The memory as a fold reads it: the two sections it can change, every entry carrying its own address. */
const CORE_CONTEXT = renderMemoryDocument(DOC, "context", { entryIds: true, sections: MEMORY_SECTIONS }).trim();

{
	const { prompt, telemetry } = buildFoldPrompt({
		agentId: "room-smoke",
		model: { provider: "gateway", model: "fold-model" },
		coreContext: CORE_CONTEXT,
		areas: AREAS,
		assessmentMarkdown: ASSESSMENT,
		guidance: GUIDANCE,
		session: SESSION,
		sessionIndex: 2,
		sessionCount: 3,
		now: new Date("2026-09-12T09:00:00.000Z"),
	});
	for (const part of [
		"# exxperts Memorize Fold Constitution",
		"## Governing Principle",
		"later entries supersede earlier ones",
		"## Dates Decide What Is Newer",
		"## Date Stamps",
		"## Must-Keep Material",
		"sensitive-material restraint",
		"## Pinned Entries",
		"## Process Metadata",
		"## Material: Core Memory As The Room Reads It",
		"## Material: Entries You Can Address",
		"## Material: Signed-Off Assessment",
		"## Material: The User's Instructions From The Discussion",
		"## Material: The Session To Fold (2 of 3)",
		"## Task: Fold This Session Into Memory (operations)",
	]) assert(prompt.includes(part), `the prompt carries "${part}"`);
	assert(prompt.includes("- [m-0003 · pinned · saved 2026-08-21] **must-keep** Send commercial summaries as one page, numbers first."), "a pinned entry carries its address, its pin and its saved date in its own first line");
	assert(prompt.includes("- [m-0001 · saved 2026-07-08] The Nordwind contract renews annually; legal signs before June."), "an unpinned entry carries its address and its saved date, and no pin marker");
	assert(prompt.includes("- [m-0002 · saved 2026-07-08 · updated 2026-09-01] The quarterly report is due on the 10th working day of the quarter."), "an entry a fold rewrote carries the day it was updated beside the day it was saved");
	// The dates are the fold's, dressed onto the render it was given: the render
	// itself still writes the bare address, and every other reader keeps it.
	assert(CORE_CONTEXT.includes("- [m-0001] The Nordwind") && !CORE_CONTEXT.includes("saved 2026"), "the entry model's render is untouched; the dates are the prompt's own");
	assert(prompt.includes(`This conversation is from ${SESSION_DATE}: it is newer than every entry saved or updated before that day, and older than every entry saved or updated after it.`), "the task states the day the conversation is from, and what that means against the entries' dates");
	assert(prompt.includes(`- Session date: ${SESSION_DATE}`) && prompt.includes(`This session is from ${SESSION_DATE}.`), "the metadata and the session material carry the date too");
	assert(prompt.includes("never supersede or update it with this session's older information"), "the constitution forbids rolling a newer entry back with an older conversation");
	assert(!prompt.includes("this session is newer than everything already in memory"), "the old rule — the session is newer than everything — is gone");
	// The prompt cache's order: what is the same from one fold to the next comes
	// first, and the per-call metadata (trigger time, session counter) sits after
	// the memory, the legend, the assessment and the guidance, just before the session.
	const at = (heading: string) => { const index = prompt.indexOf(heading); assert(index >= 0, `the prompt carries "${heading}"`); return index; };
	assert(at("## Material: Core Memory As The Room Reads It") < at("## Material: Entries You Can Address") && at("## Material: Entries You Can Address") < at("## Material: Signed-Off Assessment") && at("## Material: The User's Instructions From The Discussion") < at("## Process Metadata") && at("## Process Metadata") < at("## Material: The Session To Fold (2 of 3)") && at("## Material: The Session To Fold (2 of 3)") < at("## Task: Fold This Session Into Memory"), "the per-call metadata comes after everything that is the same from one fold to the next, so the memory prefix can be cached");
	assert(prompt.includes("- Trigger time: 2026-09-12T09:00:00.000Z"), "the metadata still carries the trigger time");
	assert(AREAS.every((area) => prompt.includes(`[${area.id}`)), "every entry of the memory is addressable from the prompt");
	// Each entry is ADDRESSED once. A prompt that listed them again beside the
	// memory paid for the room's whole memory twice — 26k tokens of rows on a
	// room at its budget — to say what each entry's own first line now says.
	assert(AREAS.every((area) => prompt.split(`[${area.id}`).length === 2), `every entry carries exactly one address (${AREAS.filter((area) => prompt.split(`[${area.id}`).length !== 2).map((area) => area.id).join(", ")})`);
	assert(prompt.includes("is the entry `m-0031`") && prompt.includes("pinned") && prompt.includes(`there are ${AREAS.length}`), "the legend reads the inline addresses, the pinned marker and how many entries there are");
	assert(prompt.includes("saved into memory on 2026-08-02") && prompt.includes("says a later fold rewrote it on 2026-09-01") && prompt.includes("Copy the id alone — `m-0031`, never the dates or the pin marker"), "the legend explains the saved and updated dates and says to copy the id alone");
	for (const shape of ['"op":"add"', '"op":"update"', '"op":"supersede"', '"op":"close"', '"op":"pin"', '"op":"unpin"', '"op":"drop"']) assert(prompt.includes(shape), `the task shows the ${shape} shape`);
	assert(prompt.includes(`at most ${FOLD_MAX_OPS} operations`) && prompt.includes(`at most ${FOLD_MAX_TEXT_WORDS} words`), "the task states the bounds the validator enforces");
	assert(prompt.includes("at most three lines") && prompt.includes("exactly one ```json fence"), "the task asks for a three-line narrative and exactly one fence");
	assert(prompt.includes("Do not claim anything has been saved."), "the task keeps the no-claim line");
	assert(prompt.includes("A point memory already holds is updated, never repeated: an add that says what an existing entry says is refused with that entry's id."), "the governing principle says a repeated point is refused");
	assert(prompt.includes("The user asked to pin these entries: m-0003") && prompt.includes("RC-0009 — a short status check") && prompt.includes("The reporting day is the 5th working day") && prompt.includes('Create the topic "Counterparties"') && prompt.includes("Keep entries to one line"), "every part of the signed-off guidance is rendered as an instruction");
	assert(prompt.includes(PIN_REQUEST), "the one session is carried whole");
	assert(telemetry.areaCount === AREAS.length && telemetry.promptChars === prompt.length && telemetry.promptEstimatedTokens === estimateTokens(prompt), "telemetry reports the area count and the size through the ONE estimator");
	assert(telemetry.promptEstimatedTokens < 4000, `a fold prompt over a small memory stays small (~${telemetry.promptEstimatedTokens} tokens)`);
	assert(FOLD_TRIGGER_PROMPT === "Fold this session into memory now.", "the worker's trigger sentence is the exported one");
	// A fold with no discussion still gets a rendered instruction block, never an empty section.
	const bare = buildFoldPrompt({ agentId: "room-smoke", model: { provider: "gateway", model: "fold-model" }, coreContext: "## Deep Memory\n", areas: AREAS, assessmentMarkdown: ASSESSMENT, session: SESSION, sessionIndex: 1, sessionCount: 1 });
	assert(bare.prompt.includes("The user signed off without further instructions."), "no guidance renders as a sentence, not as a hole");
	// A session whose date the caller does not know states no date, rather than an empty one.
	const undated = buildFoldPrompt({ agentId: "room-smoke", model: { provider: "gateway", model: "fold-model" }, coreContext: CORE_CONTEXT, areas: AREAS, assessmentMarkdown: ASSESSMENT, session: { id: SESSION_ID, text: SESSION_TEXT }, sessionIndex: 1, sessionCount: 1 });
	assert(!undated.prompt.includes("This conversation is from") && !undated.prompt.includes("Session date:"), "no date renders as no sentence");
	// The ceiling moved from 3000 to 3300 when the legend and the constitution
	// learned to read an "in memory since" date; the prompt's fixed part is
	// still a fraction of any memory it wraps.
	const bareAssembly = buildFoldPrompt({ agentId: "room-smoke", model: { provider: "gateway", model: "fold-model" }, coreContext: CORE_CONTEXT, areas: AREAS, assessmentMarkdown: ASSESSMENT, session: SESSION, sessionIndex: 1, sessionCount: 1 });
	assert(estimateTokens(bareAssembly.prompt) - estimateTokens(CORE_CONTEXT) - estimateTokens(SESSION_TEXT) < 3300, `everything the prompt adds to the memory and the session is bounded (~${estimateTokens(bareAssembly.prompt) - estimateTokens(CORE_CONTEXT) - estimateTokens(SESSION_TEXT)} tokens)`);
	console.log(`1. prompt: ${telemetry.promptChars} chars, ~${telemetry.promptEstimatedTokens} estimated tokens, ${telemetry.areaCount} addressable entries`);
	if (process.env.ABSORB_OPS_SMOKE_PRINT_PROMPT) console.log(`\n----- rendered fold prompt -----\n${prompt}----- end -----\n`);
}

// --- 1a. The prompt's size on a memory the size of a real room ---------------

// The promise this case exists for: a fold prompt costs the room's memory plus
// a fixed frame, and NOT the memory twice. It is measured on a generated room
// of the field's size class (66k tokens, ten sessions), brought to the default
// budget by the same deterministic pre-pass the run uses, because the shape
// that went wrong in the field only shows at that size: on a room at 20k, the
// per-entry list this prompt used to carry was 26k tokens on its own.
{
	const genMemory = fileURLToPath(new URL("./memory-bench/gen-memory.mjs", import.meta.url));
	const l1b = execFileSync(process.execPath, [genMemory, "66000", "10"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
	const doc = demoteToBudget(migrateMemoryDocument(parseMemoryDocument(l1b), { fallbackSaved: "2026-09-12" }).doc, 20_000, { today: "2026-09-12" }).doc;
	const coreTokens = reviewTargetTokens(doc);
	const areas = listAreas(doc);
	const session = doc.recentContext.split(/\r?\n(?=###\s+RC-)/).slice(1)[0] ?? "";
	const sessionId = /^###\s+(RC-\d+)/.exec(session)?.[1] ?? "";
	assert(coreTokens > 15_000 && coreTokens <= 20_000 && areas.length > 200 && sessionId, `the generated room is a real one: ${areas.length} entries, ${coreTokens} tokens of core memory, first session ${sessionId || "(none)"}`);

	const big = buildFoldPrompt({
		agentId: "room-smoke",
		model: { provider: "gateway", model: "fold-model" },
		coreContext: renderMemoryDocument(doc, "context", { entryIds: true, sections: MEMORY_SECTIONS }).trim(),
		areas,
		assessmentMarkdown: ASSESSMENT,
		session: { id: sessionId, text: session },
		sessionIndex: 1,
		sessionCount: 10,
		now: new Date("2026-09-12T09:00:00.000Z"),
	});
	// The one per-entry cost the prompt pays on top of the memory: each address
	// carries its saved date (and an updated date once a fold rewrote it), so a
	// conversation folded late can tell an older entry from a newer one. Five
	// tokens an entry; on a room of real-sized entries a few percent of the memory.
	const datesTokens = areas.length * estimateTokens(" · saved 2026-09-12");
	const ceiling = Math.round(1.2 * (coreTokens + 3000 + datesTokens));
	console.log(`1a. prompt on a generated ${areas.length}-entry room at its 20k budget: ~${big.telemetry.promptEstimatedTokens} estimated tokens against a ceiling of ${ceiling} (core ${coreTokens}, dates ~${datesTokens}, session ~${estimateTokens(session)})`);
	assert(big.telemetry.promptEstimatedTokens < ceiling, `a fold prompt is the memory plus its dates plus a frame, not the memory twice: ~${big.telemetry.promptEstimatedTokens} tokens against 1.2 × (${coreTokens} + 3000 + ${datesTokens}) = ${ceiling}`);
	assert(areas.every((area) => big.prompt.split(`[${area.id} `).length + big.prompt.split(`[${area.id}]`).length <= 3), "no entry of a real-sized room is addressed twice");
	assert(areas.every((area) => big.prompt.includes(`[${area.id} · saved ${area.saved}`)), "every entry of a real-sized room carries its saved date in its address");
}

// --- 2. Reading the reply ----------------------------------------------------

const CLEAN_OPS = '{"ops":[{"op":"supersede","id":"m-0001","text":"- The Nordwind contract renews annually; legal signs before the end of April."},{"op":"close","id":"m-0005"}]}';

{
	const clean = parseFoldOps(`Two changes: the notice window moved and the reconciliation is done.\n\n\`\`\`json\n${CLEAN_OPS}\n\`\`\`\n`);
	assert(clean.problems.length === 0 && clean.ops.length === 2, `a clean reply parses (${clean.problems.join("; ")})`);
	assert(clean.ops[0].op === "supersede" && clean.ops[1].op === "close", "the ops keep their order and kinds");
	assert(clean.narrative === "Two changes: the notice window moved and the reconciliation is done.", `the narrative before the fence is kept (${clean.narrative})`);

	const decorated = parseFoldOps(`### **What this session leaves behind**\n\nThe renewal's notice window moved; the reconciliation closed.\n\n### **Operations**\n\n\`\`\`json\n${CLEAN_OPS}\n\`\`\`\n\nNothing else changed.\n`);
	assert(decorated.problems.length === 0 && decorated.ops.length === 2, "prose and ### **bold** decoration around the fence are tolerated");
	assert(!decorated.narrative.includes("Operations"), "a trailing heading that only labels the fence is not narrative");

	const twoFences = parseFoldOps(`A sketch first:\n\n\`\`\`json\n{"ops":[{"op":"drop","reason":"sketch"}]}\n\`\`\`\n\nThe real list:\n\n\`\`\`json\n${CLEAN_OPS}\n\`\`\`\n`);
	assert(twoFences.problems.length === 0 && twoFences.ops.length === 2 && twoFences.ops[0].op === "supersede", "with two fences the LAST one wins");

	const untagged = parseFoldOps(`Here it is.\n\n\`\`\`\n${CLEAN_OPS}\n\`\`\`\n`);
	assert(untagged.problems.length === 0 && untagged.ops.length === 2, "a fence without the json tag is read the same");

	const cut = parseFoldOps(`The renewal moved.\n\n\`\`\`json\n{"ops":[{"op":"supersede","id":"m-0001","text":"- The Nord`);
	assert(cut.ops.length === 0 && cut.problems.length === 1 && /cut off/.test(cut.problems[0]), `a reply cut mid-fence is a named problem (${cut.problems[0]})`);
	assert(cut.narrative.startsWith("The renewal moved."), "the narrative of a cut reply survives for the diagnostics");

	const none = parseFoldOps("I folded the session into memory and saved it.");
	assert(none.ops.length === 0 && none.problems.length === 1 && /no ```json fence/.test(none.problems[0]), `a reply with no fence is a named problem (${none.problems[0]})`);

	// Never throws: the extractor answers with a problem value the route can log.
	for (const bad of ["", "```json\n{not json}\n```", "```json\n\n```", "prose only"]) {
		const result = extractFoldOpsJson(bad);
		assert(isFoldOpsJsonProblem(result), `an unreadable reply returns a problem rather than throwing (${JSON.stringify(bad).slice(0, 30)})`);
	}
	assert(!isFoldOpsJsonProblem(extractFoldOpsJson(`\`\`\`json\n${CLEAN_OPS}\n\`\`\``)), "a readable fence returns the parsed value");
	const shapes = parseFoldOps('```json\n{"ops":[{"op":"rename","id":"m-0001"},{"op":"add","kind":"fact","text":"- x"},{"op":"update","id":"m-0001"},{"op":"drop"}]}\n```');
	assert(shapes.ops.length === 0 && shapes.problems.length === 4, `each malformed op is its own named problem (${shapes.problems.length})`);
	assert(/op 1: "op" must be one of/.test(shapes.problems[0]) && /op 2 \(add\): "topic" is required/.test(shapes.problems[1]) && /op 3 \(update\): "text"/.test(shapes.problems[2]) && /op 4 \(drop\): "reason"/.test(shapes.problems[3]), `problems name the position and the field (${shapes.problems.join(" | ")})`);
	console.log("2. parse: clean, decorated, two-fence, untagged, cut and fenceless replies all read without throwing");
}

// --- 3. Refusals -------------------------------------------------------------

const refuse = (ops: FoldOp[], areas: AreaRow[] = AREAS) => validateFoldOps(ops, areas, SESSION);
/** The rule taken out once: what the validator would still say if this one refusal were not written. */
const without = (refusals: string[], rule: RegExp) => refusals.filter((line) => !rule.test(line));

{
	const GOOD: FoldOp[] = [{ op: "supersede", id: "m-0001", text: "- The Nordwind contract renews annually; legal signs before the end of April." }];
	assert(refuse(GOOD).length === 0, `a well-formed op list is accepted (${refuse(GOOD).join("; ")})`);

	// 3a. Pinned protection — red-without: the fold rewrites the user's own entry.
	{
		const ops: FoldOp[] = [{ op: "update", id: PINNED, text: "- Send commercial summaries as two pages." }];
		const refusals = refuse(ops);
		assert(refusals.length === 1 && /is pinned/.test(refusals[0]) && /may only add an entry beside it/.test(refusals[0]), `green-with: a pinned entry refuses update and the refusal says a fold may only add beside it (${refusals[0]})`);
		assert(without(refusals, /is pinned/).length === 0, "red-without: with that rule removed nothing else refuses the op");
		const damage = applyFoldOps(DOC, ops, CTX);
		const after = damage.doc.topics[1].entries[0];
		assert(after.text.includes("two pages") && DOC.topics[1].entries[0].text.includes("one page"), "red-without: applying it rewrites the user's pinned entry (and the source document is untouched)");
		for (const op of ["supersede", "close", "unpin"] as const) {
			const list = op === "close" ? [{ op, id: PINNED }] : op === "unpin" ? [{ op, id: PINNED, because: PIN_REQUEST }] : [{ op, id: PINNED, text: "- x" }];
			assert(refuse(list as FoldOp[]).some((line) => /is pinned/.test(line)), `${op} on a pinned entry is refused too`);
		}
		assert(refuse([{ op: "add", topic: "Working style", kind: "practice", text: "- The one-page rule now allows an appendix." }]).length === 0, "adding beside a pinned entry is the way through, and it is accepted");
	}

	// 3b. Unknown id — red-without: the applier cannot even find what to change.
	{
		const ops: FoldOp[] = [{ op: "update", id: "m-9999", text: "- Something about an entry that does not exist." }];
		const refusals = refuse(ops);
		assert(refusals.length === 1 && /"m-9999" is not an entry of this memory/.test(refusals[0]), `green-with: an unknown id is refused by name (${refusals[0]})`);
		assert(without(refusals, /is not an entry of this memory/).length === 0, "red-without: with that rule removed nothing else refuses the op");
		let threw = "";
		try { applyFoldOps(DOC, ops, CTX); } catch (error) { threw = (error as Error).message; }
		assert(/ops were not validated: unknown entry "m-9999"/.test(threw), `red-without: applying it cannot resolve the entry (${threw})`);
		const near = refuse([{ op: "close", id: "M-0005" }]);
		assert(near.some((line) => /did you mean "m-0005"/.test(line)), `a near-miss id is named with the id it meant (${near.join("; ")})`);
		const withDates = refuse([{ op: "close", id: "m-0005 · saved 2026-07-08" }]);
		assert(withDates.some((line) => /did you mean "m-0005"/.test(line)), `an id copied with its dates is refused naming the bare id (${withDates.join("; ")})`);
	}

	// 3c. Drop combined with other ops — red-without: the session is both dropped and folded.
	{
		const ops: FoldOp[] = [
			{ op: "drop", reason: "status chatter only" },
			{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The escalation contact is the commercial lead." },
		];
		const refusals = refuse(ops);
		assert(refusals.length === 1 && /travels alone/.test(refusals[0]), `green-with: a drop beside other operations is refused (${refusals[0]})`);
		assert(without(refusals, /travels alone/).length === 0, "red-without: with that rule removed nothing else refuses the list");
		const damage = applyFoldOps(DOC, ops, CTX);
		assert(damage.record.dropped?.reason === "status chatter only" && damage.record.added.length === 1, "red-without: applying it records the session as dropped AND as folded — the card would say both");
		assert(refuse([{ op: "drop", reason: "status chatter only" }]).length === 0, "a drop on its own is accepted");
		assert(refuse([{ op: "drop", reason: "  " }]).some((line) => /carries the reason/.test(line)), "a drop without a reason is refused");
		assert(refuse([{ op: "drop", reason: "a" }, { op: "drop", reason: "b" }]).some((line) => /dropped once/.test(line)), "two drops are refused");
	}

	// 3d. Pin without `because` — red-without: the fold pins on its own authority.
	{
		const ops: FoldOp[] = [{ op: "pin", id: "m-0002" }];
		const refusals = refuse(ops);
		assert(refusals.length === 1 && /carries "because"/.test(refusals[0]), `green-with: a pin without its quoted line is refused (${refusals[0]})`);
		assert(without(refusals, /carries "because"/).length === 0, "red-without: with that rule removed nothing else refuses the op");
		const damage = applyFoldOps(DOC, ops, CTX);
		assert(damage.doc.topics[0].entries[1].pinned && damage.record.pinned.join() === "m-0002", "red-without: applying it pins an entry nobody asked to pin");
		const invented = refuse([{ op: "pin", id: "m-0002", because: "The user asked me to pin this." }]);
		assert(invented.length === 1 && /is not in RC-0007/.test(invented[0]), `a quote the session does not hold is refused (${invented[0]})`);
		assert(refuse([{ op: "pin", id: "m-0002", because: PIN_REQUEST }]).length === 0, "a pin quoting a line of the session is accepted");
		assert(refuse([{ op: "pin", id: "m-0002", because: `  ${PIN_REQUEST.replace(" pinned;", "  pinned;")}  ` }]).length === 0, "the quote is matched on one space run, so re-wrapping does not refuse an honest quote");
	}

	// 3e. The remaining server rules, each named.
	const wrongSection = refuse([{ op: "add", topic: "Commercial terms", kind: "item", text: "- Chase the counterparty for the notice date." }]);
	assert(wrongSection.length === 1 && /an item is an open loop and lives in Active Items/.test(wrongSection[0]), `an item outside Active Items is refused (${wrongSection[0]})`);
	const wrongKind = refuse([{ op: "add", topic: FOLD_ACTIVE_ITEMS_TOPIC, kind: "fact", text: "- The renewal window moved to April." }]);
	assert(wrongKind.length === 1 && /holds open loops only/.test(wrongKind[0]), `a fact inside Active Items is refused (${wrongKind[0]})`);
	assert(refuse([{ op: "add", topic: FOLD_ACTIVE_ITEMS_TOPIC, kind: "item", text: "- Chase the counterparty for the notice date." }]).length === 0, "an item in Active Items is accepted");
	const closeFact = refuse([{ op: "close", id: "m-0001" }]);
	assert(closeFact.length === 1 && /not an open item/.test(closeFact[0]), `close on a Deep Memory entry is refused (${closeFact[0]})`);

	const notBullet = refuse([{ op: "add", topic: "Commercial terms", kind: "fact", text: "The renewal window moved to April." }]);
	assert(notBullet.length === 1 && /must start with "- "/.test(notBullet[0]), `text that does not start as a bullet is refused where the topic is bullets (${notBullet[0]})`);
	assert(validateFoldOps([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually.\n### Terms" }], AREAS, SESSION).some((line) => /heading or a comment line/.test(line)), "a heading line inside an entry's text is refused");
	assert(validateFoldOps([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually.\n<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->" }], AREAS, SESSION).some((line) => /heading or a comment line/.test(line)), "a comment line inside an entry's text is refused");
	assert(!validateFoldOps([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually #q3." }], AREAS, SESSION).some((line) => /heading or a comment line/.test(line)), "a hashtag inside a line is a word, not a heading");
	const PROSE_AREAS: AreaRow[] = [{ id: "m-0100", topic: "Context", section: "Deep Memory", kind: "fact", pinned: false, saved: "2026-06-01", tokens: 20, firstLine: "The room exists to keep the renewal cycle honest.", text: "The room exists to keep the renewal cycle honest." }];
	assert(validateFoldOps([{ op: "add", topic: "Context", kind: "fact", text: "The counterparty moved the notice window." }], PROSE_AREAS, SESSION).length === 0, "a paragraph is accepted where the topic's entries are paragraphs");
	assert(validateFoldOps([{ op: "update", id: "m-0100", text: "- A bullet is accepted there too." }], PROSE_AREAS, SESSION).length === 0, "a bullet is accepted in a paragraph topic as well");

	const long = `- ${Array.from({ length: FOLD_MAX_TEXT_WORDS + 1 }, (_, i) => `word${i}`).join(" ")}`;
	const tooLong = refuse([{ op: "add", topic: "Commercial terms", kind: "fact", text: long }]);
	assert(countWords(long) === FOLD_MAX_TEXT_WORDS + 2 && tooLong.some((line) => new RegExp(`at most ${FOLD_MAX_TEXT_WORDS}`).test(line)), `text over ${FOLD_MAX_TEXT_WORDS} words is refused (${tooLong[0]})`);

	const many: FoldOp[] = Array.from({ length: FOLD_MAX_OPS + 1 }, (_, i) => ({ op: "add", topic: "Commercial terms", kind: "fact", text: `- Fact number ${i + 1} from the session.` }));
	assert(refuse(many).some((line) => new RegExp(`at most ${FOLD_MAX_OPS} are applied`).test(line)), `more than ${FOLD_MAX_OPS} ops is refused`);
	assert(refuse(many.slice(0, FOLD_MAX_OPS)).length === 0, `exactly ${FOLD_MAX_OPS} ops is accepted`);

	const dup = refuse([{ op: "update", id: "m-0001", text: "- One." }, { op: "supersede", id: "m-0001", text: "- Two." }]);
	assert(dup.length === 1 && /named by more than one operation/.test(dup[0]), `two ops on one id are refused (${dup[0]})`);

	const foreign = parseFoldOps('```json\n{"ops":[{"op":"add","topic":"Commercial terms","kind":"fact","text":"- x","id":"m-0001","section":"Deep Memory"}]}\n```');
	assert(foreign.problems.length === 0 && foreign.ops[0].foreignKeys?.join() === "id,section", "the parser keeps the keys the grammar does not define");
	const foreignRefusals = refuse(foreign.ops);
	assert(foreignRefusals.some((line) => /"id", "section" are not part of this operation/.test(line)), `foreign keys on an op are refused by name (${foreignRefusals.join("; ")})`);

	assert(refuse([]).length === 1 && /or with a single drop/.test(refuse([])[0]), `an empty list is a refusal, not a fold (${refuse([])[0]})`);

	const badTitle = refuse([{ op: "add", topic: "### Renewals", kind: "fact", text: "- x." }]);
	assert(badTitle.some((line) => /without "#" heading marks/.test(line)), `a new topic title with heading marks is refused (${badTitle[0]})`);
	assert(refuse([{ op: "add", topic: "A", kind: "fact", text: "- x." }]).some((line) => /characters; "A" is 1/.test(line)), "a one-character topic title is refused");
	assert(refuse([{ op: "add", topic: "T".repeat(FOLD_TOPIC_TITLE_MAX_CHARS + 1), kind: "fact", text: "- x." }]).some((line) => /characters;/.test(line)), "an over-long topic title is refused");
	assert(refuse([{ op: "add", topic: " : ", kind: "fact", text: "- x." }]).some((line) => /punctuation, not a topic title/.test(line)), "a colon-only topic title is refused");
	assert(refuse([{ op: "add", topic: "Counterparties", kind: "fact", text: "- The escalation contact is the commercial lead." }]).length === 0, "a new topic with a real title is accepted");

	// 3f. Near-duplicate topic titles — red-without: the applier opens a second heading for one subject.
	{
		assert(normalizeTopicTitle("The Nordwind integrations") === "nordwind integration", `the normaliser drops stop words and a plural s (${normalizeTopicTitle("The Nordwind integrations")})`);
		assert(normalizeTopicTitle("Team and roles") === normalizeTopicTitle("Team roles"), "two titles that differ by a stop word normalise alike");
		assert(normalizeTopicTitle("Zuständigkeiten & Rollen") === "zuständigkeiten rollen", `letters of any alphabet are letters, punctuation is a space (${normalizeTopicTitle("Zuständigkeiten & Rollen")})`);
		const NEAR_DOC: MemoryDocument = {
			...DOC,
			topics: [
				...DOC.topics,
				{ section: "Deep Memory", title: "Nordwind integration", heading: "### Nordwind integration", intro: "", entries: [entry("m-0007", "fact", "- Nordwind's orders arrive over the nightly feed.")] },
				{ section: "Deep Memory", title: "Team and roles", heading: "### Team and roles", intro: "", entries: [entry("m-0008", "fact", "- The account owner signs off scope changes.")] },
			],
		};
		const NEAR_AREAS = areasFrom(NEAR_DOC);
		const nearRefusals = (topic: string) => refuse([{ op: "add", topic, kind: "fact", text: "- Retries are attempted three times, ten minutes apart." }], NEAR_AREAS);
		const isTopic = /is the topic "Nordwind integration"; write "topic":"Nordwind integration"/;
		assert(nearRefusals("nordwind integration").length === 0, `a title that is an existing one in other case files under it and is not refused (${nearRefusals("nordwind integration").join("; ")})`);
		const plural = nearRefusals("The Nordwind integrations");
		assert(plural.length === 1 && isTopic.test(plural[0]), `green-with: a title that names an existing topic with a stop word and a plural is refused with the existing title (${plural.join("; ")})`);
		const narrower = nearRefusals("Nordwind integration retries");
		assert(narrower.length === 1 && isTopic.test(narrower[0]), `green-with: a title that narrows an existing two-word topic is refused with the existing title (${narrower.join("; ")})`);
		assert(nearRefusals("Nordwind").length === 0, `a one-word title inside a longer topic is a subject of its own and is accepted (${nearRefusals("Nordwind").join("; ")})`);
		const stopWord = nearRefusals("Team roles");
		assert(stopWord.length === 1 && /is the topic "Team and roles"; write "topic":"Team and roles"/.test(stopWord[0]), `green-with: a title that differs from an existing one by a stop word is refused with the existing title (${stopWord.join("; ")})`);
		assert(nearDuplicateTopicTitle("Nordwind integration", ["Nordwind integration"]) === undefined, "the exact title is that topic, not a near-duplicate of it");
		assert(without(plural, /is the topic/).length === 0, "red-without: with that rule removed nothing else refuses the op");
		const damage = applyFoldOps(NEAR_DOC, [{ op: "add", topic: "The Nordwind integrations", kind: "fact", text: "- Retries are attempted three times, ten minutes apart." }], CTX);
		assert(damage.record.newTopics.includes("The Nordwind integrations") && damage.doc.topics.filter((topic) => /nordwind/i.test(topic.title)).length === 2, "red-without: applying it opens a second heading for the one subject");
	}

	// 3g. A note memory already holds — red-without: the applier writes the point a second time.
	{
		const twinSentence = (n: number, id: string, topic: string) => `op ${n} (add): this says what note "${id}" under "${topic}" already says — update "${id}" if the point changed, or leave it out`;
		const EXACT = "- The Nordwind contract renews annually; legal signs before June.";
		const exact = refuse([{ op: "add", topic: "Commercial terms", kind: "fact", text: EXACT }]);
		assert(exact.length === 1 && exact[0] === twinSentence(1, "m-0001", "Commercial terms"), `green-with: an add that repeats a note word for word is refused with that note's id and topic (${exact.join("; ")})`);
		assert(without(exact, /already says/).length === 0, "red-without: with that rule removed nothing else refuses the op");
		const damage = applyFoldOps(DOC, [{ op: "add", topic: "Commercial terms", kind: "fact", text: EXACT }], CTX);
		assert(damage.doc.topics[0].entries.filter((e) => e.text === EXACT).length === 2, "red-without: applying it writes the one point twice under one heading");
		// The twin is named wherever the add is filed: the point is the same point.
		const elsewhere = refuse([{ op: "add", topic: "Working style", kind: "practice", text: EXACT }]);
		assert(elsewhere.length === 1 && elsewhere[0] === twinSentence(1, "m-0001", "Commercial terms"), `an add under another topic that repeats the note is refused naming the topic that holds it (${elsewhere.join("; ")})`);
		// Bullets, markers, stamps and ids are not words: the same point dressed differently is still the same point.
		const dressed = refuse([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- **must-keep** The Nordwind contract renews annually; legal signs before June. (saved 2026-07-08)" }]);
		assert(dressed.some((line) => line === twinSentence(1, "m-0001", "Commercial terms")), `a twin carrying a marker and a stamp is still a twin (${dressed.join("; ")})`);
		// A near duplicate: the same words with one extra adjective, at six words or more.
		const near = refuse([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind contract renews annually; legal always signs before June." }]);
		assert(near.length === 1 && near[0] === twinSentence(1, "m-0001", "Commercial terms"), `green-with: the same note with one extra adjective is refused (${near.join("; ")})`);
		// Two short notes that differ in one word are two points, not one.
		const SHORT_AREAS: AreaRow[] = [{ id: "m-0200", topic: "Commercial terms", section: "Deep Memory", kind: "fact", pinned: false, saved: "2026-06-01", tokens: 6, firstLine: "- Invoices go out monthly.", text: "- Invoices go out monthly." }];
		assert(validateFoldOps([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Invoices go out weekly." }], SHORT_AREAS, SESSION).length === 0, "two notes under six words that differ in one word are not twins");
		assert(validateFoldOps([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Invoices go out monthly." }], SHORT_AREAS, SESSION)[0] === twinSentence(1, "m-0200", "Commercial terms"), "a short note repeated word for word is still a twin");
		// Two adds in one reply that say one thing: the second is refused against the first.
		const NEW_POINT = "- The counterparty's escalation contact is the commercial lead, reachable through the shared inbox.";
		const pair = refuse([
			{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT },
			{ op: "add", topic: "Counterparties", kind: "fact", text: "- The counterparty's escalation contact is the commercial lead, reachable through the shared inbox now." },
		]);
		assert(pair.length === 1 && pair[0] === `op 2 (add): this says what op 1 (add) already says — keep one of them`, `green-with: the second of two adds that say one thing is refused against the first (${pair.join("; ")})`);
		// The working copy: the areas the next conversation is judged against are
		// read off the document the previous fold produced, so a note added by
		// conversation 3 is a twin conversation 7 cannot add again.
		const folded = applyFoldOps(DOC, [{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }], CTX);
		const nextAreas = listAreas(folded.doc);
		assert(nextAreas.some((area) => area.id === foldEntryId(7) && area.text === NEW_POINT), "the area map of the working copy carries the just-added note with its text");
		const again = validateFoldOps([{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }], nextAreas, { id: "RC-0011", text: "### RC-0011\n\nA later conversation." });
		assert(again.length === 1 && again[0] === twinSentence(1, foldEntryId(7), "Counterparties"), `a later conversation's add of the same point is refused against the note the earlier fold added (${again.join("; ")})`);
		assert(validateFoldOps([{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }], AREAS, SESSION).length === 0, "against the areas as they were before that fold the same add is accepted");
	}
	console.log("3. refusals: every server rule green-with, and red-without for pinned protection, unknown id, drop-with-others, pin-without-because, near-duplicate topics and repeated notes");
}

// --- 4. Application ----------------------------------------------------------

{
	const ops: FoldOp[] = [
		{ op: "supersede", id: "m-0001", text: "- The Nordwind contract renews annually; legal signs before the end of April (moved from June on 2026-09-04)." },
		{ op: "update", id: "m-0002", text: "- The quarterly report is due on the 5th working day of the quarter." },
		{ op: "close", id: "m-0005" },
		{ op: "pin", id: "m-0004", because: PIN_REQUEST },
		{ op: "add", topic: "Counterparties", kind: "fact", text: "- The counterparty's escalation contact is the commercial lead, reachable through the shared inbox." },
		{ op: "add", topic: FOLD_ACTIVE_ITEMS_TOPIC, kind: "item", text: "- Confirm the new notice date with legal before the end of April." },
	];
	assert(validateFoldOps(ops, AREAS, SESSION).length === 0, `the fold validates (${validateFoldOps(ops, AREAS, SESSION).join("; ")})`);
	const { doc, record, nextEntryNumber } = applyFoldOps(DOC, ops, CTX);

	assert(record.sessionId === SESSION_ID && record.dropped === undefined, "the record names the session it folded and was not a drop");
	assert(record.superseded.length === 1 && record.superseded[0].id === "m-0001" && record.superseded[0].before === "- The Nordwind contract renews annually; legal signs before June." && record.superseded[0].after.includes("end of April"), "the superseded text is recorded before and after");
	assert(record.updated.length === 1 && record.updated[0].before.includes("10th working day") && record.updated[0].after.includes("5th working day"), "the updated text is recorded before and after");
	assert(record.closed.length === 1 && record.closed[0].id === "m-0005" && record.closed[0].text.includes("billing reconciliation"), "the closed item is recorded with the text it had");
	assert(record.pinned.join() === "m-0004" && record.unpinned.length === 0, "the pin is recorded");
	assert(record.newTopics.join() === "Counterparties", "the new topic is recorded once");
	assert(record.added.length === 2 && record.added[0].id === foldEntryId(7) && record.added[1].id === foldEntryId(8), `new ids are zero-padded and increment (${record.added.map((a) => a.id).join(", ")})`);
	assert(record.added[0].topic === "Counterparties" && record.added[1].topic === FOLD_ACTIVE_ITEMS_TOPIC, "each added entry is recorded under the topic it landed in");
	assert(nextEntryNumber === 9 && doc.nextEntryNumber === 9, "the counter moves on by the number of entries added");

	const counterparties = doc.topics.find((topic) => topic.title === "Counterparties");
	assert(counterparties?.section === "Deep Memory" && counterparties.heading === "### Counterparties" && counterparties.entries.length === 1, "the new topic is created in Deep Memory with its heading");
	assert(doc.topics[doc.topics.length - 1].section === "Active Items", "Active Items stays the last topic when a Deep Memory topic is created");
	const added = counterparties.entries[0];
	assert(added.saved === CTX.savedDate && added.from === SESSION_ID && added.pinned === false && added.kind === "fact" && added.status === undefined, "a new fact carries the saved date and the session it came from, unpinned and without a status");
	const newItem = doc.topics[doc.topics.length - 1].entries.find((e) => e.id === foldEntryId(8));
	assert(newItem?.status === "open" && newItem.kind === "item", "a new item opens as an open item");

	const superseded = doc.topics[0].entries[0];
	assert(superseded.updated === CTX.savedDate && superseded.refs === 1 && superseded.saved === "2026-07-08", "a supersede stamps updated and counts a reference, and leaves the original saved date alone");
	assert(doc.topics[0].entries[1].updated === CTX.savedDate && doc.topics[0].entries[1].refs === 1, "an update stamps updated and counts a reference");
	const activeItems = doc.topics.find((topic) => topic.section === "Active Items");
	const closed = activeItems?.entries.find((e) => e.id === "m-0005");
	assert(closed?.status === "done" && closed.text === "- Close out the billing reconciliation before the renewal.", "a closed item keeps its text and changes only its status");
	assert(closed.updated === CTX.savedDate && closed.refs === 1, "a close stamps updated and counts a reference: this session referenced the item, and the ranker reads refs");
	assert(doc.topics[1].entries[1].pinned === true && doc.topics[1].entries[1].refs === undefined, "a pin pins and nothing else");

	assert(doc.topics[1].entries[0].text === DOC.topics[1].entries[0].text && doc.topics[1].entries[0].pinned === true, "the entry no operation named is untouched");
	assert(doc.recentContext === DOC.recentContext, "Recent Context is left exactly as it was — removing the folded session is the route's job");
	assert(doc.chronos === DOC.chronos && doc.preamble === DOC.preamble, "Chronos and the preamble are untouched");

	assert(DOC.topics[0].entries[0].text === "- The Nordwind contract renews annually; legal signs before June." && DOC.topics[2].entries[0].status === "open" && DOC.nextEntryNumber === 7 && DOC.topics.length === 3, "the source document is not mutated: the applier is pure");

	const summary = summarizeFold(record);
	assert(summary.added === 2 && summary.updated === 1 && summary.superseded === 1 && summary.closed === 1 && summary.dropped === false, `the summary counts what was applied (${JSON.stringify(summary)})`);

	const dropped = applyFoldOps(DOC, [{ op: "drop", reason: "a status check whose result is already an entry" }], CTX);
	assert(summarizeFold(dropped.record).dropped && dropped.record.added.length === 0 && dropped.nextEntryNumber === 7 && JSON.stringify(dropped.doc) === JSON.stringify(DOC), "a drop consolidates the session and changes no memory");

	const unpin = applyFoldOps(DOC, [{ op: "unpin", id: PINNED, because: PIN_REQUEST }], CTX);
	assert(unpin.record.unpinned.join() === PINNED && unpin.doc.topics[1].entries[0].pinned === false, "unpin is applied and recorded (the validator is what refuses it on a pinned entry)");
	console.log("4. apply: record, provenance, id increments, new topic, closed item, purity");
}

// --- 4a. A must-keep marker in the text pins the entry -----------------------

{
	// Green-with: the marker travels with the words, so the entry a fold writes
	// is pinned exactly as migration would pin it — and no "because" is needed,
	// because the request IS the text.
	const MARKED = "- **must-keep** The renewal notice must be filed before the end of April, every year.";
	const added = applyFoldOps(DOC, [{ op: "add", topic: "Commercial terms", kind: "fact", text: MARKED }], CTX);
	const minted = added.doc.topics[0].entries.find((e) => e.id === foldEntryId(7));
	assert(minted?.pinned === true && added.record.pinned.join() === foldEntryId(7), `green-with: an add carrying **must-keep** is pinned and recorded as pinned (${JSON.stringify(added.record.pinned)})`);
	assert(validateFoldOps([{ op: "add", topic: "Commercial terms", kind: "fact", text: MARKED }], AREAS, SESSION).length === 0, "it needs no because: the validator accepts it as an ordinary add");

	// Red-without: the same add with the marker taken out lands unpinned, and the
	// next fold is then free to rewrite it — which is the loss the rule prevents.
	const UNMARKED = MARKED.replace("**must-keep** ", "");
	const plain = applyFoldOps(DOC, [{ op: "add", topic: "Commercial terms", kind: "fact", text: UNMARKED }], CTX);
	const unpinned = plain.doc.topics[0].entries.find((e) => e.id === foldEntryId(7));
	assert(unpinned?.pinned === false && plain.record.pinned.length === 0, "red-without: without the marker the same entry lands unpinned");
	const nextRoundMarked = areasFrom(added.doc);
	const nextRoundPlain = areasFrom(plain.doc);
	assert(validateFoldOps([{ op: "update", id: foldEntryId(7), text: "- Something else entirely." }], nextRoundMarked, SESSION).some((line) => /is pinned/.test(line)), "green-with: on the next fold the marked entry refuses an update");
	assert(validateFoldOps([{ op: "update", id: foldEntryId(7), text: "- Something else entirely." }], nextRoundPlain, SESSION).length === 0, "red-without: the unmarked twin is rewritable, and the user's request is gone");

	// update and supersede pin the same way, and the marker is read case-insensitively.
	const viaUpdate = applyFoldOps(DOC, [{ op: "update", id: "m-0002", text: "- **MUST-KEEP** The quarterly report is due on the 5th working day." }], CTX);
	assert(viaUpdate.doc.topics[0].entries[1].pinned === true && viaUpdate.record.pinned.join() === "m-0002", "an update whose new text carries the marker pins the entry, whatever its case");
	const viaSupersede = applyFoldOps(DOC, [{ op: "supersede", id: "m-0002", text: "- **must-keep:** The report day moved to the 5th working day." }], CTX);
	assert(viaSupersede.doc.topics[0].entries[1].pinned === true && viaSupersede.record.pinned.join() === "m-0002", "a supersede does the same, and the marker is read as the memory writes it");
	const bothWays = applyFoldOps(DOC, [{ op: "pin", id: "m-0004", because: PIN_REQUEST }, { op: "add", topic: "Working style", kind: "practice", text: "- **must-keep** Numbers come first." }], CTX);
	assert(bothWays.record.pinned.join() === `m-0004,${foldEntryId(7)}` && bothWays.doc.topics[1].entries.every((e) => e.pinned), "an asked-for pin and a marker-carried one land in the same record, one entry each");
	// An entry that is already pinned is not recorded a second time by its own marker.
	const marked = applyFoldOps(DOC, [{ op: "add", topic: "Working style", kind: "practice", text: "- **must-keep** Numbers come first." }], CTX);
	assert(marked.record.pinned.join() === foldEntryId(7) && applyFoldOps(marked.doc, [{ op: "close", id: "m-0005" }], { ...CTX, nextEntryNumber: 8 }).record.pinned.length === 0, "a fold that pins nothing records nothing, and an already-pinned entry is not re-recorded");
	console.log("4a. must-keep: a marker in the text pins the entry, red-without and green-with");
}

// --- 4b. The validator and the applier agree on what a topic is ---------------

{
	const ops: FoldOp[] = [{ op: "add", topic: "commercial TERMS", kind: "fact", text: "- The counterparty moved the notice window to April." }];
	assert(validateFoldOps(ops, AREAS, SESSION).length === 0, `a differently-cased existing topic title validates clean (${validateFoldOps(ops, AREAS, SESSION).join("; ")})`);
	const { doc, record } = applyFoldOps(DOC, ops, CTX);
	assert(record.newTopics.length === 0, "no new topic is recorded — the title names one that exists");
	assert(doc.topics.length === DOC.topics.length && doc.topics[0].entries.length === 3 && doc.topics[0].entries[2].id === foldEntryId(7), "the entry lands in the existing topic, under its real title");
	assert(record.added[0].topic === "Commercial terms", "the record names the topic as memory spells it, not as the operation spelled it");
	// The same agreement on Active Items and on the bullet shape of a topic.
	assert(validateFoldOps([{ op: "add", topic: " active items ", kind: "item", text: "- Confirm the notice date with legal." }], AREAS, SESSION).length === 0, "a padded, differently-cased Active Items title is not judged as a new Deep Memory topic");
	assert(validateFoldOps([{ op: "add", topic: "commercial TERMS", kind: "fact", text: "Not a bullet." }], AREAS, SESSION).some((line) => /must start with "- "/.test(line)), "the existing topic's bullet shape binds through the same match");
	console.log("4b. topics: the validator and the applier resolve a title the same way");
}

// --- 5. The discussion sign-off ----------------------------------------------

{
	const task = buildFoldGuidanceSignoffTask();
	for (const heading of ["### Pin", "### Drop", "### Corrections", "### Topics", "### Instructions"]) assert(task.includes(heading), `the sign-off task asks for ${heading}`);
	assert(task.includes("RC-NNNN — reason") && task.includes("create: Title") && task.includes("merge: A + B → C"), "the sign-off task shows the line shapes the parser reads");
	assert(task.includes("Do not claim anything has been saved."), "the sign-off task keeps the no-claim line");

	const SIGNOFF = `## Memorize discussion signoff

### Pin
- m-0003
m-0004

### Drop
- RC-0009 — a short status check with nothing durable in it
- RC-0011 — a repeat of what memory already holds

### Corrections
- The reporting day is the 5th working day, not the 10th.
- The CRM decision was reversed in August.

### Topics
- create: Counterparties
- merge: Commercial terms + Renewals → Commercial terms
- tidy up the working style topic

### Instructions
- Keep entries to one line where the point fits in one.
`;
	const parsed = parseFoldGuidance(SIGNOFF);
	assert(parsed.pin.join() === "m-0003,m-0004", `pins are read one id per line, bulleted or not (${parsed.pin.join()})`);
	assert(parsed.drop.length === 2 && parsed.drop[0].session === "RC-0009" && parsed.drop[0].reason === "a short status check with nothing durable in it", `drops are read as session and reason (${JSON.stringify(parsed.drop[0])})`);
	assert(parsed.corrections.length === 2 && parsed.corrections[1] === "The CRM decision was reversed in August.", "corrections are read as free lines");
	assert(parsed.topics.length === 2 && parsed.topics[0].action === "create" && parsed.topics[0].title === "Counterparties", "a create line is read");
	const merge = parsed.topics[1];
	assert(merge.action === "merge" && merge.sources.join(" + ") === "Commercial terms + Renewals" && merge.title === "Commercial terms", `a merge line is read (${JSON.stringify(merge)})`);
	assert(parsed.instructions.length === 2 && parsed.instructions.includes("tidy up the working style topic") && parsed.instructions.includes("Keep entries to one line where the point fits in one."), `a Topics line that is neither create nor merge is kept as an instruction rather than dropped (${parsed.instructions.join(" | ")})`);

	const empty = parseFoldGuidance("## Memorize discussion signoff\n\n### Pin\nNone\n\n### Drop\nNone.\n\n### Corrections\n\n### Topics\nNone\n\n### Instructions\nNone\n");
	assert(empty.pin.length === 0 && empty.drop.length === 0 && empty.corrections.length === 0 && empty.topics.length === 0 && empty.instructions.length === 0, "None sections read as nothing asked for");
	assert(renderFoldGuidance(empty).includes("signed off without further instructions"), "empty guidance renders as a sentence");
	assert(parseFoldGuidance("").pin.length === 0, "a missing sign-off is empty guidance, not a throw");

	// Round trip: everything the user said reaches the fold prompt.
	const rendered = renderFoldGuidance(parsed);
	assert(rendered.includes("m-0003, m-0004") && rendered.includes("RC-0009 — a short status check with nothing durable in it") && rendered.includes("The CRM decision was reversed in August.") && rendered.includes('Create the topic "Counterparties"') && rendered.includes('"Commercial terms" and "Renewals" are to become "Commercial terms"') && rendered.includes("tidy up the working style topic") && rendered.includes("Keep entries to one line"), `every parsed instruction is rendered for the fold (${rendered})`);
	assert(rendered.includes("do not emit pin operations for them"), "the render tells the fold the system pins what the user pinned");
	const arrows = parseFoldGuidance("### Topics\n- merge: A + B -> C\n");
	assert(arrows.topics.length === 1 && arrows.topics[0].action === "merge" && arrows.topics[0].title === "C", "a plain -> arrow is read like the typographic one");
	console.log("5. guidance: sign-off task, parse and render round trip");
}

console.log("absorb-ops smoke passed");
