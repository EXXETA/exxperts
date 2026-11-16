/**
 * PowerShell's own errors as plain text. Windows PowerShell 5.1 run by
 * `-EncodedCommand` with its errors redirected writes them as a `#< CLIXML`
 * line and then one `<Objs …>` block, even with `-OutputFormat Text`: each line
 * of an error is an `<S S="Error">` piece, its line end written
 * `_x000D__x000A_`. `ErrorTextTurner` takes a command's error stream as it
 * comes (box-worker-windows.ts), before it joins the output, and gives it back
 * with each piece turned into its text and the block's other records and
 * markup dropped.
 *
 * A program the command runs writes its own errors to the same stream, so its
 * text can come between the line, the block's start, its pieces and its end:
 * it passes as it comes. A piece is held until it closes, so nobody watching
 * sees it raw and then plain. A piece that isn't well formed or outgrows
 * PIECE_LIMIT passes as it came, and so does a block start that isn't well
 * formed, its line with it. A line whose block never comes, as when the command
 * is stopped, is dropped.
 */

const MARKER = /#< CLIXML\r?\n/;
const BLOCK_START = /<Objs[\s>]/;
const BLOCK_END = "</Objs>";
const PIECE_START = /^<S[\s/>]/;
const PIECE_END = "</S>";
// Any other record in the block, such as a progress record: an `Obj`, with `Obj`s inside it.
const RECORD_START = /^<Obj[\s/>]/;
const RECORD_TAG = /<(\/?)Obj(?=[\s/>])[^>]*?(\/?)>/g;
/** The most held at once to read as a block's start or one piece, in characters. */
export const PIECE_LIMIT = 1024 * 1024;

type State =
	/** Output as it comes, watching for the line. */
	| { at: "text" }
	/** The line seen and held, watching for the block's start. */
	| { at: "marker"; marker: string }
	/** Inside the block, between its pieces. */
	| { at: "block" };

/** The end of `text` that may be the start of one of `wholes`, to be read with what comes next. */
function startOf(text: string, ...wholes: string[]): string {
	for (let length = Math.min(text.length, Math.max(...wholes.map((whole) => whole.length)) - 1); length > 0; length--) {
		if (wholes.some((whole) => length < whole.length && whole.startsWith(text.slice(-length)))) return text.slice(-length);
	}
	return "";
}

export class ErrorTextTurner {
	private state: State = { at: "text" };
	/** What came last and can't be passed on yet: the start of the line, of the block, of its end or of a piece, or a whole start or piece not yet closed. */
	private kept = "";

	/** The output that can be passed on now. */
	push(text: string): string {
		let rest = this.kept + text;
		this.kept = "";
		let out = "";
		const hold = (held: string, raw: string) => {
			if (held.length <= PIECE_LIMIT) {
				this.kept = held;
				return out;
			}
			this.state = { at: "text" };
			return out + raw;
		};
		for (;;) {
			const state = this.state;
			if (state.at === "text") {
				const found = MARKER.exec(rest);
				if (!found) {
					this.kept = startOf(rest, "#< CLIXML\r\n");
					return out + rest.slice(0, rest.length - this.kept.length);
				}
				out += rest.slice(0, found.index);
				this.state = { at: "marker", marker: found[0] };
				rest = rest.slice(found.index + found[0].length);
				continue;
			}
			if (state.at === "marker") {
				const found = BLOCK_START.exec(rest);
				if (!found) {
					this.kept = startOf(rest, "<Objs ");
					return out + rest.slice(0, rest.length - this.kept.length);
				}
				out += rest.slice(0, found.index);
				rest = rest.slice(found.index);
				const close = rest.indexOf(">");
				if (close === -1) return hold(rest, state.marker + rest);
				const start = rest.slice(0, close + 1);
				rest = rest.slice(close + 1);
				if (attributes(start, "Objs") === null) {
					out += state.marker + start;
					this.state = { at: "text" };
				} else this.state = { at: "block" };
				continue;
			}
			if (rest.startsWith(BLOCK_END)) {
				this.state = { at: "text" };
				rest = rest.slice(BLOCK_END.length);
				continue;
			}
			if (PIECE_START.test(rest)) {
				const close = rest.indexOf(">");
				const empty = close !== -1 && rest[close - 1] === "/";
				const endTag = close === -1 || empty ? -1 : rest.indexOf(PIECE_END, close);
				if (!empty && endTag === -1) return hold(rest, rest);
				const piece = rest.slice(0, empty ? close + 1 : endTag + PIECE_END.length);
				rest = rest.slice(piece.length);
				out += (piece.length <= PIECE_LIMIT ? pieceText(piece) : null) ?? piece;
				continue;
			}
			if (RECORD_START.test(rest)) {
				const end = recordEnd(rest);
				if (end === -1) return hold(rest, rest);
				rest = rest.slice(end);
				continue;
			}
			// Not the block's markup: the command's output, up to the next tag.
			if (rest === "" || BLOCK_END.startsWith(rest) || "<S ".startsWith(rest) || "<Obj ".startsWith(rest)) {
				this.kept = rest;
				return out;
			}
			const next = rest.indexOf("<", 1);
			out += next === -1 ? rest : rest.slice(0, next);
			rest = next === -1 ? "" : rest.slice(next);
		}
	}

