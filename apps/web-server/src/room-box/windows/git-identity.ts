/**
 * The person's git name and e-mail, read from the text of their own git
 * settings, and the one small settings file a protected Windows command is
 * given in their place (box-root.ts writes it). Nothing else of their settings
 * is read or kept: an alias, a `url`, `http` or `core` setting never leaves
 * here.
 */

/** What was found: each key only when its value could be read for certain. */
export interface GitIdentity {
	name?: string;
	email?: string;
}

type Key = keyof GitIdentity;

/** The last value git would take for a key: a value, or one it reads but we can't for certain. */
type Found = { value: string } | { unsure: true };

class Unreadable extends Error {}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isAlpha = (c: string) => /^[A-Za-z]$/.test(c);
const isKeyChar = (c: string) => /^[A-Za-z0-9-]$/.test(c);
// A value holding one of these is not a name: git would take it, but a commit line can't carry it as typed.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * One settings file, read as git's own reader does (config.c): sections and
 * keys without case, values with quotes, escapes, comments and trimmed space.
 * Calls `key` for every key, with its section and value; a value continued on
 * the next line is marked so. Throws Unreadable where git would refuse the file.
 */
function parse(text: string, key: (section: string, name: string, value: string | undefined, continued: boolean) => void): void {
	let at = text.startsWith("﻿") ? 1 : 0;
	// Past the end git reads a line's end, as here.
	const next = (): string => {
		if (at >= text.length) {
			at += 1;
			return "\n";
		}
		const c = text[at++];
		if (c === "\r" && text[at] === "\n") {
			at += 1;
			return "\n";
		}
		return c;
	};
	const ended = () => at > text.length;
	let section = "";
	let comment = false;
	for (;;) {
		const c = next();
		if (c === "\n") {
			if (ended()) return;
			comment = false;
			continue;
		}
		if (comment || isSpace(c)) continue;
		if (c === "#" || c === ";") {
			comment = true;
			continue;
		}
		if (c === "[") {
			section = header(next);
			continue;
		}
		if (!isAlpha(c)) throw new Unreadable();
		let name = c.toLowerCase();
		let d = next();
		while (!ended() && isKeyChar(d)) {
			name += d.toLowerCase();
			d = next();
		}
		while (d === " " || d === "\t") d = next();
		if (d === "\n") {
			key(section, name, undefined, false);
			if (ended()) return;
			continue;
		}
		if (d !== "=") throw new Unreadable();
		const { value, continued } = parseValue(next);
		key(section, name, value, continued);
		if (ended()) return;
	}
}

/** A section's name, lower case, after its `[`: `user`, `user.x` for `[user "x"]` or `[user.x]`. */
function header(next: () => string): string {
	let name = "";
	for (;;) {
		const c = next();
		if (c === "]") break;
		if (isSpace(c)) {
			let d = c;
			while (isSpace(d)) {
				if (d === "\n") throw new Unreadable();
				d = next();
			}
			if (d !== '"') throw new Unreadable();
			name += ".";
			for (;;) {
				let e = next();
				if (e === "\n") throw new Unreadable();
				if (e === '"') break;
				if (e === "\\") {
					e = next();
					if (e === "\n") throw new Unreadable();
				}
				name += e;
			}
			if (next() !== "]") throw new Unreadable();
			break;
		}
		if (!isKeyChar(c) && c !== ".") throw new Unreadable();
		name += c.toLowerCase();
	}
	if (name === "") throw new Unreadable();
	return name;
}

/** A value after its `=`, to its line's end. */
function parseValue(next: () => string): { value: string; continued: boolean } {
	let value = "";
	let quote = false;
	let comment = false;
	let continued = false;
	let trim = 0;
	for (;;) {
		let c = next();
		if (c === "\n") {
			if (quote) throw new Unreadable();
			return { value: trim ? value.slice(0, trim) : value, continued };
		}
		if (comment) continue;
		if (isSpace(c) && !quote) {
			if (!trim) trim = value.length;
			if (value.length) value += c;
			continue;
		}
		if (!quote && (c === ";" || c === "#")) {
			comment = true;
			continue;
		}
		trim = 0;
		if (c === "\\") {
			c = next();
			if (c === "\n") {
				continued = true;
				continue;
			}
			const escaped = ({ t: "\t", b: "\b", n: "\n", "\\": "\\", '"': '"' } as Record<string, string>)[c];
			if (escaped === undefined) throw new Unreadable();
			value += escaped;
			continue;
		}
		if (c === '"') {
			quote = !quote;
			continue;
		}
		value += c;
	}
}

/**
 * The name and e-mail git would take from these files, given in the order git
 * reads them: `.config\git\config`, then `.gitconfig`, a missing one as
 * undefined. As in git the last value wins, so a key's last value decides: one
 * continued on the next line, holding a control character, or empty counts as
 * not there. A file git can't read, or an include in either, gives nothing at
 * all, since what it would bring in is unknown here.
 */
export function readGitIdentity(files: readonly (string | undefined)[]): GitIdentity {
	const last: Partial<Record<Key, Found>> = {};
	let include = false;
	try {
		for (const text of files) {
			if (text === undefined) continue;
			parse(text, (section, name, value, continued) => {
				if (section === "include" || section.startsWith("includeif.")) include = true;
				if (section !== "user") return;
				if (name !== "name" && name !== "email") return;
				last[name] = value === undefined || continued || CONTROL.test(value) ? { unsure: true } : { value };
			});
		}
	} catch (error) {
		if (error instanceof Unreadable) return {};
		throw error;
	}
	if (include) return {};
	const identity: GitIdentity = {};
	for (const key of ["name", "email"] as const) {
		const found = last[key];
		if (found && "value" in found && found.value !== "") identity[key] = found.value;
	}
	return identity;
}

/** git's quoted value: a backslash and a quote escaped, everything else as it is. */
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** The settings file for a command: a `[user]` section with the keys found, or undefined when neither was. */
export function gitIdentityText(identity: GitIdentity): string | undefined {
	const lines = (["name", "email"] as const).flatMap((key) => (identity[key] === undefined ? [] : [`\t${key} = ${quoted(identity[key])}`]));
	return lines.length === 0 ? undefined : ["[user]", ...lines, ""].join("\n");
}
