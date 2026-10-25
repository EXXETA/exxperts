// An answer's table, as Chromium lays it out with the page's own styles: the
// frame fits the table (no empty band, the header shading runs to the frame's
// edge), and a table wider than the answer scrolls inside its frame with a
// band that shows, in both themes, on the side that hides columns. Also the
// numbered checklist keeps its numbers while a bulleted one shows only its
// boxes, and a "#" link finds the heading it names in its own answer.
//
// Offline: no server; the rendered markup and styles.css are loaded into a page.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

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
const css = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "styles.css"), "utf8");
const render = (text: string): string => renderToStaticMarkup(createElement(markdown.MarkdownRenderer, { answer: true }, text));

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
console.log("answer table frame smoke passed");
