// The one rule for text that reaches a room's memory file, whoever wrote it:
// a person in an editor, a paste from a chat, or the Memory model's own draft
// of a Remember page. Every word is kept, in its order, and nothing in it can
// become the file's structure: no section, topic, note, id or Remember part,
// and nothing a later reader drops (Memorize's summary filing strips any run of
// # and drops comment lines). Pure, with no Node imports: the server applies it
// at every save, and the page imports it to count what the server will keep.

/** The longest note a card's Edit takes (Memorize and Review), counted after the rule. */
export const MEMORY_CARD_NOTE_MAX_CHARS = 2000;
/** The longest note Room settings, Memory takes, counted after the rule. */
export const MEMORY_NOTE_MAX_CHARS = 20_000;
/** The longest Remember page Save takes, counted on the page the server builds (rememberPageFromParts). */
export const MEMORY_PAGE_MAX_CHARS = 8_000;
/** The longest topic name Room settings, Memory takes. */
export const MEMORY_TOPIC_NAME_MAX_CHARS = 120;

/** Every line break splitLines and the readers break on, U+0085 too: each becomes "\n" first. */
const LINE_BREAKS = /\r\n|[\r\u2028\u2029\u0085]/g;
/** A heading line at any level, indented or not: a run of # and then whitespace and words, or nothing. */
const HEADING_LINE = /^[ \t]*#+(?:[ \t]+(.*?))?[ \t]*$/;
/** Remember's part markers in both bold forms, any case (absorb-summary.ts FIELD_LABEL, persistent-agents.ts extractApprovedRecentContextField). */
const PART_MARKER = /\*\*(session arc|body|parked)(?::\*\*|\*\*:)/gi;
/** Words that would read as a part marker or the must-keep marker once made bold. */
const MARKER_WORDS = /^\s*(?:(?:session arc|body|parked)\s*:?|.*\bmust-keep\b.*)\s*$/i;

function headingWords(words: string): string | null {
	// A run of hashes inside the words goes too ("## ## X"), and closing hashes ("## X ##").
	const plain = words.replace(/^(?:#+[ \t]+)+/, "").replace(/[ \t]+#+$/, "").trim();
	if (!plain || !/[^#\s]/.test(plain)) return null;
	if (MARKER_WORDS.test(plain.replace(/\*\*/g, ""))) return plain.replace(/\*\*/g, "");
	return /^\*\*[\s\S]+\*\*$/.test(plain) ? plain : `**${plain}**`;
}

/**
 * The rule. In this order: every line break becomes "\n"; every comment mark
 * goes and its words stay, mid-line too; every heading line becomes its words
 * in bold, and a heading with no words goes (one whose words are a part marker
 * or the must-keep marker ends as plain words); then Remember's part markers
 * lose their bold. Everything else is kept byte for byte. Applying it twice
 * changes nothing.
 */
export function memoryTypedText(text: string): string {
	const lines = text.replace(LINE_BREAKS, "\n").replace(/<!--[ \t]*/g, "").replace(/[ \t]*-->/g, "").split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const heading = HEADING_LINE.exec(line);
		if (!heading) { out.push(line); continue; }
		const words = headingWords(heading[1] ?? "");
		if (words !== null) out.push(words);
	}
	return out.join("\n").replace(PART_MARKER, (_marker, name: string) => `${name}:`);
}

/** Whether a text says anything once its list marks are set aside: "", "- " and "**" say nothing. */
export function memoryTextHasWords(text: string): boolean {
	return /[\p{L}\p{N}]/u.test(text.replace(/^\s*(?:[-*+]|\d+[.)])\s*/gm, ""));
}

/** A typed topic name on one line: every line break and run of spaces becomes one space, comment marks go. */
export function memoryTopicName(raw: string): string {
	return raw.replace(LINE_BREAKS, "\n").replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();
}

/** Why a typed new topic name cannot be used, as a code the surfaces turn into their sentence; null when it can. */
export function memoryTopicNameProblem(name: string, options: { maxChars?: number } = {}): "empty" | "heading" | "reserved" | "too-long" | null {
	if (!name) return "empty";
	if (name.startsWith("#")) return "heading";
	// The file's own list of open items: a fact filed there would join them.
	if (/^active items$/i.test(name)) return "reserved";
	if (name.length > (options.maxChars ?? MEMORY_TOPIC_NAME_MAX_CHARS)) return "too-long";
	return null;
}

/** The sentence a refused topic name gets, the same on every surface (draft wording). */
export function topicNameSentence(problem: "empty" | "heading" | "reserved" | "too-long", name: string, maxChars = MEMORY_TOPIC_NAME_MAX_CHARS): string {
	switch (problem) {
		case "empty": return "Write a name for the topic.";
		case "heading": return "A topic name can't start with #. Write it without the #.";
		case "reserved": return `${name} is the name of a list memory keeps for itself. Choose another name.`;
		case "too-long": return `A topic name is at most ${maxChars} characters.`;
	}
}

export interface RememberPageParts {
	sessionArc: string;
	body: string;
	parked: string;
}

/** Each of Remember's parts under the rule, trimmed. */
export function rememberPartsTyped(parts: RememberPageParts): RememberPageParts {
	return { sessionArc: memoryTypedText(parts.sessionArc).trim(), body: memoryTypedText(parts.body).trim(), parked: memoryTypedText(parts.parked).trim() };
}

/**
 * A page sent as one string (the older form of Save), read back into its
 * heading and parts, or null when it cannot be read without guessing: every
 * part marker it holds, in either bold form and any case, must open a line, in
 * the order What happened (optional), What to keep, Still open, once each. A
 * marker typed inside a part makes it unreadable, never a part of its own.
 */
export function rememberPartsOfPage(page: string): { heading: string; parts: RememberPageParts } | null {
	const lines = page.replace(LINE_BREAKS, "\n").trim().split("\n");
	const heading = lines.shift() ?? "";
	const rest = lines.join("\n");
	const found = [...rest.matchAll(PART_MARKER)];
	const names = found.map((match) => match[1].toLowerCase()).join(",");
	if (names !== "session arc,body,parked" && names !== "body,parked") return null;
	if (!found.every((match) => /(?:^|\n)[ \t]*$/.test(rest.slice(0, match.index)))) return null;
	const text = (n: number) => rest.slice(found[n].index! + found[n][0].length, n + 1 < found.length ? found[n + 1].index : rest.length).trim();
	const arc = found.length === 3;
	return { heading, parts: { sessionArc: arc ? text(0) : "", body: text(arc ? 1 : 0), parked: text(arc ? 2 : 1) } };
}

/** An empty Still open, or one that says None, saves as None and closes the page. */
function nothingOpen(parked: string): boolean {
	return !parked || /^none\.?$/i.test(parked);
}

/**
 * The page Save writes, built from the proposal's heading and the three parts
 * under the rule: What happened is left out when empty, an empty Still open
 * saves as None, and the heading's OPEN or CLOSED follows Still open. Its
 * length is what MEMORY_PAGE_MAX_CHARS counts.
 */
export function rememberPageFromParts(proposalHeading: string, raw: RememberPageParts): string {
	const parts = rememberPartsTyped(raw);
	const open = !nothingOpen(parts.parked);
	const heading = proposalHeading.trim().replace(/\|\s*(?:OPEN|CLOSED)\s*\|/i, `| ${open ? "OPEN" : "CLOSED"} |`);
	const arc = parts.sessionArc ? `**Session arc:** ${parts.sessionArc}\n\n` : "";
	return `${heading}\n\n${arc}**Body:**\n${parts.body}\n\n**Parked:**\n${open ? parts.parked : "None"}`;
}
