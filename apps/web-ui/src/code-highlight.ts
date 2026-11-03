/**
 * Colours for fenced code, from Shiki with its JavaScript regex engine: the
 * page's security header has no 'wasm-unsafe-eval', so the WebAssembly engine
 * would never start. Shiki and every grammar load lazily, as chunks of our
 * own build (code-highlight-engine.ts), so the page's entry chunk holds only
 * this file: no Shiki module, and no other origin is asked.
 *
 * The theme names no colour: every token colour is a `--code-*` variable that
 * 01-base.css sets from our own tokens in each theme, so a theme change needs
 * no second pass.
 *
 * A block is coloured line by line as it is written (`colourLines`): a
 * finished line is tokenized once, from the grammar state the line before it
 * left, and keeps its tokens; the line still being written stays plain. A
 * finished block's lines are cached by language and code, so a remount or a
 * room switch paints it coloured at once.
 */

import type { GrammarState, ThemedToken } from "shiki/core";

/**
 * The languages we colour: our id (Shiki's grammar name, a key of the
 * engine's grammar table), the readable name the block's label shows, then
 * the other names a fence may give it. C++ and Ruby stay plain: Shiki's C++
 * grammar embeds a GLSL grammar that carries no licence, and Ruby's embeds
 * C++.
 */
export const CODE_LANGUAGES = {
	shellscript: ["Shell", "sh", "bash", "zsh", "shell", "console"],
	powershell: ["PowerShell", "ps1", "pwsh"],
	bat: ["Batch", "batch", "cmd"],
	python: ["Python", "py"],
	javascript: ["JavaScript", "js", "mjs", "cjs"],
	typescript: ["TypeScript", "ts", "mts", "cts"],
	jsx: ["JSX"],
	tsx: ["TSX"],
	json: ["JSON"],
	jsonc: ["JSON", "json5"],
	yaml: ["YAML", "yml"],
	toml: ["TOML"],
	ini: ["INI"],
	html: ["HTML", "htm"],
	css: ["CSS"],
	scss: ["SCSS"],
	sql: ["SQL"],
	go: ["Go", "golang"],
	rust: ["Rust", "rs"],
	java: ["Java"],
	kotlin: ["Kotlin", "kt"],
	c: ["C", "h"],
	csharp: ["C#", "cs", "c#"],
	swift: ["Swift"],
	php: ["PHP"],
	diff: ["Diff", "patch"],
	dockerfile: ["Dockerfile", "docker"],
	markdown: ["Markdown", "md"],
	xml: ["XML", "svg"],
	graphql: ["GraphQL", "gql"],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type CodeLanguage = keyof typeof CODE_LANGUAGES;

const BY_NAME = new Map<string, CodeLanguage>();
for (const [id, [, ...aliases]] of Object.entries(CODE_LANGUAGES) as [CodeLanguage, readonly string[]][]) for (const name of [id, ...aliases]) BY_NAME.set(name, id);

/** Our id for a fence's language, or undefined when we do not colour it. */
export function codeLanguage(fenceLanguage: string | undefined): CodeLanguage | undefined {
	return fenceLanguage ? BY_NAME.get(fenceLanguage.toLowerCase()) : undefined;
}

/** The label a fence's language shows: a readable name for the ones we know, else as written. */
export function codeLanguageLabel(fenceLanguage: string): string {
	const id = codeLanguage(fenceLanguage);
	return id ? CODE_LANGUAGES[id][0] : fenceLanguage;
}

/** Above these a block stays plain: highlighting runs on the page's main thread. */
export const HIGHLIGHT_BUDGET = { lines: 3_000, chars: 150_000 } as const;

type Engine = typeof import("./code-highlight-engine");
let engine: Engine | null = null;
let engineLoad: Promise<Engine> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
	version++;
	for (const listener of listeners) listener();
}

/** Bumped each time Shiki or a grammar finishes loading: a block that waited draws again. */
export function highlightVersion(): number {
	return version;
}

export function subscribeHighlight(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Starts loading what a block needs: Shiki on the first fence an answer
 * opens, the grammar once the fence's language is known. Never throws: a
 * failed load leaves the block plain.
 */
export function prepareHighlight(language: CodeLanguage | undefined): void {
	engineLoad ??= import("./code-highlight-engine").then(
		(loaded) => (engine = loaded),
		(error: unknown) => {
			// A chunk that failed to arrive is asked for again by the next block.
			engineLoad = null;
			throw error;
		},
	);
	engineLoad.then((loaded) => loaded.prepare(language)).then(changed, () => undefined);
}

/** One block's coloured lines so far, and where its grammar stood after the last of them. */
export interface ColouredLines {
	language: CodeLanguage;
	/** The finished lines' text, joined with line ends. */
	text: string;
	lines: ThemedToken[][];
	state?: GrammarState;
}

/**
 * The block's finished lines coloured, reusing `previous` when the new lines
 * only extend it: a line is tokenized once, from the state its previous line
 * left. Undefined while the language is not loaded, or for a block over the
 * budget.
 */
export function colourLines(previous: ColouredLines | undefined, language: CodeLanguage, finished: string): ColouredLines | undefined {
	if (!engine?.ready(language) || finished.length > HIGHLIGHT_BUDGET.chars) return undefined;
	if (previous && previous.language === language && previous.text === finished) return previous;
	const extending = previous !== undefined && previous.language === language && previous.text !== "" && finished.startsWith(previous.text + "\n");
	const added = extending ? finished.slice(previous.text.length + 1) : finished;
	if ((extending ? previous.lines.length : 0) + added.split("\n").length > HIGHLIGHT_BUDGET.lines) return undefined;
	const result = engine.tokenize(added, language, extending ? previous.state : undefined);
	if (!result) return undefined;
	return { language, text: finished, lines: extending ? [...previous.lines, ...result.lines] : result.lines, state: result.state };
}

const CACHE_SIZE = 200;
const finishedBlocks = new Map<string, ColouredLines>();

/** A finished block's colours, kept so the same block paints coloured at once next time. */
export function cachedColours(language: CodeLanguage, code: string): ColouredLines | undefined {
	const key = `${language}\n${code}`;
	const found = finishedBlocks.get(key);
	if (found) {
		// Most recently used last, so the oldest goes first.
		finishedBlocks.delete(key);
		finishedBlocks.set(key, found);
	}
	return found;
}

export function cacheColours(coloured: ColouredLines): void {
	const key = `${coloured.language}\n${coloured.text}`;
	finishedBlocks.delete(key);
	finishedBlocks.set(key, coloured);
	if (finishedBlocks.size > CACHE_SIZE) finishedBlocks.delete(finishedBlocks.keys().next().value!);
}
