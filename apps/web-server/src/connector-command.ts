/**
 * A connector's command line as a person pastes it from a setup page, read
 * into the program, its arguments and the settings written in front of it
 * (`NAME=value`). It is read the way a terminal reads one simple command, and
 * nothing ever runs through a shell: a line that would need one (a pipe, a
 * second command, a redirect, a command inside the command) is refused.
 * Browser-safe: the page takes the settings' sentences from here.
 */

export interface ConnectorCommand {
	command: string;
	args: string[];
	/** Settings written in front of the program, as in `API_KEY=abc npx -y server`. */
	env: Record<string, string>;
}

export const CONNECTOR_COMMAND_LINES = {
	missing: "Paste the command from the connector's setup instructions.",
	shellOnly: "Paste only the command and what follows it, without symbols such as | or &&.",
	openQuote: "A quote in the command isn't closed. Check the command, then try again.",
} as const;

/** What a program's settings say when one can't be saved, on the page and from the add route alike. */
export const SETTING_LINES = {
	unnamed: "Each setting needs a name.",
	noValue: (name: string) => `The ${name} setting needs a value.`,
	twice: (name: string) => `The ${name} setting is listed twice.`,
} as const;

/** A setting's name, as a terminal takes it in front of a command. */
export const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Word {
	text: string;
	/** Where the first quote or backslash is in the text; Infinity when none. */
	quotedFrom: number;
	/** Started with an unquoted `~`, the home folder. */
	tilde: boolean;
}

/**
 * The words of a line: whitespace splits them outside quotes; single quotes
 * keep everything; double quotes keep everything but `\"` and `\\`. Outside
 * quotes a backslash keeps the next character, a line end after it joins the
 * lines. On Windows a backslash is part of a path, except before a quote.
 */
function wordsOf(line: string, platform: NodeJS.Platform): Word[] | { error: string } {
	const windows = platform === "win32";
	const words: Word[] = [];
	let current: Word | null = null;
	const word = (): Word => (current ??= { text: "", quotedFrom: Number.POSITIVE_INFINITY, tilde: false });
	const markQuoted = () => {
		const w = word();
		w.quotedFrom = Math.min(w.quotedFrom, w.text.length);
	};
	for (let at = 0; at < line.length; at += 1) {
		const char = line[at];
		const next = line[at + 1];
		if (char === " " || char === "\t") {
			if (current) words.push(current);
			current = null;
		} else if (char === "\n" || char === "\r" || "|&;<>`".includes(char) || (char === "$" && next === "(")) {
			return { error: CONNECTOR_COMMAND_LINES.shellOnly };
		} else if (char === "'") {
			markQuoted();
			const end = line.indexOf("'", at + 1);
			if (end === -1) return { error: CONNECTOR_COMMAND_LINES.openQuote };
			word().text += line.slice(at + 1, end);
			at = end;
		} else if (char === '"') {
			markQuoted();
			const w = word();
			let closed = false;
			for (at += 1; at < line.length; at += 1) {
				const inner = line[at];
				if (inner === '"') {
					closed = true;
					break;
				}
				// A command inside the command runs in a terminal even between double quotes.
				if (inner === "`" || (inner === "$" && line[at + 1] === "(")) return { error: CONNECTOR_COMMAND_LINES.shellOnly };
				if (inner === "\\" && (line[at + 1] === '"' || (!windows && line[at + 1] === "\\"))) {
					w.text += line[at + 1];
					at += 1;
				} else w.text += inner;
			}
			if (!closed) return { error: CONNECTOR_COMMAND_LINES.openQuote };
		} else if (char === "\\" && !windows) {
			if (next === undefined) {
				word().text += "\\";
			} else if (next === "\n" || next === "\r") {
				at += next === "\r" && line[at + 2] === "\n" ? 2 : 1;
			} else {
				markQuoted();
				word().text += next;
				at += 1;
			}
		} else if (char === "\\" && next === '"') {
			markQuoted();
			word().text += '"';
			at += 1;
		} else {
			const w = word();
			if (char === "~" && w.text === "" && w.quotedFrom === Number.POSITIVE_INFINITY) w.tilde = true;
			w.text += char;
		}
	}
	if (current) words.push(current);
	return words;
}

/** `~` alone or before a separator is the home folder, as a terminal reads it. */
function withHome(word: Word, home: string, platform: NodeJS.Platform): string {
	if (!word.tilde) return word.text;
	const rest = word.text.slice(1);
	if (rest === "" || rest.startsWith("/") || (platform === "win32" && rest.startsWith("\\"))) return home + rest;
	return word.text;
}

/** A word a terminal reads as it is; on Windows a backslash is part of a path. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const PLAIN_WINDOWS_WORD = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * One word written so readConnectorCommand reads it back as it is: plain, or
 * in single quotes, which keep everything; a single quote itself is written
 * between double quotes.
 */
function quotedWord(text: string, first: boolean, platform: NodeJS.Platform): string {
	// A first word that reads as a setting would be taken for one.
	const plain = (platform === "win32" ? PLAIN_WINDOWS_WORD : PLAIN_WORD).test(text) && !(first && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text));
	if (plain) return text;
	return text.split("'").map((piece) => (piece ? `'${piece}'` : "")).join(`"'"`) || "''";
}

/** A program and its arguments as one line to show and paste back: readConnectorCommand reads it as the same program and arguments. */
export function commandLineOf(command: string, args: readonly unknown[], platform: NodeJS.Platform): string {
	return [command, ...args.map(String)].map((word, at) => quotedWord(word, at === 0, platform)).join(" ");
}

/** A pasted command line as a program, its arguments and the settings in front of it; or why it can't be read. */
export function readConnectorCommand(line: string, platform: NodeJS.Platform, home: string): ConnectorCommand | { error: string } {
	const words = wordsOf(line.trim(), platform);
	if ("error" in words) return words;
	const settings: Array<[string, string]> = [];
	let at = 0;
	for (; at < words.length; at += 1) {
		const { text, quotedFrom } = words[at];
		const equals = text.indexOf("=");
		if (equals <= 0 || equals > quotedFrom || !SETTING_NAME.test(text.slice(0, equals))) break;
		settings.push([text.slice(0, equals), text.slice(equals + 1)]);
	}
	// No program, or one quoted as nothing ("").
	if (at >= words.length || !words[at].text.trim()) return { error: CONNECTOR_COMMAND_LINES.missing };
	const [program, ...rest] = words.slice(at).map((word) => withHome(word, home, platform));
	// From pairs, so a name such as __proto__ is a setting like any other; the last of a name twice wins, as in a terminal.
	return { command: program, args: rest, env: Object.fromEntries(settings) };
}
