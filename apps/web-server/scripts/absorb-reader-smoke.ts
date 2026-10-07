export {};

// Memorize never gets stuck: the reader. A fold reply's operations are found
// wherever a model put them, and a reply with none usable is named by the
// class the diagnostics count. Everything runs through the real parser.

const { parseFoldOps } = await import("../src/absorb-ops.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exit(1);
	}
}

const OPS = '{"ops":[{"op":"add","topic":"Renewals","kind":"fact","text":"- The Nordwind contract renews in April."},{"op":"close","id":"m-0005"}]}';
const fence = (body: string, label = "json") => `\`\`\`${label}\n${body}\n\`\`\``;

// --- 1. Tolerance: the ops are read wherever they are -------------------------
{
	const trailing = parseFoldOps(`Done.\n\n${fence('{"ops":[{"op":"close","id":"m-0005"},],}')}\n`);
	assert(trailing.problems.length === 0 && trailing.items.length === 1, `trailing commas are forgiven (${trailing.problems.join("; ")})`);

	const bare = parseFoldOps(`Done.\n\n${fence('[{"op":"close","id":"m-0005"}]')}\n`);
	assert(bare.problems.length === 0 && bare.items.length === 1, `a bare array is an op list (${bare.problems.join("; ")})`);

	const stray = parseFoldOps(`The session moved the renewal.\n\n\`\`\`\n\nMore narrative.\n\n${fence(OPS)}\n`);
	assert(stray.problems.length === 0 && stray.items.length === 2, `a stray \`\`\` line before the fence neither hides the ops nor reads as cut (${stray.problems.join("; ")})`);

	const strayAfter = parseFoldOps(`Narrative.\n\n${fence(OPS)}\n\nThat is all.\n\`\`\`\n`);
	assert(strayAfter.problems.length === 0 && strayAfter.items.length === 2, `a stray \`\`\` line after the fence is ignored (${strayAfter.problems.join("; ")})`);

	const unfenced = parseFoldOps(`Here are the operations: ${OPS}\n`);
	assert(unfenced.problems.length === 0 && unfenced.items.length === 2, `a reply with no fence but a balanced JSON value is read (${unfenced.problems.join("; ")})`);

	const brokenJsonFenceThenGood = parseFoldOps(`${fence("{not json")}\n\nSorry, again:\n\n${fence(OPS, "")}\n`);
	assert(brokenJsonFenceThenGood.problems.length === 0 && brokenJsonFenceThenGood.items.length === 2, `when the last json fence does not parse, another complete fence that does is read (${brokenJsonFenceThenGood.problems.join("; ")})`);

	const salvaged = parseFoldOps(`Narrative.\n\n${fence(OPS)}\n\nAnd one more:\n\n\`\`\`json\n{"ops":[{"op":"add","topic":"X","kind":"fact","text":"- cut her`, { truncated: true });
	assert(salvaged.problems.length === 0 && salvaged.items.length === 2 && salvaged.unreadable === undefined, `a cut-off reply is salvaged from its last complete fence (${salvaged.problems.join("; ")})`);
	console.log("1. reader: trailing commas, bare arrays, stray fences, unfenced JSON and salvage");
}

