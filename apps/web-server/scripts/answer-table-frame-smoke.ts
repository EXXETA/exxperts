// An answer's table, as Chromium lays it out with the page's own styles: the
// frame fits the table (no empty band, the header shading runs to the frame's
// edge), and a table wider than the answer scrolls inside its frame with a
// band that shows, in both themes, on the side that hides columns. Also the
// numbered checklist keeps its numbers while a bulleted one shows only its
// boxes, and a "#" link finds the heading it names in its own answer.
// While an answer with a table streams, frame by frame, with outer pipes and
// without them: no paragraph of pipes before the table, each row drawn as it is written, columns that never move,
// and one settle to the table's own widths when the answer ends; a path in a
// cell breaks only after its separators.
//
// Offline: no server; the rendered markup and the page's stylesheet (every
// area file styles.css lists) are loaded into a page.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readPageStyles } from "./page-styles.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("answer table frame smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
const { createElement } = pageRequire("react");
(globalThis as any).React = pageRequire("react");
const { renderToStaticMarkup } = pageRequire("react-dom/server");
const markdown: any = await import(new URL("../../web-ui/src/components/Markdown.tsx", import.meta.url).href);
const css = readPageStyles();
const render = (text: string, streaming?: boolean): string => renderToStaticMarkup(createElement(markdown.MarkdownRenderer, { answer: true, streaming }, text));

const small = render(["| Step | Time |", "| --- | --- |", "| Export | ~5 min |", "| Import | 5~10 min |"].join("\n"));
const columns = Array.from({ length: 10 }, (_, n) => `Column ${n + 1} heading`);
const wide = render([`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map((_, n) => `value-${n + 1}-without-spaces-${"x".repeat(12)}`).join(" | ")} |`].join("\n"));
const checklists = render(["1. [x] Export the data", "2. [ ] Check the totals", "", "- [x] Send the report", "- [ ] Archive the files"].join("\n"));
const linked = render(["See [the details](#details) and [the second part](#details-1), or the note.[^1]", "", "## Details", "", "First part.", "", "## Details", "", "Second part.", "", "[^1]: The source."].join("\n"));
const anchorTarget = typeof markdown.anchorTarget === "function" ? String(markdown.anchorTarget) : "function () { return null; }";
// The page's own marking of a frame that hides columns, when the component has one.
// The functions are sent as source; the loader names inner functions with __name, which the page defines.
const markFrame = typeof markdown.markTableFrame === "function" ? String(markdown.markTableFrame) : "function () {}";

