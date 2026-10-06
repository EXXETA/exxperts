export {};

// Memorize never gets stuck: the summary fallback's note shapes, and the entry
// metadata that marks a summary note surviving every rewrite. Everything runs
// through the real filer, applier, parser and renderer.

const { parseMemoryDocument, renderMemoryDocument, parseArchive, renderArchive } = await import("../src/memory-entries.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exit(1);
	}
}

const MEMORY = [
	"# Memory",
	"",
	"## Deep Memory",
	"",
	"<!-- entries: next=3 -->",
	"",
	"### Renewals",
	"",
	"<!-- e: id=m-0001 kind=fact saved=2026-09-01 refs=2 -->",
	"- The Nordwind contract renews in April.",
	"",
	"## Active Items",
	"",
	"<!-- e: id=m-0002 kind=item saved=2026-09-01 status=open -->",
	"- Send the draft to legal.",
	"",
	"## Recent Context",
	"",
	"No sessions yet.",
	"",
].join("\n");

const PAGE = [
	"### RC-0007 | OPEN | 2026-09-20 | Pricing review with the Nordwind team",
	"<!-- rc_metadata: checkpoint=cp-123 conversation=conv-9 -->",
	"",
	"**Session arc:** The team moved from an open pricing question to a settled tiered model.",
	"",
	"**Body:**",
	"- Tiered pricing is agreed: three tiers, billed yearly.",
	"### A heading the page should not have",
	"- **must-keep** The discount never exceeds 12 percent.",
	"  - It needs the CFO's sign-off above 8 percent.",
	"- The next review is in November.",
	"",
	"**Parked:**",
	"- Whether the support tier is priced per seat.",
	"- The invoicing currency for the Swiss entity.",
	"",
].join("\n");

const ctx = { savedDate: "2026-09-28", nextEntryNumber: 3, sessionDate: "2026-09-20" };
const find = (doc: any, id: string) => {
	for (const topic of doc.topics) for (const entry of topic.entries) if (entry.id === id) return { topic, entry };
	return undefined;
};

// --- 1. Metadata the version does not write survives a rewrite --------------------
{
	const canonical = parseMemoryDocument(MEMORY);
	assert(renderMemoryDocument(canonical, "storage") === MEMORY, "existing entries are byte-identical after a rewrite");

	const future = MEMORY.replace("<!-- e: id=m-0001 kind=fact saved=2026-09-01 refs=2 -->", '<!-- e: id=m-0001 kind=fact saved=2026-09-01 refs=2 tried=openai/gpt-5 confirmed=2026-08-30 note="two words" -->');
	const parsed = parseMemoryDocument(future);
	const rendered = renderMemoryDocument(parsed, "storage");
	assert(rendered.includes('tried=openai/gpt-5 confirmed=2026-08-30 note="two words"'), `an unknown key survives a rewrite (${rendered.split("\n").find((line) => line.includes("m-0001"))})`);
	assert(rendered === future, "and the line is written back exactly");

	const archive = renderArchive([{ id: "m-0009", kind: "fact", saved: "2026-01-01", pinned: false, text: "- Old.", archived: "2026-02-01", why: "budget", topic: "Renewals", section: "Deep Memory", extra: { sorter: "x/y" } } as any]);
	const rows = parseArchive(archive);
	assert(rows[0].extra?.sorter === "x/y" && !("archived" in (rows[0].extra ?? {})) && renderArchive(rows) === archive, "an archive row carries its unknown keys once, and its own keys are not doubled");
	console.log("1. metadata: unknown keys survive a rewrite; known entries stay byte-identical");
}

// The filer is imported after the metadata checks, so they run on their own too.
const { fileSessionAsSummary, SUMMARY_TOPIC } = await import("../src/absorb-summary.js");

