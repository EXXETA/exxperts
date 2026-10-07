export {};

// Memory v2 stream C: the Memorize fold operation layer's promises as
// predicates. Everything is imported from the real module, never an inline
// copy. Each op of a reply is decided alone: applied, fixed by code,
// redirected as a new note, left out because memory already says every word
// of it, or traced when it carries no content; the section on decisions
// proves each rule's fate.

import type { AreaRow, FoldGuidance, FoldOp, MemoryDocument, MemoryEntry } from "../src/absorb-ops.js";

const {
	applyFoldOps,
	buildFoldGuidanceSignoffTask,
	buildFoldPrompt,
	countWords,
	decideFoldOps,
	nearDuplicateTopicTitle,
	normalizeTopicTitle,
	FOLD_ACTIVE_ITEMS_TOPIC,
	FOLD_MAX_OPS,
	FOLD_OP_KINDS,
	FOLD_MAX_TEXT_WORDS,
	FOLD_TOPIC_TITLE_MAX_CHARS,
	FOLD_TRIGGER_PROMPT,
	FOLD_UNSORTED_TOPIC,
	foldEntryId,
	parseFoldGuidance,
	parseFoldOps,
	readFoldOp,
	readFoldReply,
	renderFoldGuidance,
	summarizeFold,
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
const { conflictReason } = await import("../src/memory-duplicates.js");
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
				entry("m-0002", "fact", "- The quarterly report is due on the 10th working day of the quarter.", { updated: "2026-09-01", learned: "2026-09-01" }),
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
			...(e.learned ? { learned: e.learned } : {}),
			...(e.from ? { from: e.from } : {}),
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
	// An entry a dated conversation wrote reads the day it was learned; one a
	// fold wrote before days were learned reads its saved day and the day a fold
	// rewrote it; one nothing wrote reads "in memory since", a floor on its age.
	const sinceAreas = AREAS.map((area, i) => (i === 1 ? { ...area, learned: "2026-08-30" } : i === 3 ? { ...area, from: undefined } : i === 4 ? { ...area, updated: "2026-09-10" } : i === 5 ? { ...area, from: undefined, updated: "2026-09-10" } : area));
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
	assert(prompt.includes("[m-0001 · saved 2026-07-08]"), "an entry a fold wrote before days were learned reads its saved day");
	assert(prompt.includes("[m-0005 · saved 2026-07-08 · rewritten 2026-09-10]"), "and the day a later fold rewrote it");
	assert(prompt.includes("[m-0004 · in memory since 2026-07-08]") && prompt.includes("[m-0006 · in memory since 2026-07-08 · rewritten 2026-09-10]"), "an entry nothing wrote reads \"in memory since\", with a rewrite when it had one");
	assert(prompt.includes("[m-0002 · learned 2026-08-30]") && !/learned 2026-08-30 · /.test(prompt), "an entry a dated conversation wrote reads the day it was learned, and nothing else");
	assert(!/· updated 20/.test(prompt), "no address reads an updated day: a rewrite reads as rewritten");
	assert(prompt.includes('reads "in memory since"') && prompt.includes("an entry saved or rewritten AFTER this session's date also knows more than this session does, so never supersede or update it either") && prompt.includes("unless it also carries a rewritten date after the session's"), "the constitution tells the fold how to read each form: a saved or rewritten day after the session's is newer");
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
	assert(prompt.includes("- [m-0003 · pinned · saved 2026-08-21] **must-keep** Send commercial summaries as one page, numbers first."), "a pinned entry carries its address, its pin and its date in its own first line");
	assert(prompt.includes("- [m-0001 · saved 2026-07-08] The Nordwind contract renews annually; legal signs before June."), "an unpinned entry with no learned day carries its address and its saved day, and no pin marker");
	assert(prompt.includes("- [m-0002 · learned 2026-09-01] The quarterly report is due on the 10th working day of the quarter."), "an entry a dated conversation wrote carries the day it was learned");
	// The dates are the fold's, dressed onto the render it was given: the render
	// itself still writes the bare address, and every other reader keeps it.
	assert(CORE_CONTEXT.includes("- [m-0001] The Nordwind") && !CORE_CONTEXT.includes("saved 2026"), "the entry model's render is untouched; the dates are the prompt's own");
	assert(prompt.includes(`This conversation is from ${SESSION_DATE}: it is newer than every entry learned, saved or rewritten before that day, and older than every entry learned, saved or rewritten after it.`), "the task states the day the conversation is from, and what that means against the entries' dates");
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
	assert(prompt.includes("whose text a conversation of 2026-08-02 wrote") && prompt.includes("saved 2026-08-02 · rewritten 2026-09-01]` is an entry a fold wrote before days were learned") && prompt.includes("no conversation wrote it") && prompt.includes("Copy the id alone") && prompt.includes("`m-0031`, never the dates or the pin marker"), "the legend explains the learned, the saved and rewritten, and the in-memory-since dates and says to copy the id alone");
	for (const shape of ['"op":"add"', '"op":"update"', '"op":"supersede"', '"op":"close"', '"op":"pin"', '"op":"drop"']) assert(prompt.includes(shape), `the task shows the ${shape} shape`);
	assert(!/unpin/i.test(prompt), "the prompt never offers unpin: only the person unpins");
	assert(prompt.includes(`at most ${FOLD_MAX_OPS} operations`) && prompt.includes(`at most ${FOLD_MAX_TEXT_WORDS} words`), "the task states its soft bounds");
	assert(prompt.includes("at most three lines") && prompt.includes("exactly one ```json fence"), "the task asks for a three-line narrative and exactly one fence");
	assert(prompt.includes("Do not claim anything has been saved."), "the task keeps the no-claim line");
	assert(prompt.includes("A point memory already holds is updated, never repeated.") && !/\brefused\b/.test(prompt), "the governing principle asks for no repeats, and the prompt promises no refusal");
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
	const datesTokens = areas.length * estimateTokens(" · in memory since 2026-09-12");
	const ceiling = Math.round(1.2 * (coreTokens + 3000 + datesTokens));
	console.log(`1a. prompt on a generated ${areas.length}-entry room at its 20k budget: ~${big.telemetry.promptEstimatedTokens} estimated tokens against a ceiling of ${ceiling} (core ${coreTokens}, dates ~${datesTokens}, session ~${estimateTokens(session)})`);
	assert(big.telemetry.promptEstimatedTokens < ceiling, `a fold prompt is the memory plus its dates plus a frame, not the memory twice: ~${big.telemetry.promptEstimatedTokens} tokens against 1.2 × (${coreTokens} + 3000 + ${datesTokens}) = ${ceiling}`);
	// The frame's own instructions quote example addresses (`[m-0031 · saved …]`),
	// and a room of this size has notes with those ids, so the count is against
	// the same prompt — same areas, same instructions — built on an empty memory
	// text: the memory adds each address exactly once.
	const frame = buildFoldPrompt({
		agentId: "room-smoke",
		model: { provider: "gateway", model: "fold-model" },
		coreContext: "## Deep Memory\n",
		areas,
		assessmentMarkdown: ASSESSMENT,
		session: { id: sessionId, text: session },
		sessionIndex: 1,
		sessionCount: 10,
		now: new Date("2026-09-12T09:00:00.000Z"),
	}).prompt;
	const addressed = (text: string, id: string) => text.split(`[${id} `).length + text.split(`[${id}]`).length - 2;
	assert(areas.every((area) => addressed(big.prompt, area.id) - addressed(frame, area.id) === 1), "no entry of a real-sized room is addressed twice");
	assert(areas.every((area) => big.prompt.includes(`[${area.id} · ${area.learned ? `learned ${area.learned}` : `${area.from ? "saved" : "in memory since"} ${area.saved}${area.updated ? ` · rewritten ${area.updated}` : ""}`}`)), "every entry of a real-sized room carries its date in its address");
}

// --- 2. Reading the reply ----------------------------------------------------

const CLEAN_OPS = '{"ops":[{"op":"supersede","id":"m-0001","text":"- The Nordwind contract renews annually; legal signs before the end of April."},{"op":"close","id":"m-0005"}]}';