	/** At the output's end, as when the command is stopped: whatever is still held, as it came, less a line whose block never came. */
	end(): string {
		const { kept } = this;
		this.state = { at: "text" };
		this.kept = "";
		return kept;
	}
}

/** Where the record `text` starts with ends, past its closing tag; -1 while it hasn't closed. */
function recordEnd(text: string): number {
	let depth = 0;
	for (const found of text.matchAll(RECORD_TAG)) {
		if (found[1] === "/") depth--;
		else if (found[2] !== "/") depth++;
		if (depth <= 0) return found.index + found[0].length;
	}
	return -1;
}

// A start tag of `name`, each attribute quoted with ". CLIXML writes no comment, CDATA or declaration: a piece with one isn't read.
const ATTRIBUTE = /\s+([A-Za-z_][\w.:-]*)="[^"<&]*"/y;

/** The names of a start tag's attributes, or null where it isn't one start tag of `name`, or names one twice. */
function attributes(tag: string, name: string): string[] | null {
	const head = `<${name}`;
	if (!tag.startsWith(head)) return null;
	const names: string[] = [];
	let at = head.length;
	for (;;) {
		ATTRIBUTE.lastIndex = at;
		const found = ATTRIBUTE.exec(tag);
		if (!found) break;
		if (names.includes(found[1])) return null;
		names.push(found[1]);
		at = ATTRIBUTE.lastIndex;
	}
	return /^\s*\/?>$/.test(tag.slice(at)) ? names : null;
}

const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9A-Fa-f]+));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Text between tags with its entities undone, or null where an `&` starts none. */
function entities(text: string): string | null {
	let undone = "";
	let at = 0;
	for (const found of text.matchAll(ENTITY)) {
		if (text.slice(at, found.index).includes("&")) return null;
		const code = found[2] !== undefined ? Number(found[2]) : found[3] !== undefined ? parseInt(found[3], 16) : null;
		if (code !== null && code > 0x10ffff) return null;
		undone += text.slice(at, found.index) + (code === null ? NAMED[found[1]] : String.fromCodePoint(code));
		at = found.index + found[0].length;
	}
	return text.slice(at).includes("&") ? null : undone + text.slice(at);
}

/** PowerShell's `_xHHHH_` escapes undone: a line end, a control character, or an underscore that would read as one. */
const unescape = (text: string) => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** One whole `<S …>…</S>` or `<S …/>` piece as its text, or null when it isn't well formed. */
export function pieceText(piece: string): string | null {
	const close = piece.indexOf(">") + 1;
	if (attributes(piece.slice(0, close), "S") === null) return null;
	if (piece[close - 2] === "/") return close === piece.length ? "" : null;
	if (!piece.endsWith(PIECE_END)) return null;
	const inside = piece.slice(close, -PIECE_END.length);
	const undone = inside.includes("<") ? null : entities(inside);
	return undone === null ? null : unescape(undone);
}