// --- 2. The note shapes ---------------------------------------------------------
{
	const doc = parseMemoryDocument(MEMORY);
	const filed = fileSessionAsSummary(doc, { id: "RC-0007", title: "Pricing review with the Nordwind team", text: PAGE }, ctx);
	const summary = find(filed.doc, filed.summaryNoteId ?? "");
	assert(summary, "the page is filed as a summary note");
	assert(summary.topic.title === SUMMARY_TOPIC && summary.topic.section === "Deep Memory", `the summary note is in Deep Memory, "${SUMMARY_TOPIC}", got ${summary.topic.section}/${summary.topic.title}`);
	assert(filed.record.newTopics.includes(SUMMARY_TOPIC), "the topic is created when the room does not have it");
	assert(summary.entry.summary === true, "the summary note is marked");
	const { sessionDate: _day, ...undated } = ctx;
	const undatedFiling = fileSessionAsSummary(doc, { id: "RC-0007", title: "Pricing review with the Nordwind team", text: PAGE }, undated);
	assert(summary.entry.learned === "2026-09-20" && find(undatedFiling.doc, undatedFiling.summaryNoteId ?? "")?.entry.learned === undefined, "a summary note is learned on its page's day, and has none when the page has no day");
	assert(summary.entry.pinned === false, "the summary note is never pinned");
	assert(!/must-keep/i.test(summary.entry.text), `the summary note holds no must-keep line (${summary.entry.text})`);
	assert(!summary.entry.text.includes("CFO"), "the must-keep line's continuation left with it");
	// ONE block: the title is its only top-level bullet, on its own line, and the
	// arc and the Body sit under it, so it never runs into the arc and the next
	// note never reads as one more of its lines.
	const expected = [
		"- Pricing review with the Nordwind team",
		"  - The team moved from an open pricing question to a settled tiered model.",
		"  - Tiered pricing is agreed: three tiers, billed yearly.",
		"  - A heading the page should not have",
		"  - The next review is in November.",
	].join("\n");
	assert(summary.entry.text === expected, `the note is the title with the arc and the Body under it (${JSON.stringify(summary.entry.text)})`);
	assert(summary.entry.text.includes("The team moved from an open pricing question") && summary.entry.text.includes("- Tiered pricing is agreed") && summary.entry.text.includes("- The next review is in November."), "the arc and the Body are in the note");
	assert(!/RC-0007|rc_metadata|\*\*Body:\*\*|\*\*Session arc:\*\*/.test(summary.entry.text), `the heading's bookkeeping, the metadata and the labels are not (${summary.entry.text})`);
	assert(summary.entry.text.split("\n").every((line: string) => !/^\s*(#|<!--)/.test(line)), "no line of the note can be read as structure");
	assert(summary.entry.from === "RC-0007", "the note says which conversation it came from");

	const mustKeep = filed.record.added.filter((added: any) => filed.record.pinned.includes(added.id));
	assert(mustKeep.length === 1, `the must-keep line is its own note, pinned, got ${mustKeep.length}`);
	const mustKeepEntry = find(filed.doc, mustKeep[0].id)!;
	assert(mustKeepEntry.entry.pinned === true, "and the applier pins it");
	assert(mustKeepEntry.entry.text === "- The discount never exceeds 12 percent.\n  - It needs the CFO's sign-off above 8 percent.", `it keeps the line that continues it, and no must-keep label (${JSON.stringify(mustKeepEntry.entry.text)})`);
	assert(mustKeep[0].text === mustKeepEntry.entry.text, "the card shows the note as it is stored");
	assert(!mustKeepEntry.entry.summary, "a must-keep note is not the summary note");

	const items = filed.record.added.filter((added: any) => added.kind === "item");
	assert(items.length === 2, `each Parked line becomes an open item, got ${items.length}`);
	for (const item of items) {
		const found = find(filed.doc, item.id)!;
		assert(found.topic.section === "Active Items" && found.entry.status === "open", "a parked line is an open item in Active Items");
	}
	assert(filed.nextEntryNumber === 3 + 1 + 1 + 2, `the counter moves by every note filed, got ${filed.nextEntryNumber}`);

	// Round trip: the summary note is ONE note with its bullets, and keeps its mark.
	const stored = renderMemoryDocument(filed.doc as any, "storage");
	const reread = parseMemoryDocument(stored);
	const again = find(reread, filed.summaryNoteId!);
	assert(again && again.entry.text === summary.entry.text, `the summary note with "- " bullets reads back as one note, unchanged (${again?.entry.text})`);
	assert(again.entry.summary === true, "its mark survives the write");
	assert(renderMemoryDocument(reread, "storage") === stored, "a second rewrite changes nothing");
	const pinnedAgain = find(reread, mustKeep[0].id)!;
	assert(pinnedAgain.entry.pinned === true && !/must-keep/i.test(pinnedAgain.entry.text), "the must-keep note reads back pinned, with no label");
	console.log("2. summary: one unpinned summary note in Unsorted, must-keep lines pinned apart, parked lines as items");
}

// --- 3. None parked, and a block written by hand --------------------------------
{
	const doc = parseMemoryDocument(MEMORY);
	const none = PAGE.replace(/\*\*Parked:\*\*[\s\S]*$/, "**Parked:**\nNone\n");
	const filed = fileSessionAsSummary(doc, { id: "RC-0007", title: "Pricing review", text: none }, ctx);
	assert(filed.record.added.every((added: any) => added.kind !== "item"), "Parked None gives no item");

	const hand = "### RC-0008 | OPEN | 2026-09-21 | Notes\n\nCall the supplier about the delay.\nThey promised an answer by Friday.\n";
	const handFiled = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0008", title: "Notes", text: hand }, ctx);
	assert(handFiled.record.added.length === 1 && handFiled.summaryNoteId, `a hand-written block is one note, got ${handFiled.record.added.length}`);
	const note = find(handFiled.doc, handFiled.summaryNoteId!)!;
	assert(note.topic.title === SUMMARY_TOPIC && note.entry.text.includes("Call the supplier") && note.entry.text.includes("by Friday"), `and it holds the block (${note.entry.text})`);

	// An existing Unsorted topic is reused, not doubled.
	const withTopic = fileSessionAsSummary(handFiled.doc as any, { id: "RC-0007", title: "Pricing review", text: none }, { ...ctx, nextEntryNumber: handFiled.nextEntryNumber });
	assert(withTopic.doc.topics.filter((topic: any) => topic.title === SUMMARY_TOPIC).length === 1 && !withTopic.record.newTopics.includes(SUMMARY_TOPIC), "a second summary goes into the same Unsorted topic");
	console.log("3. summary: None parked adds no item; a hand-written block is one note; Unsorted is reused");
}

// --- 4. Review fixes: structure, continuations, labels, keys ------------------------
{
	const rewriteTwice = (doc: any) => {
		const once = renderMemoryDocument(doc, "storage");
		return { once, twice: renderMemoryDocument(parseMemoryDocument(once), "storage") };
	};
	for (const [label, title, bodyLine] of [["title hashes", "### A heading title", "- A plain line."], ["hashes only", "Plain title", "##"], ["three hashes", "Plain title", "###"], ["seven hashes", "Plain title", "####### x"], ["comment", "Plain title", "<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->"]]) {
		const text = `### RC-0009 | OPEN | 2026-09-20 | ${title}\n\n**Session arc:** The arc.\n\n**Body:**\n- First line.\n${bodyLine}\nThe line after it.\n\n**Parked:**\nNone\n`;
		const filed = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0009", title, text }, ctx);
		const { once, twice } = rewriteTwice(filed.doc);
		assert(once === twice, `${label}: the second rewrite is identical`);
		const note = find(parseMemoryDocument(once), filed.summaryNoteId!);
		assert(note && note.entry.summary === true && note.entry.text.includes("First line.") && note.entry.text.includes("The line after it.") && note.entry.text.includes("The arc."), `${label}: the summary note holds its lines (${note?.entry.text})`);
		assert(note.entry.text.split("\n").every((line: string) => !/^\s*(?:#+(?:\s|$)|<!--)/.test(line)), `${label}: no line reads as structure`);
	}
	const hyphen = MEMORY.replace("<!-- e: id=m-0001 kind=fact saved=2026-09-01 refs=2 -->", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 refs=2 learned-at=2026-01-01 model.name=gpt -->");
	const hyphenOut = renderMemoryDocument(parseMemoryDocument(hyphen), "storage");
	assert(hyphenOut.includes("learned-at=2026-01-01 model.name=gpt") && !/ at=2026-01-01/.test(hyphenOut), "a key with a hyphen or a dot is kept whole");

	const parkedText = "### RC-0010 | OPEN | 2026-09-20 | Parked\n\n**Session arc:** Arc.\n\n**Body:**\n- Body.\n\n**Parked:**\n- Thread A\n  with a continuation line\n- Thread B\n";
	const parked = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0010", title: "Parked", text: parkedText }, ctx);
	const items = parked.record.added.filter((added: any) => added.kind === "item");
	assert(items.length === 2 && items[0].text.includes("Thread A") && items[0].text.includes("with a continuation line"), `a parked bullet keeps its continuation inside one item (${JSON.stringify(items.map((item: any) => item.text))})`);
	for (const none of ["None yet", "No open threads", "Nothing pending.", "- None"]) {
		const filed = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0010", title: "P", text: parkedText.replace(/\*\*Parked:\*\*[\s\S]*$/, `**Parked:**\n${none}\n`) }, ctx);
		assert(filed.record.added.every((added: any) => added.kind !== "item"), `"${none}" is nothing parked`);
	}
	const outsideColon = "### RC-0011 | OPEN | 2026-09-20 | Labels\n\n**Session arc**: Arc outside.\n\n**Body**:\n- A body line.\n\n**Parked**:\nNone\n";
	const outside = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0011", title: "Labels", text: outsideColon }, ctx);
	const outsideNote = find(outside.doc, outside.summaryNoteId!)!;
	assert(!/\*\*Body\*\*|None/.test(outsideNote.entry.text) && outsideNote.entry.text.includes("A body line."), `labels with the colon outside the bold are read as labels (${outsideNote.entry.text})`);

	const nested = "### RC-0012 | OPEN | 2026-09-20 | Nested\n\n**Session arc:** Arc.\n\n**Body:**\n- Pricing:\n  - **must-keep** The floor is 40 euros.\n- Other.\n\n**Parked:**\nNone\n";
	const nestedFiled = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0012", title: "Nested", text: nested }, ctx);
	const pinnedNote = nestedFiled.record.added.find((added: any) => nestedFiled.record.pinned.includes(added.id));
	assert(pinnedNote && pinnedNote.text === "- Pricing:\n  - The floor is 40 euros.", `a nested must-keep line carries its parent line as context (${JSON.stringify(pinnedNote?.text)})`);
	assert(find(nestedFiled.doc, nestedFiled.summaryNoteId!)!.entry.text.includes("- Pricing:"), "and the parent stays in the summary note");

	const markedTitle = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0013", title: "**must-keep** Launch plan", text: "### RC-0013 | OPEN | 2026-09-20 | **must-keep** Launch plan\n\n**Session arc:** Arc.\n\n**Body:**\n- Line.\n\n**Parked:**\nNone\n" }, ctx);
	const markedNote = find(markedTitle.doc, markedTitle.summaryNoteId ?? "");
	assert(markedNote && markedNote.entry.pinned === false && markedNote.entry.summary === true && markedNote.entry.text.startsWith("- Launch plan\n"), `a must-keep marker in the title is stripped, so the summary note is never pinned (${markedNote?.entry.text})`);

	const { applyFoldOps } = await import("../src/absorb-ops.js");
	const withExtra = parseMemoryDocument(MEMORY.replace("refs=2 -->", "refs=2 sorter=x/y -->"));
	const applied = applyFoldOps(withExtra as any, [], { sessionId: "RC-0001", savedDate: "2026-09-28", nextEntryNumber: 3 });
	const original = find(withExtra, "m-0001")!.entry;
	const copy = find(applied.doc, "m-0001")!.entry;
	assert(copy.extra && copy.extra !== original.extra && copy.extra.sorter === "x/y", "the applier's copy owns its own extra");
	console.log("4. summary: structure-proof lines and title, parked continuations, label variants, nested must-keep, keys with hyphens");
}

// --- 5. A restore keeps the summary mark and the keys it does not know ----------------------
{
	const { restoreEntry } = await import("../src/memory-entries.js");
	const ARCHIVE = `<!-- e: id=m-0003 kind=fact saved=2026-09-28 from=RC-0007 summary=true tried=openai/gpt-5 sorter=x archived=2026-09-28 why=user topic=Unsorted section="Deep Memory" -->\nPricing review\n- Body line\n\n`;
	const row = parseArchive(ARCHIVE)[0];
	assert(row?.summary === true && JSON.stringify(row.tried) === JSON.stringify(["openai/gpt-5"]) && row.extra?.sorter === "x" && !row.extra?.tried, "the archived summary row carries its mark, the models that re-read it and its unknown key");
	const restored = restoreEntry(parseMemoryDocument(MEMORY), row);
	const back = find(restored, "m-0003");
	assert(back?.entry.summary === true && JSON.stringify(back.entry.tried) === JSON.stringify(["openai/gpt-5"]) && back.entry.tried !== row.tried && back.entry.extra?.sorter === "x" && back.entry.extra !== row.extra, `a restored summary note is still one, with its tried and its unknown keys (${JSON.stringify(back?.entry)})`);
	const rendered = renderMemoryDocument(restored, "storage");
	assert(/id=m-0003[^\n]*summary=true tried=openai\/gpt-5 sorter=x/.test(rendered), "and they are written back");
	// A model id with a space is quoted, and a list of models reads back as written.
	const two = parseMemoryDocument(renderMemoryDocument(restoreEntry(parseMemoryDocument(MEMORY), { ...row, tried: ["openai-compatible/my model:latest", "amazon-bedrock/us.anthropic.claude-v1"] }), "storage"));
	assert(JSON.stringify(find(two, "m-0003")?.entry.tried) === JSON.stringify(["openai-compatible/my model:latest", "amazon-bedrock/us.anthropic.claude-v1"]), `a quoted list of models round-trips (${JSON.stringify(find(two, "m-0003")?.entry)})`);
	assert(renderMemoryDocument(two, "storage").includes('tried="openai-compatible/my model:latest,amazon-bedrock/us.anthropic.claude-v1"'), "written quoted, comma-separated");
	// A comma in a model id is encoded, so the key reads back whole and the model does not re-read the note again.
	const { rereadModelKey, selectRereads } = await import("../src/absorb-reread.js");
	const comma = { provider: "gateway", model: "gpt-5.5,mini" };
	assert(rereadModelKey(comma) === "gateway/gpt-5.5%2Cmini" && rereadModelKey({ provider: "p", model: "a%2Cb" }) === "p/a%252Cb", "a comma and a percent sign are encoded in the key");
	const tried = parseMemoryDocument(renderMemoryDocument(restoreEntry(parseMemoryDocument(MEMORY), { ...row, topic: "Unsorted", tried: [rereadModelKey(comma), "openai/gpt-5"] }), "storage"));
	assert(JSON.stringify(find(tried, "m-0003")?.entry.tried) === JSON.stringify(["gateway/gpt-5.5%2Cmini", "openai/gpt-5"]), `a model id with a comma round-trips as one key (${JSON.stringify(find(tried, "m-0003")?.entry.tried)})`);
	assert(!selectRereads(tried, comma).some((entry) => entry.id === "m-0003") && selectRereads(tried, { provider: "gateway", model: "gpt-5.5" }).some((entry) => entry.id === "m-0003"), "the model with the comma does not re-read it again; the model without the comma still can");
	console.log("5. summary: a restore keeps summary=true, tried and unknown keys; tried round-trips quoted, a comma in a model id encoded");
}

// --- 6. A page without a title of its own, and the marker on any fold --------------------
{
	const untitled = fileSessionAsSummary(parseMemoryDocument(MEMORY), { id: "RC-0014", title: "RC-0014", text: "### RC-0014 | OPEN | 2026-09-20 |\n\nCall the supplier about the delay.\nThey promised an answer by Friday.\n" }, ctx);
	const untitledNote = find(untitled.doc, untitled.summaryNoteId!)!;
	assert(untitledNote.entry.text === "- Call the supplier about the delay.\n  - They promised an answer by Friday.", `a page with no title is headed by its first line (${JSON.stringify(untitledNote.entry.text)})`);

	// The applier strips the marker wherever it pins, an ordinary fold included.
	const { applyFoldOps } = await import("../src/absorb-ops.js");
	const { applyUserEdit, hasMustKeepMarker, withoutMustKeepMarkers } = await import("../src/memory-entries.js");
	const folded = applyFoldOps(parseMemoryDocument(MEMORY) as any, [
		{ op: "add", topic: "Renewals", kind: "fact", text: "- **must-keep** The contract is signed by the CEO." },
		{ op: "add", topic: "Renewals", kind: "fact", text: "- **must-keep - price floor**: 40 euros a seat." },
		{ op: "update", id: "m-0001", text: "- The Nordwind contract renews in April. **must-keep:**" },
	], { sessionId: "RC-0001", savedDate: "2026-09-28", nextEntryNumber: 3 });
	const texts = folded.record.added.map((added: any) => find(folded.doc, added.id)!.entry);
	assert(texts.every((entry: any) => entry.pinned) && texts[0].text === "- The contract is signed by the CEO." && texts[1].text === "- **price floor**: 40 euros a seat.", `a fold's must-keep note is pinned and keeps its words, not the label (${JSON.stringify(texts.map((entry: any) => entry.text))})`);
	const updated = find(folded.doc, "m-0001")!.entry;
	assert(updated.pinned && updated.text === "- The Nordwind contract renews in April." && folded.record.updated[0].after === updated.text, `an update carrying the marker pins the note and drops the label (${JSON.stringify(updated.text)})`);
	const twice = renderMemoryDocument(parseMemoryDocument(renderMemoryDocument(folded.doc as any, "storage")), "storage");
	assert(twice === renderMemoryDocument(folded.doc as any, "storage") && !/must-keep/i.test(twice), "no label comes back on a second rewrite");
	assert(withoutMustKeepMarkers("- **must-keep**") === "- **must-keep**", "a note that is only the label keeps it");
	assert(withoutMustKeepMarkers("- a\r\n- **must-keep** b ") === "- a\r\n- b", "only the lines that held the label change, whatever their ending");
	console.log("6. summary: an untitled page is headed by its first line; a pinned note carries no must-keep label, from any fold");

	// --- 7. The label's shapes, and a hand edit ----------------------------------------
	const quoted = "- Use `**must-keep**` to pin a line.";
	assert(!hasMustKeepMarker(quoted) && withoutMustKeepMarkers(quoted) === quoted, "a marker in a code span is quoted text, never a marker");
	const quotedFold = applyFoldOps(parseMemoryDocument(MEMORY) as any, [{ op: "add", topic: "Renewals", kind: "fact", text: quoted }], { sessionId: "RC-0001", savedDate: "2026-09-28", nextEntryNumber: 3 });
	const quotedEntry = find(quotedFold.doc, quotedFold.record.added[0].id)!.entry;
	assert(!quotedEntry.pinned && quotedEntry.text === quoted, `a fold that quotes the marker neither pins nor loses the quote (${JSON.stringify(quotedEntry)})`);
	for (const [label, text, expected] of [
		["a label that ends the sentence", "- The price is fixed **must-keep**.", "- The price is fixed."],
		["a label before a dash", "- **must-keep** - The floor is 40 euros.", "- The floor is 40 euros."],
		["a label before a long dash", "- **must-keep** \u2014 The floor is 40 euros.", "- The floor is 40 euros."],
		["a label beside a quoted one", "- **must-keep** Write `**must-keep**` to pin.", "- Write `**must-keep**` to pin."],
	]) {
		assert(withoutMustKeepMarkers(text) === expected, `${label}: ${JSON.stringify(withoutMustKeepMarkers(text))}`);
	}
	const added = applyUserEdit(parseMemoryDocument(MEMORY), { op: "add", topic: "Renewals", kind: "fact", text: "- **must-keep** Legal signs every renewal.", saved: "2026-09-28" }).doc;
	const handAdded = added.topics.flatMap((topic: any) => topic.entries).find((entry: any) => entry.text.includes("Legal signs"));
	assert(handAdded?.pinned === true && handAdded.text === "- Legal signs every renewal.", `a hand-added note with the marker is pinned, with no label (${JSON.stringify(handAdded)})`);
	const edited = find(applyUserEdit(parseMemoryDocument(MEMORY), { op: "edit", id: "m-0001", text: "- **must-keep:** The renewal is in April.", today: "2026-09-28" }).doc, "m-0001")!.entry;
	assert(edited.pinned === true && edited.text === "- The renewal is in April.", `a hand edit with the marker pins the note and drops the label (${JSON.stringify(edited)})`);
	const plainEdit = find(applyUserEdit(parseMemoryDocument(MEMORY), { op: "edit", id: "m-0001", text: "- Use `**must-keep**` here.", today: "2026-09-28" }).doc, "m-0001")!.entry;
	assert(plainEdit.pinned === false && plainEdit.text === "- Use `**must-keep**` here.", "a hand edit that quotes the marker is text");
	console.log("7. summary: the label's shapes (quoted, ending a sentence, before a dash) and a hand edit's marker");
}

console.log("absorb-summary smoke passed");
