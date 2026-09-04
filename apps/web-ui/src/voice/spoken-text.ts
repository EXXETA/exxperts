/**
 * Turning a streamed markdown reply into sentences a voice can say.
 *
 * Pure functions, no DOM: the smoke runs them in Node. The splitter is fed
 * text deltas as they arrive and hands back whole sentences the moment their
 * terminator lands, so the first sentence is spoken while the rest is still
 * being written. Code, tables and URLs are not read aloud; the room keeps
 * them on screen.
 */

/** Markdown to plain speech. Fences, tables, images and bare URLs vanish; links keep their text. */
export function cleanForSpeech(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^\s*\|.*\|\s*$/gm, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*{1,3}|_{1,3}|~~)(\S[^*_~]*?)\1/g, "$2")
		.replace(/[*_#>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// A terminator followed by whitespace ends a sentence, unless it closes an
// abbreviation or a bare number ("z.B. ", "Nr. 5", "3. Quartal").
const TERMINATOR = /[.!?…]+["'”’)\]]*\s/g;
const ABBREVIATION = /(?:^|\s)(?:z\.B|bzw|Dr|Nr|ca|e\.g|i\.e|vs|etc|Mr|Mrs|Ms|St|Inc|approx|u\.a|d\.h|evtl|ggf|Prof|Hr|Fr)\.$/i;

export class SentenceSplitter {
	private buffer = "";

	/** Feed a delta; get back every sentence it completed, cleaned for speech. */
	push(delta: string): string[] {
		this.buffer += delta;
		const sentences: string[] = [];
		for (;;) {
			const cut = this.findCut();
			if (cut < 0) break;
			const spoken = cleanForSpeech(this.buffer.slice(0, cut));
			this.buffer = this.buffer.slice(cut);
			if (spoken) sentences.push(spoken);
		}
		return sentences;
	}

	/** The reply is over: whatever is left is the last sentence. */
	flush(): string | null {
		const spoken = cleanForSpeech(this.buffer);
		this.buffer = "";
		return spoken || null;
	}

	reset(): void {
		this.buffer = "";
	}

	private findCut(): number {
		const text = this.buffer;
		const newline = text.indexOf("\n");
		const limit = newline >= 0 ? newline : text.length;
		let cut = -1;
		TERMINATOR.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = TERMINATOR.exec(text)) && match.index < limit) {
			const head = text.slice(0, match.index + 1);
			if (ABBREVIATION.test(head)) continue;
			if (/(?:^|\s)\d+\.$/.test(head)) continue;
			if (!/[a-zA-Zäöüß]/.test(head)) continue;
			cut = match.index + match[0].length;
			break;
		}
		// A line break ends a heading, a list item or a paragraph on its own.
		if (cut < 0 && newline >= 0) cut = newline + 1;
		if (cut < 0) return -1;
		// Never cut inside a code fence: wait until it closes, then drop it whole.
		const fences = (text.slice(0, cut).match(/```/g) ?? []).length;
		if (fences % 2 === 1) {
			const close = text.indexOf("```", cut);
			if (close < 0) return -1;
			const lineEnd = text.indexOf("\n", close + 3);
			return lineEnd < 0 ? -1 : lineEnd + 1;
		}
		return cut;
	}
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-zäöüß0-9]+/).filter((word) => word.length >= 3);

/** Three real words or more: a person talking, not a cough, a stray partial or a single "hm". */
export function looksLikeSpeech(partial: string): boolean {
	return wordsOf(partial).length >= 3;
}

/**
 * Whether a partial is mostly the room's own recent words coming back through
 * the microphone. Echo cancellation catches nearly all of it; this catches the
 * rest, so the room does not interrupt itself.
 */
export function isEcho(partial: string, recentlySpoken: string): boolean {
	const words = wordsOf(partial);
	if (words.length === 0) return false;
	const spoken = new Set(wordsOf(recentlySpoken));
	const hits = words.filter((word) => spoken.has(word)).length;
	return hits / words.length >= 0.6;
}