// --- 2. Unusable replies are named by class ------------------------------------
{
	const cases: Array<[string, string, { truncated?: boolean }?]> = [
		["I folded the session into memory.", "no-fence"],
		[fence("{not json"), "invalid-json"],
		[fence('{"operations":[]}'), "not-a-list"],
		[fence('{"ops":[]}'), "empty-list"],
		[fence("[]"), "empty-list"],
		['Narrative.\n\n```json\n{"ops":[{"op":"add","topic":"X","kind":"fact","text":"- cut', "cut-off"],
		["A long narrative that never reached its fence", "cut-off", { truncated: true }],
	];
	for (const [reply, expected, opts] of cases) {
		const parsed = parseFoldOps(reply, opts);
		assert(parsed.items.length === 0 && parsed.problems.length === 1, `an unusable reply has no ops and one named problem (${JSON.stringify(reply).slice(0, 40)})`);
		assert(parsed.unreadable === expected, `class for ${JSON.stringify(reply).slice(0, 40)} is ${expected}, got ${parsed.unreadable}`);
	}
	// A cut-off reply never yields an array nested inside the fence it was cut in.
	const innerArray = parseFoldOps('Narrative.\n\n```json\n{"ops":[{"op":"add","topic":"X","text":"one"},{"op":"supersede","ids":["m-0001","m-0002"],"text":"new val', { truncated: true });
	assert(innerArray.items.length === 0 && innerArray.unreadable === "cut-off", `a cut-off reply is not read from an inner array (${innerArray.unreadable}, ${innerArray.items.length} ops)`);
	const strings = parseFoldOps('Ids: ["m-0001","m-0002"]');
	assert(strings.items.length === 0 && strings.unreadable === "no-fence", `an array of strings is never an op list (${strings.unreadable})`);
	const stringsFenced = parseFoldOps(fence('{"ops":["m-0001"]}'));
	assert(stringsFenced.unreadable === "not-a-list", `an ops array of strings is not a list (${stringsFenced.unreadable})`);

	// A later json fence that is not an op list does not hide the real one.
	const laterSummary = parseFoldOps('Narrative.\n\n```json\n{"ops":[{"op":"add","topic":"X","kind":"fact","text":"- one"}]}\n```\n\nSummary:\n```json\n{"summary":"added one note"}\n```\n');
	assert(laterSummary.problems.length === 0 && laterSummary.items.length === 1, `an op list before a later non-list json fence is read (${laterSummary.unreadable ?? laterSummary.problems.join("; ")})`);

	const perOp = parseFoldOps(fence('{"ops":[{"op":"rename","id":"m-0001"}]}'));
	assert(perOp.unreadable === undefined && perOp.items.length === 1 && perOp.items[0].op === "rename", "a readable list with a malformed op is read, not unreadable: the op is decided alone");

	// Each op is read alone, with its place in the reply: a stray string is
	// words with no kind, a malformed op beside real ops costs only itself.
	const mixed = parseFoldOps(fence('{"ops":["- Bob left the team on 3 June.",{"op":"close","id":"m-0005"},{"op":"ADD ","topic":"X","kind":" Fact","text":"- one","section":"Deep Memory"},{"op":"add","text":7},{"op":"add","text":["- Alice moved to Berlin.","  In May."]},{"op":"add","text":{"a":1}},3]}'));
	assert(mixed.unreadable === undefined && mixed.items?.length === 7, `a list with SOME op objects is an op list (${mixed.unreadable}, ${mixed.items?.length} items)`);
	assert(mixed.items.map((item) => item.index).join() === "0,1,2,3,4,5,6" && mixed.items[1].id === "m-0005", "each item keeps its place in the reply");
	assert(mixed.items[0].op === "" && mixed.items[0].text === "- Bob left the team on 3 June.", "a string item is words with no kind, so they can be kept");
	assert(mixed.items[2].op === "add" && mixed.items[2].kind === "fact" && mixed.items[2].foreignKeys?.join() === "section", "the kind and the note's kind are read trimmed and lowercased, and a stray key is named on its op");
	assert(mixed.items[3].text === "7" && mixed.items[4].text === "- Alice moved to Berlin.\n  In May.", "a number in a text is its spelling, and a text given as lines is those lines");
	assert(mixed.items[5].text === undefined && mixed.items[5].textNotText === true && mixed.items[6].op === "" && mixed.items[6].text === undefined, "a text that is an object is no text, and a number item is no op and no words");
	// A list needs an op-shaped item: a mixed array quoted after the real list
	// (a string beside an object that names no kind) never replaces it.
	const REAL = '{"ops":[{"op":"add","topic":"Pricing","kind":"fact","text":"- Alice moved to Berlin in May."},{"op":"close","id":"m-0002"}]}';
	const laterMixed = parseFoldOps(`Two points.\n\n${fence(REAL)}\n\nFor the record:\n${fence('["note", {"a": 1}]')}\n`);
	assert(laterMixed.items?.length === 2 && laterMixed.items[1].op === "close", `a later fenced array with no op-shaped item leaves the real list (${laterMixed.unreadable ?? laterMixed.items?.map((item) => item.op).join()})`);
	const proseMixed = parseFoldOps('Ops:\n{"ops":[{"op":"add","topic":"Pricing","kind":"fact","text":"- Alice moved to Berlin in May."}]}\nSources [1, {"x": 2}] end.');
	assert(proseMixed.items?.length === 1 && proseMixed.items[0].op === "add", `a mixed array in prose after unfenced ops leaves the real list (${proseMixed.unreadable ?? proseMixed.items?.map((item) => item.op).join()})`);
	assert(parseFoldOps(fence('{"ops":[{}]}')).unreadable === "not-a-list", "a list whose only object names no kind is not an op list");
	console.log("2. reader: unusable replies carry their class; an empty list is never a drop");
}