const shots = process.env.ANSWER_TABLE_SHOTS;
// How much the 12 px nearest one side of the wide table's frame differ from the middle of its first row, in
// luminance (0 to 255), read from a screenshot of the row's top padding, where no text sits.
async function bandContrast(page: import("playwright").Page, side: "left" | "right"): Promise<number> {
	const box = await page.evaluate(() => {
		const frame = document.querySelectorAll(".md-table-scroll")[1].getBoundingClientRect();
		const row = document.querySelectorAll("table")[1].querySelector("tbody tr")!.getBoundingClientRect();
		return { x: frame.left, y: row.top + 2, width: frame.width };
	});
	const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: 3 } });
	return page.evaluate(async ({ data, width, side }) => {
		const image = new Image();
		image.src = data;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d")!;
		context.drawImage(image, 0, 0);
		const scale = image.width / width;
		const average = (from: number, to: number) => {
			let sum = 0;
			let count = 0;
			for (let x = from; x <= to; x++) for (let y = 0; y < image.height; y++) {
				const [r, g, b] = context.getImageData(Math.round(x * scale), y, 1, 1).data;
				sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
				count++;
			}
			return sum / count;
		};
		const edge = side === "right" ? average(width - 14, width - 2) : average(2, 14);
		return Math.round(Math.abs(edge - average(width / 2 - 6, width / 2 + 6)));
	}, { data: `data:image/png;base64,${shot.toString("base64")}`, width: box.width, side });
}
const browser = await chromium.launch();
try {
	for (const [width, theme] of [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${css}</style><style>body { margin: 0; padding: 16px; } .answer { max-width: 760px; }</style></head><body><div class="answer md assistant-markdown">${small}${wide}${checklists}</div><script>var __name = (fn) => fn; const mark = ${markFrame}; document.querySelectorAll(".md-table-scroll").forEach((scroller) => { const frame = scroller.closest(".md-table-frame") ?? scroller; mark(frame); scroller.addEventListener("scroll", () => mark(frame)); });</script></body></html>`);
		const measured = await page.evaluate(() => [...document.querySelectorAll("table")].map((table) => {
			const frame = (table.closest(".md-table-scroll") as HTMLElement | null) ?? (table as HTMLElement);
			const row = table.querySelector("tr")!.getBoundingClientRect();
			const head = table.querySelector("thead")!.getBoundingClientRect();
			return { frame: Math.round(frame.getBoundingClientRect().width), row: Math.round(row.width), head: Math.round(head.width), scrolls: frame.scrollWidth > frame.clientWidth + 1, scrollWidth: frame.scrollWidth, table: Math.round(table.scrollWidth), marked: (frame.closest(".md-table-frame") ?? frame).hasAttribute("data-more-right") };
		}));
		console.log(`  ${width} ${theme}: ${JSON.stringify(measured)}`);
		const [smallTable, wideTable] = measured;
		assert(!smallTable.scrolls && Math.abs(smallTable.frame - smallTable.row) <= 2 && Math.abs(smallTable.frame - smallTable.head) <= 2, `a small table's frame fits it, with the header shading to the edge, at ${width} ${theme}, got ${JSON.stringify(smallTable)}`);
		assert(wideTable.scrolls && wideTable.scrollWidth >= wideTable.table, `a wide table scrolls inside its frame to its last column at ${width} ${theme}, got ${JSON.stringify(wideTable)}`);
		assert(wideTable.marked, `a wide table's frame shows that it scrolls at ${width} ${theme}, got ${JSON.stringify(wideTable)}`);
		const right = await bandContrast(page, "right");
		assert(right >= 35, `the band on the side that hides columns shows at ${width} ${theme}: the frame's edge differs from the middle of the row by ${right} of 255, want 35 or more`);
		if (shots) await page.screenshot({ path: path.join(shots, `tables-${width}-${theme}-start.png`), fullPage: true });
		// Scrolled to the end, nothing hides to the right.
		const atEnd = await page.evaluate(() => { const scroller = document.querySelectorAll(".md-table-scroll")[1] as HTMLElement; scroller.scrollLeft = scroller.scrollWidth; scroller.dispatchEvent(new Event("scroll")); return (scroller.closest(".md-table-frame") ?? scroller).hasAttribute("data-more-right"); });
		assert(!atEnd, `scrolled to its end, the frame no longer marks more on the right at ${width} ${theme}`);
		const left = await bandContrast(page, "left");
		assert(left >= 35, `scrolled to its end, the band on the left shows at ${width} ${theme}: ${left} of 255, want 35 or more`);
		console.log(`  ${width} ${theme}: the band reads ${right} at the start (right) and ${left} at the end (left), of 255`);
		const markers = await page.evaluate(() => [...document.querySelectorAll(".task-list-item")].map((item) => `${item.parentElement!.tagName}:${getComputedStyle(item).listStyleType}`));
		assert(markers.join(",") === "OL:decimal,OL:decimal,UL:none,UL:none", `a numbered checklist keeps its numbers, a bulleted one shows only boxes, got ${markers.join(",")}`);
		if (shots) await page.screenshot({ path: path.join(shots, `tables-${width}-${theme}-end.png`), fullPage: true });
		if (width === 1280 && theme === "light") {
			await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="md assistant-markdown" id="one">${linked}</div><div class="md assistant-markdown" id="two">${linked}</div><script>var __name = (fn) => fn; window.anchorTarget = ${anchorTarget};</script></body></html>`);
			const found = await page.evaluate(() => {
				const two = document.getElementById("two")!;
				const target = (id: string) => (window as any).anchorTarget(two, id) as Element | null;
				const headings = [...two.querySelectorAll("h2")];
				return {
					details: target("details") === headings[0],
					second: target("details-1") === headings[1],
					footnote: target("fn-1")?.closest("#two") === two && /fn-1$/.test(target("fn-1")?.id ?? ""),
					duplicateIds: [...document.querySelectorAll("[id]")].map((el) => el.id).filter((id, at, all) => id && all.indexOf(id) !== at && !id.startsWith("user-content-") && id !== "footnote-label").length,
				};
			});
			assert(found.details && found.second && found.footnote && found.duplicateIds === 0, `a "#" link finds its heading or note in its own answer, with no id shared between answers, got ${JSON.stringify(found)}`);
		}
		await page.close();
	}
} finally {
	await browser.close();
}
const FOLDERS = [
	"Apps keep their settings in these folders:",
	"",
	"| Location | Full path | Variable | Typical use |",
	"| --- | --- | --- | --- |",
	"| Roaming AppData | `C:\\Users\\<username>\\AppData\\Roaming` | `%APPDATA%` | Settings that follow the person across machines |",
	"| Local AppData | `C:\\Users\\<username>\\AppData\\Local` | `%LOCALAPPDATA%` | Caches and data for this machine only |",
	"| LocalLow | `C:\\Users\\<username>\\AppData\\LocalLow` | none | Apps that run with low rights, such as browser sandboxes |",
	"| ProgramData | `C:\\ProgramData` | `%PROGRAMDATA%` | Settings shared by every user |",
	"",
	"Pick Roaming for anything that should follow the person.",
].join("\n");
// The same answer with its table written without outer pipes, as GFM allows.
const BARE = FOLDERS.split("\n").map((line) => line.replace(/^\| (.*) \|$/, "$1")).join("\n");

const streamed = await chromium.launch();
try {
	for (const [width, text] of [[1280, FOLDERS], [390, FOLDERS], [1280, BARE], [390, BARE]] as const) {
		const form = text === BARE ? "without outer pipes" : "with outer pipes";
		const tableStart = text.indexOf("Location");
		const separatorEnd = text.indexOf("\n", text.indexOf("--- |")) + 1;
		const rowsEnd = text.indexOf("\n\n", separatorEnd);
		// The answer as it arrives, a few characters at a time, each frame drawn as the page draws it.
		const frames: Array<{ end: number; html: string }> = [];
		for (let end = tableStart - 4; end <= text.length; end += 3) frames.push({ end, html: render(text.slice(0, end), true) });
		frames.push({ end: text.length, html: render(text, true) });
		const ended = render(text, false);
		const page = await streamed.newPage({ viewport: { width, height: 900 } });
		await page.setContent(`<!doctype html><html data-theme="light"><head><style>${css}</style><style>body { margin: 0; padding: 16px; } .answer { max-width: 760px; }</style></head><body><div class="answer md assistant-markdown"></div></body></html>`);
		const seen = await page.evaluate((list) => list.map(({ end, html }) => {
			const answer = document.querySelector(".answer")!;
			answer.innerHTML = html;
			const table = answer.querySelector("table");
			return {
				end,
				pipes: [...answer.querySelectorAll("p")].some((p) => p.textContent!.includes("|")),
				table: !!table,
				widths: table ? [...table.querySelectorAll("thead th")].map((cell) => Math.round(cell.getBoundingClientRect().width * 10) / 10) : [],
				rows: table ? [...table.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "") : [],
			};
		}), frames);
		const pipes = seen.filter((frame) => frame.pipes);
		assert(!pipes.length, `at ${width} ${form}, no frame shows a paragraph of pipes, got one at ${pipes.map((frame) => frame.end).join(", ")} characters`);
		const early = seen.filter((frame) => frame.end < separatorEnd && frame.table);
		assert(!early.length, `at ${width} ${form}, no table shows before its separator line is complete, got one at ${early.map((frame) => frame.end).join(", ")}`);
		const tables = seen.filter((frame) => frame.table);
		assert(tables.length && tables[0].end <= separatorEnd + 3, `at ${width} ${form}, the table shows as soon as its separator line is complete, first at ${tables[0]?.end}`);
		// A row whose line has not ended yet, already drawn with its first cells.
		const halfRows = tables.filter((frame) => {
			const rows = text.slice(separatorEnd, frame.end).split("\n");
			return frame.end < rowsEnd && rows.at(-1)!.length > 4 && frame.rows.at(-1)?.trim() && rows.length === frame.rows.length;
		});
		assert(halfRows.length >= 20, `at ${width} ${form}, a row shows while it is being written, got ${halfRows.length} such frames`);
		const sizes = new Set(tables.map((frame) => frame.widths.join("/")));
		assert(sizes.size === 1, `at ${width} ${form}, the columns keep their widths while rows stream, got ${sizes.size} sets: ${[...sizes].slice(0, 6).join("  ")}`);
		const settled = await page.evaluate((html) => {
			const answer = document.querySelector(".answer")!;
			answer.innerHTML = html;
			return [...answer.querySelectorAll("thead th")].map((cell) => Math.round(cell.getBoundingClientRect().width * 10) / 10);
		}, ended);
		const moved = settled.some((size, i) => Math.abs(size - tables[0].widths[i]) > 2);
		assert(moved, `at ${width} ${form}, the table takes its own widths once the answer ends: ${tables[0].widths.join("/")} while streaming, ${settled.join("/")} after`);
		console.log(`  ${width} ${form}: ${frames.length} frames, the table from ${tables[0].end} characters, ${halfRows.length} with a row being written; columns ${tables[0].widths.join("/")} while streaming, ${settled.join("/")} once ended`);
		if (width === 390) {
			// The finished table at phone width: a path breaks only after a separator, and a variable stays whole.
			const lines = await page.evaluate(() => [...document.querySelectorAll("td code")].map((code) => {
				const text = code.textContent ?? "";
				const range = document.createRange();
				const tops: number[] = [];
				let at = 0;
				const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
				const breaks: string[] = [];
				let line = "";
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					for (let i = 0; i < node.textContent!.length; i++, at++) {
						range.setStart(node, i);
						range.setEnd(node, i + 1);
						const top = Math.round(range.getBoundingClientRect().top);
						if (tops.length && top > tops[tops.length - 1] + 2) {
							breaks.push(line);
							line = "";
						}
						tops.push(top);
						line += node.textContent![i];
					}
				}
				breaks.push(line);
				return { text, lines: breaks };
			}));
			for (const { text, lines: parts } of lines) {
				assert(parts.slice(0, -1).every((part) => /[\\/]$/.test(part)), `at 390 the path ${text} breaks only after its separators, got ${JSON.stringify(parts)}`);
				if (!/[\\/]/.test(text)) assert(parts.length === 1, `at 390 ${text} stays whole, got ${JSON.stringify(parts)}`);
			}
			console.log(`  390: the cells' code reads ${lines.map(({ lines: parts }) => parts.join(" | ")).join(", ")}`);
		}
		await page.close();
	}
} finally {
	await streamed.close();
}
console.log("answer table frame smoke passed");
