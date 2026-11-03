// How the last block of an answer looks while it is still being written
// (stream-repair.ts), rendered as the page renders it: half-written bold,
// italic, code and strikethrough show styled from their first letter, a link
// shows as its words until its address is complete, lone markers wait for
// their first word, and a table shows once its header and separator lines are
// complete, its rows then as they are written. The rows that must not change
// (paths, products, snake_case, a citation being typed) render exactly as
// when finished, an inline formula still arriving waits for its closer, and a
// finished answer is never repaired. Each repaired row is also checked
// against the same text drawn finished, so it proves the repair does the work.
// Offline: no server, no provider.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ONLY=<words of a label> runs one section alone.
function check(label: string, body: () => void | Promise<void>): Promise<void> {
	if (process.env.ONLY && !label.includes(process.env.ONLY)) return Promise.resolve();
	return Promise.resolve(body()).then(() => console.log(`  ok  ${label}`));
}

const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
const { createElement } = pageRequire("react");
(globalThis as any).React = pageRequire("react");
const { renderToStaticMarkup } = pageRequire("react-dom/server");
// Page components (.tsx): loaded at run time, as the server build compiles scripts without JSX.
const markdown: any = await import(new URL("../../web-ui/src/components/Markdown.tsx", import.meta.url).href);

const render = (text: string, streaming = true): string => renderToStaticMarkup(createElement(markdown.MarkdownRenderer, { answer: true, streaming }, text));
const finished = (text: string) => render(text, false);
// Drawn in blocks and drawn whole differ only in the line breaks the whole render puts between top-level elements.
const look = (html: string) => html.replace(/>\n+/g, ">").trim();

/** A row: drawn while it streams it passes `ok`, and the same text drawn finished does not. */
function closes(text: string, ok: (html: string) => boolean, what: string): void {
	const html = render(text);
	assert(ok(html), `${what}: ${JSON.stringify(text)} rendered ${html}`);
	const before = finished(text);
	assert(!ok(before), `${what}: drawn finished, ${JSON.stringify(text)} should not pass, got ${before}`);
}

await check("half-written marks show styled from their first letter", () => {
	closes("Here is the plan. **Summary firs", (h) => h.includes("<strong>Summary firs</strong>") && !h.includes("**"), "open bold");
	closes("**bold*", (h) => h.includes("<strong>bold</strong>") && !h.includes("<em>"), "bold half-closed");
	closes("***x", (h) => /<em><strong>x<\/strong><\/em>|<strong><em>x<\/em><\/strong>/.test(h), "bold italic");
	closes("Say *it", (h) => h.includes("<em>it</em>"), "open italic");
	closes("Run `npm ru", (h) => h.includes("<code>npm ru</code>") && !h.includes("`"), "open code");
	closes("This is ~~x", (h) => h.includes("<del>x</del>"), "open strikethrough");
	closes("**bold and `cod", (h) => h.includes("<strong>bold and <code>cod</code></strong>"), "code inside bold");
	closes("Ends with **bold ", (h) => h.includes("<strong>bold</strong>"), "a trailing space before the closer");
	closes("Run ``a`", (h) => h.includes("<code>a</code>") && !h.includes("`"), "a closing run half received");
	closes("**see `x`", (h) => h.includes("<strong>see <code>x</code></strong>"), "a closer right after a finished span");
	closes("**Use `open and ``closed``", (h) => h.includes("<strong>Use `open and <code>closed</code></strong>"), "bold still closes when the code closer would join a finished span's run");
	closes("- **Speed**: fast\n- **Co", (h) => h.includes("<strong>Speed</strong>") && h.includes("<strong>Co</strong>"), "bold in the last list item");
	const earlier = render("An **open** start.\n\nThen **more");
	assert(earlier.includes("<strong>open</strong>") && earlier.includes("<strong>more</strong>"), `only the last block is repaired, the blocks before draw as written, got ${earlier}`);
});

