// The chart block in an answer, rendered as the page renders it: a ```chart
// fence of plain data is drawn as a bar, line or pie chart once its fence
// closes, a value shows on hover and with the arrow keys, Table shows the
// numbers, and a block that is not a chart, or that the answer left
// half-written, shows as its code. Offline: no server, no provider.
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
const markdown: any = await import(new URL("../../web-ui/src/components/Markdown.tsx", import.meta.url).href);
const { readChart, niceTicks } = await import(new URL("../../web-ui/src/components/chart-block.ts", import.meta.url).href);

const render = (text: string, options: Record<string, unknown> = {}): string => renderToStaticMarkup(createElement(markdown.MarkdownRenderer, { answer: true, ...options }, text));

const BAR = "type: bar\ntitle: Requests refused per hour\nnote: Today, example numbers\nHour, Refused\n09:00, 12\n10:00, 30\n11:00, 84\n12:00, 41";
const LINE = "type: line\ntitle: Requests per day\nDay, Served, Refused\nMon, 1200, 140\nTue, 1350, 152\nWed, 1310, 149";
const PIE = "type: pie\nClient, Refused\nNightly sync, 84\nMobile app, 41\nPartner API, 30";
const fence = (body: string) => `Most refusals came in one hour:\n\n\`\`\`chart\n${body}\n\`\`\`\n\nThat is the sync.`;

await check("a table carries its Copy in an answer and not on the other surfaces", () => {
	const TABLE = "| Team | Left |\n| --- | --- |\n| Sales | 8 |";
	assert(render(TABLE).includes('aria-label="Copy table"'), "an answer's table has Copy");
	assert(!render(TABLE, { answer: false }).includes("figure-strip") && render(TABLE, { answer: false }).includes("md-table-frame"), "a table elsewhere stays as it was");
});

await check("the block's form is read once, into named fields; anything else is not a chart", () => {
	const bar = readChart(BAR);
	assert(bar.ok && bar.chart.kind === "bar" && bar.chart.title === "Requests refused per hour" && bar.chart.note === "Today, example numbers", `the settings are read, got ${JSON.stringify(bar)}`);
	assert(bar.ok && bar.chart.labelName === "Hour" && bar.chart.labels.join() === "09:00,10:00,11:00,12:00" && bar.chart.series[0].name === "Refused" && bar.chart.series[0].values.join() === "12,30,84,41", `the rows are read, got ${JSON.stringify(bar)}`);
	const line = readChart(LINE);
	assert(line.ok && line.chart.series.length === 2 && line.chart.series[1].values.join() === "140,152,149", `a line takes more number columns, got ${JSON.stringify(line)}`);
	const quoted = readChart('type: bar\nCity, People\n"Bonn, Germany", 330000\n"The ""Big"" Apple", -2.5');
	assert(quoted.ok && quoted.chart.labels.join("|") === 'Bonn, Germany|The "Big" Apple' && quoted.chart.series[0].values.join() === "330000,-2.5", `a quoted cell holds a comma and a quote, got ${JSON.stringify(quoted)}`);
	const wrong: [string, string][] = [
		["no type line", "Hour, Refused\n09:00, 12"],
		["an unknown kind", "type: radar\nHour, Refused\n09:00, 12"],
		["a word for a number", "type: bar\nClient, Refused\nMobile app, forty-one"],
		["a thousands comma", "type: bar\nClient, Refused\nMobile app, 1,200"],
		["no rows", "type: bar\nHour, Refused"],
		["no header", "type: bar"],
		["a pie of two series", "type: pie\nClient, A, B\nX, 1, 2"],
		["a negative pie", "type: pie\nClient, Refused\nX, -1\nY, 3"],
		["an open quote", 'type: bar\nCity, People\n"Bonn, 3'],
		["a setting twice", "type: bar\ntype: line\nHour, Refused\n09:00, 12"],
		["a number too big to draw", `type: bar\nHour, Refused\n09:00, 1${"0".repeat(400)}`],
		["a number whose axis cannot be drawn", `type: bar\nHour, Refused\n09:00, -17${"0".repeat(307)}`],
	];
	for (const [what, text] of wrong) {
		const read = readChart(text);
		assert(!read.ok && read.reason, `${what} is not a chart, got ${JSON.stringify(read)}`);
	}
	assert(niceTicks(9, 84).join() === "0,20,40,60,80,100" && niceTicks(-3, 7).join() === "-4,-2,0,2,4,6,8", `round ticks with zero in range, got ${niceTicks(9, 84)} and ${niceTicks(-3, 7)}`);
});

