// The page's whole stylesheet as the browser gets it, for smokes that check
// rules. apps/web-ui/src/styles.css only lists the area files of
// apps/web-ui/src/styles/ in cascade order, and Vite inlines them there in
// that order; reading styles.css alone would hand a smoke the bare list, so a
// check that a rule is absent would pass without looking at any rule.
//
// It throws when the list is not what Vite would inline as the page's styles:
// anything but comments and `./styles/*.css` imports in styles.css, a listed
// file missing or listed twice, a `.css` file in the folder left off the list,
// a list out of name order (the numbers follow the cascade order), or an
// `@import` inside an area file. Other files there, such as Finder's
// .DS_Store, are not stylesheets, and Vite never reads them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_SRC = fileURLToPath(new URL("../../web-ui/src/", import.meta.url));
const IMPORT_LINE = /^@import "\.\/styles\/([^"/]+\.css)";$/;
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The area files joined in list order; `src` is the folder holding styles.css. */
export function readPageStyles(src: string = PAGE_SRC): string {
	const list = path.join(src, "styles.css");
	const names: string[] = [];
	for (const line of withoutComments(fs.readFileSync(list, "utf8")).split("\n")) {
		if (!line.trim()) continue;
		const name = IMPORT_LINE.exec(line.trim())?.[1];
		if (!name) throw new Error(`${list} holds more than comments and ./styles/*.css imports: ${JSON.stringify(line.trim())}`);
		if (names.includes(name)) throw new Error(`${list} lists ${name} twice`);
		names.push(name);
	}
	if (names.length === 0) throw new Error(`${list} lists no area file`);
	const sorted = [...names].sort();
	if (sorted.join("\n") !== names.join("\n")) throw new Error(`${list} lists its files out of name order: ${names.join(", ")}`);
	const folder = path.join(src, "styles");
	const unlisted = fs.readdirSync(folder).filter((name) => name.endsWith(".css") && !names.includes(name));
	if (unlisted.length) throw new Error(`${folder} holds files ${list} does not list: ${unlisted.join(", ")}`);
	return names.map((name) => {
		const file = path.join(folder, name);
		if (!fs.existsSync(file)) throw new Error(`${list} lists ${name}, which is not in ${folder}`);
		const css = fs.readFileSync(file, "utf8");
		if (/@import\b/.test(withoutComments(css))) throw new Error(`${file} has an @import: only styles.css lists files`);
		return css;
	}).join("");
}