await check("a link shows as its words until its address is complete", () => {
	closes("See [the docs](https://exa", (h) => h.includes("See the docs") && !h.includes("<a") && !h.includes("]("), "open link");
	closes("See \\![docs](https://exa", (h) => h.includes("See !docs") && !h.includes("<a") && !h.includes("]("), "an open link after an escaped exclamation mark");
	closes("Read https://exa", (h) => h.includes("https://exa") && !h.includes("<a"), "a bare address being typed");
	const done = render("See [the docs](https://example.com) now");
	assert(done.includes('<a href="https://example.com"'), `a finished link is a link, got ${done}`);
	closes("See [the docs](<https://example.com/a b", (h) => h.includes("See the docs") && !h.includes("<a") && !h.includes("]("), "an open link with its address in angle brackets");
	closes("[docs](<https://example.com/a **b>) and **mo", (h) => h.includes("<strong>mo</strong>") && h.includes('href="https://example.com/a%20**b"'), "bold after a finished link with its address in angle brackets");
	closes("Look: ![chart](/api/persistent-agents/r/files/c", (h) => !h.includes("<img") && !h.includes("chart") && !h.includes("!["), "an image waits for its address");
});

await check("headings, bullets and rules being typed never flash", () => {
	closes("Text\n-", (h) => h.includes("<p>Text</p>") && !h.includes("<h2") && !h.includes("<ul"), "setext dash");
	closes("Text\n==", (h) => h.includes("<p>Text</p>") && !h.includes("<h1"), "setext equals");
	closes("Intro\n\n#", (h) => !h.includes("<h1"), "a lone hash");
	closes("Intro\n\n- ", (h) => !h.includes("<li"), "a lone bullet");
	closes("Intro\n\n1.", (h) => !h.includes("<ol"), "a lone number");
	closes("Intro\n\n**", (h) => !h.includes("<li") && !h.includes("**"), "a lone pair of stars");
	closes("Intro\n\n--", (h) => !h.includes("<li") && !h.includes("--"), "a rule being typed");
	closes("Intro <b", (h) => h.includes("Intro") && !h.includes("&lt;b"), "a tag being typed");
	closes('Intro <a href="htt', (h) => !h.includes("&lt;a"), "a tag with its address being typed");
});

await check("the closing fence being typed never shows as a line of code", () => {
	closes("```sh\nnpm test\n``", (h) => h.includes("npm test") && !h.includes("``"), "closing fence");
	const open = render("```sh\nnpm te");
	assert(open.includes("npm te"), `an open fence keeps its code, got ${open}`);
	const marks = render("```js\nconst a = **b\n");
	assert(marks.includes("const a = **b"), `marks inside code are left alone, got ${marks}`);
});

await check("an inline formula still arriving holds the rest of its line; a formula's insides are not marks", () => {
	closes("the area is \\(x^2", (h) => h.includes("the area is") && !h.includes("\\(") && !h.includes("x^2"), "an open \\( formula");
	closes("so $$E = mc", (h) => h.includes("so") && !h.includes("$$") && !h.includes("mc"), "an open $$ formula");
	closes("for each \\(n", (h) => h.includes("for each") && !h.includes("(n"), "an open \\( formula without a maths sign");
	closes("Code `\\(n` then \\(m", (h) => h.includes("<code>\\(n</code>") && !h.includes("(m"), "an open \\( formula after one in code");
	closes("Bash's `$$` is the PID; the area is \\(x^2 + y", (h) => h.includes("<code>$$</code>") && !h.includes("x^2"), "an open \\( formula after a $$ in code");
	for (const text of ["With \\(a^* + b\\) and **bo", "With $a^*$ and **bo"]) {
		const formula = render(text);
		assert(formula.includes("<strong>bo</strong>") && !/<em>|\*<\/strong>|<\/strong>\*/.test(formula), `a star inside a formula opens nothing, got ${formula}`);
	}
	const display = "Before.\n\n$$\n\\text{a*b} **x";
	assert(look(render(display)) === look(finished(display)), `a display formula still open is left as written, got ${render(display)}`);
	for (const price of ["It costs $5 and $1", "the area is $x^2"]) assert(look(render(price)) === look(finished(price)), `a single dollar is never held: it may be a price, got ${render(price)}`);
});