{
	const clean = parseFoldOps(`Two changes: the notice window moved and the reconciliation is done.\n\n\`\`\`json\n${CLEAN_OPS}\n\`\`\`\n`);
	assert(clean.problems.length === 0 && clean.items.length === 2, `a clean reply parses (${clean.problems.join("; ")})`);
	assert(clean.items[0].op === "supersede" && clean.items[1].op === "close", "the ops keep their order and kinds");
	assert(clean.narrative === "Two changes: the notice window moved and the reconciliation is done.", `the narrative before the fence is kept (${clean.narrative})`);

	const decorated = parseFoldOps(`### **What this session leaves behind**\n\nThe renewal's notice window moved; the reconciliation closed.\n\n### **Operations**\n\n\`\`\`json\n${CLEAN_OPS}\n\`\`\`\n\nNothing else changed.\n`);
	assert(decorated.problems.length === 0 && decorated.items.length === 2, "prose and ### **bold** decoration around the fence are tolerated");
	assert(!decorated.narrative.includes("Operations"), "a trailing heading that only labels the fence is not narrative");

	const twoFences = parseFoldOps(`A sketch first:\n\n\`\`\`json\n{"ops":[{"op":"drop","reason":"sketch"}]}\n\`\`\`\n\nThe real list:\n\n\`\`\`json\n${CLEAN_OPS}\n\`\`\`\n`);
	assert(twoFences.problems.length === 0 && twoFences.items.length === 2 && twoFences.items[0].op === "supersede", "with two fences the LAST one wins");

	const untagged = parseFoldOps(`Here it is.\n\n\`\`\`\n${CLEAN_OPS}\n\`\`\`\n`);
	assert(untagged.problems.length === 0 && untagged.items.length === 2, "a fence without the json tag is read the same");

	const cut = parseFoldOps(`The renewal moved.\n\n\`\`\`json\n{"ops":[{"op":"supersede","id":"m-0001","text":"- The Nord`);
	assert(cut.items.length === 0 && cut.problems.length === 1 && /cut off/.test(cut.problems[0]), `a reply cut mid-fence is a named problem (${cut.problems[0]})`);
	assert(cut.narrative.startsWith("The renewal moved."), "the narrative of a cut reply survives for the diagnostics");

	const none = parseFoldOps("I folded the session into memory and saved it.");
	assert(none.items.length === 0 && none.problems.length === 1 && /no ```json fence/.test(none.problems[0]), `a reply with no fence is a named problem (${none.problems[0]})`);

	// Never throws: the reader answers with the class of an unreadable reply, which the run records.
	for (const bad of ["", "```json\n{not json}\n```", "```json\n\n```", "prose only"]) {
		const result = readFoldReply(bad);
		assert(result.list === undefined && result.unreadable, `an unreadable reply returns its class rather than throwing (${JSON.stringify(bad).slice(0, 30)})`);
	}
	const readable = readFoldReply(`\`\`\`json\n${CLEAN_OPS}\n\`\`\``);
	assert(Array.isArray(readable.list) && readable.list.length === 2 && !readable.unreadable, "a readable fence returns the parsed op list");
	const shapes = parseFoldOps('```json\n{"ops":[{"op":"rename","id":"m-0001"},{"op":"add","kind":"fact","text":"- x"},{"op":"update","id":"m-0001"},{"op":"drop"}]}\n```');
	assert(shapes.problems.length === 0 && shapes.items.length === 4 && shapes.items.map((item) => item.op).join() === "rename,add,update,drop", `each malformed op is read alone, with its kind (${shapes.items.map((item) => item.op).join()})`);
	console.log("2. parse: clean, decorated, two-fence, untagged, cut and fenceless replies all read without throwing");
}

// --- 3. Decisions ------------------------------------------------------------

/** The reply's ops as the reader hands them over, decided against the areas. */
const decide = (list: unknown[], areas: AreaRow[] = AREAS, ctx: { keptForFolds?: Set<string> } = {}) => decideFoldOps(list.map(readFoldOp), areas, SESSION, ctx);
const fateOf = (decided: ReturnType<typeof decide>, n = 0) => { const d = decided.decisions[n]; return `${d.fate}${d.codes.length ? `:${d.codes.join("+")}` : ""}`; };
const areaRow = (id: string, text: string, saved: string, extra: Partial<AreaRow> = {}): AreaRow => ({ id, topic: "Commercial terms", section: "Deep Memory", kind: "fact", pinned: false, saved, tokens: estimateTokens(text), firstLine: text, text, ...extra });

