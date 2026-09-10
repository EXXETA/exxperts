// OpenAI web-search-capable models delimit citation markers with Unicode
// private-use-area characters, e.g. U+E200 cite U+E202 turn0search1 U+E201.
// These are model-internal tokens and never occur in legitimate prose.
const MARKER_START = "\ue200";
const MARKER_END = "\ue201";
const MARKER_SEP = "\ue202";
const CODE_START = 0xe200;
const CODE_END = 0xe201;
const CODE_SEP = 0xe202;

function hasMarkerChars(text: string): boolean {
	return (
		text.indexOf(MARKER_START) !== -1 || text.indexOf(MARKER_END) !== -1 || text.indexOf(MARKER_SEP) !== -1
	);
}

/**
 * Removes every well-formed U+E200 ... U+E201 citation marker span (inclusive)
 * plus any stray marker characters. Byte-identical no-op on text without them.
 */
export function stripCitationMarkers(text: string): string {
	if (!hasMarkerChars(text)) {
		return text;
	}
	let out = "";
	let keepFrom = 0;
	let i = 0;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === CODE_START) {
			out += text.slice(keepFrom, i);
			const end = text.indexOf(MARKER_END, i + 1);
			// A start with no close is a stray: drop just the character.
			i = end === -1 ? i + 1 : end + 1;
			keepFrom = i;
		} else if (code === CODE_END || code === CODE_SEP) {
			out += text.slice(keepFrom, i);
			i++;
			keepFrom = i;
		} else {
			i++;
		}
	}
	return out + text.slice(keepFrom);
}

/**
 * Streaming variant: clean text passes through immediately; once an unclosed
 * U+E200 is seen, everything from it is held back until the closing
 * U+E201 arrives (the whole marker is then dropped) or until flush().
 */
export class CitationMarkerStreamFilter {
	private held = "";

	push(delta: string): string {
		let text: string;
		if (this.held.length > 0) {
			text = this.held + delta;
			this.held = "";
		} else {
			if (!hasMarkerChars(delta)) {
				return delta;
			}
			text = delta;
		}
		let out = "";
		let keepFrom = 0;
		let i = 0;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			if (code === CODE_START) {
				const end = text.indexOf(MARKER_END, i + 1);
				if (end === -1) {
					// Marker not closed yet: hold it back for the next delta.
					out += text.slice(keepFrom, i);
					this.held = text.slice(i);
					return out;
				}
				out += text.slice(keepFrom, i);
				i = end + 1;
				keepFrom = i;
			} else if (code === CODE_END || code === CODE_SEP) {
				out += text.slice(keepFrom, i);
				i++;
				keepFrom = i;
			} else {
				i++;
			}
		}
		return out + text.slice(keepFrom);
	}

	flush(): string {
		const held = this.held;
		this.held = "";
		if (held.length === 0 || held.charCodeAt(0) === CODE_START) {
			return "";
		}
		return held;
	}
}