await check("text that only looks half-written renders exactly as when finished", () => {
	for (const text of [
		"5 * 3 = 15",
		"2*3*4",
		"snake_case",
		"__init__.py",
		"__init",
		"C:\\temp\\*.log",
		"C:\\exxtest\\ENV~1",
		"C:\\PROGRA~1\\App",
		"5~10 min",
		"* item",
		"- [ ] task",
		"see [1",
		"see [1]",
		"if a <b then c",
		"a < b",
		"Plain words",
		"Done **bold** and `code` and ~~gone~~.",
		"Path `C:\\Users\\me`",
		"|x| is the size\nof x, and more",
		// Code is never repaired: a finished fence, indented code, a fence in a quote, a finished span.
		"```py\n\nprint('**x')\n```",
		"Text\n\n    a = **b",
		"> ```\n> a = **b\n> ```",
		// Nothing cuts code either: a lone marker, a pipe line or a rule ending an indented block, a span over two quote lines.
		"    cat <<'-'\n    hello\n    -",
		"Run this:\n\n    echo hi\n    #",
		"> `first\n> second`",
		"Run `curl https://example.com`",
		"Run `<b`",
		// A closing backtick right after a finished span would join its closing run.
		"Use `open and ``closed``",
		// Escaped openers open nothing, and an escaped bracket in prose is not maths.
		"Use \\` literally",
		"Use \\[label](unfinished",
		"Use \\[field_name] in the regex",
		"\\[field_name] in the regex",
		'[docs](https://example.com "**x(")',
		"[docs](https://example.com/a_(b)**x)",
		// An address in angle brackets may hold spaces, and its marks are not marks.
		"[docs](<https://example.com/a **b>)",
		"[docs](<https://example.com/a **b> \"the **title\") and more",
		"[docs]( <https://example.com/a **b>)",
		"[docs](\n<https://example.com/a **b>)",
		// A line with a pipe shows as soon as the next line proves it is no table header.
		"|x| is the size\nSo",
		// A table row pads its cells one way, so a line that mixes the two is prose from its first words.
		"|x| is the size of x.",
		"|x| is the size of x.\n",
		"Intro\n\n|x| is the size",
		"pick A | B here\nand more",
		"Location | Path\n--- | --- | -",
		// No delimiter row starts like this, so the lines are text at once.
		"A | B\n-:- | -",
		"A | B\n--- | | -",
		"A | B\n--- | : ",
		// A pipe inside code, or in a list item, is no table header.
		"Run `a | b` now",
		"- use a | b",
	]) {
		const repaired = render(text);
		const plain = finished(text);
		assert(look(repaired) === look(plain), `${JSON.stringify(text)} must render as when finished:\n  streaming ${repaired}\n  finished  ${plain}`);
	}
});

