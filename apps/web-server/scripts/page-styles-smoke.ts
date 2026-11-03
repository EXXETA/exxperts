// The stylesheet the smokes read (page-styles.ts): the real list joins into
// the area files in order, and each list Vite would not inline as the page's
// styles is refused, beside a good list that passes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPageStyles } from "./page-styles.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const page = readPageStyles();
const folder = new URL("../../web-ui/src/styles/", import.meta.url);
const areaFiles = fs.readdirSync(folder).filter((name) => name.endsWith(".css")).sort();
assert(areaFiles.length > 1 && page === areaFiles.map((name) => fs.readFileSync(new URL(name, folder), "utf8")).join(""), "the real list joins every area file, in name order");
assert(page.includes(":root,") && page.includes(".bubble-row {"), "the joined stylesheet holds the rules, not the list");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "page-styles-smoke-"));
function pageWith(list: string, files: Record<string, string>): string {
	fs.rmSync(scratch, { recursive: true, force: true });
	fs.mkdirSync(path.join(scratch, "styles"), { recursive: true });
	fs.writeFileSync(path.join(scratch, "styles.css"), list);
	for (const [name, css] of Object.entries(files)) fs.writeFileSync(path.join(scratch, "styles", name), css);
	return scratch;
}
function refused(list: string, files: Record<string, string>, why: string, words: string) {
	let message = "";
	try {
		readPageStyles(pageWith(list, files));
	} catch (error) {
		message = String((error as Error).message);
	}
	assert(message.includes(words), `${why}: expected an error with ${JSON.stringify(words)}, got ${JSON.stringify(message)}`);
}

const two = { "01-a.css": ".a { color: red; }\n", "02-b.css": "/* @import in a comment is words */\n.b { color: blue; }\n" };
const good = '/* The order is the cascade order. */\n@import "./styles/01-a.css";\n\n/* a note */\n@import "./styles/02-b.css";\n';
try {
	assert(readPageStyles(pageWith(good, two)) === two["01-a.css"] + two["02-b.css"], "a list of comments and imports in order joins its files");
	refused(good + ".late { color: green; }\n", two, "a rule left in styles.css", "holds more than comments");
	refused('@import "./styles/01-a.css";\n@import "./styles/01-a.css";\n@import "./styles/02-b.css";\n', two, "a file listed twice", "twice");
	refused('@import "./styles/02-b.css";\n@import "./styles/01-a.css";\n', two, "a list out of order", "out of name order");
	refused('@import "./styles/01-a.css";\n', two, "an area file left off the list", "does not list: 02-b.css");
	assert(readPageStyles(pageWith(good, { ...two, ".DS_Store": "finder", "notes.txt": "words" })) === two["01-a.css"] + two["02-b.css"], "files that are not stylesheets stay out of the list check");
	refused(good + '@import "./styles/03-c.css";\n', two, "a listed file that is missing", "03-c.css, which is not in");
	refused(good, { ...two, "02-b.css": '@import "./03-c.css";\n' }, "an @import inside an area file", "has an @import");
	refused("/* nothing listed */\n", {}, "an empty list", "lists no area file");
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("page-styles smoke: ok");