await check("while it is written a chart is a quiet box; one left half-written or wrong shows as its code", () => {
	const writing = render("Here:\n\n```chart\ntype: bar\nHour, Refused\n09:00, 12", { streaming: true });
	assert(writing.includes('aria-label="Drawing chart"') && writing.includes("Drawing chart…") && !writing.includes("09:00"), `a chart being written is a quiet box, its numbers hidden, got ${writing}`);
	const cut = render("Here:\n\n```chart\ntype: bar\nHour, Refused\n09:00, 12");
	assert(!cut.includes("Drawing chart") && cut.includes("09:00, 12") && cut.includes("<pre"), `an answer that ended inside the block shows it as code, got ${cut}`);
	const wrong = render(fence("type: radar\nClient, Refused\nMobile app, forty-one"));
	assert(!wrong.includes("answer-chart") && !wrong.includes("Drawing chart") && wrong.includes("type: radar") && wrong.includes("forty-one") && wrong.includes("<pre"), `a wrong block shows as its code, never a broken chart, got ${wrong}`);
	for (const typed of ["c", "cha", "chart"]) {
		const opening = render(`Here:\n\n\`\`\`${typed}`, { streaming: true });
		assert(opening.includes('aria-label="Drawing chart"') && !opening.includes("<pre"), `a fence whose language is still being typed toward chart is the box, never code first: ${typed} gave ${opening}`);
	}
	const notChart = render("Here:\n\n```csv\na, 1", { streaming: true });
	assert(!notChart.includes("Drawing chart") && notChart.includes("a, 1"), `another language is code as it is written, got ${notChart}`);
	const loading = render(fence(BAR));
	assert(loading.includes('aria-label="Drawing chart"'), `a closed block waits for its drawing code in the quiet box, got ${loading}`);
});