await check("a table shows once its header and separator lines are complete, its rows as they are written", () => {
	closes("Intro\n\n|", (h) => h.includes("Intro") && !h.includes("|"), "a header's first pipe waits");
	closes("Intro\n\n| Location | Full path |", (h) => h.includes("Intro") && !h.includes("|") && !h.includes("<table"), "a header alone waits");
	closes("Intro\n\n|Location|Full path|", (h) => h.includes("Intro") && !h.includes("|") && !h.includes("<table"), "a header without blanks around its cells waits");
	closes("Intro\n\n| Name|Path |", (h) => h.includes("Intro") && !h.includes("|") && !h.includes("<table"), "a header padded unevenly waits");
	closes("Intro\n\n| Name|Path |\n| --", (h) => h.includes("Intro") && !h.includes("|") && !h.includes("<table"), "a header padded unevenly waits while its separator is typed");
	closes("Intro\n\n| Location | Full path |\n", (h) => h.includes("Intro") && !h.includes("|") && !h.includes("<table"), "a header whose line has ended waits for its separator");
	closes("Intro\n\n| Location | Full path |\n| --- | -", (h) => !h.includes("|") && !h.includes("<table"), "a separator being typed draws no pipes and no table");
	const table = render("| Location | Full path |\n| --- | --- |\n");
	assert(table.includes("<table") && table.includes("<th>Location</th>") && !table.includes("<td"), `a complete header shows the table, got ${table}`);
	const row = render("| Location | Full path |\n| --- | --- |\n| Roaming | `C:\\Users\\me\\AppData\\Roa");
	assert(row.includes("<td>Roaming</td>") && /<td><code class="md-cell-code">C:\\(<wbr\/>)?Users\\(<wbr\/>)?me\\(<wbr\/>)?AppData\\(<wbr\/>)?Roa<\/code><\/td>/.test(row), `a row being written shows its half-filled cells, its code already code, got ${row}`);
	const next = render("| Location | Full path |\n| --- | --- |\n| Roaming | `C:\\Users\\me\\AppData\\Roaming` |\n| Lo");
	assert(next.includes("<td>Roaming</td>") && next.includes("<td>Lo</td>"), `the next row shows as its first letters arrive, got ${next}`);
	const lone = render("| A | B |\r| --- | --- |\r| x | y");
	assert(lone.includes("<th>A</th>") && lone.includes("<td>x</td><td>y</td>"), `a table whose lines end with a lone CR shows as it is written, got ${lone}`);
	// Without outer pipes, as GFM allows.
	closes("Intro\n\nLocation | Path", (h) => h.includes("Intro") && !h.includes("|") && !h.includes("<table"), "a header without outer pipes waits");
	closes("Location | Path\n", (h) => !h.includes("|") && !h.includes("<table"), "a header without outer pipes whose line has ended waits");
	closes("Location | Path\n--- | -", (h) => !h.includes("|") && !h.includes("<table"), "a separator without outer pipes being typed draws no pipes and no table");
	closes("Text\nLocation | Path\n---", (h) => h.includes("<p>Text</p>") && !h.includes("|") && !h.includes("<h2"), "a header under a line of text waits, its separator's first dashes too");
	const bare = render("Location | Path\n--- | ---\n");
	assert(bare.includes("<th>Location</th>") && bare.includes("<th>Path</th>"), `a complete header without outer pipes shows the table, got ${bare}`);
	const bareRow = render("Location | Path\n--- | ---\nRoaming | `C:\\Users`\nLo");
	assert(bareRow.includes("<td>Roaming</td>") && bareRow.includes("<td>Lo</td>"), `rows without outer pipes show as they are written, got ${bareRow}`);
	for (const text of ["A | B\n--- | ---\nfirst\nsecond | value", "A | B\n--- | ---\nfirst\nsecond | value\n"]) {
		const rows = render(text);
		assert(rows.includes("<td>first</td>") && rows.includes("<td>second</td><td>value</td>"), `a row after a row without a pipe is a row, not a new header: ${JSON.stringify(text)} rendered ${rows}`);
	}
	for (const text of ["- A | B\n  --- | ---\n  x | y", "| - | - |\n| --- | --- |\n| x | y |"]) {
		const rows = render(text);
		assert(rows.includes("<td>x</td><td>y</td>"), `the last row of a table under way shows, its header in a list item or made of marks: ${JSON.stringify(text)} rendered ${rows}`);
	}
	closes("- first\n\n  A | B\n  --- | ---\n  x | y\n- next\n  C | D", (h) => h.includes("<td>x</td>") && !h.includes("C | D"), "a header in the next list item waits, though a table stands above it");
	closes("Use a | b\n| A | B |", (h) => h.includes("Use a | b") && !h.includes("| A"), "a header under a line of text with a pipe waits");
	assert(table.includes("data-streaming") && !finished("| a | b |\n| --- | --- |\n| c | d |").includes("data-streaming"), "the table is marked while the answer streams, and not once it is finished");
});

