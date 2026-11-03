/**
 * Shiki itself, loaded only when the first fenced block is drawn
 * (code-highlight.ts): the core, its JavaScript regex engine, our theme and
 * each grammar as its own chunk of our build. Never the WebAssembly engine:
 * the page's security header has no 'wasm-unsafe-eval'. Only this file
 * imports Shiki's code; the entry chunk reaches it through one dynamic import.
 */

import { createCssVariablesTheme, createHighlighterCore, type GrammarState, type HighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeLanguage } from "./code-highlight";

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

/** The grammars, by our id in code-highlight.ts: the type keeps both tables in step. */
const GRAMMARS: Record<CodeLanguage, Grammar> = {
	shellscript: () => import("shiki/langs/shellscript.mjs"),
	powershell: () => import("shiki/langs/powershell.mjs"),
	bat: () => import("shiki/langs/bat.mjs"),
	python: () => import("shiki/langs/python.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	typescript: () => import("shiki/langs/typescript.mjs"),
	jsx: () => import("shiki/langs/jsx.mjs"),
	tsx: () => import("shiki/langs/tsx.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	jsonc: () => import("shiki/langs/jsonc.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	toml: () => import("shiki/langs/toml.mjs"),
	ini: () => import("shiki/langs/ini.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	scss: () => import("shiki/langs/scss.mjs"),
	sql: () => import("shiki/langs/sql.mjs"),
	go: () => import("shiki/langs/go.mjs"),
	rust: () => import("shiki/langs/rust.mjs"),
	java: () => import("shiki/langs/java.mjs"),
	kotlin: () => import("shiki/langs/kotlin.mjs"),
	c: () => import("shiki/langs/c.mjs"),
	csharp: () => import("shiki/langs/csharp.mjs"),
	swift: () => import("shiki/langs/swift.mjs"),
	php: () => import("shiki/langs/php.mjs"),
	diff: () => import("shiki/langs/diff.mjs"),
	dockerfile: () => import("shiki/langs/dockerfile.mjs"),
	markdown: () => import("shiki/langs/markdown.mjs"),
	xml: () => import("shiki/langs/xml.mjs"),
	graphql: () => import("shiki/langs/graphql.mjs"),
};

const THEME = "exx";
let highlighter: HighlighterCore | null = null;
let coreLoad: Promise<HighlighterCore> | null = null;
const grammars = new Map<CodeLanguage, Promise<void>>();
const loadedGrammars = new Set<CodeLanguage>();

function loadCore(): Promise<HighlighterCore> {
	coreLoad ??= (async () => {
		// Every colour is a `--code-*` variable that 01-base.css sets per theme.
		const theme = createCssVariablesTheme({ name: THEME, variablePrefix: "--code-", fontStyle: false });
		// Comments in italic; no other style, so the colours stay calm. The
		// theme has no colours for prose markup, so Markdown gets ours.
		const variable = (name: string) => `var(--code-token-${name})`;
		theme.tokenColors = [
			...(theme.tokenColors ?? []),
			{ scope: ["comment", "punctuation.definition.comment"], settings: { fontStyle: "italic" } },
			{ scope: ["markup.heading", "entity.name.section"], settings: { foreground: variable("keyword") } },
			{ scope: ["markup.inline.raw", "markup.fenced_code", "markup.raw"], settings: { foreground: variable("string") } },
			{ scope: ["markup.bold", "markup.italic"], settings: { foreground: variable("constant") } },
			{ scope: ["markup.quote"], settings: { foreground: variable("comment") } },
			{ scope: ["punctuation.definition.list.begin", "punctuation.definition.heading", "punctuation.definition.bold", "punctuation.definition.italic"], settings: { foreground: variable("punctuation") } },
		];
		// Forgiving: a grammar rule the JavaScript engine cannot read matches nothing, instead of failing the language.
		highlighter = await createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
		return highlighter;
	})();
	coreLoad.catch(() => (coreLoad = null));
	return coreLoad;
}

/** Loads the core and, when given, a grammar; resolves when both are ready, rejects when one failed. */
export function prepare(language: CodeLanguage | undefined): Promise<void> {
	const core = loadCore();
	if (!language) return core.then(() => undefined);
	let loading = grammars.get(language);
	if (!loading) {
		loading = Promise.all([core, GRAMMARS[language]()]).then(
			async ([loaded, grammar]) => {
				await loaded.loadLanguage(grammar.default);
				loadedGrammars.add(language);
			},
			(error: unknown) => {
				// A chunk that failed to arrive is asked for again by the next block.
				grammars.delete(language);
				throw error;
			},
		);
		grammars.set(language, loading);
	}
	return loading;
}

export function ready(language: CodeLanguage): boolean {
	return highlighter !== null && loadedGrammars.has(language);
}

/** Tokens for `code`, starting from `state` (the grammar state an earlier piece of the block left). */
export function tokenize(code: string, language: CodeLanguage, state: GrammarState | undefined): { lines: ThemedToken[][]; state?: GrammarState } | undefined {
	if (!highlighter) return undefined;
	try {
		const result = highlighter.codeToTokens(code, { lang: language, theme: THEME, grammarState: state });
		return { lines: result.tokens, state: result.grammarState };
	} catch {
		return undefined;
	}
}