{
	const GOOD = [{ op: "supersede", id: "m-0001", text: "- The Nordwind contract renews annually; legal signs before the end of April." }];
	const good = decide(GOOD);
	assert(good.landed && good.ops.length === 1 && good.ops[0].op === "supersede" && fateOf(good) === "applied", `a well-formed op is applied as it is (${fateOf(good)})`);

	// 3a. A pinned note: a change aimed at it is added beside it, tagged; the note never changes.
	{
		const update = decide([{ op: "update", id: PINNED, text: "- Send commercial summaries as two pages." }]);
		const add = update.ops[0];
		assert(update.ops.length === 1 && add.op === "add" && add.topic === "Working style" && add.kind === "practice" && add.beside === "pinned", `an update of a pinned note becomes an add beside it, tagged (${JSON.stringify(update.ops)})`);
		assert(fateOf(update) === "redirected:beside-pinned" && update.pairs.besidePinned === 1, `it is counted as redirected beside a pinned note (${fateOf(update)})`);
		assert((update.ops[0] as { besideOf?: string }).besideOf === PINNED && applyFoldOps(DOC, update.ops, CTX).record.added[0].besideOf === PINNED, "the add names the pinned note it stands beside, and the record keeps it");
		const applied = applyFoldOps(DOC, update.ops, CTX);
		assert(applied.doc.topics[1].entries[0].text === DOC.topics[1].entries[0].text && applied.doc.topics[1].entries[0].pinned && applied.record.added[0].beside === "pinned", "the pinned note is untouched and the new row carries the tag");
		const supersede = decide([{ op: "supersede", id: PINNED, text: "- Send commercial summaries as two pages." }]);
		assert(supersede.ops[0].op === "add" && fateOf(supersede) === "redirected:beside-pinned", "a supersede of a pinned note is added beside it too");
		const ITEM_PINNED = [...AREAS.filter((area) => area.id !== "m-0006"), { ...AREAS.find((area) => area.id === "m-0006")!, pinned: true }];
		const item = decide([{ op: "update", id: "m-0006", text: "- Decide on the vendor follow-up after the renewal." }], ITEM_PINNED);
		assert(item.ops[0].op === "add" && item.ops[0].topic === FOLD_ACTIVE_ITEMS_TOPIC && item.ops[0].kind === "item", "beside a pinned item, the new text stays an item in Active Items");
		const close = decide([{ op: "close", id: PINNED }]);
		assert(close.ops.length === 0 && fateOf(close) === "traced:close-pinned" && !close.landed, `a close of a pinned note is traced, and nothing lands (${fateOf(close)})`);
		assert(fateOf(decide([{ op: "pin", id: PINNED, because: PIN_REQUEST }])) === "traced:already-pinned", "a pin of a pinned note is traced");
		const same = decide([{ op: "update", id: PINNED, text: "- Send commercial summaries as one page, numbers first." }]);
		assert(same.ops.length === 0 && same.landed && fateOf(same) === "left-out:beside-pinned+subset", `an update saying nothing the pinned note does not is left out (${fateOf(same)})`);
		// A kept note (a resume pins it for the folds only): redirected the same way, never tagged.
		const KEPT_AREAS = AREAS.map((area) => (area.id === "m-0004" || area.id === "m-0006" ? { ...area, pinned: true } : area));
		const kept = new Set(["m-0004", "m-0006"]);
		const keptUpdate = decide([{ op: "update", id: "m-0004", text: "- Decisions are written down within the hour." }], KEPT_AREAS, { keptForFolds: kept });
		assert(keptUpdate.ops[0].op === "add" && keptUpdate.ops[0].beside === undefined && fateOf(keptUpdate) === "redirected:beside-kept" && keptUpdate.pairs.besidePinned === 0, `an update of a kept note is added beside it, untagged (${fateOf(keptUpdate)})`);
		assert(fateOf(decide([{ op: "close", id: "m-0006" }], KEPT_AREAS, { keptForFolds: kept })) === "traced:close-kept", "a close of a kept item is traced");
		assert(decide([{ op: "pin", id: "m-0004", because: PIN_REQUEST }], KEPT_AREAS, { keptForFolds: kept }).ops[0]?.op === "pin", "a kept note can still be pinned when the page asks");
		const keptConflict = decide([{ op: "add", topic: "Working style", kind: "practice", text: "- Decisions are not written down the same day they are taken." }], KEPT_AREAS, { keptForFolds: kept });
		assert((keptConflict.ops[0] as { beside?: string }).beside === "may-disagree" && keptConflict.pairs.mayDisagree === 1, `a new note that may disagree with a kept note is tagged "may disagree", never "pinned" (${JSON.stringify(keptConflict.ops[0])})`);
	}

	// 3b. An unknown id: repaired when it is an id copied loosely, else the text is kept in Unsorted.
	{
		const unknown = decide([{ op: "update", id: "m-9999", text: "- Something about an entry that does not exist." }]);
		assert(unknown.ops[0].op === "add" && unknown.ops[0].topic === FOLD_UNSORTED_TOPIC && unknown.ops[0].kind === "fact" && fateOf(unknown) === "redirected:unknown-id", `an update of an unknown id is kept in Unsorted (${fateOf(unknown)})`);
		assert(fateOf(decide([{ op: "update", text: "- A rewrite with no id." }])) === "redirected:no-id", "an update with no id is kept in Unsorted");
		assert(fateOf(decide([{ op: "close", id: "m-9999" }])) === "traced:unknown-id", "a close of an unknown id is traced");
		const near = decide([{ op: "close", id: "M-0005" }]);
		assert(near.ops[0].op === "close" && (near.ops[0] as { id: string }).id === "m-0005" && fateOf(near) === "normalised:id-repaired", `a near-miss id is repaired (${fateOf(near)})`);
		assert((decide([{ op: "close", id: "m-0005 · saved 2026-07-08" }]).ops[0] as { id: string }).id === "m-0005", "an id copied with its dates is repaired");
		let threw = "";
		try { applyFoldOps(DOC, [{ op: "update", id: "m-9999", text: "- x" }], CTX); } catch (error) { threw = (error as Error).message; }
		assert(/ops were not decided: unknown entry "m-9999"/.test(threw), `the applier still refuses an undecided unknown id (${threw})`);
	}

	// 3c. A drop stands only when nothing else changes.
	{
		const both = decide([{ op: "drop", reason: "status chatter only" }, { op: "add", topic: "Commercial terms", kind: "fact", text: "- The escalation contact is the commercial lead." }]);
		assert(both.ops.length === 1 && both.ops[0].op === "add" && fateOf(both, 0) === "traced:drop-with-content", `content wins over a drop beside it (${fateOf(both, 0)})`);
		const alone = decide([{ op: "drop", reason: "status chatter only" }]);
		assert(alone.ops.length === 1 && alone.ops[0].op === "drop" && (alone.ops[0] as { reason: string }).reason === "status chatter only" && alone.landed, "a drop on its own stands");
		const blank = decide([{ op: "drop", reason: "  " }]);
		assert((blank.ops[0] as { reason: string }).reason === "" && fateOf(blank) === "normalised:reason-empty", "a drop without a reason stands with none (the card has its own sentence)");
		assert(decide([{ op: "drop" }]).ops[0]?.op === "drop", "a drop with no reason field stands too");
		const two = decide([{ op: "drop", reason: "" }, { op: "drop", reason: "b" }]);
		assert(two.ops.length === 1 && (two.ops[0] as { reason: string }).reason === "b" && fateOf(two, 1) === "traced:extra-drop", "two drops are one, with the first reason given");
		const withText = decide([{ op: "drop", reason: "nothing", text: "- The escalation contact is the commercial lead." }]);
		assert(withText.ops.length === 1 && withText.ops[0].op === "add" && withText.ops[0].topic === FOLD_UNSORTED_TOPIC && fateOf(withText) === "redirected:drop-text+drop-with-content", `a drop carrying a text keeps the text in Unsorted (${fateOf(withText)})`);
		const known = decide([{ op: "drop", reason: "repeats memory" }, { op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind contract renews annually; legal signs before June." }]);
		assert(known.ops.length === 1 && known.ops[0].op === "drop" && fateOf(known, 1) === "left-out:subset", "a drop stands beside an add memory already holds");
	}

	// 3d. A pin needs the page's own words.
	{
		assert(fateOf(decide([{ op: "pin", id: "m-0002" }])) === "traced:pin-no-quote", "a pin without its quoted line is traced");
		assert(fateOf(decide([{ op: "pin", id: "m-0002", because: "The user asked me to pin this." }])) === "traced:quote-missing", "a quote the page does not hold is traced");
		assert(fateOf(decide([{ op: "pin", id: "m-0002", because: PIN_REQUEST }])) === "applied", "a pin quoting a line of the page applies");
		assert(fateOf(decide([{ op: "pin", id: "m-0002", because: `  ${PIN_REQUEST.replace(" pinned;", "  pinned;")}  ` }])) === "applied", "the quote is matched on one space run");
		const curly = decide([{ op: "pin", id: "m-0002", because: "\u201Cplease keep the one\u2011page rule pinned; I never want it rewritten.\u201D" }]);
		assert(fateOf(curly) === "normalised:quote-normalised" && curly.ops[0].op === "pin", `typographic quotes, dashes and case do not hide an honest quote (${fateOf(curly)})`);
		const pinText = decide([{ op: "pin", id: "m-0002", because: PIN_REQUEST, text: "- The report goes to the finance lead first." }]);
		assert(pinText.ops.map((op) => op.op).join() === "add,pin" && pinText.ops[0].op === "add" && pinText.ops[0].topic === "Commercial terms" && fateOf(pinText) === "redirected:pin-text", `a text on a pin goes beside the note (${fateOf(pinText)})`);
	}

	// 3e. Tidiness is fixed by code.
	{
		const item = decide([{ op: "add", topic: "Commercial terms", kind: "item", text: "- Chase the counterparty for the notice date." }]);
		assert(item.ops[0].op === "add" && item.ops[0].kind === "fact" && item.ops[0].topic === "Commercial terms" && fateOf(item) === "normalised:item-to-fact", "an item outside Active Items becomes a fact where it was filed");
		const fact = decide([{ op: "add", topic: FOLD_ACTIVE_ITEMS_TOPIC, kind: "fact", text: "- The renewal window moved to April." }]);
		assert(fact.ops[0].op === "add" && fact.ops[0].kind === "item" && fateOf(fact) === "normalised:fact-to-item", "a fact inside Active Items becomes an item");
		assert(decide([{ op: "add", topic: "Commercial terms", kind: "note", text: "- x y." }]).ops[0].op === "add" && fateOf(decide([{ op: "add", topic: "Commercial terms", kind: "note", text: "- x y." }])) === "normalised:kind-fixed", "an unknown kind becomes a fact outside Active Items");
		assert((decide([{ op: "add", topic: FOLD_ACTIVE_ITEMS_TOPIC, text: "- Chase legal." }]).ops[0] as { kind: string }).kind === "item", "and an item inside it");
		assert(fateOf(decide([{ op: "close", id: "m-0001" }])) === "traced:close-not-item", "a close of a note that is not an open item is traced");
		const bullet = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "The renewal window moved to April." }]);
		assert((bullet.ops[0] as { text: string }).text === "- The renewal window moved to April." && fateOf(bullet) === "normalised:bullet", "a missing bullet is added where the topic is bullets");
		const heading = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually.\n### Terms\n## Deep Memory" }]);
		assert((heading.ops[0] as { text: string }).text === "- Renews annually.\n\\### Terms\n\\## Deep Memory" && fateOf(heading) === "normalised:escaped", `a heading line is escaped and kept (${JSON.stringify((heading.ops[0] as { text: string }).text)})`);
		const comment = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually.\n<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->\n<!-- rc_metadata id=RC-0001 -->" }]);
		assert((comment.ops[0] as { text: string }).text === "- Renews annually." && fateOf(comment) === "normalised:comment-removed", "a copied metadata or rc_metadata line is removed");
		const open = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually.\n<!-- a note\nstill the note -->" }]);
		assert((open.ops[0] as { text: string }).text === "- Renews annually.\n\\<!-- a note\nstill the note -->", "a multi-line comment is escaped and kept");
		assert(fateOf(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually #q3." }])) === "applied", "a hashtag inside a line is a word, not a heading");
		const PROSE_AREAS: AreaRow[] = [{ id: "m-0100", topic: "Context", section: "Deep Memory", kind: "fact", pinned: false, saved: "2026-06-01", tokens: 20, firstLine: "The room exists to keep the renewal cycle honest.", text: "The room exists to keep the renewal cycle honest." }];
		assert(fateOf(decide([{ op: "add", topic: "Context", kind: "fact", text: "The counterparty moved the notice window." }], PROSE_AREAS)) === "applied", "a paragraph stays a paragraph where the topic's entries are paragraphs");
		const long = `- ${Array.from({ length: FOLD_MAX_TEXT_WORDS + 1 }, (_, i) => `word${i}`).join(" ")}`;
		assert(countWords(long) === FOLD_MAX_TEXT_WORDS + 2 && fateOf(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: long }])) === "applied", `a text over ${FOLD_MAX_TEXT_WORDS} words is accepted`);
		const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "heron", "ivory", "jetty", "kiln", "larch", "maple"];
		const many = decide(WORDS.map((word) => ({ op: "add", topic: "Commercial terms", kind: "fact", text: `- The ${word} account renews through its own channel.` })));
		assert(WORDS.length > FOLD_MAX_OPS && many.ops.length === WORDS.length, `more than ${FOLD_MAX_OPS} ops are all accepted (${many.ops.length})`);
		const twice = decide([{ op: "update", id: "m-0001", text: "- One." }, { op: "supersede", id: "m-0001", text: "- Two." }]);
		assert(twice.ops.map((op) => op.op).join() === "add,supersede" && fateOf(twice, 0) === "redirected:same-id-earlier" && (twice.ops[0] as { text: string }).text === "- One.", `the last text on one id wins, the earlier one is kept beside the note (${twice.ops.map((op) => op.op).join()})`);
		const earlierSaid = decide([{ op: "update", id: "m-0001", text: "- The Nordwind contract renews annually; legal signs off." }, { op: "supersede", id: "m-0001", text: "- The Nordwind contract renews annually; legal signs off each renewal." }]);
		assert(earlierSaid.ops.length === 1 && fateOf(earlierSaid, 0) === "left-out:same-id-earlier+same-in-reply" && earlierSaid.pairs.subsetInReply === 1, `an earlier text the winner says in full is left out, as a repeat within the reply (${fateOf(earlierSaid, 0)})`);
		const closeAfter = decide([{ op: "close", id: "m-0005" }, { op: "update", id: "m-0005", text: "- Close out the billing reconciliation; done on 4 September." }]);
		const closed = applyFoldOps(DOC, closeAfter.ops, CTX);
		const reconciliation = closed.doc.topics[2].entries.find((e) => e.id === "m-0005");
		assert(closeAfter.ops.map((op) => op.op).join() === "update,close" && reconciliation?.status === "done" && reconciliation.text.includes("4 September"), "an update and a close of one item end with the new text, done");
		const foreign = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind contract renews annually; legal signs before June.", id: "m-0001", section: "Deep Memory" }]);
		assert(foreign.ops.length === 0 && fateOf(foreign) === "left-out:foreign-keys+subset", `a stray key is dropped, and an add naming a note is judged against it (${fateOf(foreign)})`);
		assert(!decide([]).landed, "an empty list lands nothing");
		const topicOf = (topic: unknown, kind = "fact") => { const d = decide([{ op: "add", topic, kind, text: "- The escalation contact is the commercial lead." }]); return `${(d.ops[0] as { topic: string }).topic}|${d.decisions[0].codes.join("+")}`; };
		assert(topicOf("### Renewals") === "Renewals|topic-marks", `heading marks leave a title (${topicOf("### Renewals")})`);
		assert(topicOf("#Heading") === "Heading|topic-marks", "a mark with no space leaves a title too");
		for (const empty of ["#######", "---", " : ", "#"]) assert(topicOf(empty).startsWith(`${FOLD_UNSORTED_TOPIC}|`), `a title with no letter or digit goes to Unsorted (${JSON.stringify(empty)}: ${topicOf(empty)})`);
		assert(topicOf(undefined) === `${FOLD_UNSORTED_TOPIC}|topic-missing`, "an add with no topic goes to Unsorted");
		assert(topicOf("A") === `${FOLD_UNSORTED_TOPIC}|topic-length`, "a one-character title goes to Unsorted");
		const longTitle = `${"Renewal ".repeat(10)}terms`;
		assert(topicOf(longTitle).split("|")[0].length <= FOLD_TOPIC_TITLE_MAX_CHARS && topicOf(longTitle).endsWith("|topic-length") && !topicOf(longTitle).split("|")[0].endsWith(" "), `an over-long title is cut at a word (${topicOf(longTitle)})`);
		assert(topicOf("Counterparties") === "Counterparties|", "a new topic with a real title is kept");
	}

	// 3f. Near-duplicate topic titles file under the topic that holds the subject.
	{
		assert(normalizeTopicTitle("The Nordwind integrations") === "nordwind integration", `the normaliser drops stop words and a plural s (${normalizeTopicTitle("The Nordwind integrations")})`);
		assert(normalizeTopicTitle("Team and roles") === normalizeTopicTitle("Team roles"), "two titles that differ by a stop word normalise alike");
		assert(normalizeTopicTitle("Zuständigkeiten & Rollen") === "zuständigkeiten rollen", `letters of any alphabet are letters, punctuation is a space (${normalizeTopicTitle("Zuständigkeiten & Rollen")})`);
		const NEAR_AREAS: AreaRow[] = [...AREAS, areaRow("m-0007", "- Nordwind's orders arrive over the nightly feed.", "2026-07-08", { topic: "Nordwind integration" }), areaRow("m-0008", "- The account owner signs off scope changes.", "2026-07-08", { topic: "Team and roles" })];
		const filed = (topic: string) => (decide([{ op: "add", topic, kind: "fact", text: "- Retries are attempted three times, ten minutes apart." }], NEAR_AREAS).ops[0] as { topic: string }).topic;
		assert(filed("nordwind integration") === "nordwind integration", "a title that is an existing one in other case is that topic (the applier matches case aside)");
		assert(filed("The Nordwind integrations") === "Nordwind integration", "a title with a stop word and a plural files under the existing topic");
		assert(filed("Nordwind integration retries") === "Nordwind integration", "a title that narrows an existing two-word topic files under it");
		assert(filed("Nordwind") === "Nordwind", "a one-word title inside a longer topic is a subject of its own");
		assert(filed("Team roles") === "Team and roles", "a title that differs by a stop word files under the existing topic");
		assert(nearDuplicateTopicTitle("Nordwind integration", ["Nordwind integration"]) === undefined, "the exact title is that topic, not a near-duplicate of it");
		assert((decide([{ op: "add", topic: "Active Item", kind: "fact", text: "- The renewal window moved to April." }]).ops[0] as { topic: string; kind: string }).kind === "fact", "a fact under a title like Active Items keeps its own title rather than become an item");
	}

	// 3g. Repeats and conflicts, with no AI: left out only when memory already says every word.
	{
		const EXACT = "- The Nordwind contract renews annually; legal signs before June.";
		const exact = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: EXACT }]);
		assert(exact.ops.length === 0 && exact.landed && fateOf(exact) === "left-out:subset" && exact.pairs.subset === 1, `an add that repeats a note word for word is left out, and it counts as landed (${fateOf(exact)})`);
		assert(fateOf(decide([{ op: "add", topic: "Working style", kind: "practice", text: EXACT }])) === "left-out:subset", "the same words under another topic are left out too");
		const dressed = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind contract renews annually; legal signs before June. (saved 2026-07-08)" }]);
		assert(fateOf(dressed) === "left-out:subset", `a repeat carrying a stamp is still a repeat (${fateOf(dressed)})`);
		const mustKeep = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: `- **must-keep** ${EXACT.slice(2)}` }]);
		assert(mustKeep.ops.length === 1 && mustKeep.ops[0].op === "add", "a repeat that carries the must-keep marker is kept, since the note it repeats is not pinned");
		const more = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind contract renews annually; legal always signs before June." }]);
		assert(more.ops.length === 1 && more.ops[0].op === "add" && more.ops[0].beside === undefined && fateOf(more) === "applied:beside" && more.pairs.beside === 1, `a repeat with one more word is kept beside the note, untagged (${fateOf(more)})`);
		const SHORT_AREAS: AreaRow[] = [areaRow("m-0200", "- Invoices go out monthly.", "2026-06-01")];
		assert(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Invoices go out weekly." }], SHORT_AREAS).ops.length === 1, "two short notes that differ in one word are two points");
		assert(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Invoices go out monthly." }], SHORT_AREAS).ops.length === 0, "a short note repeated word for word is left out");
		// A narrower value or a dropped negation is never a subset: the classifier calls it a conflict.
		const NEG_AREAS: AreaRow[] = [areaRow("m-0210", "- Invoices are never sent to the Nordwind team on weekends.", "2026-06-01"), areaRow("m-0211", "- The Nordwind renewal discount is 12 or 14 percent.", "2026-06-01")];
		const negation = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Invoices are sent to the Nordwind team on weekends." }], NEG_AREAS);
		assert(negation.ops.length === 1 && negation.ops[0].op === "add" && negation.ops[0].beside === "may-disagree", `a dropped negation is kept and tagged, never left out (${JSON.stringify(negation.ops)})`);
		const narrower = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind renewal discount is 12 percent." }], NEG_AREAS);
		assert(narrower.ops.length === 1, `a narrower value ("12" against "12 or 14") is kept (${fateOf(narrower)})`);
		// Two adds of one reply.
		const NEW_POINT = "- The counterparty's escalation contact is the commercial lead, reachable through the shared inbox.";
		const LONGER = "- The counterparty's escalation contact is the commercial lead, reachable through the shared inbox now.";
		const pair = decide([{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }, { op: "add", topic: "Counterparties", kind: "fact", text: LONGER }]);
		assert(pair.ops.length === 1 && (pair.ops[0] as { text: string }).text === LONGER && fateOf(pair, 0) === "left-out:same-in-reply", `of two adds that say one thing, the longer is kept (${fateOf(pair, 0)})`);
		const equal = decide([{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }, { op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }]);
		assert(equal.ops.length === 1 && fateOf(equal, 1) === "left-out:same-in-reply", "two equal adds keep one");
		const JUNE = "- The Nordwind maintenance contract renews automatically on 1 June.";
		const JULY = "- The Nordwind maintenance contract renews automatically on 1 July.";
		const disagreeing = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JUNE }, { op: "add", topic: "Commercial terms", kind: "fact", text: JULY }]);
		assert(disagreeing.ops.length === 2 && disagreeing.ops.every((op) => op.op === "add" && op.beside === undefined) && fateOf(disagreeing, 1) === "applied:disagree-in-reply" && disagreeing.pairs.mayDisagreeInReply === 1 && disagreeing.pairs.mayDisagree === 0, `two adds of one reply that may disagree are both kept, untagged, and counted apart (${fateOf(disagreeing, 1)})`);
		assert(equal.pairs.subsetInReply === 1 && equal.pairs.subset === 0 && exact.pairs.subsetInReply === 0, "a repeat within the reply is counted apart from a repeat of memory");
		// The subset is read in order: the same words with the roles swapped are a new note.
		const ROLES: AreaRow[] = [areaRow("m-0220", "- Anna pays Bert the deposit before the handover.", "2026-06-01")];
		const swapped = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Bert pays Anna the deposit before the handover." }], ROLES);
		assert(swapped.ops.length === 1 && swapped.pairs.subset === 0, `the same words in another order are kept (${fateOf(swapped)})`);
		assert(fateOf(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Anna pays Bert the deposit before handover." }], ROLES)) === "left-out:subset", "the note's words in its own order, one left out, are a repeat");
		// Against memory: the working copy carries this run's own adds.
		const folded = applyFoldOps(DOC, [{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }], CTX);
		const nextAreas = listAreas(folded.doc);
		assert(decide([{ op: "add", topic: "Counterparties", kind: "fact", text: NEW_POINT }], nextAreas).ops.length === 0, "a later conversation's repeat of a note this run added is left out");
		const CONFLICT_AREAS = [...AREAS, areaRow("m-0300", JUNE, "2026-06-02"), areaRow("m-0301", "- Nordwind contract renews on 1 June.", "2026-06-02", { learned: "2026-06-20" })];
		const july = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JULY }], CONFLICT_AREAS);
		assert(july.ops[0].op === "add" && july.ops[0].beside === "may-disagree" && july.pairs.mayDisagree === 1 && fateOf(july) === "applied:may-disagree", `a changed date is kept beside the note, tagged (${fateOf(july)})`);
		assert(july.ops[0].op === "add" && july.ops[0].besideOf === "m-0300", `the add names the note it may disagree with (${JSON.stringify(july.ops[0])})`);
		assert(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JUNE }], CONFLICT_AREAS).ops.length === 0, "a genuine repeat is left out");
		assert((decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Nordwind contract renews on 1 July." }], CONFLICT_AREAS).ops[0] as { beside?: string }).beside === "may-disagree", "the short shape under the six-word floor is tagged too");
		const PINNED_CONFLICT = [...AREAS, areaRow("m-0300", JUNE, "2026-06-02", { pinned: true })];
		assert((decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JULY }], PINNED_CONFLICT).ops[0] as { beside?: string }).beside === "pinned", "a new note that may disagree with a pinned note is tagged as beside it");
		// A note this reply rewrites is judged by what it will say, not by its old words.
		const REWRITTEN = [...AREAS, areaRow("m-0300", JUNE, "2026-06-02")];
		const AUGUST = "- The Nordwind maintenance contract renews automatically on 1 August.";
		const earlierOff = decide([{ op: "update", id: "m-0300", text: JULY }, { op: "supersede", id: "m-0300", text: AUGUST }], REWRITTEN);
		assert(earlierOff.ops[0].op === "add" && earlierOff.ops[0].beside === undefined && fateOf(earlierOff, 0) === "redirected:same-id-earlier+disagree-in-reply" && earlierOff.pairs.mayDisagreeInReply === 1 && earlierOff.pairs.mayDisagree === 0, `an earlier text that disagrees with the winning text is kept untagged, as a disagreement within the reply (${fateOf(earlierOff, 0)})`);
		const DEPOSIT = [...AREAS, areaRow("m-0310", "- The Nordwind deposit is 5000 euros, paid before the handover.", "2026-06-02")];
		const rewriteAndAdd = decide([{ op: "update", id: "m-0310", text: "- The Nordwind deposit is 7000 euros, paid before the handover." }, { op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind deposit is 9000 euros, paid before the handover." }], DEPOSIT);
		assert(rewriteAndAdd.ops[0].op === "add" && rewriteAndAdd.ops[0].beside === undefined && fateOf(rewriteAndAdd, 1) === "applied:disagree-in-reply" && rewriteAndAdd.pairs.mayDisagreeInReply === 1, `an add that disagrees with a text rewriting a note of the same reply is kept untagged and counted (${fateOf(rewriteAndAdd, 1)})`);
		const sameAsRewrite = decide([{ op: "update", id: "m-0310", text: "- The Nordwind deposit is 7000 euros, paid before the handover." }, { op: "add", topic: "Commercial terms", kind: "fact", text: "- The Nordwind deposit is 7000 euros, paid before the handover." }], DEPOSIT);
		assert(sameAsRewrite.ops.length === 1 && fateOf(sameAsRewrite, 1) === "left-out:same-in-reply" && sameAsRewrite.pairs.subsetInReply === 1, `an add that a text rewriting a note says in full is left out as a repeat within the reply (${fateOf(sameAsRewrite, 1)})`);
		const oldWords = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JUNE }, { op: "update", id: "m-0300", text: JULY }], REWRITTEN);
		assert(oldWords.ops.some((op) => op.op === "add" && (op as { text: string }).text === JUNE) && fateOf(oldWords, 0) === "applied:disagree-in-reply" && oldWords.pairs.subset === 0, `a text that repeats the old words of a note the reply rewrites is kept, since memory will no longer say it, and counted against the new words (${fateOf(oldWords, 0)})`);
		// Words that are not an op: a string item, a close's outcome.
		const words = decide(["- Bob left the team on 3 June."]);
		assert(words.ops[0].op === "add" && words.ops[0].topic === FOLD_UNSORTED_TOPIC && fateOf(words) === "redirected:no-kind", `a string item is kept in Unsorted (${fateOf(words)})`);
		assert(fateOf(decide([{ op: "unpin", id: PINNED, because: PIN_REQUEST }])) === "traced:unpin", "an unpin is traced: only the person unpins");
		assert(fateOf(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: { a: 1 } }])) === "traced:text-not-text+empty-text", "a text that is an object is traced");
		// A text of marks only, or of the must-keep marker only, says nothing: never a note, and never a note's new text.
		const marks = [{ op: "add", topic: "Commercial terms", kind: "fact", text: "###" }, { op: "update", id: "m-0001", text: "---" }, { op: "supersede", id: "m-0001", text: "- ###" }, { op: "update", id: PINNED, text: "###" }, { op: "add", topic: "Commercial terms", kind: "fact", text: "- **must-keep**" }];
		const marksOnly = decide(marks);
		assert(marksOnly.ops.length === 0 && marks.every((_, i) => fateOf(marksOnly, i) === "traced:empty-text"), `a text with no letter or digit is traced on an add, an update, a supersede and a pinned note (${marks.map((_, i) => fateOf(marksOnly, i)).join(" | ")})`);
		assert(fateOf(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "1. **must-keep:**" }])) === "traced:empty-text", "a list mark and the must-keep marker say nothing");
		assert(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- `**must-keep**`" }]).ops.length === 1, "a marker quoted in a code span is text, as everywhere else");
		const outcome = decide([{ op: "close", id: "m-0005", text: "- The reconciliation closed with no open invoices." }]);
		assert(outcome.ops.map((op) => op.op).join() === "add,close" && outcome.ops[0].op === "add" && outcome.ops[0].kind === "fact" && outcome.ops[0].topic === FOLD_UNSORTED_TOPIC && fateOf(outcome) === "redirected:close-text", `a close's text is the item's outcome, a fact in Unsorted (${fateOf(outcome)})`);
		const echo = decide([{ op: "close", id: "m-0005", text: "- Close out the billing reconciliation before the renewal." }]);
		assert(echo.ops.map((op) => op.op).join() === "close" && fateOf(echo) === "applied:close-text+foreign-text", `a close's text that repeats the item is traced (${fateOf(echo)})`);
		// The day a text was learned is its page's day: an add, an update and a
		// supersede take it; a page with no day takes it away, and never guesses.
		const pageDay = { ...CTX, sessionDate: "2026-09-10" };
		const wrote = applyFoldOps(DOC, [{ op: "add", topic: "Commercial terms", kind: "fact", text: "- A new point." }, { op: "update", id: "m-0001", text: "- The Nordwind contract renews annually." }, { op: "supersede", id: "m-0002", text: "- The quarterly report is due on the 12th working day." }], pageDay);
		const learnedIn = (doc: MemoryDocument, id: string) => doc.topics.flatMap((topic) => topic.entries).find((e) => e.id === id)?.learned;
		assert(learnedIn(wrote.doc, wrote.record.added[0].id) === "2026-09-10" && learnedIn(wrote.doc, "m-0001") === "2026-09-10" && learnedIn(wrote.doc, "m-0002") === "2026-09-10", "an add, an update and a supersede are learned on the page's day");
		const undatedRewrite = applyFoldOps(wrote.doc, [{ op: "update", id: "m-0001", text: "- The Nordwind contract renews every year." }, { op: "add", topic: "Commercial terms", kind: "fact", text: "- Another point." }], { ...CTX, nextEntryNumber: wrote.nextEntryNumber, sessionDate: "Tuesday" });
		assert(learnedIn(undatedRewrite.doc, "m-0001") === undefined && learnedIn(undatedRewrite.doc, undatedRewrite.record.added[0].id) === undefined, "a page with no real day leaves no learned, and takes the old one away from a note it rewrites");
		assert(undatedRewrite.record.updated[0].learnedBefore === "2026-09-10", "the record keeps the day the old text was learned, for its archive row");
		const closed = applyFoldOps(wrote.doc, [{ op: "close", id: "m-0005" }], { ...CTX, sessionDate: "2026-09-20" });
		assert(learnedIn(closed.doc, "m-0005") === learnedIn(wrote.doc, "m-0005"), "a close changes no text, and no day");

		// The item it closes is not what memory will say: its text is never tagged against it.
		const contrary = decide([{ op: "close", id: "m-0005", text: "- Never close out the billing reconciliation before the renewal." }]);
		assert(fateOf(contrary) === "redirected:close-text" && contrary.ops[0].op === "add" && !contrary.ops[0].beside && contrary.pairs.mayDisagree === 0, `a close's text that disagrees with the item it closes is a plain fact, untagged (${fateOf(contrary)}, ${JSON.stringify(contrary.ops[0])})`);
		// The file: nothing a note says changes the memory's structure.
		const hostile = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- Renews annually.\n## Deep Memory\n### Topic\n<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->\n---\n#" }]);
		const written = applyFoldOps(DOC, hostile.ops, CTX).doc;
		const once = renderMemoryDocument(written, "storage");
		const reread = parseMemoryDocument(once);
		assert(renderMemoryDocument(reread, "storage") === once && reread.topics.length === written.topics.length && reread.topics.reduce((n, topic) => n + topic.entries.length, 0) === written.topics.reduce((n, topic) => n + topic.entries.length, 0), "a note with heading, comment and rule lines round-trips as a fixed point, with no topic or entry gained or lost");
		const CONFLICT_DOC: MemoryDocument = { ...DOC, topics: [{ ...DOC.topics[0], entries: [...DOC.topics[0].entries, entry("m-0300", "fact", JUNE, { saved: "2026-06-02", learned: "2026-06-02" })] }, ...DOC.topics.slice(1)] };
		const dated = applyFoldOps(CONFLICT_DOC, [
			{ op: "supersede", id: "m-0300", text: JULY },
			{ op: "supersede", id: "m-0002", text: "- The quarterly report is due on the 5th working day of the quarter." },
			{ op: "supersede", id: "m-0004", text: "- Decisions are written down on the day they are taken." },
		], { ...CTX, sessionDate: SESSION_DATE });
		assert(dated.record.superseded[0].reason === conflictReason(JUNE, JULY, "2026-06-02", SESSION_DATE, CTX.savedDate) && dated.record.superseded[0].reason === "1 July (as of 8 Sep) replaces 1 June (as of 2 Jun); the newer date decides", `a supersede whose texts disagree on a date carries the reason, the two days each text was learned (${JSON.stringify(dated.record.superseded[0].reason)})`);
		assert(dated.record.superseded[1].reason === "5th (as of 8 Sep) replaces 10th (as of 1 Sep); the newer date decides", `the older day is the day the old text was learned (${JSON.stringify(dated.record.superseded[1].reason)})`);
		assert(dated.record.superseded[2].reason === undefined && !("reason" in dated.record.superseded[2]), `a supersede that only rewords carries no reason (${JSON.stringify(dated.record.superseded[2])})`);
		// A note this same run added carries the day of the conversation that wrote
		// it, never the run's day, so two conversations are compared.
		const SAME_RUN_DOC: MemoryDocument = { ...DOC, topics: [{ ...DOC.topics[0], entries: [...DOC.topics[0].entries, entry("m-0300", "fact", JUNE, { saved: CTX.savedDate, from: "RC-0002", learned: "2026-09-04" })] }, ...DOC.topics.slice(1)] };
		const sameRun = applyFoldOps(SAME_RUN_DOC, [{ op: "supersede", id: "m-0300", text: JULY }], { ...CTX, sessionDate: SESSION_DATE });
		assert(sameRun.record.superseded[0].reason === "1 July (as of 8 Sep) replaces 1 June (as of 4 Sep); the newer date decides", `a note added earlier in this run is dated by its own conversation, not by the run's day (${JSON.stringify(sameRun.record.superseded[0].reason)})`);
		const NEWER_DOC: MemoryDocument = { ...DOC, topics: [{ ...DOC.topics[0], entries: [...DOC.topics[0].entries, entry("m-0300", "fact", JUNE, { learned: "2026-09-10" })] }, ...DOC.topics.slice(1)] };
		const backwards = applyFoldOps(NEWER_DOC, [{ op: "supersede", id: "m-0300", text: JULY }], { ...CTX, sessionDate: SESSION_DATE });
		assert(backwards.record.superseded[0].reason === "1 July replaces 1 June", `when the newer text's day is not the later one, no date is named as deciding (${JSON.stringify(backwards.record.superseded[0].reason)})`);
		const undated = applyFoldOps(CONFLICT_DOC, [{ op: "supersede", id: "m-0300", text: JULY }], CTX);
		assert(undated.record.superseded[0].reason === "1 July replaces 1 June", `a session without a day of its own names no day (${JSON.stringify(undated.record.superseded[0].reason)})`);

		// A note with no learned day that a fold saved or rewrote after the page
		// may be newer: a text that disagrees with it is added beside it, tagged,
		// so the automatic save waits; any other text rewrites it as before.
		const FLOOR = [...AREAS, areaRow("m-0300", JUNE, "2026-09-01", { from: "RC-0040", updated: "2026-09-11" })];
		const floored = decide([{ op: "update", id: "m-0300", text: JULY }], FLOOR);
		assert(floored.ops.length === 1 && floored.ops[0].op === "add" && floored.ops[0].beside === "may-disagree" && floored.ops[0].besideOf === "m-0300" && floored.ops[0].topic === "Commercial terms" && fateOf(floored) === "redirected:older-than-floor+may-disagree" && floored.pairs.mayDisagree === 1, `an older text that disagrees with a note rewritten after it is added beside it, tagged (${fateOf(floored)}, ${JSON.stringify(floored.ops)})`);
		assert(fateOf(decide([{ op: "supersede", id: "m-0300", text: JULY }], FLOOR)) === "redirected:older-than-floor+may-disagree", "a supersede too");
		const KEEPS_JUNE = "- The Nordwind maintenance contract renews automatically on 1 June; legal reads the terms each spring.";
		assert(fateOf(decide([{ op: "update", id: "m-0300", text: KEEPS_JUNE }], FLOOR)) === "applied", "a text that keeps every value of the note rewrites it as before");
		// However it is worded: a rewording that drops or replaces the note's value disagrees with it.
		for (const text of ["- The Nordwind maintenance contract now renews on 1 July.", "- Nordwind maintenance renewal: 1 July.", "- Legal reads the Nordwind renewal terms every spring."]) {
			const reworded = decide([{ op: "update", id: "m-0300", text }], FLOOR);
			assert(reworded.ops[0].op === "add" && reworded.ops[0].beside === "may-disagree" && reworded.ops[0].besideOf === "m-0300" && fateOf(reworded) === "redirected:older-than-floor+may-disagree", `a rewording that drops the note's value is added beside it, tagged: ${text} (${fateOf(reworded)})`);
		}
		assert(fateOf(decide([{ op: "update", id: "m-0300", text: JULY }], [...AREAS, areaRow("m-0300", JUNE, "2026-09-10", { from: "RC-0040" })])) === "redirected:older-than-floor+may-disagree", "a note a fold saved after the page counts from its saved day");
		for (const [extra, label] of [[{ from: "RC-0040", updated: "2026-09-05" }, "rewritten before the page"], [{}, "nothing wrote, saved after the page"], [{ from: "RC-0040", updated: "2026-09-11", learned: "2026-09-02" }, "learned before the page"]] as const) {
			assert(fateOf(decide([{ op: "update", id: "m-0300", text: JULY }], [...AREAS, areaRow("m-0300", JUNE, "2026-09-10", extra)])) === "applied", `a note ${label} is rewritten as before`);
		}
		assert(fateOf(decide([{ op: "update", id: "m-0300", text: JULY }], [...AREAS, areaRow("m-0300", JUNE, "2026-09-01", { updated: "2026-09-11" })])) === "redirected:older-than-floor+may-disagree", "a note nothing wrote but a fold rewrote after the page is tagged too");
		assert(decideFoldOps([{ op: "update", id: "m-0300", text: JULY }].map(readFoldOp), FLOOR, { text: SESSION_TEXT }).ops[0].op === "update", "a page with no day rewrites it as before");
		// The volume price, end to end: a page of 3 Sep against 45k, saved 1 Sep and rewritten 11 Sep.
		const PRICE = parseMemoryDocument(["<!-- exxeta:l1b schema_version=1 -->", "", "## Deep Memory", "", "<!-- entries: next=200 -->", "", "### Pricing", "", "<!-- e: id=m-0102 kind=fact saved=2026-09-01 from=RC-0040 updated=2026-09-11 -->", "- The volume price is 45k.", ""].join("\n"));
		const priceOps = decideFoldOps([{ op: "update", id: "m-0102", text: "- The volume price is 40k." }].map(readFoldOp), listAreas(PRICE), { text: SESSION_TEXT, date: "2026-09-03" }).ops;
		const priced = applyFoldOps(PRICE, priceOps, { sessionId: "RC-0007", savedDate: "2026-09-30", sessionDate: "2026-09-03", nextEntryNumber: 200 });
		assert(priced.doc.topics[0].entries.find((e) => e.id === "m-0102")?.text === "- The volume price is 45k." && priced.record.updated.length === 0 && priced.record.added[0]?.beside === "may-disagree" && priced.record.added[0].besideOf === "m-0102", `the 45k note stands and the older 40k is added beside it, tagged (${JSON.stringify(priced.record)})`);

		// Dates decide an older page (this one is from 8 Sep): a text that may
		// disagree with a note learned after it is kept as history and the note
		// is untouched; any other text aimed at the note is added beside it.
		const LATER = "2026-09-20";
		const LATER_AREAS = [...AREAS, areaRow("m-0300", JUNE, "2026-09-20", { learned: LATER })];
		const LATER_DOC: MemoryDocument = { ...DOC, topics: [{ ...DOC.topics[0], entries: [...DOC.topics[0].entries, entry("m-0300", "fact", JUNE, { saved: "2026-09-20", learned: LATER })] }, ...DOC.topics.slice(1)] };
		for (const op of ["update", "supersede"]) {
			const older = decide([{ op, id: "m-0300", text: JULY }], LATER_AREAS);
			assert(older.ops.length === 1 && older.ops[0].op === "history" && older.ops[0].of === "m-0300" && older.ops[0].until === LATER && older.ops[0].text === JULY && fateOf(older) === "redirected:older-history" && older.landed && older.pairs.mayDisagree === 0, `an older ${op} that disagrees with the note is kept as history (${fateOf(older)}, ${JSON.stringify(older.ops)})`);
		}
		const kept = applyFoldOps(LATER_DOC, decide([{ op: "update", id: "m-0300", text: JULY }], LATER_AREAS).ops, { ...CTX, sessionDate: SESSION_DATE });
		const keptNote = kept.doc.topics[0].entries.find((e) => e.id === "m-0300");
		assert(keptNote?.text === JUNE && keptNote.learned === LATER && keptNote.updated === undefined && kept.record.updated.length === 0 && kept.record.added.length === 0, `the note keeps its text and its day (${JSON.stringify(keptNote)})`);
		assert(JSON.stringify(kept.record.history) === JSON.stringify([{ id: foldEntryId(7), of: "m-0300", topic: "Commercial terms", section: "Deep Memory", kind: "fact", text: JULY, learned: SESSION_DATE, until: LATER }]) && kept.nextEntryNumber === 8, `the history row has its own id, the page's day and the note's (${JSON.stringify(kept.record.history)})`);
		const RENEWAL = "- Legal reads the Nordwind renewal terms every spring.";
		const olderBeside = decide([{ op: "update", id: "m-0300", text: KEEPS_JUNE }], LATER_AREAS);
		assert(olderBeside.ops.length === 1 && olderBeside.ops[0].op === "add" && olderBeside.ops[0].topic === "Commercial terms" && olderBeside.ops[0].beside === undefined && fateOf(olderBeside) === "redirected:older-beside+beside", `an older text that does not disagree is added beside the note, untagged (${fateOf(olderBeside)}, ${JSON.stringify(olderBeside.ops)})`);
		const LATER_PINNED = [...AREAS, areaRow("m-0300", JUNE, "2026-09-20", { learned: LATER, pinned: true })];
		const pinnedBeside = decide([{ op: "update", id: "m-0300", text: KEEPS_JUNE }], LATER_PINNED);
		assert(pinnedBeside.ops[0].op === "add" && pinnedBeside.ops[0].beside === "pinned" && fateOf(pinnedBeside) === "redirected:beside-pinned", `beside a pinned note, an older text that does not disagree keeps its tag (${fateOf(pinnedBeside)})`);
		for (const text of ["- The Nordwind maintenance contract now renews on 1 July.", "- Nordwind maintenance renewal: 1 July."]) {
			assert(fateOf(decide([{ op: "update", id: "m-0300", text }], LATER_AREAS)) === "redirected:older-history", `a rewording that replaces the newer note's value is history however it is worded: ${text}`);
		}
		// A number respelt is the same number; a negation the note lacks is a disagreement, however little else changes.
		const DEPOSIT_LATER = [...AREAS, areaRow("m-0300", "- The Nordwind deposit is 5000 euros.", "2026-09-20", { learned: LATER })];
		assert(fateOf(decide([{ op: "update", id: "m-0300", text: "- The Nordwind deposit is 5.000 euros, paid before the handover." }], DEPOSIT_LATER)) === "redirected:older-beside+beside", "a respelt number is no older value: the refinement stays current beside the note");
		const DEPOSIT_FLOOR = [...AREAS, areaRow("m-0300", "- The Nordwind deposit is 5000 euros.", "2026-09-01", { from: "RC-0040", updated: "2026-09-11" })];
		assert(fateOf(decide([{ op: "update", id: "m-0300", text: "- The Nordwind deposit is 5,000 euros, paid before the handover." }], DEPOSIT_FLOOR)) === "applied", "and it rewrites a pre-upgrade note as before");
		const RENEWS = "- The Nordwind contract renews automatically.";
		const NEGATED = "- The Nordwind contract does not renew automatically.";
		assert(fateOf(decide([{ op: "update", id: "m-0300", text: NEGATED }], [...AREAS, areaRow("m-0300", RENEWS, "2026-09-20", { learned: LATER })])) === "redirected:older-history", "an older text that negates a newer note is history");
		const negatedFloor = decide([{ op: "update", id: "m-0300", text: NEGATED }], [...AREAS, areaRow("m-0300", RENEWS, "2026-09-01", { from: "RC-0040", updated: "2026-09-11" })]);
		assert(negatedFloor.ops[0].op === "add" && negatedFloor.ops[0].beside === "may-disagree" && fateOf(negatedFloor) === "redirected:older-than-floor+may-disagree", `and beside a pre-upgrade note rewritten after the page it is tagged, never a silent rewrite (${fateOf(negatedFloor)})`);
		const valueless = decide([{ op: "update", id: "m-0300", text: RENEWAL }], LATER_AREAS);
		assert(valueless.ops[0].op === "add" && valueless.ops[0].beside === undefined && fateOf(valueless) === "redirected:older-beside", `a text with no value of its own is another fact, not an older value: kept beside the note, untagged (${fateOf(valueless)})`);
		const pinnedHistory = decide([{ op: "update", id: "m-0300", text: JULY }], LATER_PINNED);
		assert(pinnedHistory.ops[0].op === "history" && pinnedHistory.pairs.besidePinned === 0 && fateOf(pinnedHistory) === "redirected:older-history", `an older text that disagrees with a pinned note is history, with no tag (${fateOf(pinnedHistory)})`);
		assert(decide([{ op: "update", id: "m-0300", text: JULY }], LATER_AREAS, { keptForFolds: new Set(["m-0300"]) }).ops[0].op === "history", "a kept note's hold is no date: an older text that disagrees with it is history too");
		for (const [day, label] of [[SESSION_DATE, "the same day"], ["2026-09-01", "an older day"]]) {
			const areas = [...AREAS, areaRow("m-0300", JUNE, "2026-09-01", { learned: day })];
			assert(fateOf(decide([{ op: "update", id: "m-0300", text: JULY }], areas)) === "applied", `a note learned on ${label} is rewritten as before`);
		}
		assert(fateOf(decide([{ op: "update", id: "m-0300", text: JULY }], CONFLICT_AREAS)) === "applied", "a note with no learned day is rewritten as before");
		const undatedPage = decideFoldOps([{ op: "update", id: "m-0300", text: JULY }].map(readFoldOp), LATER_AREAS, { text: SESSION_TEXT });
		assert(undatedPage.ops[0].op === "update" && undatedPage.decisions[0].codes.join() === "undated-rewrite", `a page with no day rewrites a dated note, and says so in its code (${JSON.stringify(undatedPage.decisions[0])})`);
		assert(decideFoldOps([{ op: "update", id: "m-0001", text: JULY }].map(readFoldOp), AREAS, { text: SESSION_TEXT }).decisions[0].codes.length === 0, "a page with no day rewriting an undated note carries no code");
		// An add: history when any note it may disagree with was learned after the
		// page, against the newest of them; a repeat is still left out.
		const TWO_DATES = [...AREAS, areaRow("m-0300", JUNE, "2026-06-02", { learned: "2026-06-02" }), areaRow("m-0301", "- The Nordwind maintenance contract renews automatically on 1 August.", "2026-09-12", { learned: "2026-09-12" }), areaRow("m-0302", "- The Nordwind maintenance contract renews automatically on 1 September.", "2026-09-20", { learned: LATER })];
		const addOlder = decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JULY }], TWO_DATES);
		assert(addOlder.ops.length === 1 && addOlder.ops[0].op === "history" && addOlder.ops[0].of === "m-0302" && addOlder.ops[0].until === LATER && fateOf(addOlder) === "redirected:older-history" && addOlder.pairs.mayDisagree === 0, `an older add that disagrees with newer notes is history against the newest (${fateOf(addOlder)}, ${JSON.stringify(addOlder.ops)})`);
		assert(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JULY }], LATER_PINNED).ops[0].op === "history", "an older add that disagrees with a newer pinned note is history, untagged");
		assert(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JUNE }], LATER_AREAS).ops.length === 0, "an older add that repeats a newer note is still left out");
		const markedHistory = applyFoldOps(LATER_DOC, decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: "- **must-keep** The Nordwind maintenance contract renews automatically on 1 July." }], LATER_AREAS).ops, { ...CTX, sessionDate: SESSION_DATE });
		assert(markedHistory.record.history[0]?.text === JULY && markedHistory.record.pinned.length === 0, `an older must-keep text that disagrees with a newer note is history, its marker taken out like any stored text's (${JSON.stringify(markedHistory.record.history)})`);
		const namedOlder = decide([{ op: "add", id: "m-0300", topic: "Commercial terms", kind: "fact", text: RENEWAL }], LATER_AREAS);
		assert(namedOlder.ops[0].op === "add" && namedOlder.ops[0].beside === undefined && fateOf(namedOlder) === "applied:older-beside", `an older add naming a newer note it does not disagree with lands beside it, coded like an older rewrite (${fateOf(namedOlder)})`);
		assert((decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: JULY }], CONFLICT_AREAS).ops[0] as { beside?: string }).beside === "may-disagree", "an add that disagrees only with notes learned before the page is tagged as before");
	}
	console.log("3. decisions: pinned and kept notes, unknown ids, drops, pins, tidiness, topics, repeats and conflicts, each op decided alone");
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
	assert(decide(ops).decisions.every((decision) => decision.fate === "applied"), `every op of the fold applies as written (${decide(ops).decisions.map((decision) => decision.fate).join()})`);
	const { doc, record, nextEntryNumber } = applyFoldOps(DOC, ops, CTX);

	assert(record.sessionId === SESSION_ID && record.dropped === undefined, "the record names the session it folded and was not a drop");
	assert(record.superseded.length === 1 && record.superseded[0].id === "m-0001" && record.superseded[0].before === "- The Nordwind contract renews annually; legal signs before June." && record.superseded[0].after.includes("end of April"), "the superseded text is recorded before and after");
	assert(record.updated.length === 1 && record.updated[0].before.includes("10th working day") && record.updated[0].after.includes("5th working day"), "the updated text is recorded before and after");
	assert(record.closed.length === 1 && record.closed[0].id === "m-0005" && record.closed[0].text.includes("billing reconciliation"), "the closed item is recorded with the text it had");
	assert(record.pinned.join() === "m-0004", "the pin is recorded");
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

	// unpin is out of the grammar: only the person unpins, so a reply's unpin is an op of no known kind.
	const unpin = parseFoldOps(`\`\`\`json\n{"ops":[{"op":"unpin","id":"${PINNED}","because":"${PIN_REQUEST}"}]}\n\`\`\``);
	assert(!(FOLD_OP_KINDS as readonly string[]).includes("unpin") && unpin.items[0]?.op === "unpin" && decideFoldOps(unpin.items, AREAS, SESSION).ops.length === 0, "unpin is no kind of the grammar: a reply's unpin is read, and applies nothing");
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
	assert(fateOf(decide([{ op: "add", topic: "Commercial terms", kind: "fact", text: MARKED }])) === "applied", "it needs no because: it applies as an ordinary add");

	// Red-without: the same add with the marker taken out lands unpinned, and the
	// next fold is then free to rewrite it — which is the loss the rule prevents.
	const UNMARKED = MARKED.replace("**must-keep** ", "");
	// Learned on its page's day: a note an undated fold saved after the next page would hold that page's rewrite beside it.
	const plain = applyFoldOps(DOC, [{ op: "add", topic: "Commercial terms", kind: "fact", text: UNMARKED }], { ...CTX, sessionDate: SESSION_DATE });
	const unpinned = plain.doc.topics[0].entries.find((e) => e.id === foldEntryId(7));
	assert(unpinned?.pinned === false && plain.record.pinned.length === 0, "red-without: without the marker the same entry lands unpinned");
	const nextRoundMarked = areasFrom(added.doc);
	const nextRoundPlain = areasFrom(plain.doc);
	assert(fateOf(decide([{ op: "update", id: foldEntryId(7), text: "- Something else entirely." }], nextRoundMarked)) === "redirected:beside-pinned", "green-with: on the next fold an update of the marked entry is added beside it");
	assert(fateOf(decide([{ op: "update", id: foldEntryId(7), text: "- Something else entirely." }], nextRoundPlain)) === "applied", "red-without: the unmarked twin is rewritable, and the user's request is gone");

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
	// A marker written into a note that reads as pinned already is recorded as a
	// pin too: a note pinned only for a resume's folds is unpinned after them
	// unless a record says a fold pinned it.
	const repinned = applyFoldOps(DOC, [{ op: "update", id: PINNED, text: "- **must-keep** Send commercial summaries as one page." }], CTX);
	assert(repinned.record.pinned.join() === PINNED && repinned.doc.topics[1].entries[0].pinned && !/must-keep/.test(repinned.doc.topics[1].entries[0].text), `the marker's pin is recorded on a note already pinned (${JSON.stringify(repinned.record.pinned)})`);
	console.log("4a. must-keep: a marker in the text pins the entry, red-without and green-with");
}