await check("no repair changes code, at any point of an answer's writing", () => {
	const { fromMarkdown } = pageRequire("mdast-util-from-markdown");
	const { gfmFromMarkdown } = pageRequire("mdast-util-gfm");
	const { gfm } = pageRequire("micromark-extension-gfm");
	type Found = { blocks: string[]; spans: string[]; at: Array<[number, number]> };
	const codeIn = (text: string): Found => {
		const found: Found = { blocks: [], spans: [], at: [] };
		const visit = (node: { type: string; value?: string; lang?: string | null; children?: unknown[]; position?: { start: { offset: number }; end: { offset: number } } }) => {
			if (node.type === "code") found.blocks.push(`${node.lang ?? ""}:${node.value}`);
			else if (node.type === "inlineCode") {
				found.spans.push(node.value ?? "");
				found.at.push([node.position!.start.offset, node.position!.end.offset]);
			}
			else (node.children as typeof node[] | undefined)?.forEach(visit);
		};
		visit(fromMarkdown(text, { extensions: [gfm({ singleTilde: false })], mdastExtensions: [gfmFromMarkdown()] }));
		return found;
	};
	const answers = [
		"Intro **bold**\n\n```sh\nnpm run **x\n- item\n#\n```\n\nAfter `code` and **more**",
		"Steps:\n\n    cat <<'-'\n    hello\n    -\n    #\n    | a |\n\nDone.",
		"> Note:\n>\n>     echo hi\n>     #\n>     -\n\nNext",
		">     #\n>     -\n\nNext",
		"> ```\n> a = **b\n> |x|\n> ```\n> after `x`",
		"Use `a | b` and ``x ` y`` then [the `api` docs](https://e.com/x) and `https://e.com` end",
		"| A | `B` |\n| - | - |\n| `x` | `C:\\Users\\me` |\n",
		"Use `open and ``closed`` then **more** and `done`",
		"See [docs](<https://example.com/a **b>) and `code` then **more**",
		"Paths:\n\nLocation | Path\n--- | ---\nRoaming | `C:\\Users\\me` and **x\nLocal | `%LOCALAPPDATA%`\n\nDone.",
	];
	for (const answer of answers) {
		for (let end = 1; end <= answer.length; end++) {
			const written = answer.slice(0, end);
			const repaired = markdown.repairAnswerTail(written);
			const before = codeIn(written);
			const after = codeIn(repaired);
			const where = `at ${end} characters of ${JSON.stringify(answer)}: ${JSON.stringify(written)} became ${JSON.stringify(repaired)}`;
			// Every code block stays exactly as written; only an open fence's closing line being typed waits.
			const typedCloser = /(?:^|\n)[`~]{1,2}$/;
			const blocks = (found: Found) => found.blocks.map((block, i) => (i === found.blocks.length - 1 ? block.replace(typedCloser, "") : block));
			assert(JSON.stringify(blocks(after)) === JSON.stringify(blocks(before)), `code blocks changed ${where}`);
			// Spans: a run of the written ones from the start (the rest may wait whole with their line), then at most one
			// span the repair closed, whose text was written after a backtick.
			const leads = (spans: string[]) => spans.length <= before.spans.length && spans.every((span, i) => span === before.spans[i]);
			const last = after.spans.at(-1) ?? "";
			assert(leads(after.spans) || (leads(after.spans.slice(0, -1)) && written.includes(`\`${last}`)), `code spans changed ${where}`);
			// A written span still in its place is still a span, unless the span the repair closed holds it.
			const [closedStart, closedEnd] = after.at.at(-1) ?? [0, 0];
			for (const [start, stop] of before.at) {
				const kept = repaired.slice(start, stop) === written.slice(start, stop);
				const held = after.at.some(([s, e]) => s === start && e === stop) || (closedStart < start && stop <= closedEnd);
				assert(!kept || held, `a written span stopped being code ${where}`);
			}
		}
	}
});

await check("a table, with or without outer pipes, never shows its pipes as text, at any point of its writing", () => {
	const bare = "Apps keep settings here:\n\nLocation | Path | Variable\n:--- | --- | ---:\nRoaming | `C:\\Users\\me\\AppData\\Roaming` | `%APPDATA%`\nLocal | `C:\\Users\\me\\AppData\\Local` | `%LOCALAPPDATA%`\n\nPick Roaming.";
	const piped = bare.replace(/^(.* \| .*)$/gm, "| $1 |");
	for (const answer of [bare, piped]) for (let end = 1; end <= answer.length; end++) {
		const html = render(answer.slice(0, end));
		const pipes = [...html.matchAll(/<p>(.*?)<\/p>/gs)].filter((match) => match[1].includes("|"));
		assert(!pipes.length, `at ${end} characters, ${JSON.stringify(answer.slice(0, end))} drew a paragraph of pipes: ${html}`);
	}
});

await check("a finished answer is never repaired; the repair is idempotent", () => {
	for (const text of ["**open bold", "[link](https://exa", "Text\n-", "Intro\n\n| a | b |"]) {
		const html = finished(text);
		assert(html === renderToStaticMarkup(createElement(markdown.MarkdownRenderer, { answer: true }, text)), `a finished ${JSON.stringify(text)} renders as written`);
	}
	assert(finished("**open bold").includes("**open bold") && finished("Intro\n\n| a | b |").includes("| a | b |"), "a finished answer keeps its marks and pipes as written");
	const samples = ["Here is **Summary firs", "**x*", "***x", "See [a](http", "Text\n-", "`cod", "| a | b |\n| --- | --- |\n| c", "| a | b |\n| -", "Read https://exa", "Intro <b", "```sh\nx\n``", "a ~~b", "- **a\n- b", "the area is \\(x^2"];
	for (const text of samples) {
		const once = markdown.repairAnswerTail(text);
		const twice = markdown.repairAnswerTail(once);
		assert(once === twice, `the repair is idempotent on ${JSON.stringify(text)}: ${JSON.stringify(once)} then ${JSON.stringify(twice)}`);
	}
});

console.log("stream repair smoke passed");
