/**
 * The text rules of per-room instructions, shared by the server and the pane.
 *
 * Browser-safe on purpose: no node imports, so apps/web-ui can import it the
 * way it imports the other pure server modules. This is the ONE place that
 * says what a text becomes when stored (normalization), what a save refuses
 * (validation: control characters, the cap), and how the boot prompt marks
 * the layer (the marker grammar and its parser). The file module
 * (persistent-room-instructions.ts) does the disk work on top of these.
 */
export const ROOM_INSTRUCTIONS_MAX_CHARS = 8000;

const MARKER_PREFIX = "<!-- exxeta:persistent-agent:instructions";
// C0 controls except tab (0x09), LF (0x0a) and CR (0x0d, folded into LF before
// the check), plus DEL. Written with escapes: a raw control byte in the
// source makes git treat the whole file as binary.
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// The marker as the boot layer writes it: at a layer boundary (the prompt
// start or the "---" separator the boot assembly joins layers with), under
// the layer's own heading. Used only as a FALLBACK for conversations whose
// thread record predates the booted fingerprint being stored as metadata;
// prose can imitate a boundary, metadata cannot.
const LAYER_MARKER_PATTERN = /(?:^|\n---\n\n)# [^\n]+ Instructions\n\n<!-- exxeta:persistent-agent:instructions schema_version=1 fingerprint=([0-9a-f]{64}) -->\n/;
const MARKER_LINE_PATTERN = /^<!-- exxeta:persistent-agent:instructions schema_version=1 fingerprint=([0-9a-f]{64}) -->$/m;

function refuse(message: string): Error {
	const error = new Error(message);
	(error as any).statusCode = 400;
	return error;
}

function foldLineEndings(raw: unknown): string {
	if (typeof raw !== "string") throw refuse("instructions must be text");
	return raw.normalize("NFC").replace(/\r\n?/g, "\n");
}

/**
 * The one normalization, shared by the read and the write and by the pane's
 * counter: line endings become LF, the text is NFC (macOS paste can deliver
 * decomposed accents), and surrounding blank lines go. It never refuses
 * text (a file the user wrote by hand is theirs and boots as it is), so an
 * empty result is the only way to mean "no instructions". Anything that is
 * not text is refused: a request that names no text is not a request to
 * remove the instructions.
 */
export function normalizePersistentRoomInstructionsText(raw: unknown): string {
	return foldLineEndings(raw).replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/**
 * Control characters a save refuses, counted BEFORE the blank-line trimming
 * (a vertical tab at the edge is whitespace to the trimmer, so counting
 * after it would let the trimmer silently drop what the rule says it
 * refuses). The pane calls this on the raw draft to name them before the
 * request.
 */
export function countPersistentRoomInstructionsControlCharacters(raw: unknown): number {
	return (foldLineEndings(raw).match(CONTROL_CHARACTERS) ?? []).length;
}

/**
 * What a save accepts: the normalized text, measured against the cap in
 * UTF-16 units (the same number a browser textarea reports, so the pane
 * and the server agree), with control characters other than newline and
 * tab refused rather than stripped: a silent edit of what the user typed is
 * worse than a refusal that names the problem. Refusals carry a 400.
 */
export function validatePersistentRoomInstructionsText(raw: unknown): string {
	const controls = countPersistentRoomInstructionsControlCharacters(raw);
	if (controls > 0) {
		throw refuse(`instructions contain ${controls} invisible control ${controls === 1 ? "character" : "characters"} that cannot be stored, usually from a paste; remove ${controls === 1 ? "it" : "them"} and save again`);
	}
	const text = normalizePersistentRoomInstructionsText(raw);
	if (text.length > ROOM_INSTRUCTIONS_MAX_CHARS) {
		throw refuse(`instructions are ${text.length.toLocaleString("en-US")} characters; the limit is ${ROOM_INSTRUCTIONS_MAX_CHARS.toLocaleString("en-US")}. Shorten them and save again`);
	}
	return text;
}

export function persistentRoomInstructionsLayerHeading(displayName: string): string {
	return `# ${displayName} Instructions`;
}

export function persistentRoomInstructionsMarkerLine(fingerprint: string): string {
	return `${MARKER_PREFIX} schema_version=1 fingerprint=${fingerprint} -->`;
}

/**
 * The fingerprint a boot LAYER's own content carries (its second paragraph
 * is the marker line). Call it on the instructions layer only: the pattern
 * matches a marker line anywhere in the string, and it is safe there because
 * the layer text is code-built and the marker precedes the user's text.
 * Null when the layer carries no marker line.
 */
export function parsePersistentRoomInstructionsLayerFingerprint(layerContent: string): string | null {
	const match = MARKER_LINE_PATTERN.exec(String(layerContent ?? ""));
	return match ? match[1] : null;
}

/**
 * Fallback for thread records without the booted fingerprint: the marker as
 * it sits in a frozen boot PROMPT. Prose can imitate the boundary this
 * pattern keys on (a "---" rule plus a heading), which is why the fingerprint
 * is stored as thread metadata for every conversation booted since: this
 * parse exists only so older conversations keep working until they end.
 */
export function parsePersistentRoomInstructionsMarker(systemPrompt: string): string | null {
	const match = LAYER_MARKER_PATTERN.exec(String(systemPrompt ?? ""));
	return match ? match[1] : null;
}