const { JSDOM } = await import("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const globals = globalThis as any;
globals.window = dom.window;
globals.document = dom.window.document;
if (!("navigator" in globalThis)) globals.navigator = dom.window.navigator;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// No canvas here: words measure a fixed share of their font's size per letter, so the lines below can be counted.
const LETTER = 0.55;
(dom.window.HTMLCanvasElement.prototype as any).getContext = () => ({ font: "", measureText(this: { font: string }, text: string) { return { width: text.length * LETTER * Number(/([\d.]+)px/.exec(this.font)![1]) }; } });
const { createRoot } = pageRequire("react-dom/client");
const { act } = pageRequire("react");
const container = dom.window.document.getElementById("root")!;
const root = createRoot(container);
const show = async (text: string) => {
	await act(async () => root.render(createElement(markdown.MarkdownRenderer, { answer: true }, text)));
	// The drawing code is its own chunk: wait for it, not for a fixed time.
	for (let i = 0; i < 50 && !container.querySelector(".answer-chart-svg, .answer-chart-table, pre"); i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
};
const fire = async (target: Element, type: string, init: Record<string, unknown> = {}) => act(async () => { target.dispatchEvent(new dom.window.Event(type, { bubbles: true, ...init })); });
const tip = () => container.querySelector(".answer-chart-tip")?.textContent ?? "";

await check("a bar chart is drawn, and hover shows the value", async () => {
	await show(fence(BAR));
	const card = container.querySelector("figure.answer-chart-card");
	assert(card?.getAttribute("aria-label") === "Bar chart: Requests refused per hour", `the card names its chart, got ${container.innerHTML}`);
	assert(container.querySelector(".answer-chart-title")?.textContent === "Requests refused per hour" && container.querySelector(".answer-chart-note")?.textContent === "Today, example numbers", "the title and the note show");
	assert(container.querySelectorAll(".answer-chart-bar").length === 4, `one bar per row, got ${container.querySelectorAll(".answer-chart-bar").length}`);
	const ticks = [...container.querySelectorAll(".answer-chart-tick")].map((t) => t.textContent);
	assert(["09:00", "12:00", "0", "100"].every((t) => ticks.includes(t)), `labels and round ticks show, got ${ticks.join(" ")}`);
	assert(!container.querySelector(".answer-chart-tip"), "no value shows before a hover");
	await fire(container.querySelector('.answer-chart-hit[data-i="2"]')!, "pointerover");
	assert(tip().includes("11:00") && tip().includes("Refused") && tip().includes("84"), `hover shows that bar's label and value, got "${tip()}"`);
	assert(container.querySelector(".answer-chart-svg")!.classList.contains("focus") && container.querySelectorAll(".answer-chart-bar.on").length === 1, "the hovered bar stands out, the others dim");
	await fire(container.querySelector(".answer-chart-svg")!, "pointerout");
	assert(!container.querySelector(".answer-chart-tip"), "leaving the chart hides the value");
	await act(async () => { container.querySelector(".answer-chart-svg")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
	assert(tip().includes("09:00") && tip().includes("12"), `the arrow keys step through the values, got "${tip()}"`);
	await act(async () => { container.querySelector(".answer-chart-svg")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
	assert(tip().includes("12:00") && tip().includes("41"), `left from the first value wraps to the last, got "${tip()}"`);
});

await check("Table shows the same numbers, and Chart brings the drawing back", async () => {
	await show(fence(BAR));
	const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
	const toolsInOrder = () => [...container.querySelectorAll(".figure-tools > *, .figure-switch > *")].filter((tool) => !tool.classList.contains("figure-switch")).map((tool) => tool.querySelector("button")?.getAttribute("aria-label") ?? tool.textContent).join();
	assert(button("Chart").getAttribute("aria-pressed") === "true" && button("Table").getAttribute("aria-pressed") === "false", "the chart view is the first");
	await act(async () => button("Table").click());
	const rows = [...container.querySelectorAll(".answer-chart-table tr")].map((tr) => [...tr.children].map((c) => c.textContent).join("|"));
	assert(rows.join("\n") === "Hour|Refused\n09:00|12\n10:00|30\n11:00|84\n12:00|41", `the table holds the header and every row, got ${rows.join(" / ")}`);
	assert(!container.querySelector(".answer-chart-svg") && button("Table").getAttribute("aria-pressed") === "true" && !container.querySelector('[aria-label="Copy image"]'), "the drawing and Copy image give way to the table");
	assert(toolsInOrder() === "Chart,Table,", "Copy's slot stays with nothing in it, so the switch does not move");
	await act(async () => button("Chart").click());
	assert(container.querySelectorAll(".answer-chart-bar").length === 4 && toolsInOrder() === "Chart,Table,Copy image", `Chart draws it again, Copy image last, got ${toolsInOrder()}`);
	const copy = container.querySelector('[aria-label="Copy image"]')!;
	assert(copy.getAttribute("data-tip") === "Copy image" && !copy.textContent, "Copy image is an icon with a tooltip and a name");
});

await check("a line chart draws a line per series and lists them all on hover", async () => {
	await show(fence(LINE));
	assert(container.querySelectorAll(".answer-chart-line").length === 2, `one line per series, got ${container.querySelectorAll(".answer-chart-line").length}`);
	const legend = container.querySelector(".answer-chart-legend-row")?.textContent;
	assert(legend === "ServedRefused", `two series name their colours, got ${legend}`);
	await fire(container.querySelector('.answer-chart-hit[data-i="1"]')!, "pointerover");
	assert(tip().includes("Tue") && tip().includes("Served") && tip().includes("Refused") && /1.?350/.test(tip()) && tip().includes("152"), `hover lists each series' value for that label, got "${tip()}"`);
	assert(container.querySelector(".answer-chart-guide"), "a guide line marks the hovered label");
});

await check("a pie draws its slices with their shares, the smallest past six joined as Other", async () => {
	await show(fence(PIE));
	assert(container.querySelectorAll(".answer-chart-slice").length === 3 && container.querySelector(".answer-chart-total")?.textContent === "155", `three slices around the total, got ${container.innerHTML.slice(0, 400)}`);
	const shares = [...container.querySelectorAll(".answer-chart-legend")].map((g) => g.textContent);
	assert(shares.join("|") === "Nightly sync54%|Mobile app26%|Partner API19%", `the legend names each slice and its share, got ${shares.join("|")}`);
	await fire(container.querySelectorAll(".answer-chart-slice")[1], "pointerover");
	assert(tip().includes("Mobile app") && tip().includes("41") && tip().includes("26%"), `hover shows the slice's value and share, got "${tip()}"`);
	await show(fence("type: pie\nKind, N\nA, 50\nB, 40\nC, 30\nD, 20\nE, 10\nF, 5\nG, 3\nH, 2"));
	const many = [...container.querySelectorAll(".answer-chart-legend")].map((g) => g.textContent?.replace(/\d+%$/, ""));
	assert(many.join() === "A,B,C,D,E,Other" && container.querySelectorAll(".answer-chart-slice").length === 6, `six slices at most, got ${many.join()}`);
});

await check("on a phone a pie's legend goes under the ring, its names whole", async () => {
	// The card's width as a phone gives it: the chart measures itself through a ResizeObserver.
	const saved = globals.ResizeObserver;
	globals.ResizeObserver = class { constructor(private report: (entries: unknown[]) => void) {} observe() { this.report([{ contentRect: { width: 350 } }]); } disconnect() {} };
	try {
		await show(fence(PIE));
		const names = [...container.querySelectorAll(".answer-chart-legend text:not([text-anchor])")].map((t) => t.textContent);
		const svg = container.querySelector(".answer-chart-svg")!;
		assert(names.join() === "Nightly sync,Mobile app,Partner API", `every name whole, got ${names.join()}`);
		assert(Number(svg.getAttribute("height")) > 220 && svg.getAttribute("width") === "350", `the drawing grows to hold the legend under the ring, got ${svg.getAttribute("width")}x${svg.getAttribute("height")}`);
		// A value read from the legend shows by its row, which may be all that is in view; one read from a slice shows by the ring.
		const tipTop = () => parseFloat((container.querySelector(".answer-chart-tip") as HTMLElement | null)?.style.top ?? "NaN");
		await fire(container.querySelectorAll(".answer-chart-legend")[2], "pointerover");
		assert(tip().includes("Partner API") && tipTop() > 220, `hovering the last legend row shows its value by the row, got "${tip()}" at ${tipTop()}`);
		await fire(container.querySelector('.answer-chart-slice[data-i="2"]')!, "pointerover");
		assert(tip().includes("Partner API") && tipTop() < 220, `hovering a slice shows its value by the ring, got "${tip()}" at ${tipTop()}`);
	} finally {
		globals.ResizeObserver = saved;
		await act(async () => root.render(createElement("div")));
	}
});

await check("small numbers keep their digits in the table, the value and the axis", async () => {
	await show(fence("type: bar\nSample, Share\na, 0.001\nb, 0.004\nc, 0.0025"));
	await fire(container.querySelector('.answer-chart-hit[data-i="0"]')!, "pointerover");
	assert(tip().includes("0.001"), `hover shows the value as written, got "${tip()}"`);
	const ticks = [...container.querySelectorAll(".answer-chart-tick[text-anchor=end]")].map((t) => t.textContent);
	assert(new Set(ticks).size === ticks.length && ticks.includes("0.004"), `each tick on the axis reads differently, got ${ticks.join(" ")}`);
	const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
	await act(async () => button("Table").click());
	const cells = [...container.querySelectorAll(".answer-chart-table td")].map((td) => td.textContent);
	assert(cells.join() === "a,0.001,b,0.004,c,0.0025", `the table keeps every digit, got ${cells.join()}`);
});

await check("every bar has a width, even sixty rows of six series", async () => {
	const rows = Array.from({ length: 60 }, (_, i) => `r${i}, ${[1, 2, 3, 4, 5, 6].map((s) => s + i).join(", ")}`);
	await show(fence(`type: bar\nRow, A, B, C, D, E, F\n${rows.join("\n")}`));
	const widths = [...container.querySelectorAll(".answer-chart-bar")].map((bar) => {
		const d = bar.getAttribute("d") ?? "";
		const found = /^M([-\d.e]+) .*Q([-\d.e]+) [-\d.e]+ [-\d.e]+ [-\d.e]+V[-\d.e]+Z$/.exec(d);
		return found ? Number(found[2]) - Number(found[1]) : NaN;
	});
	assert(widths.length === 360 && widths.every((w) => w > 0), `360 bars, each wider than nothing, got ${widths.filter((w) => !(w > 0)).length} without a width`);
});

await check("Copy image takes the chart with its title, note and series names", async () => {
	await show(fence("type: line\ntitle: Requests per day\nnote: Last week\nDay, Served, Refused\nMon, 1200, 140\nTue, 1350, 152"));
	// The page's copy: the picture is drawn from the SVG it serialises; this records that SVG and stops there.
	const pictures: string[] = [];
	// The page reads the global navigator, which is Node's own here.
	const saved = { createObjectURL: (globalThis.URL as any).createObjectURL, revoke: (globalThis.URL as any).revokeObjectURL, item: globals.ClipboardItem, clipboard: Object.getOwnPropertyDescriptor(globals.navigator, "clipboard"), serializer: globals.XMLSerializer };
	globals.XMLSerializer = dom.window.XMLSerializer;
	const recorded: Promise<void>[] = [];
	(globalThis.URL as any).createObjectURL = (blob: Blob) => { recorded.push(blob.text().then((text) => { pictures.push(text); })); return "blob:picture"; };
	(globalThis.URL as any).revokeObjectURL = () => {};
	globals.ClipboardItem = class { constructor(public items: Record<string, Promise<Blob>>) { Object.values(items).forEach((item) => item.catch(() => {})); } };
	Object.defineProperty(globals.navigator, "clipboard", { configurable: true, value: { write: async () => {} } });
	try {
		const copied = async () => {
			const copy = container.querySelector('[aria-label="Copy image"]') as HTMLButtonElement;
			await act(async () => copy.click());
			await Promise.all(recorded);
			return pictures.pop() ?? "";
		};
		const lines = (picture: string) => {
			const host = dom.window.document.createElement("div");
			host.innerHTML = picture;
			const svg = host.querySelector("svg")!;
			const head = [...svg.children].filter((child) => !child.hasAttribute("transform"));
			return { svg, words: head.flatMap((child) => (child.tagName === "text" ? [child] : [...child.querySelectorAll("text")])).map((text) => ({ text: text.textContent!, x: Number(text.getAttribute("x")), y: Number(text.getAttribute("y")), size: text.getAttribute("class") === "answer-chart-copy-title" ? 14.5 : text.getAttribute("class") === "answer-chart-copy-note" ? 12.5 : 11 })), top: Number(/translate\(0 ([\d.]+)\)/.exec(svg.querySelector("g[transform]")!.getAttribute("transform")!)![1]) };
		};
		const svg = await copied();
		assert(svg.includes("Requests per day") && svg.includes("Last week") && svg.includes(">Served<") && svg.includes(">Refused<") && svg.includes("answer-chart-line"), `the copied picture holds the drawing, its title, note and series names, got ${svg.slice(0, 600)}`);
		assert(!container.querySelector(".answer-chart-copy"), "the picture made for the copy leaves the page once copied");
		const short = lines(svg);
		assert(JSON.stringify(short.words.map((word) => [word.text, word.x, word.y])) === JSON.stringify([["Requests per day", 12, 22], ["Last week", 12, 40], ["Served", 26, 62], ["Refused", short.words[3]?.x, 62]]) && short.top === 72, `short words stay on their lines, in their places, got ${JSON.stringify(short)}`);
		const TITLE = "Quarterly revenue of every northern European enterprise customer compared with the same quarter of the previous financial year";
		const NOTE = "Figures are in thousands of euros, before the one-off adjustment for the spring acquisition, and they leave out every partner who joined after the close of the financial year, so these totals differ from the annual report.";
		const NAMES = ["Northern Europe enterprise customers", "Southern Europe enterprise customers", "Everyone else in every other region whichever market or channel or partner they first signed through over all of the years"];
		// Wider than the picture with no space to break at.
		const WORD = "https://reports.example.com/".repeat(5);
		for (const [kind, names, rows] of [["bar", NAMES, "Q1, 1, 2, 3\nQ2, 2, 3, 4"], ["line", NAMES, "Q1, 1, 2, 3\nQ2, 2, 3, 4"], ["pie", NAMES.slice(0, 1), "Q1, 1\nQ2, 2"]] as const) {
			await show(fence(`type: ${kind}\ntitle: ${TITLE}\nnote: ${NOTE} ${WORD}\nQuarter, ${names.join(", ")}\n${rows}`));
			const long = lines(await copied());
			const said = long.words.map((word) => word.text).join(" ");
			for (const whole of [TITLE, NOTE, ...names]) assert(said.includes(whole), `${kind}: the copy holds "${whole}" in full, got "${said}"`);
			assert(long.words.map((word) => word.text).join("").includes(WORD), `${kind}: a word wider than the picture is broken, not cut, got "${said}"`);
			assert(long.words.every((word) => word.x + word.text.length * LETTER * word.size <= 560 - 12), `${kind}: every line ends inside the picture, got ${JSON.stringify(long.words)}`);
			const lowest = Math.max(...long.words.map((word) => word.y));
			assert(long.top === lowest + 10 && long.svg.getAttribute("viewBox")!.endsWith(` ${long.top + (kind === "pie" ? Number(container.querySelector(".answer-chart-svg")!.getAttribute("height")) : 220)}`), `${kind}: the drawing is pushed below the words, whole, got ${long.top} under ${lowest}, ${long.svg.getAttribute("viewBox")}`);
		}
		// A pie's legend: whole in the copy, as it is on screen.
		const SLICES = ["Salaries and social security contributions of every office in the group", "Cloud infrastructure and software licences for all of the teams", "Travel"];
		await show(fence(`type: pie\nClient, Spend\n${SLICES[0]}, 40\n${SLICES[1]}, 30\n${SLICES[2]}, 30`));
		const onScreen = [...container.querySelectorAll(".answer-chart-svg .answer-chart-legend")].map((row) => row.textContent!);
		const pieCopy = lines(await copied());
		const legend = [...pieCopy.svg.querySelectorAll(".answer-chart-legend")].map((row) => [...row.querySelectorAll("text")].map((text) => text.textContent!));
		for (const [i, name] of SLICES.entries()) assert(legend[i]?.slice(0, -1).join(" ") === name && /^\d+%$/.test(legend[i].at(-1)!), `a pie's copy holds "${name}" in full beside its share, got ${JSON.stringify(legend)}`);
		const legendWords = [...pieCopy.svg.querySelectorAll(".answer-chart-legend text")].filter((text) => !text.textContent!.endsWith("%"));
		assert(legendWords.every((text) => Number(text.getAttribute("x")) + text.textContent!.length * LETTER * 11 <= 560 - 12), `every legend line ends inside the picture, got ${legendWords.map((text) => text.textContent)}`);
		const heights = [...pieCopy.svg.querySelectorAll(".answer-chart-legend text")].map((text) => Number(text.getAttribute("y")));
		assert(new Set(heights).size === heights.length - SLICES.length, `the legend's lines never overlap, got ${heights}`);
		const pictureHeight = Number(pieCopy.svg.getAttribute("height"));
		assert(Math.max(...heights) + pieCopy.top < pictureHeight, `the legend ends inside the picture, ${pictureHeight} high, got ${Math.max(...heights)} under ${pieCopy.top}`);
		assert([...container.querySelectorAll(".answer-chart-svg .answer-chart-legend")].map((row) => row.textContent!).join() === onScreen.join(), `copying leaves the screen's legend as it was, got ${onScreen}`);
		// A value being read on screen is no part of the picture.
		await show(fence(LINE));
		await fire(container.querySelector('.answer-chart-hit[data-i="1"]')!, "pointerover");
		assert(container.querySelector(".answer-chart-guide"), "the hovered value shows its guide on screen");
		const hovered = await copied();
		assert(!hovered.includes("answer-chart-guide"), `the copy leaves the hovered value's marks out, got ${hovered.slice(0, 600)}`);
		await fire(container.querySelector(".answer-chart-svg")!, "pointerout");
		// A name of nothing but spaces keeps its row: the words below it stay in their places.
		await show(fence('type: bar\ntitle: Requests\nDay, " ", Refused\nMon, 1, 2'));
		const blank = lines(await copied());
		assert(blank.words.every((word) => word.y >= 22) && blank.top === 54, `a blank series name moves nothing, got ${JSON.stringify(blank.words)} and ${blank.top}`);
		// One series, no title: its name is what says what the numbers are.
		await show(fence("type: bar\nQuarter, Revenue (USD)\nQ1, 3\nQ2, 4"));
		const single = await copied();
		assert(single.includes(">Revenue (USD)<") && single.includes("answer-chart-bar"), `a one-series chart's copy names its series, got ${single.slice(0, 600)}`);
		await show(fence(PIE));
		const pie = await copied();
		assert(pie.includes(">Refused<") && pie.includes("answer-chart-slice"), `a pie's copy names its series, got ${pie.slice(0, 600)}`);
	} finally {
		(globalThis.URL as any).createObjectURL = saved.createObjectURL;
		(globalThis.URL as any).revokeObjectURL = saved.revoke;
		globals.ClipboardItem = saved.item;
		if (saved.clipboard) Object.defineProperty(globals.navigator, "clipboard", saved.clipboard);
		else delete globals.navigator.clipboard;
		globals.XMLSerializer = saved.serializer;
	}
});

await check("a pie's legend wraps long names, beside the ring on a wide card and under it on a phone's", async () => {
	const SLICES = ["Salaries and social security contributions of every office in the group", "Cloud infrastructure and software licences for all of the teams", "Travel"];
	const legendAt = async () => {
		await show(fence(`type: pie\nClient, Spend\n${SLICES[0]}, 40\n${SLICES[1]}, 30\n${SLICES[2]}, 30`));
		const rows = [...container.querySelectorAll(".answer-chart-svg .answer-chart-legend")];
		const words = rows.map((row) => [...row.querySelectorAll("text")].filter((text) => !text.textContent!.endsWith("%")));
		for (const [i, name] of SLICES.entries()) assert(words[i].map((text) => text.textContent).join(" ") === name, `"${name}" shows in full, got ${words[i].map((text) => text.textContent)}`);
		const lows = words.map((lines) => Number(lines.at(-1)!.getAttribute("y")));
		const tops = words.map((lines) => Number(lines[0].getAttribute("y")));
		assert(tops[1] > lows[0] && tops[2] > lows[1], `a wrapped name pushes the rows below it down, got ${tops} after ${lows}`);
		const ring = Math.max(...[...container.querySelectorAll(".answer-chart-slice")].map((slice) => Number(/^M([\d.]+)/.exec(slice.getAttribute("d")!)![1])));
		const hit = rows[0].querySelector("rect.answer-chart-hit")!;
		assert(Number(hit.getAttribute("height")) === 20 + (words[0].length - 1) * 15, `the whole of a wrapped row reads its value, got ${hit.getAttribute("height")}`);
		return { rows, words, ring, legendX: Number(words[0][0].getAttribute("x")), legendY: tops[0], height: Number(container.querySelector(".answer-chart-svg")!.getAttribute("height")), lows };
	};
	const wide = await legendAt();
	assert(wide.words[0].length > 1 && wide.words[2].length === 1, `the long name takes the lines it needs, the short one its one, got ${wide.words.map((lines) => lines.length)}`);
	assert(wide.legendX > wide.ring && wide.legendY < 220, `on a wide card the legend stands beside the ring, got x ${wide.legendX} past the ring's ${wide.ring}, y ${wide.legendY}`);
	// Read from a row, the value stands in the ring's hole: over no other row, wrapped to the ring.
	await fire(wide.rows[1], "pointerover");
	const beside = container.querySelector(".answer-chart-tip") as HTMLElement;
	assert(beside.textContent!.includes(SLICES[1]) && beside.classList.contains("answer-chart-tip-ring") && Number.parseFloat(beside.style.left) < wide.legendX, `the value shows over the ring, got ${beside.outerHTML}`);
	await fire(container.querySelector(".answer-chart-svg")!, "pointerout");
	await act(async () => root.render(null));
	const Observer = globals.ResizeObserver;
	globals.ResizeObserver = class { constructor(private tell: (entries: unknown[]) => void) {} observe() { this.tell([{ contentRect: { width: 340 } }]); } disconnect() {} };
	try {
		const phone = await legendAt();
		assert(phone.words[0].length > 1, `on a phone's card the name takes the lines it needs, got ${phone.words[0].length}`);
		assert(phone.legendY > 220 && Math.max(...phone.lows) < phone.height, `on a phone's card the legend stands under the ring, inside the drawing, got ${phone.legendY} to ${phone.lows} of ${phone.height}`);
	} finally {
		globals.ResizeObserver = Observer;
	}
});

await check("a wrong block in the page is its code, with no chart", async () => {
	await show(fence("type: bar\nClient, Refused\nMobile app, forty-one"));
	assert(!container.querySelector(".answer-chart-card") && container.querySelector("pre code")?.textContent?.includes("forty-one"), `shown as its code, got ${container.innerHTML}`);
});

await act(async () => root.unmount());
console.log("chart block smoke passed");
