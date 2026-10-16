import path from "node:path";
import { marked } from "marked";
import { classifyReferencePath, normalizeRepoPath, type ReferenceKind } from "./skills-file-policy.js";

const pathIndexes = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

function indexWithDirectories(files: ReadonlySet<string>): ReadonlySet<string> {
	const cached = pathIndexes.get(files);
	if (cached) return cached;
	const paths = new Set(files);
	for (const file of files) {
		let directory = path.posix.dirname(file);
		while (directory !== ".") { paths.add(directory); directory = path.posix.dirname(directory); }
	}
	pathIndexes.set(files, paths);
	return paths;
}

/** Local links are discovery hints, never permission to fetch or import their targets. */
export function skillMarkdownReferences(markdown: string, skillPath: string, files: ReadonlySet<string>): string[] {
	return repositoryTextReferences(markdown, skillPath ? `${skillPath}/SKILL.md` : "SKILL.md", "markdown", files).slice(0, 500);
}

/** Resolve explicit inert-data links against original repository paths, including directories. */
export function repositoryTextReferences(content: string, from: string, kind: ReferenceKind, files: ReadonlySet<string>): string[] {
	const paths = indexWithDirectories(files);
	const directory = path.posix.dirname(from) === "." ? "" : path.posix.dirname(from);
	const references = new Set<string>();
	function add(raw: string) {
		let target: string;
		try { target = decodeURIComponent(raw.trim().replace(/^<|>$/g, "").split(/[?#]/)[0]); } catch { return; }
		if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.includes("\\")) return;
		const relative = path.posix.normalize(path.posix.join(directory, target)).replace(/\/+$/, "");
		const root = path.posix.normalize(target).replace(/\/+$/, "");
		const resolved = paths.has(relative) ? relative : paths.has(root) ? root : relative;
		try { normalizeRepoPath(resolved); } catch { return; }
		if (resolved !== from) references.add(resolved);
	}
	function markup(raw: string): void {
		for (const match of raw.matchAll(/(?:\b(?:href|src)\s*=\s*["']([^"']+)["']|<([^<>\s]+\.[a-z][a-z0-9]*(?:[?#][^<>\s]*)?)>)/gi)) add(match[1] ?? match[2]);
		for (const match of raw.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const image of match[1].split(",")) add(image.trim().split(/\s+/)[0]);
	}
	function styles(raw: string): void {
		for (const match of raw.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|@(?:import|use|forward)\s+["']([^"']+)["']/gi)) {
			const target = match[1] ?? match[2] ?? match[3] ?? match[4];
			if (!target.startsWith("var(")) add(target);
		}
	}
	if (kind === "markdown") {
		marked.walkTokens(marked.lexer(content), (token) => {
			if (token.type === "link" || token.type === "image") add(token.href);
			else if (token.type === "codespan") {
				const value = token.text.trim();
				if (/[/.]/.test(value) || paths.has(path.posix.normalize(path.posix.join(directory, value))) || paths.has(value)) add(value);
			} else if (token.type === "html" || token.type === "text") {
				markup(token.raw);
				if (token.type === "html") styles(token.raw);
				for (const match of token.raw.matchAll(/(?:^|[\s(["'])((?:\.{1,2}\/|[\w.-]+\/)[^\s<>"'`()\[\]{}]*[\w/-])/g)) add(match[1]);
			}
		});
	} else if (kind === "html" || kind === "svg") { markup(content); styles(content); }
	else if (kind === "styles") styles(content);
	else if (kind === "text" && from.toLowerCase().endsWith(".json")) {
		let data: unknown;
		try { data = JSON.parse(content); } catch { return []; }
		const pending = [data];
		for (let index = 0; index < pending.length; index += 1) {
			const value = pending[index];
			if (typeof value === "string") {
				if ((!/\s/.test(value) && (value.includes("/") || classifyReferencePath(value))) || paths.has(value) || paths.has(path.posix.normalize(path.posix.join(directory, value)))) add(value);
			} else if (Array.isArray(value)) for (const child of value) pending.push(child);
			else if (value && typeof value === "object") for (const child of Object.values(value)) pending.push(child);
		}
	}
	return [...references].sort();
}