// --- 4b. The decision and the applier agree on what a topic is ----------------

{
	const ops: FoldOp[] = [{ op: "add", topic: "commercial TERMS", kind: "fact", text: "- The counterparty moved the notice window to April." }];
	assert(fateOf(decide(ops)) === "applied", `a differently-cased existing topic title applies as written (${fateOf(decide(ops))})`);
	const { doc, record } = applyFoldOps(DOC, ops, CTX);
	assert(record.newTopics.length === 0, "no new topic is recorded — the title names one that exists");
	assert(doc.topics.length === DOC.topics.length && doc.topics[0].entries.length === 3 && doc.topics[0].entries[2].id === foldEntryId(7), "the entry lands in the existing topic, under its real title");
	assert(record.added[0].topic === "Commercial terms", "the record names the topic as memory spells it, not as the operation spelled it");
	// The same agreement on Active Items and on the bullet shape of a topic.
	assert(fateOf(decide([{ op: "add", topic: " active items ", kind: "item", text: "- Confirm the notice date with legal." }])) === "applied", "a padded, differently-cased Active Items title is not judged as a new Deep Memory topic");
	assert(fateOf(decide([{ op: "add", topic: "commercial TERMS", kind: "fact", text: "Not a bullet." }])) === "normalised:bullet", "the existing topic's bullet shape binds through the same match");
	console.log("4b. topics: the decision and the applier resolve a title the same way");
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