// --- 3. Review fixes: an unclosed fence, linear scans, honest classes ----------------
{
	const unclosed = parseFoldOps(`Narrative.\n\n\`\`\`json\n${OPS}\n`);
	assert(unclosed.problems.length === 0 && unclosed.items.length === 2, `a complete op list in a fence never closed is read (${unclosed.unreadable})`);
	const unclosedCut = parseFoldOps(`Narrative.\n\n\`\`\`json\n${OPS}\n\`\``, { truncated: true });
	assert(unclosedCut.items.length === 2, `a reply cut inside its closing marker is read from the complete body (${unclosedCut.unreadable})`);
	const bashOnly = parseFoldOps("Here is how:\n\n```bash\nls -la\n```\n");
	assert(bashOnly.unreadable === "no-fence", `a reply with a code sample and no ops is no-fence, got ${bashOnly.unreadable}`);
	const emptyJson = parseFoldOps("Nothing:\n\n```json\n\n```\n");
	assert(emptyJson.unreadable === "no-fence", `an empty json fence is no-fence, got ${emptyJson.unreadable}`);
	const thenEmpty = parseFoldOps(`${fence(OPS)}\n\nOn reflection:\n\n${fence('{"ops":[]}')}\n`);
	assert(thenEmpty.items.length === 2, "when the last json fence is an empty list, an earlier fence's ops are taken");
	for (const [label, runaway] of [["[", "[".repeat(100_000)], ["{", "{".repeat(100_000)], ['["', '["'.repeat(60_000)]] as const) {
		const started = performance.now();
		const read = parseFoldOps(runaway, { truncated: true });
		const ms = performance.now() - started;
		assert(read.unreadable === "cut-off" && ms < 200, `a runaway reply of ${runaway.length} "${label}" reads in under 200 ms (${ms.toFixed(0)} ms)`);
	}
	const manyCommas = parseFoldOps(fence(`{"ops":[${Array.from({ length: 2_000 }, () => '{"op":"close","id":"m-0005"}').join(", ")},]}`));
	assert(manyCommas.items.length === 2_000, "a long list with a trailing comma reads");
	console.log("3. reader: unclosed fences, linear on runaway replies, bash-only and empty fences are no-fence");
}

// --- 4. A quote in the prose hides nothing; an open fence is cut only when it is --------
{
	const { readFoldReply } = await import("../src/absorb-ops.js");
	const OPS1 = '{"ops":[{"op":"close","id":"m-0001"}]}';
	for (const reply of [
		`Sources [1] and "two" quotes. Ops: ${OPS1}`,
		`Section [1 of the doc says "quote. Ops: ${OPS1}`,
		`Config { was noted, he said "no. Ops: ${OPS1}`,
		`Sources [see "the note]. Ops: ${OPS1}`,
		`He said "fine. Ops: ${OPS1}`,
		`Section [1 says "a" and "b". Ops: ${OPS1}`,
		`Section [1 says "a" and "b. Ops: ${OPS1}`,
		`Section [1 says it's the user's. Ops: ${OPS1}`,
		`${OPS1} ] then "x`,
		`Result [draft: "${OPS1}"`,
		`Section [1 says "quote.\n\nOps:\n${OPS1}`,
		`Sources [see "the note].\n\nOperations:\n[{"op":"close","id":"m-0001"}]`,
	]) {
		const read = readFoldReply(reply);
		assert(read.list?.length === 1, `a quote in the prose before the ops hides nothing: ${JSON.stringify(reply.slice(0, 40))} read ${read.unreadable}`);
	}
	const prose = parseFoldOps(`A.\n\n\`\`\`json\n${OPS}\nThat is all.\n`);
	assert(prose.items.length === 2 && prose.problems.length === 0, `an open fence with complete ops and closing prose, not cut, is read (${prose.unreadable})`);
	const proseCut = readFoldReply(`A.\n\n\`\`\`json\n${OPS}\nThat is al`, { truncated: true });
	assert(proseCut.unreadable === "cut-off", "the same reply cut by the cap stays cut-off");
	const markerNewline = readFoldReply(`A.\n\n\`\`\`json\n${OPS}\n\`\`\n`, { truncated: true });
	assert(markerNewline.list?.length === 2, "a cut closing marker followed by a newline is stripped");
	const openEmpty = readFoldReply(`A.\n\n\`\`\`json\n{"ops":[]}\n`);
	assert(openEmpty.unreadable === "empty-list", `an open fence holding an empty list is empty-list, got ${openEmpty.unreadable}`);
	const lastWins = readFoldReply(`${fence(OPS)}\nBetter:\n\`\`\`json\n${OPS1}\n`);
	assert(lastWins.list?.length === 1, "a complete fence followed by an open fence with another list takes the open, last one");
	const runaway = `Section [1 says "x. ${"[".repeat(100_000)}`;
	const started = performance.now();
	readFoldReply(runaway);
	assert(performance.now() - started < 200, "the anchored starts keep a runaway reply under 200 ms");
	const EXAMPLE = '{"ops": [{"op": "unpin", "id": "m-0001"}]}';
	const REAL = '{"ops":[{"op":"close","id":"m-0005"},{"op":"close","id":"m-0006"}]}';
	for (const reply of [
		`Never ${EXAMPLE}.\n\n\`\`\`json\n{"ops":[{"op":"close","id":"m-0001"}, {"op":"add","text":"cu`,
		`Not ${EXAMPLE}.\n\`\`\`json\n${REAL.slice(0, -3)}`,
	]) {
		const read = readFoldReply(reply, { truncated: true });
		assert(read.unreadable === "cut-off" && !read.list, `an example quoted before a cut fence is never read as the answer, got ${JSON.stringify(read.list)}`);
	}
	const wrapped = readFoldReply(`Done.\n\n{"result":${OPS1}}`);
	assert(wrapped.list?.length === 1, "an op list wrapped in another object is read through the anchor");
	console.log("4. reader: a prose quote hides no ops, an open fence with closing prose is read, empty open fences are empty-list");
}

console.log("absorb-reader smoke passed");
